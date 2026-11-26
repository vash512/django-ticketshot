"""Review panel, with tickets awaiting review first."""
import json

from django.contrib.auth.views import redirect_to_login
from django.core.exceptions import PermissionDenied
from django.core.paginator import Paginator
from django.db.models import Case, Count, DateTimeField, F, OuterRef, Q, Subquery, Value, When
from django.http import Http404
from django.shortcuts import get_object_or_404, render
from django.utils.http import url_has_allowed_host_and_scheme
from django.utils.translation import gettext as _, gettext_lazy as _lazy
from django.views.decorators.http import require_GET

from . import assets, conf, keys, permissions, queries, states, timeline, users
from .api import require_enabled, ticket_or_404
from .models import DebugRecord, TicketEvent, TicketImage, TicketSeen
from .workflow import tickets

S = states.Status
DEFAULT_FILTER = "open"
FILTERS = {
    "open": (_lazy("Open tickets"), states.OPEN),
    "in-review": (_lazy("In review"), (S.IN_REVIEW,)),
    "requested": (_lazy("Requested"), (S.REQUESTED,)),
    "in-progress": (_lazy("In progress"), (S.IN_PROGRESS,)),
    "approved": (_lazy("Approved tickets"), (S.APPROVED,)),
    "discarded": (_lazy("Discarded tickets"), (S.DISCARDED,)),
    "all": (_lazy("All"), tuple(S)),
}


def _guard(request):
    """Return None when access is allowed, otherwise login or 403 response."""
    require_enabled()
    if not request.user.is_authenticated:
        return redirect_to_login(request.get_full_path())
    if not permissions.can_view(request.user):
        raise PermissionDenied(_("Your account cannot view tickets."))
    return None


def _base_context(request):
    config = conf.current()
    return {
        "css": assets.url(assets.PANEL_CSS),
        "project": config.project,
        "language": conf.language(),
        "can": permissions.flags(request.user),
        "user_label": users.label(request.user),
        "review_url": config.review_url,
        "review_branch": config.review_branch,
        "board_js": assets.url(f"{assets.BAR_DIR}/board.js"),
        "review_count": tickets().filter(status=S.IN_REVIEW).count(),
    }


def _search(rows, query):
    condition = (Q(note__icontains=query) | Q(trigger_path__icontains=query)
                 | Q(author_label__icontains=query) | Q(view_name__icontains=query))
    number = keys.parse(query)
    if number is not None:
        condition |= Q(number=number)
    return rows.filter(condition)


def _tabs(current):
    counts = dict(tickets().order_by().values_list("status").annotate(n=Count("id")))
    return [{"slug": slug, "label": label, "active": slug == current,
             "count": sum(counts.get(s, 0) for s in statuses)}
            for slug, (label, statuses) in FILTERS.items()]


@require_GET
def panel(request):
    denied = _guard(request)
    if denied:
        return denied
    if request.GET.get("view") != "list":
        return _board(request)
    return _list(request)


def _list(request):
    selected_filter = request.GET.get("status")
    current = selected_filter if selected_filter in FILTERS else DEFAULT_FILTER
    query = (request.GET.get("q") or "").strip()[:200]
    device = request.GET.get("device", "")

    rows = tickets().filter(status__in=FILTERS[current][1])
    if device in states.Device.values:
        rows = rows.filter(device=device)
    if query:
        rows = _search(rows, query)
    rows = (rows.annotate(image_count=Count("images"), order=queries.review_order())
            .select_related("parent").order_by("order", "-updated_at", "-id"))
    page = Paginator(rows, conf.current().panel_page_size).get_page(
        request.GET.get("page"))
    fresh = queries.news(page.object_list, request.user.get_username())
    for ticket in page.object_list:
        ticket.is_new = fresh.get(ticket.pk, False)

    context = _base_context(request)
    context.update({
        "page": page, "tabs": _tabs(current), "current": current, "query": query,
        "device": device, "devices": states.Device.choices,
    })
    return render(request, "ticketshot/panel/list.html", context)


def _board_rows(request):
    """Board filters, including unread state before column limits."""
    query = (request.GET.get("q") or "").strip()[:200]
    device = request.GET.get("device", "")
    rows = tickets()
    if query:
        rows = _search(rows, query)
    if device in states.Device.values:
        rows = rows.filter(device=device)
    if request.GET.get("recordings") == "1":
        rows = rows.filter(kind=states.Kind.RECORDING)
    if request.GET.get("unsolicited") == "1":
        rows = rows.filter(source=states.Source.SKILL)
    username = request.user.get_username()
    if username:
        alias = conf.database()
        last_other = (TicketEvent.objects.using(alias).filter(ticket_id=OuterRef("pk"))
                      .exclude(actor_username=username).order_by("-created_at", "-pk")
                      .values("created_at")[:1])
        last_seen = (TicketSeen.objects.using(alias).filter(ticket_id=OuterRef("pk"), username=username)
                     .values("seen_at")[:1])
        rows = rows.annotate(last_other=Subquery(last_other, output_field=DateTimeField()),
                             last_seen=Subquery(last_seen, output_field=DateTimeField()))
        rows = rows.annotate(is_new=Case(
            When(Q(last_other__isnull=False) &
                 (Q(last_seen__isnull=True) | Q(last_other__gt=F("last_seen"))),
                 then=Value(True)), default=Value(False)))
    else:
        rows = rows.annotate(is_new=Value(False))
    if request.GET.get("unread") == "1":
        rows = rows.filter(is_new=True)
    return rows, query, device


def _board(request):
    rows, query, device = _board_rows(request)
    counts = dict(rows.order_by().values("status").annotate(total=Count("pk"))
                  .values_list("status", "total"))
    image_id = (TicketImage.objects.using(conf.database()).filter(ticket_id=OuterRef("pk"))
                .order_by("position", "pk").values("pk")[:1])
    can = permissions.flags(request.user)
    target_map = {}
    labels = dict(states.BOARD_COLUMNS)
    for status, _ in states.BOARD_COLUMNS:
        targets = list(states.team_targets(status)) if can["work"] else []
        if can["approve"] and status == S.IN_REVIEW:
            targets.extend((S.APPROVED, S.REQUESTED))
        target_map[status] = [{"status": candidate, "label": str(labels[candidate])}
                              for candidate, _ in states.BOARD_COLUMNS if candidate in targets]
    columns = []
    for status, title in states.BOARD_COLUMNS:
        column_rows = (rows.filter(status=status).select_related("parent")
                       .annotate(first_image_id=Subquery(image_id))
                       .order_by("-updated_at", "-pk"))
        if status in states.CLOSED:
            column_rows = column_rows[:10]
        cards = list(column_rows)
        for ticket in cards:
            ticket.board_targets = target_map[ticket.status]
            ticket.board_target_values = ",".join(t["status"] for t in ticket.board_targets)
        columns.append({"status": status, "title": str(title), "count": counts.get(status, 0),
                        "cards": cards, "more": status in states.CLOSED and counts.get(status, 0) > 0,
                        "list_filter": "approved" if status == S.APPROVED else "discarded"})
    context = _base_context(request)
    context.update({"columns": columns, "target_map": target_map, "query": query, "device": device,
                    "devices": states.Device.choices,
                    "only_news": request.GET.get("unread") == "1",
                    "only_flows": request.GET.get("recordings") == "1",
                    "only_skill": request.GET.get("unsolicited") == "1"})
    return render(request, "ticketshot/panel/board.html", context)


@require_GET
def panel_queue(request):
    denied = _guard(request)
    if denied:
        return denied
    pending = tickets().filter(status=S.IN_REVIEW)
    total = pending.count()
    selected = request.GET.get("ticket")
    if selected:
        number = keys.parse(selected)
        ticket = pending.filter(number=number).first() if number is not None else None
        if ticket is None:
            raise Http404(_("That ticket is not in the queue."))
    else:
        ticket = pending.order_by("created_at", "pk").first()
    position = 0
    next_key = ""
    if ticket:
        position = pending.filter(Q(created_at__lt=ticket.created_at) |
                                  Q(created_at=ticket.created_at, pk__lte=ticket.pk)).count()
        if total > 1:
            later = pending.filter(Q(created_at__gt=ticket.created_at) |
                                   Q(created_at=ticket.created_at, pk__gt=ticket.pk))
            next_ticket = later.order_by("created_at", "pk").first()
            if next_ticket is None:
                next_ticket = pending.order_by("created_at", "pk").first()
            next_key = next_ticket.key
    context = _base_context(request)
    context.update({"ticket": ticket, "images": list(ticket.images.using(conf.database()).all()) if ticket else [],
                    "position": position, "total": total, "next_key": next_key,
                    "review_count": total,
                    "review_path": _safe_review_path(request, ticket.trigger_path) if ticket else None})
    return render(request, "ticketshot/panel/queue.html", context)


def _safe_review_path(request, path):
    if (path and path.startswith("/") and not path.startswith("//")
            and url_has_allowed_host_and_scheme(path, allowed_hosts={request.get_host()})):
        return path
    return None


def _review_links(request, ticket):
    path = _safe_review_path(request, ticket.trigger_path)
    if path is None:
        return None
    return {
        "compare": f"{path}#ticketshot-compare={ticket.key}",
        "chain": f"{path}#ticketshot-chain={ticket.key}",
        "open": path,
    }


def _pretty(value):
    return json.dumps(value, ensure_ascii=False, indent=2, default=str)


@require_GET
def panel_detail(request, key):
    denied = _guard(request)
    if denied:
        return denied
    ticket = ticket_or_404(key)
    alias = conf.database()
    user = request.user
    queries.mark_seen(ticket, user.get_username())
    debug_records = []
    if permissions.can_debug(user):
        debug_records = list(ticket.debug_records.using(alias).defer("data"))
    context = _base_context(request)
    context.update({
        "ticket": ticket,
        "images": list(ticket.images.using(alias).all()),
        "history": list(ticket.history.using(alias).all()),
        "children": list(ticket.children.using(alias).order_by("created_at")),
        "debug_records": debug_records,
        "moves": [(s, s.label) for s in states.team_targets(ticket.status)],
        "links": _review_links(request, ticket),
        "tags_text": "\n".join(f"{name}: {where}" for name, where in (ticket.url_tags or {}).items()),
        "timeline": timeline.rows(ticket.events),
        "server_json": _pretty(ticket.server_context),
        "client_json": _pretty(ticket.client_context),
        "logs_json": _pretty(ticket.logs) if ticket.logs else "",
        "flash_ok": request.GET.get("ok", "")[:300],
        "flash_error": request.GET.get("error", "")[:300],
        "in_review": ticket.status == S.IN_REVIEW,
    })
    return render(request, "ticketshot/panel/detail.html", context)


@require_GET
def panel_debug(request, key, pk):
    denied = _guard(request)
    if denied:
        return denied
    if not permissions.can_debug(request.user):
        raise PermissionDenied(_("Your account cannot view the debug log."))
    ticket = ticket_or_404(key)
    record = get_object_or_404(DebugRecord.objects.using(conf.database()), pk=pk, ticket=ticket)
    context = _base_context(request)
    context.update({
        "ticket": ticket,
        "record": record,
        "data_json": _pretty(record.data),
        "exception": (record.data or {}).get("exception", ""),
    })
    return render(request, "ticketshot/panel/debug.html", context)
