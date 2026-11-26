"""Readable recording events for admin and panel."""
from django.utils.translation import gettext as _

EVENT_LABELS = {
    "start": "Recording start",
    "stop": "Recording end",
    "page": "Page load",
    "nav": "Navigation",
    "click": "Click",
    "input": "Input",
    "change": "Value change",
    "submit": "Form submission",
    "key": "Key",
    "scroll": "Scroll",
    "resize": "Resize",
    "dialog": "Page dialog",
    "native": "Browser dialog",
    "open": "New window",
    "leave": "Left the page",
    "visibility": "Tab visibility",
    "console": "Console",
    "network": "Network",
    "error": "JavaScript error",
    "capture": "Capture",
    "print": "Print",
    "limit": "Limit reached",
}

_DETAIL_KEYS = ("label", "target", "message", "url", "status", "result", "value", "y", "size")


def clock(ms):
    if isinstance(ms, bool) or not isinstance(ms, (int, float)):
        return ""
    seconds = ms / 1000
    return f"{int(seconds // 60):02d}:{seconds % 60:04.1f}"


def detail(event):
    parts = [f"{key}: {event[key]}" for key in _DETAIL_KEYS if event.get(key) not in (None, "")]
    server = event.get("server")
    if isinstance(server, dict) and server.get("view"):
        parts.append(f"{_('view')}: {server['view']}")
    return " · ".join(parts)[:400]


def rows(events):
    return [{
        "at": clock(event.get("t")),
        "label": _(EVENT_LABELS[event["type"]]) if event.get("type") in EVENT_LABELS else event.get("type"),
        "detail": detail(event),
        "tab": str(event.get("tab") or "")[:4],
    } for event in events or [] if isinstance(event, dict)]
