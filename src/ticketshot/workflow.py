"""The only writer of ticket status and history."""
from django.core.exceptions import ValidationError
from django.utils.translation import gettext as _
from django.db import transaction
from django.db.models import Max
from django.utils import timezone

from . import conf, keys, states, urltemplate
from .models import Counter, Ticket, TicketEvent

S = states.Status
A = states.Action


def tickets():
    """Tickets belonging to the configured project."""
    return Ticket.objects.using(conf.database()).filter(project=conf.current().project)


def find(key):
    number = keys.parse(key)
    if number is None:
        return None
    return tickets().filter(number=number).first()


def next_number(project):
    """Allocate the next project ticket number inside a transaction."""
    alias = conf.database()
    counter, _ = Counter.objects.using(alias).select_for_update().get_or_create(project=project)
    if counter.value == 0:
        # Continue after any existing tickets added by other means.
        last = Ticket.objects.using(alias).filter(project=project).aggregate(
            last=Max("number"))["last"] or 0
        counter.value = last
    counter.value += 1
    counter.save(using=alias, update_fields=["value"])
    return counter.value


def add_event(ticket, kind, actor, *, text="", from_status="", to_status="", data=None):
    return TicketEvent.objects.using(conf.database()).create(
        ticket=ticket, kind=kind, actor_username=actor.username, actor_label=actor.label,
        text=text, from_status=from_status, to_status=to_status, data=data or {})


def clean_text(text, *, required, missing=None):
    """Trim and validate note or comment text against its limit."""
    text = str(text or "").strip()
    if required and not text:
        raise ValidationError(missing or _("Write a note."))
    if len(text) > conf.current().max_note_length:
        raise ValidationError(_("The text is too long."))
    return text


# locking

def _locked(ticket):
    """Lock the ticket row until this transaction ends."""
    return Ticket.objects.using(conf.database()).select_for_update().get(pk=ticket.pk)


def _refresh(ticket, fresh):
    """Copy saved values back to the caller's ticket instance."""
    ticket.__dict__.update({f.attname: getattr(fresh, f.attname) for f in Ticket._meta.concrete_fields})
    return ticket


def _set_status(row, to, actor, kind, *, text="", data=None):
    previous = row.status
    row.status = to
    row.closed_at = timezone.now() if states.is_closed(to) else None
    row.save(using=conf.database(), update_fields=["status", "closed_at", "updated_at"])
    add_event(row, kind, actor, text=text, from_status=previous, to_status=to, data=data)


def change_status(ticket, action, actor, *, to="", text="", data=None):
    """Move, approve, or reject using states.next_status rules."""
    required = action == A.REJECT and not (data or {}).get("chained")
    text = clean_text(text, required=required, missing=_("Describe what still does not work."))
    with transaction.atomic(using=conf.database()):
        row = _locked(ticket)
        target = states.next_status(row.status, action, to)
        _set_status(row, target, actor, states.EVENT[action], text=text, data=data)
    return _refresh(ticket, row)


def set_status(ticket, to, actor, *, text=""):
    """Manual status change by the team."""
    return change_status(ticket, A.MOVE, actor, to=to, text=text)


def approve(ticket, actor, *, text=""):
    return change_status(ticket, A.APPROVE, actor, text=text)


def reject(ticket, actor, *, text, chained=None):
    """Reject a ticket, optionally with a new chained capture."""
    data = {"chained": chained.key} if chained else {}
    return change_status(ticket, A.REJECT, actor, text=text, data=data)


def comment(ticket, actor, *, text):
    text = clean_text(text, required=True, missing=_("Write a comment."))
    return add_event(ticket, states.EventKind.COMMENT, actor, text=text)


def set_template(ticket, actor, *, template, tags):
    built = urltemplate.build(template, tags)
    with transaction.atomic(using=conf.database()):
        row = _locked(ticket)
        row.url_template, row.url_tags = built.template, built.tags
        row.save(using=conf.database(), update_fields=["url_template", "url_tags", "updated_at"])
        add_event(row, states.EventKind.TEMPLATE, actor,
                  data={"template": built.template, "tags": built.tags})
    return _refresh(ticket, row)


def link_commit(ticket, actor, *, commit, branch="", message=""):
    """Link a ticket when its implementation commit reaches the review branch."""
    commit = str(commit or "").strip()[:40]
    if not commit:
        raise ValidationError(_("The commit is missing."))
    with transaction.atomic(using=conf.database()):
        row = _locked(ticket)
        if row.implemented_commit == commit:
            return _refresh(ticket, row)
        row.implemented_commit = commit
        row.implemented_branch = str(branch or "")[:200]
        row.implemented_at = timezone.now()
        row.save(using=conf.database(), update_fields=[
            "implemented_commit", "implemented_branch", "implemented_at", "updated_at"])
        data = {"commit": commit, "branch": row.implemented_branch,
                "message": str(message or "")[:500]}
        target = states.after_commit(row.status)
        if target != row.status:
            _set_status(row, target, actor, states.EventKind.COMMIT, data=data)
        else:
            add_event(row, states.EventKind.COMMIT, actor, data=data)
    return _refresh(ticket, row)


def reopen_threshold(ticket):
    """Determine whether a commit is new enough to move a ticket into review."""
    last = ticket.history.using(conf.database()).filter(
        to_status=S.REQUESTED).aggregate(last=Max("created_at"))["last"]
    return max(filter(None, [ticket.created_at, last]))
