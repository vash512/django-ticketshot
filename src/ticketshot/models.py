"""Review ticket models and append-only history."""
import logging

from django.db import models, transaction
from django.db.models.signals import post_delete
from django.dispatch import receiver
from django.utils.crypto import salted_hmac
from django.utils.translation import gettext_lazy as _lazy, gettext as _

from . import conf, states
from .storage import backend_for, get_storage

logger = logging.getLogger(__name__)


def image_upload_to(instance, filename):
    """Build a private ticket image path with a signed ticket grouping."""
    ticket = instance.ticket
    ext = filename.rpartition(".")[2].lower() if "." in filename else "png"
    folder = salted_hmac("ticketshot.folder", str(ticket.pk)).hexdigest()[:16]
    return (f"tickets/{ticket.project}/{ticket.created_at:%Y/%m}/{ticket.pk}-{folder}/"
            f"{instance.position:02d}-{instance.role}.{ext}")


class Counter(models.Model):
    """Last ticket number per project, locked during allocation."""

    project = models.CharField(_lazy("project"), max_length=60, unique=True)
    value = models.PositiveIntegerField(_lazy("last number"), default=0)

    class Meta:
        verbose_name = _lazy("ticket counter")
        verbose_name_plural = _lazy("ticket counters")

    def __str__(self):
        return f"{self.project}: {self.value}"


class Ticket(models.Model):
    Kind = states.Kind
    Status = states.Status
    Device = states.Device
    Source = states.Source
    OPEN = states.OPEN

    project = models.CharField(_lazy("project"), max_length=60, db_index=True)
    number = models.PositiveIntegerField(_lazy("number"))
    kind = models.CharField(_lazy("kind"), max_length=12, choices=Kind.choices, default=Kind.NOTE)
    status = models.CharField(_lazy("status"), max_length=12, choices=Status.choices,
                              default=Status.REQUESTED, db_index=True)
    device = models.CharField(_lazy("device"), max_length=8, choices=Device.choices,
                              default=Device.DESKTOP)
    source = models.CharField(_lazy("source"), max_length=8, choices=Source.choices,
                              default=Source.BAR)
    note = models.TextField(_lazy("note"))
    # A chained ticket may be a new-capture rejection or related change.
    parent = models.ForeignKey(
        "self", verbose_name=_lazy("chained to"), null=True, blank=True,
        on_delete=models.SET_NULL, related_name="children")
    # Draft ID: retries return the same ticket; skill tickets have no ID.
    client_id = models.CharField(_lazy("submission"), max_length=64, null=True, blank=True)
    submission_hash = models.CharField(_lazy("submission hash"), max_length=64, blank=True)

    # Trigger URL and reproducible route template.
    trigger_url = models.TextField(_lazy("Trigger URL"))
    trigger_path = models.CharField(_lazy("trigger path"), max_length=1000, db_index=True)
    page_title = models.CharField(_lazy("page title"), max_length=300, blank=True)
    view_name = models.CharField(_lazy("view"), max_length=200, blank=True, db_index=True)
    route = models.CharField(_lazy("URL pattern"), max_length=300, blank=True)
    route_kwargs = models.JSONField(_lazy("route arguments"), default=dict, blank=True)
    url_template = models.CharField(
        "Reproducible URL", max_length=1000, blank=True,
        help_text=_lazy("Use tags in braces when the URL changes, for example "
                        "/customers/{customer}/detail/."))
    url_tags = models.JSONField(
        "URL tags", default=dict, blank=True,
        help_text=_lazy('Where each tag comes from: {"customer": "a customer with an active account"}.'))
    visited_urls = models.JSONField(_lazy("visited URLs"), default=list, blank=True)

    # Author identity without a foreign key across databases.
    author_username = models.CharField(_lazy("user"), max_length=150, blank=True, db_index=True)
    author_label = models.CharField(_lazy("author"), max_length=200, blank=True)
    author_groups = models.JSONField(_lazy("author groups"), default=list, blank=True)

    # Location and system version of the original capture.
    base_url = models.CharField(_lazy("system"), max_length=300, blank=True)
    app_version = models.CharField(_lazy("version"), max_length=100, blank=True)
    revision = models.JSONField(_lazy("capture commit"), default=dict, blank=True)

    # Implementation commit and team description.
    implemented_commit = models.CharField(_lazy("implementation commit"), max_length=40, blank=True)
    implemented_branch = models.CharField(_lazy("implementation branch"), max_length=200, blank=True)
    implemented_at = models.DateTimeField(_lazy("implemented"), null=True, blank=True)
    implementation_note = models.TextField(_lazy("what was implemented"), blank=True)

    # Technical context.
    server_context = models.JSONField(_lazy("server context"), default=dict, blank=True)
    context_verified = models.BooleanField(_lazy("verified context"), default=False)
    client_context = models.JSONField(_lazy("browser context"), default=dict, blank=True)
    logs = models.JSONField(_lazy("console and network logs"), default=list, blank=True)
    events = models.JSONField(_lazy("recorded events"), default=list, blank=True)
    duration_ms = models.PositiveIntegerField(_lazy("recording duration (ms)"), null=True, blank=True)
    recording_id = models.CharField(_lazy("recording"), max_length=64, blank=True, db_index=True)
    storage_mode = models.CharField(_lazy("storage"), max_length=12, blank=True)

    created_at = models.DateTimeField(_lazy("created"), auto_now_add=True, db_index=True)
    updated_at = models.DateTimeField(_lazy("updated"), auto_now=True)
    closed_at = models.DateTimeField(_lazy("closed"), null=True, blank=True)

    class Meta:
        verbose_name = _lazy("ticket")
        verbose_name_plural = _lazy("tickets")
        ordering = ["-created_at", "-id"]
        constraints = [
            models.UniqueConstraint(fields=["project", "number"],
                                    name="ticketshot_ticket_project_number"),
            # NULL values do not conflict; uniqueness applies only to bar submissions.
            models.UniqueConstraint(fields=["project", "client_id"],
                                    name="ticketshot_ticket_project_client"),
        ]
        permissions = [
            ("approve_ticket", _lazy("Can approve and reject tickets")),
            ("view_debug", _lazy("Can view the debug log")),
        ]

    def __str__(self):
        return f"{self.key} · {self.note[:60]}"

    @property
    def key(self):
        return f"{conf.current().key_prefix}-{self.number}"

    @property
    def is_open(self):
        return states.is_open(self.status)


class TicketImage(models.Model):
    Role = states.ImageRole
    Method = states.ImageMethod

    ticket = models.ForeignKey(Ticket, verbose_name=_lazy("ticket"), on_delete=models.CASCADE,
                               related_name="images")
    position = models.PositiveSmallIntegerField(_lazy("position"), default=0)
    role = models.CharField(_lazy("role"), max_length=8, choices=Role.choices, default=Role.MANUAL)
    method = models.CharField(_lazy("method"), max_length=10, choices=Method.choices, default=Method.DOM)
    device = models.CharField(
        "device", max_length=8, blank=True,
        choices=[(d.value, d.label) for d in states.IMAGE_DEVICES])
    image = models.ImageField(_lazy("image"), upload_to=image_upload_to, storage=get_storage,
                              width_field="width", height_field="height", max_length=300)
    width = models.PositiveIntegerField(_lazy("width"), null=True, blank=True)
    height = models.PositiveIntegerField(_lazy("height"), null=True, blank=True)
    size_bytes = models.PositiveIntegerField(_lazy("size (bytes)"), null=True, blank=True)
    storage_mode = models.CharField(_lazy("storage"), max_length=12)
    edited = models.BooleanField(_lazy("annotated before sending"), default=False)
    redactions = models.PositiveSmallIntegerField(_lazy("redacted areas"), default=0)
    caption = models.CharField(_lazy("image comment"), max_length=500, blank=True)
    page_url = models.TextField(_lazy("capture URL"), blank=True)
    page_title = models.CharField(_lazy("title"), max_length=300, blank=True)
    view_name = models.CharField(_lazy("view"), max_length=200, blank=True)
    captured_at = models.DateTimeField(_lazy("captured"), null=True, blank=True)
    # Milliseconds since recording started, only for recordings.
    offset_ms = models.PositiveIntegerField(_lazy("offset (ms)"), null=True, blank=True)

    class Meta:
        verbose_name = _lazy("ticket image")
        verbose_name_plural = _lazy("ticket images")
        ordering = ["ticket", "position", "id"]

    def __str__(self):
        return f"{self.ticket.key} · {self.position + 1} · {self.get_role_display()}"


class HistoryEditError(RuntimeError):
    """History is append-only."""


class HistoryQuerySet(models.QuerySet):
    """Prevent bulk edits and deletes; ticket cascade deletion is handled separately."""

    def delete(self):
        raise HistoryEditError(_("A ticket's history cannot be deleted (it is removed with the ticket)."))

    def update(self, **kwargs):
        raise HistoryEditError(_("A ticket's history cannot be edited."))


class TicketEvent(models.Model):
    """Append-only ticket history entry; edits and direct deletes fail."""

    Kind = states.EventKind

    ticket = models.ForeignKey(Ticket, verbose_name=_lazy("ticket"), on_delete=models.CASCADE,
                               related_name="history")
    kind = models.CharField(_lazy("kind"), max_length=10, choices=Kind.choices)
    actor_username = models.CharField(_lazy("user"), max_length=150, blank=True)
    actor_label = models.CharField(_lazy("who"), max_length=200, blank=True)
    text = models.TextField(_lazy("text"), blank=True)
    from_status = models.CharField(_lazy("from"), max_length=12, blank=True, choices=states.Status.choices)
    to_status = models.CharField(_lazy("to"), max_length=12, blank=True, choices=states.Status.choices)
    data = models.JSONField(_lazy("data"), default=dict, blank=True)
    created_at = models.DateTimeField("momento", auto_now_add=True, db_index=True)

    objects = HistoryQuerySet.as_manager()

    class Meta:
        verbose_name = _lazy("ticket event")
        verbose_name_plural = _lazy("ticket history")
        ordering = ["ticket", "created_at", "id"]

    def __str__(self):
        return f"{self.ticket.key} · {self.get_kind_display()}"

    def save(self, *args, **kwargs):
        if not self._state.adding:
            raise HistoryEditError(_("A ticket's history cannot be edited."))
        return super().save(*args, **kwargs)

    def delete(self, *args, **kwargs):
        raise HistoryEditError(_("A ticket's history cannot be deleted (it is removed with the ticket)."))


class TicketSeen(models.Model):
    """Last ticket visit by a user; later activity is new."""

    ticket = models.ForeignKey(Ticket, on_delete=models.CASCADE, related_name="seen_by")
    username = models.CharField(max_length=150)
    seen_at = models.DateTimeField()

    class Meta:
        verbose_name = _lazy("ticket view")
        verbose_name_plural = _lazy("ticket views")
        constraints = [
            models.UniqueConstraint(fields=["ticket", "username"],
                                    name="ticketshot_seen_ticket_user"),
        ]


class DebugRecord(models.Model):
    """Server observations during a recorded request."""

    project = models.CharField(_lazy("project"), max_length=60, db_index=True)
    recording_id = models.CharField(_lazy("recording"), max_length=64, db_index=True)
    ticket = models.ForeignKey(Ticket, verbose_name=_lazy("ticket"), null=True, blank=True,
                               on_delete=models.CASCADE, related_name="debug_records")
    request_id = models.CharField(_lazy("request"), max_length=64)
    username = models.CharField(_lazy("user"), max_length=150, blank=True)
    method = models.CharField(_lazy("method"), max_length=10)
    path = models.TextField(_lazy("path"))
    view_name = models.CharField(_lazy("view"), max_length=200, blank=True)
    status_code = models.PositiveSmallIntegerField(_lazy("response"), null=True, blank=True)
    duration_ms = models.FloatField(_lazy("duration (ms)"), default=0)
    failed = models.BooleanField(_lazy("had exception"), default=False)
    data = models.JSONField(_lazy("data"), default=dict)
    size_bytes = models.PositiveIntegerField(_lazy("size (bytes)"), default=0)
    created_at = models.DateTimeField("momento", auto_now_add=True, db_index=True)

    class Meta:
        verbose_name = _lazy("debug record")
        verbose_name_plural = _lazy("debug records")
        ordering = ["created_at", "id"]

    def __str__(self):
        return f"{self.method} {self.path} ({self.status_code})"


def delete_file_later(mode, name):
    """Delete an image file only after its transaction commits."""
    def _delete():
        try:
            backend_for(mode).delete(name)
        except Exception:  # noqa: BLE001 - failed cleanup must not block deletion
            logger.warning("ticketshot: could not delete file %s", name)

    transaction.on_commit(_delete, using=conf.database())


@receiver(post_delete, sender=TicketImage)
def delete_image_file(sender, instance, **kwargs):
    """Deleting a ticket or image also deletes its file."""
    if instance.image.name:
        delete_file_later(instance.storage_mode, instance.image.name)
