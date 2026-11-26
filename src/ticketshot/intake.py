"""Persist a validated NewTicket and its related records atomically."""
import logging
from dataclasses import dataclass
from typing import Optional

from django.core.exceptions import ValidationError
from django.utils.translation import gettext as _
from django.db import IntegrityError, transaction

from . import conf, states, workflow
from .imaging import CleanImage
from .models import DebugRecord, Ticket, TicketImage
from .storage import backend_for

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class NewImage:
    clean: CleanImage
    # Validated TicketImage fields such as role, method, device, and URL.
    fields: dict


@dataclass(frozen=True)
class NewTicket:
    # Validated Ticket fields excluding project and number.
    fields: dict
    images: tuple
    parent: Optional[Ticket] = None
    reject_parent: bool = False


class DuplicateSubmission(ValidationError):
    """The same draft was submitted with different content or author."""


def _existing(new):
    """Return an existing ticket with this client ID, if any."""
    client_id = new.fields.get("client_id")
    if not client_id:
        return None
    ticket = workflow.tickets().filter(client_id=client_id).first()
    if ticket is None:
        return None
    same_author = ticket.author_username == new.fields.get("author_username", "")
    if not same_author or ticket.submission_hash != new.fields.get("submission_hash", ""):
        raise DuplicateSubmission(
            _("This draft was already submitted as %(key)s with different content.") % {"key": ticket.key})
    return ticket


def create(new, actor):
    """Store a ticket and return it with a created flag; retries do not duplicate."""
    existing = _existing(new)
    if existing is not None:
        return existing, False
    try:
        return _store(new, actor), True
    except IntegrityError:
        # The first concurrent submission of a draft wins.
        existing = _existing(new)
        if existing is None:
            raise
        return existing, False


def _store(new, actor):
    alias = conf.database()
    mode = new.fields["storage_mode"]
    saved = []
    try:
        with transaction.atomic(using=alias):
            ticket = Ticket(project=conf.current().project, parent=new.parent, **new.fields)
            ticket.number = workflow.next_number(ticket.project)
            ticket.save(using=alias)
            for position, image in enumerate(new.images):
                saved.append(_save_image(ticket, position, image))
            workflow.add_event(ticket, states.EventKind.CREATED, actor, to_status=ticket.status,
                               data={"source": ticket.source,
                                     "parent": new.parent.key if new.parent else ""})
            if new.parent is not None:
                _link_parent(new.parent, ticket, actor, new.reject_parent)
            _claim_debug_records(ticket)
    except Exception:
        # Database rollback does not delete files, so clean them up.
        for name in saved:
            _delete_quietly(mode, name)
        raise
    return ticket

def _save_image(ticket, position, image):
    item = TicketImage(ticket=ticket, position=position, size_bytes=image.clean.size,
                        storage_mode=ticket.storage_mode, width=image.clean.width,
                        height=image.clean.height, **image.fields)
    item.image.save(f"image.{image.clean.ext}", image.clean.content(), save=False)
    item.width, item.height = image.clean.width, image.clean.height
    item.save(using=conf.database())
    return item.image.name


def _link_parent(parent, child, actor, reject):
    """A rejected child rejects its parent if still in review."""
    if reject:
        try:
            workflow.reject(parent, actor, text="", chained=child)
        except states.TransitionError:
            pass  # Another reviewer moved it first; retain only the chain.
    workflow.add_event(parent, states.EventKind.CHAINED, actor, data={"child": child.key})


def _claim_debug_records(ticket):
    if ticket.recording_id:
        DebugRecord.objects.using(conf.database()).filter(
            project=ticket.project, recording_id=ticket.recording_id,
            ticket__isnull=True, username=ticket.author_username,
        ).update(ticket=ticket)


def _delete_quietly(mode, name):
    try:
        backend_for(mode).delete(name)
    except Exception:  # noqa: BLE001
        logger.warning("ticketshot: could not delete %s", name)
