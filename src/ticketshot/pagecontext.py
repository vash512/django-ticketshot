"""Server context for each rendered page: view, user, and timing."""
import contextvars
import json
import platform
import time
from urllib.parse import parse_qsl, urlsplit

import django
from django.conf import settings
from django.core import signing
from django.db import connections
from django.utils import timezone

from . import __version__, anonymize, conf, revision, users

SALT = "ticketshot.page"
MAX_TEMPLATES = 40
MAX_EXTRA_BYTES = 4096

# Templates rendered in this request; None means tracking is off.
_templates = contextvars.ContextVar("ticketshot_templates", default=None)
# Additional template listeners, including debug recording.
_listeners = []


def names_only(url):
    """Keep route and parameter names without values."""
    text = str(url or "")
    try:
        parts = urlsplit(text)
    except ValueError:
        return text.partition("#")[0].partition("?")[0]
    names = dict.fromkeys(name for name, _ in parse_qsl(parts.query, keep_blank_values=True))
    query = "&".join(f"{name}=…" for name in names)
    head = (f"{parts.scheme}:" if parts.scheme else "") + (f"//{parts.netloc}" if parts.netloc else "")
    return head + parts.path + (f"?{query}" if query else "")


# templates

def on_template(listener):
    """Register a listener for each rendered template."""
    if listener not in _listeners:
        _listeners.append(listener)


def _note_template(template, context):
    name = getattr(getattr(template, "origin", None), "template_name", None) \
        or getattr(template, "name", None)
    if not name:
        return
    names = _templates.get()
    if names is not None and len(names) < MAX_TEMPLATES and name not in names:
        names.append(str(name))
    for listener in _listeners:
        listener(str(name), context)


def install_template_tracking():
    """Track rendered templates once, outside ticketshot views."""
    from django.template.base import Template

    if getattr(Template._render, "_ticketshot", False):
        return
    original = Template._render

    def _render(self, context):
        _note_template(self, context)
        return original(self, context)

    _render._ticketshot = True
    Template._render = _render


class QueryTimer:
    """Wrap database connections to count and time queries."""

    def __init__(self, on_query):
        self.on_query = on_query
        self._wrappers = []

    def _wrapper(self, execute, sql, params, many, context):
        started = time.perf_counter()
        error = None
        try:
            return execute(sql, params, many, context)
        except Exception as exc:
            error = exc
            raise
        finally:
            self.on_query(context["connection"].alias, sql, params, many,
                          (time.perf_counter() - started) * 1000, error)

    def __enter__(self):
        for connection in connections.all():
            wrapper = connection.execute_wrapper(self._wrapper)
            wrapper.__enter__()
            self._wrappers.append(wrapper)
        return self

    def __exit__(self, *exc):
        for wrapper in reversed(self._wrappers):
            wrapper.__exit__(*exc)
        return False


class Tracker:
    """Measure request time, queries, and templates."""

    def __init__(self, listener=None):
        self.started = time.perf_counter()
        self.elapsed_ms = 0.0
        self.queries = 0
        self.query_ms = 0.0
        self.templates = []
        self._token = None
        self._listener = listener
        self._timer = QueryTimer(self._on_query)

    def _on_query(self, alias, sql, params, many, ms, error):
        self.queries += 1
        self.query_ms += ms
        if self._listener is not None:
            self._listener(alias, sql, params, many, ms, error)

    def __enter__(self):
        # Reinstall for each request; other code may have replaced
        # Template._render.
        install_template_tracking()
        if conf.current().track_templates:
            self._token = _templates.set(self.templates)
        self._timer.__enter__()
        return self

    def __exit__(self, *exc):
        self._timer.__exit__(*exc)
        if self._token is not None:
            _templates.reset(self._token)
        self.elapsed_ms = (time.perf_counter() - self.started) * 1000
        return False


# context

_MATCH_NAMES = {"name": "view_name", "url_name": "url_name", "namespace": "namespace",
                "app_name": "app_name", "route": "route"}


def _func_path(func):
    """Return the view's module and class name."""
    target = getattr(func, "view_class", None) or func
    qualname = getattr(target, "__qualname__", getattr(target, "__name__", ""))
    return f"{getattr(target, '__module__', '')}.{qualname}".strip(".")


def view_info(request, show=str):
    """Describe the view handling the request."""
    match = getattr(request, "resolver_match", None)
    if match is None:
        return {}
    info = {key: getattr(match, attr, "") or "" for key, attr in _MATCH_NAMES.items()}
    info.update({
        "func": _func_path(match.func),
        "args": [show(a) for a in match.args][:10],
        "kwargs": {str(k): show(v) for k, v in match.kwargs.items()},
    })
    return info


def _request_info(request):
    post_keys = []
    if request.method == "POST":
        post_keys = sorted(k for k in request.POST.keys() if k != "csrfmiddlewaretoken")[:50]
    return {
        "method": request.method,
        "path": anonymize.url(request.path),
        "full_path": anonymize.url(request.get_full_path()),
        "host": request.get_host(),
        "secure": request.is_secure(),
        # Previous-page query values are unnecessary for navigation.
        "referer": names_only(anonymize.url(request.headers.get("Referer", "")))[:500],
        "user_agent": request.headers.get("User-Agent", "")[:300],
        "language": getattr(request, "LANGUAGE_CODE", "") or "",
        "get_keys": [anonymize.value(key) for key in sorted(request.GET.keys())[:50]],
        "post_keys": post_keys,
        # Send session key names to the page, never their values.
        "session_keys": sorted(request.session.keys())[:50] if hasattr(request, "session") else [],
    }


def _response_info(response, tracker):
    templates = list(tracker.templates)
    template_name = getattr(response, "template_name", None)
    if template_name and not templates:
        templates = [template_name] if isinstance(template_name, str) else [str(t) for t in template_name]
    return {
        "status": response.status_code,
        "content_type": response.get("Content-Type", ""),
        "templates": templates,
    }


def _app_info():
    return {
        "version": revision.app_version(),
        "revision": revision.revision(),
        "debug": bool(settings.DEBUG),
        "django": django.get_version(),
        "python": platform.python_version(),
        "ticketshot": __version__,
        "project": conf.current().project,
    }


def _extra(request, response):
    """Get bounded project-specific JSON context or an error."""
    extra = conf.current().context_extra
    if not extra:
        return None
    try:
        value = extra(request, response) or {}
        if not isinstance(value, dict):
            raise TypeError("CONTEXT_EXTRA must return a dict")
        if len(json.dumps(value, ensure_ascii=False).encode("utf-8")) > MAX_EXTRA_BYTES:
            raise ValueError(f"CONTEXT_EXTRA exceeds {MAX_EXTRA_BYTES} bytes")
        return value
    except Exception as exc:  # noqa: BLE001 - extra context must not break the page
        return {"error": f"{type(exc).__name__}: {exc}"[:300]}


def build(request, response, tracker):
    """Return server context as rendered for the page."""
    context = {
        "v": 1,
        "at": timezone.now().isoformat(),
        "request": _request_info(request),
        "view": view_info(request, show=anonymize.value),
        "response": _response_info(response, tracker),
        "timing": {
            "total_ms": round(tracker.elapsed_ms, 1),
            "queries": tracker.queries,
            "query_ms": round(tracker.query_ms, 1),
        },
        "user": users.summary(getattr(request, "user", None)),
        "app": _app_info(),
    }
    extra = _extra(request, response)
    if extra is not None:
        context["extra"] = extra
    return context


def sign(context):
    return signing.dumps(context, salt=SALT, compress=True)


def unsign(token):
    """Return context and verification status; bad or expired tokens are harmless."""
    if not token or not isinstance(token, str):
        return {}, False
    try:
        return signing.loads(token, salt=SALT, max_age=conf.current().page_token_max_age), True
    except signing.BadSignature:
        return {}, False


def summary(context):
    """Return the minimum context shown beside an image or event."""
    view = context.get("view", {})
    timing = context.get("timing", {})
    return {
        "view": view.get("name", ""),
        "route": view.get("route", ""),
        "status": context.get("response", {}).get("status"),
        "total_ms": timing.get("total_ms"),
        "queries": timing.get("queries"),
    }
