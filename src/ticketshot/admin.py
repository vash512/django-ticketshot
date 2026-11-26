"""Read-only backup admin. Daily review happens in the panel.

Only show tickets for the configured project, even on a shared database.
"""
import json

from django.contrib import admin
from django.urls import reverse
from django.utils.html import format_html, format_html_join
from django.utils.translation import gettext as _, gettext_lazy as _lazy

from . import conf, permissions, timeline
from .models import DebugRecord, Ticket, TicketEvent, TicketImage


def _pretty(value):
    return format_html("<pre style='white-space:pre-wrap;max-height:28rem;overflow:auto;margin:0'>{}</pre>",
                       json.dumps(value, ensure_ascii=False, indent=2, default=str))


class PolicyView:
    """The configured permissions class controls admin access."""

    def has_view_permission(self, request, obj=None):
        return permissions.can_view(request.user)

    def has_module_permission(self, request):
        return permissions.can_view(request.user)


class ReadOnlyInline(PolicyView, admin.TabularInline):
    """Read-only ticket rows; the parent admin disables edits."""

    extra = 0


class TicketImageInline(ReadOnlyInline):
    model = TicketImage
    fields = ("preview", "position", "role", "device", "method", "edited",
              "redactions", "view_name", "page_url", "dimensions")
    readonly_fields = fields

    @admin.display(description="image")
    def preview(self, obj):
        if not obj.pk:
            return ""
        url = reverse("ticketshot:image", args=[obj.pk])
        return format_html(
            '<a href="{0}" target="_blank" rel="noopener">'
            '<img src="{0}" alt="{2}" loading="lazy" '
            'style="max-width:220px;max-height:160px;border:1px solid #ccc"></a>',
            url, obj.position + 1, _("Image %(number)s") % {"number": obj.position + 1})

    @admin.display(description=_lazy("size"))
    def dimensions(self, obj):
        kb = obj.size_bytes // 1024 if obj.size_bytes else 0
        return f"{obj.width}×{obj.height} · {kb} KB"


class TicketEventInline(ReadOnlyInline):
    """History is append-only and read-only here."""

    model = TicketEvent
    fields = ("created_at", "kind", "actor_label", "from_status", "to_status", "text")
    readonly_fields = fields


class ProjectAdmin(PolicyView, admin.ModelAdmin):
    """Read-only access to the configured project's tickets."""

    def has_delete_permission(self, request, obj=None):
        # Deletion is cleanup: require view and work access. Django checks only
        # this permission before opening the delete view.
        return (self.has_view_permission(request, obj) and permissions.can_work(request.user)
                and super().has_delete_permission(request, obj))

    def get_queryset(self, request):
        return super().get_queryset(request).using(conf.database()).filter(
            project=conf.current().project)

    def has_add_permission(self, request):
        # Tickets are created through the bar or skill, with their context.
        return False

    def has_change_permission(self, request, obj=None):
        # Status changes happen in the panel, which records history.
        return False


@admin.register(Ticket)
class TicketAdmin(ProjectAdmin):
    list_display = ("key_display", "status", "kind", "device", "short_note",
                    "author_label", "trigger_path", "created_at")
    list_filter = ("status", "kind", "device", "source")
    search_fields = ("note", "trigger_path", "view_name", "author_label")
    date_hierarchy = "created_at"
    inlines = [TicketImageInline, TicketEventInline]
    fieldsets = (
        (None, {"fields": ("project", "status", "note_display", "kind", "device",
                           "source", "author_label", "created_at", "panel_link")}),
        ("The view", {"fields": ("trigger_url", "page_title", "view_name", "route",
                                 "url_template", "url_tags", "visited_urls", "context_verified")}),
        ("Implementation", {"fields": ("implemented_commit", "implemented_branch",
                                       "implementation_note")}),
        (_lazy("Recording"), {"fields": ("duration_display", "timeline_display"), "classes": ("collapse",)}),
        ("Technical data", {"fields": ("server_display", "client_display", "logs_display",
                                       "storage_mode"), "classes": ("collapse",)}),
    )
    readonly_fields = tuple(name for _, section in fieldsets for name in section["fields"])

    @admin.display(description=_lazy("key"), ordering="number")
    def key_display(self, obj):
        return obj.key

    @admin.display(description="note")
    def short_note(self, obj):
        return obj.note if len(obj.note) <= 80 else obj.note[:79] + "…"

    @admin.display(description="note")
    def note_display(self, obj):
        return format_html("<div style='white-space:pre-wrap'>{}</div>", obj.note)

    @admin.display(description="panel")
    def panel_link(self, obj):
        return format_html('<a href="{}">{}</a>',
                           reverse("ticketshot:panel_detail", args=[obj.key]), _("Open in panel"))

    @admin.display(description=_lazy("duration"))
    def duration_display(self, obj):
        return timeline.clock(obj.duration_ms) if obj.duration_ms is not None else "—"

    @admin.display(description=_lazy("events"))
    def timeline_display(self, obj):
        rows = timeline.rows(obj.events)
        if not rows:
            return "—"
        body = format_html_join("", "<tr><td>{}</td><td>{}</td><td>{}</td><td>{}</td></tr>",
                                ((r["at"], r["label"], r["detail"], r["tab"]) for r in rows))
        return format_html(
            "<table style='font-size:12px'><thead><tr><th>{}</th><th>{}</th>"
            "<th>{}</th><th>{}</th></tr></thead><tbody>{}</tbody></table>",
            _("Time"), _("Event"), _("Detail"), _("Tab"), body)

    @admin.display(description="server context")
    def server_display(self, obj):
        return _pretty(obj.server_context)

    @admin.display(description="browser context")
    def client_display(self, obj):
        return _pretty(obj.client_context)

    @admin.display(description=_lazy("logs"))
    def logs_display(self, obj):
        return _pretty(obj.logs) if obj.logs else "—"


@admin.register(DebugRecord)
class DebugRecordAdmin(ProjectAdmin):
    list_display = ("created_at", "ticket", "method", "path", "status_code", "duration_ms", "failed")
    list_filter = ("failed", "method")
    search_fields = ("path", "view_name", "recording_id")
    readonly_fields = ("project", "recording_id", "ticket", "request_id", "username",
                       "method", "path", "view_name", "status_code", "duration_ms",
                       "failed", "data_display", "size_bytes", "created_at")
    exclude = ("data",)

    def has_view_permission(self, request, obj=None):
        return permissions.can_debug(request.user)

    def has_module_permission(self, request):
        return permissions.can_debug(request.user)

    @admin.display(description="data")
    def data_display(self, obj):
        return _pretty(obj.data)
