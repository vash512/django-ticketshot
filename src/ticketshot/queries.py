"""Read queries for open tickets, unread changes, and visits."""
from urllib.parse import urlsplit

from django.db.models import BooleanField, Case, IntegerField, Max, Q, Value, When
from django.urls import Resolver404, resolve
from django.utils import timezone

from . import conf, states
from .models import TicketEvent, TicketSeen
from .workflow import tickets

OPEN_LIMIT = 30


def resolve_view(path):
    try:
        match = resolve(urlsplit(path).path)
    except Resolver404:
        return None
    return match.view_name or None


def open_for(path):
    """List open tickets for a URL, prioritizing exact paths before limiting."""
    only_path = urlsplit(path or "/").path or "/"
    same_path = Q(trigger_path=only_path) | Q(trigger_path__startswith=only_path + "?")
    condition = same_path
    view_name = resolve_view(only_path)
    if view_name:
        condition |= Q(view_name=view_name)
    return list(
        tickets().filter(condition, status__in=states.OPEN)
        .annotate(exact=Case(When(same_path, then=Value(True)), default=Value(False),
                             output_field=BooleanField()))
        .order_by("-exact", "-created_at", "-id")
        .prefetch_related("images")[:OPEN_LIMIT])


def review_order():
    """Database ordering expression for states.REVIEW_ORDER."""
    return Case(*[When(status=s, then=Value(i)) for i, s in enumerate(states.REVIEW_ORDER)],
                output_field=IntegerField())


def mark_seen(ticket, username):
    if not username:
        return
    TicketSeen.objects.using(conf.database()).update_or_create(
        ticket=ticket, username=username, defaults={"seen_at": timezone.now()})


def news(ticket_list, username):
    """Map ticket IDs to true when others changed them since last visit."""
    ids = [t.pk for t in ticket_list]
    if not ids or not username:
        return {}
    alias = conf.database()
    seen = dict(TicketSeen.objects.using(alias).filter(
        ticket_id__in=ids, username=username).values_list("ticket_id", "seen_at"))
    latest = (TicketEvent.objects.using(alias).filter(ticket_id__in=ids)
              .exclude(actor_username=username).order_by().values("ticket_id")
              .annotate(last=Max("created_at")).values_list("ticket_id", "last"))
    return {tid: (tid not in seen or moment > seen[tid]) for tid, moment in latest}
