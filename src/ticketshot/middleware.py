"""Inject the review bar before closing body and log recordings."""
import contextlib
import logging
import re

from django.middleware.csrf import get_token
from django.template.loader import render_to_string
from django.urls import NoReverseMatch, reverse
from django.utils.cache import patch_cache_control
from django.utils.translation import override

from . import __version__, assets, conf, debuglog, pagecontext, permissions, users

logger = logging.getLogger(__name__)

_BODY_END = re.compile(rb"</body\s*>", re.IGNORECASE)


def _url(name, *args):
    try:
        return reverse(name, args=args)
    except NoReverseMatch:
        return ""


def _own_prefix():
    """Return the URL prefix used to include ticketshot.urls."""
    create = _url("ticketshot:ticket_create")
    return create.rsplit("tickets/", 1)[0] if create else None


def skip_path(path):
    own = _own_prefix()
    if own and path.startswith(own):
        return True
    return any(path.startswith(p) for p in conf.current().exclude_paths)


def injectable(response):
    """Accept only complete uncompressed HTML, not downloads or empty responses."""
    return not (
        response.streaming
        or response.status_code in (204, 304) or response.status_code < 200
        or not response.get("Content-Type", "").lower().startswith("text/html")
        or response.get("Content-Encoding")
        or response.get("Content-Disposition", "").lower().startswith("attachment")
    )


def _template_url(name):
    """Return a URL template whose key is filled in by the browser."""
    return _url(name, "KEY").replace("KEY", "{key}")


def client_config(request, page_token):
    """Return public configuration needed by the bar."""
    config = conf.current()
    return {
        "version": __version__,
        "language": conf.language(),
        "project": config.project,
        "keyPrefix": config.key_prefix,
        "endpoints": {
            "create": _url("ticketshot:ticket_create"),
            "open": _url("ticketshot:tickets_open"),
            "action": _template_url("ticketshot:ticket_action"),
            "panel": _url("ticketshot:panel"),
            "detail": _template_url("ticketshot:panel_detail"),
        },
        "csrf": get_token(request),
        "pageToken": page_token,
        "assets": {"css": assets.url(assets.BAR_CSS), "capture": assets.url(assets.CAPTURE_LIB)},
        "limits": {
            "maxImages": config.max_images,
            "recordingSteps": config.recording_max_steps,
            "recordingMinutes": config.recording_max_minutes,
            "recordingEvents": config.recording_max_events,
            "noteLength": config.max_note_length,
        },
        "deviceBreakpoint": config.device_breakpoint,
        "recordingCookie": debuglog.COOKIE if config.debug_record else "",
        "mask": {"selectors": list(config.mask_selectors), "patterns": list(config.mask_patterns)},
        "dialogSelectors": list(config.dialog_selectors),
        "position": config.position,
        "user": users.label(request.user),
        "can": permissions.flags(request.user),
    }


def inject(request, response, tracker):
    content = response.content
    ends = list(_BODY_END.finditer(content))
    if not ends:
        return
    page = pagecontext.build(request, response, tracker)
    snippet = render_to_string("ticketshot/snippet.html", {
        "config": client_config(request, pagecontext.sign(page)),
        "script": assets.url(assets.BAR_ENTRY),
    })
    position = ends[-1].start()
    charset = response.charset
    response.content = content[:position] + snippet.encode(charset) + content[position:]
    if response.has_header("Content-Length"):
        response["Content-Length"] = str(len(response.content))
    # The user-specific page and token must never enter a shared cache.
    patch_cache_control(response, private=True)


def _record(collector, request, response, duration_ms):
    try:
        debuglog.save(collector, response, getattr(request.user, "get_username", lambda: "")(),
                      duration_ms)
    except Exception:  # noqa: BLE001 - logging must not break the page
        logger.exception("ticketshot: could not save the debug record")


class TicketShotMiddleware:
    def __init__(self, get_response):
        self.get_response = get_response

    def _collector(self, request):
        recording = debuglog.recording_id(request) if conf.current().debug_record else None
        return debuglog.Collector(request, recording) if recording else None

    def __call__(self, request):
        with override(conf.language()):
            return self._respond(request)

    def _respond(self, request):
        if not conf.current().enabled or skip_path(request.path_info):
            return self.get_response(request)
        if not permissions.show_bar(request):
            return self.get_response(request)
        collector = self._collector(request)
        request._ticketshot_collector = collector
        listener = collector.on_query if collector is not None else None
        with pagecontext.Tracker(listener) as tracker, (collector or contextlib.nullcontext()):
            response = self.get_response(request)
        if collector is not None:
            _record(collector, request, response, tracker.elapsed_ms)
        if injectable(response):
            inject(request, response, tracker)
        return response

    def process_exception(self, request, exception):
        collector = getattr(request, "_ticketshot_collector", None)
        if collector is not None:
            collector.exception_raised(type(exception), exception, exception.__traceback__)
        return None
