"""Ticket vocabulary and pure state transition rules."""
from django.core.exceptions import ValidationError
from django.db import models
from django.utils.translation import gettext as _, gettext_lazy as _lazy


class Status(models.TextChoices):
    REQUESTED = "requested", _lazy("Change requested")
    IN_PROGRESS = "in_progress", _lazy("In progress")
    IN_REVIEW = "in_review", _lazy("In review")
    APPROVED = "approved", _lazy("Approved")
    DISCARDED = "discarded", _lazy("Discarded")


class Kind(models.TextChoices):
    NOTE = "note", _lazy("Annotated capture")
    RECORDING = "recording", _lazy("Recorded flow")


class Device(models.TextChoices):
    DESKTOP = "desktop", _lazy("Desktop")
    MOBILE = "mobile", _lazy("Mobile")
    BOTH = "both", _lazy("Desktop and mobile")


class Source(models.TextChoices):
    BAR = "bar", _lazy("Bar")
    SKILL = "skill", _lazy("Skill (unsolicited change)")


class ImageRole(models.TextChoices):
    MANUAL = "manual", _lazy("Capture")
    START = "start", _lazy("Recording start")
    STEP = "step", _lazy("Recording step")
    END = "end", _lazy("Recording end")


class ImageMethod(models.TextChoices):
    DOM = "dom", _lazy("Reconstructed from the page")
    DISPLAY = "display", _lazy("Exact browser capture")
    AUTOMATED = "automated", _lazy("Automated browser (skill)")


class EventKind(models.TextChoices):
    CREATED = "created", _lazy("Created")
    COMMENT = "comment", _lazy("Add comment")
    STATUS = "status", _lazy("Status change")
    REJECTED = "rejected", _lazy("Still not working")
    APPROVED = "approved", _lazy("Approved")
    CHAINED = "chained", _lazy("Chained ticket")
    COMMIT = "commit", _lazy("Linked commit")
    TEMPLATE = "template", _lazy("Reproducible URL")


class Action(models.TextChoices):
    """Actions on an existing ticket."""

    COMMENT = "comment", _lazy("Comment")
    MOVE = "status", _lazy("Move status")
    APPROVE = "approve", _lazy("Approve")
    REJECT = "reject", _lazy("Still not working")
    TEMPLATE = "template", _lazy("Edit the reproducible URL")


# Images belong to one device; tickets may cover both.
IMAGE_DEVICES = (Device.DESKTOP, Device.MOBILE)
OPEN = (Status.REQUESTED, Status.IN_PROGRESS, Status.IN_REVIEW)
CLOSED = (Status.APPROVED, Status.DISCARDED)
BOARD_COLUMNS = (
    (Status.REQUESTED, _lazy("Request")),
    (Status.IN_PROGRESS, _lazy("In progress")),
    (Status.IN_REVIEW, _lazy("In review")),
    (Status.APPROVED, _lazy("Approved tickets")),
    (Status.DISCARDED, _lazy("Closed")),
)
# Panel order puts decisions first.
REVIEW_ORDER = (Status.IN_REVIEW, Status.REQUESTED, Status.IN_PROGRESS,
                Status.APPROVED, Status.DISCARDED)
# Skill tickets start in progress because a branch already has the change.
SKILL_START = (Status.IN_PROGRESS, Status.REQUESTED)

# Statuses the team may set manually.
TEAM_MOVES = {
    Status.REQUESTED: (Status.IN_PROGRESS, Status.IN_REVIEW, Status.DISCARDED),
    Status.IN_PROGRESS: (Status.REQUESTED, Status.IN_REVIEW, Status.DISCARDED),
    Status.IN_REVIEW: (Status.IN_PROGRESS, Status.DISCARDED),
}

# Permission flag required for each action.
PERMISSION = {
    Action.COMMENT: "comment",
    Action.MOVE: "work",
    Action.TEMPLATE: "work",
    Action.APPROVE: "approve",
    Action.REJECT: "approve",
}

# History event produced by each status transition.
EVENT = {
    Action.MOVE: EventKind.STATUS,
    Action.APPROVE: EventKind.APPROVED,
    Action.REJECT: EventKind.REJECTED,
}


class TransitionError(ValidationError):
    """The current status does not allow this transition."""


def is_open(status):
    return status in OPEN


def is_closed(status):
    return status in CLOSED


def team_targets(status):
    """Ordered manual destinations from a given status."""
    allowed = TEAM_MOVES.get(status, ())
    return tuple(s for s in REVIEW_ORDER if s in allowed)


def next_status(current, action, to=""):
    """Return the status after an action or raise TransitionError."""
    current = Status(current)
    if action == Action.MOVE:
        if to not in Status.values:
            raise TransitionError(_("Unknown status."))
        if to not in TEAM_MOVES.get(current, ()):
            raise TransitionError(
                _("A ticket in “%(current)s” cannot move to “%(target)s”.") %
                {"current": current.label, "target": Status(to).label})
        return Status(to)
    if action in (Action.APPROVE, Action.REJECT):
        if current != Status.IN_REVIEW:
            if action == Action.APPROVE:
                raise TransitionError(_("Only a ticket in “In review” can be approved."))
            raise TransitionError(_("Only a ticket in “In review” can be rejected."))
        return Status.APPROVED if action == Action.APPROVE else Status.REQUESTED
    raise TransitionError(_("That action does not change the status."))


def after_commit(current):
    """Move a ticket into review when its implementation commit arrives."""
    if current in (Status.REQUESTED, Status.IN_PROGRESS):
        return Status.IN_REVIEW
    return Status(current)
