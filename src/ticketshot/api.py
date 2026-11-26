"""Bar API for creating tickets, listing open tickets, and taking actions.

Actions return JSON to the bar and redirect form submissions to the panel.
"""
from urllib.parse import quote

from django.core.exceptions import PermissionDenied, ValidationError
from django.http import FileResponse, Http404, JsonResponse
from django.shortcuts import get_object_or_404, redirect
from django.urls import reverse
from django.utils.translation import gettext as _
from django.views.decorators.http import require_GET, require_POST

from . import anonymize, conf, intake, permissions, queries, states, submission, storage, users, workflow
from .models import TicketImage

A = states.Action
CONTENT_TYPES = {"webp": "image/webp", "png": "image/png", "jpg": "image/jpeg", "jpeg": "image/jpeg"}


def require_enabled():
    if not conf.current().enabled:
        raise Http404


def ticket_or_404(key):
    ticket = workflow.find(key)
    if ticket is None:
        raise Http404(_("That ticket does not exist."))
    return ticket


def _wants_json(request):
    return (request.headers.get("X-Requested-With") == "ticketshot"
            or "application/json" in request.headers.get("Accept", ""))


def ticket_json(ticket, user):
    can = permissions.flags(user)
    data = {
        "key": ticket.key,
        "status": ticket.status,
        "statusLabel": ticket.get_status_display(),
        "kind": ticket.kind,
        "kindLabel": ticket.get_kind_display(),
        "device": ticket.device,
        "deviceLabel": ticket.get_device_display(),
        "note": ticket.note[:400],
        "author": ticket.author_label,
        "created": ticket.created_at.isoformat(),
        "path": ticket.trigger_path,
        "exact": bool(getattr(ticket, "exact", True)),
        "parent": ticket.parent.key if ticket.parent_id and ticket.parent else "",
        "canApprove": can["approve"] and ticket.status == states.Status.IN_REVIEW,
    }
    if can["view"]:
        data["detailUrl"] = reverse("ticketshot:panel_detail", args=[ticket.key])
        data["images"] = [{
            "id": image.pk, "url": reverse("ticketshot:image", args=[image.pk]),
            "device": image.device, "role": image.role, "width": image.width, "height": image.height,
        } for image in ticket.images.all()]
    return data


# --------------------------------------------------------------- create

class _EveryAlias(frozenset):
    """Match every alias so no database wraps the view in a transaction."""

    def __contains__(self, alias):
        return True


def own_transaction(view):
    """Keep file creation outside `ATOMIC_REQUESTS` so rollback can clean it up."""
    view._non_atomic_requests = _EveryAlias()
    return view


@own_transaction
@require_POST
def ticket_create(request):
    require_enabled()
    # Bar visibility alone does not grant ticket creation.
    if not permissions.can_add(request.user):
        return JsonResponse({"error": _("Your account cannot create tickets.")}, status=403)
    try:
        payload = submission.parse_payload(request.POST.get("payload"))
        new = submission.from_bar(request, payload, request.FILES)
        ticket, created = intake.create(new, users.Actor.from_user(request.user))
    except intake.DuplicateSubmission as exc:
        return JsonResponse({"error": " ".join(exc.messages)}, status=409)
    except ValidationError as exc:
        return JsonResponse({"error": " ".join(exc.messages)}, status=400)
    return JsonResponse({
        "id": ticket.pk,
        "key": ticket.key,
        "status": ticket.status,
        "images": ticket.images.count(),
        "created": created,
        "detailUrl": (reverse("ticketshot:panel_detail", args=[ticket.key])
                      if permissions.can_view(request.user) else None),
    }, status=201 if created else 200)


@require_GET
def tickets_open(request):
    """Open tickets for the reviewer's current URL."""
    require_enabled()
    if not (permissions.show_bar(request) or permissions.can_view(request.user)):
        return JsonResponse({"error": _("Permission denied.")}, status=403)
    path = request.GET.get("path") or "/"
    if not path.startswith("/"):
        return JsonResponse({"error": _("The path must start with '/'.")}, status=400)
    found = queries.open_for(anonymize.url(path)[:1000])
    return JsonResponse({
        "tickets": [ticket_json(t, request.user) for t in found],
        "panelUrl": reverse("ticketshot:panel") if permissions.can_view(request.user) else "",
    })


# ----------------------------------------------------------------- actions

def _comment(ticket, actor, post):
    workflow.comment(ticket, actor, text=post.get("text", ""))
    return _("Comment added.")


def _approve(ticket, actor, post):
    workflow.approve(ticket, actor, text=post.get("text", ""))
    return _("%(key)s approved.") % {"key": ticket.key}


def _reject(ticket, actor, post):
    workflow.reject(ticket, actor, text=post.get("text", ""))
    return _("%(key)s returned to “%(status)s”.") % {
        "key": ticket.key, "status": states.Status.REQUESTED.label}


def _move(ticket, actor, post):
    workflow.set_status(ticket, post.get("to", ""), actor, text=post.get("text", ""))
    return _("%(key)s is now “%(status)s”.") % {
        "key": ticket.key, "status": ticket.get_status_display()}


def _template(ticket, actor, post):
    workflow.set_template(ticket, actor, template=post.get("template", ""),
                          tags=post.get("tags", ""))
    return _("Reproducible URL saved.")


HANDLERS = {A.COMMENT: _comment, A.APPROVE: _approve, A.REJECT: _reject,
            A.MOVE: _move, A.TEMPLATE: _template}


@require_POST
def ticket_action(request, key):
    require_enabled()
    if not request.user.is_authenticated:
        raise PermissionDenied
    ticket = ticket_or_404(key)
    action = request.POST.get("action", "")
    handler = HANDLERS.get(action)
    if handler is None:
        return _answer(request, ticket, error=_("Unknown action."), status=400)
    if not permissions.can_do(request.user, action):
        return _answer(request, ticket, error=_("Your account cannot do that."), status=403)
    try:
        message = handler(ticket, users.Actor.from_user(request.user), request.POST)
    except ValidationError as exc:
        return _answer(request, ticket, error=" ".join(exc.messages), status=400)
    return _answer(request, ticket, message=message)


def _answer(request, ticket, *, message="", error="", status=200):
    if _wants_json(request):
        if error:
            return JsonResponse({"error": error}, status=status)
        return JsonResponse({"message": message, "ticket": ticket_json(ticket, request.user)})
    if status == 403:
        raise PermissionDenied(error)
    target = reverse("ticketshot:panel_detail", args=[ticket.key])
    kind = "error" if error else "ok"
    return redirect(f"{target}?{kind}={quote(error or message)}")


# ---------------------------------------------------------------- image

@require_GET
def image_view(request, pk):
    """Serve an image only to users who can view tickets."""
    require_enabled()
    if not permissions.can_view(request.user):
        raise PermissionDenied
    item = get_object_or_404(
        TicketImage.objects.using(conf.database()).select_related("ticket"),
        pk=pk, ticket__project=conf.current().project)
    backend = storage.backend_for(item.storage_mode)
    name = item.image.name
    if conf.current().serve == conf.REDIRECT and not storage.is_local(backend):
        return redirect(backend.url(name))
    try:
        handle = backend.open(name, "rb")
    except OSError as exc:
        raise Http404(_("The image is no longer in storage.")) from exc
    ext = name.rpartition(".")[2].lower()
    response = FileResponse(handle, content_type=CONTENT_TYPES.get(ext, "application/octet-stream"))
    response["Cache-Control"] = "private, max-age=300"
    response["X-Content-Type-Options"] = "nosniff"
    response["Content-Disposition"] = f'inline; filename="{item.ticket.key}-{item.position + 1}.{ext}"'
    return response
