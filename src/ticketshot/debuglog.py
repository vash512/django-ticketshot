"""Server-side debug records for recorded review journeys."""
import contextvars
import json
import re
import uuid

from django.db.models.signals import post_delete, post_save
from django.views.debug import ExceptionReporter, SafeExceptionReporterFilter
from django.utils.translation import gettext as _

from . import conf, pagecontext
from .pagecontext import names_only
from .routers import APP_LABEL

COOKIE = "ticketshot_rec"
VALID_ID = re.compile(r"[A-Za-z0-9-]{8,64}")
MASK = SafeExceptionReporterFilter.cleansed_substitute
MAX_REPR = 300
MAX_SQL = 2000
MAX_CONTEXT_KEYS = 60
MAX_TEMPLATES = 8
MAX_WRITES = 200
NOISY_CONTEXT = {
    "request", "perms", "csrf_token", "messages", "DEFAULT_MESSAGE_LEVELS",
    "True", "False", "None", "block", "forloop", "view",
}
HIDDEN_SESSION = re.compile(r"hash|token|secret|key|pass|otp|code", re.I)
WRITE_VERBS = ("INSERT", "UPDATE", "DELETE")

_current = contextvars.ContextVar("ticketshot_debug", default=None)


def recording_id(request):
    """Return the active recording ID from a valid cookie, or None."""
    value = request.COOKIES.get(COOKIE, "")
    return value if VALID_ID.fullmatch(value or "") else None


def short(value, limit=MAX_REPR):
    try:
        text = repr(value)
    except Exception as exc:  # noqa: BLE001 - broken repr must not break logging
        text = f"<repr failed: {type(exc).__name__}>"
    return text if len(text) <= limit else text[: limit - 1] + "…"


# sanitization

def _filter():
    return SafeExceptionReporterFilter()


def shown(key, value, limit=MAX_REPR):
    """Return a masked value for sensitive keys, otherwise its repr."""
    cleansed = _filter().cleanse_setting(key, value)
    return MASK if cleansed == MASK else short(cleansed, limit)


def clean_pairs(pairs, limit=MAX_REPR):
    """Map headers to values, masking values for sensitive names."""
    return {key: [shown(key, v, limit) for v in values][:20] for key, values in pairs}


_EXTENSION = re.compile(r"[A-Za-z0-9]{1,8}")


def _extension_only(filename):
    """Keep only a safe uploaded file extension; filenames may identify people."""
    name = str(filename or "")
    suffix = name.rpartition(".")[2] if "." in name else ""
    return f"….{suffix.lower()}" if _EXTENSION.fullmatch(suffix) else "…"


def clean_get(request):
    keys = list(request.GET.keys())[:60]
    return clean_pairs((k, request.GET.getlist(k)) for k in keys)


def clean_post(request):
    if request.method != "POST":
        return {}
    try:
        cleaned = _filter().get_post_parameters(request)
        keys = [k for k in cleaned if k != "csrfmiddlewaretoken"]
        return clean_pairs((k, cleaned.getlist(k) if hasattr(cleaned, "getlist") else [cleaned[k]])
                           for k in keys)
    except Exception:  # noqa: BLE001 - malformed bodies must not break logging
        return {"error": _("Could not read the request body.")}


def clean_session(request):
    if not hasattr(request, "session"):
        return {}
    try:
        return {key: MASK if HIDDEN_SESSION.search(key) else shown(key, value)
                for key, value in list(request.session.items())[:60]}
    except Exception:  # noqa: BLE001
        return {"error": _("Could not read the session.")}


def clean_query(alias, sql, params, many, ms, error):
    """Format a query for logs without params when SQL mentions sensitive data."""
    sql = str(sql)
    sensitive = bool(_filter().hidden_settings.search(sql))
    entry = {
        "db": alias,
        "sql": sql[:MAX_SQL],
        "params": MASK if sensitive else short(params, 600),
        "many": bool(many),
        "ms": round(ms, 2),
    }
    if error is not None:
        entry["error"] = MASK if sensitive else f"{type(error).__name__}: {error}"[:300]
    return entry


def clean_context(context):
    """Mask and truncate template variables by name."""
    try:
        flat = context.flatten()
    except Exception:  # noqa: BLE001
        return {}
    variables = {}
    for key in list(flat)[:200]:
        if not isinstance(key, str) or key in NOISY_CONTEXT or key.startswith("_"):
            continue
        if len(variables) >= MAX_CONTEXT_KEYS:
            break
        variables[key] = shown(key, flat[key])
    return variables


# truncation

def size_of(data):
    return len(json.dumps(data, ensure_ascii=False, default=str).encode("utf-8"))


def _halve_queries(data, limit):
    queries = data["sql"]["queries"]
    while len(queries) > 1 and size_of(data) > limit:
        del queries[len(queries) // 2:]
        data["sql"]["truncated"] = True


def _drop_template_context(data, limit):
    data["templates"] = [{"name": t["name"], "context": {}} for t in data["templates"]]


def _shorten_exception(data, limit):
    if data["exception"]:
        data["exception"] = data["exception"][:max(1000, limit // 3)] + "\n…(recortado)"


def _drop_queries(data, limit):
    data["sql"].update(queries=[], truncated=True)


def _drop_state(data, limit):
    data.update(writes=[], session={"truncated": True})


def _drop_parameters(data, limit):
    data["request"].update(get={}, post={"truncated": True}, files=[])


# Trim least important fields first.
_CUTS = (_halve_queries, _drop_template_context, _shorten_exception,
         _drop_queries, _drop_state, _drop_parameters)


def fit(data, limit):
    """Trim heavy fields to fit the byte limit, leaving a summary if needed."""
    for cut in _CUTS:
        if size_of(data) <= limit:
            return data
        cut(data, limit)
    if size_of(data) <= limit:
        return data
    return _summary(data.get("exception", ""), limit)


def _summary(exception, limit):
    """Trim the exception last to fit the remaining bytes."""
    summary = {"truncated": True, "exception": exception}
    while summary["exception"] and size_of(summary) > limit:
        summary["exception"] = summary["exception"][: len(summary["exception"]) // 2]
    return summary


# collector

class Collector:
    """Collect request activity while recording is active."""

    def __init__(self, request, recording):
        self.request = request
        self.recording = recording
        self.request_id = uuid.uuid4().hex
        self.queries = []
        self.query_count = 0
        self.writes = []
        self.templates = []
        self.exception = ""
        self._token = None
        own = conf.database()
        # Ticketshot writes to its own database are not part of the reviewed flow.
        self._skip_alias = own if own != "default" else None

    def on_query(self, alias, sql, params, many, ms, error):
        if alias == self._skip_alias:
            return
        self.query_count += 1
        if len(self.queries) < conf.current().debug_record_max_queries:
            self.queries.append(clean_query(alias, sql, params, many, ms, error))

    def __enter__(self):
        self._token = _current.set(self)
        return self

    def __exit__(self, *exc):
        _current.reset(self._token)
        return False

    def model_written(self, sender, instance, action):
        if sender._meta.app_label == APP_LABEL or len(self.writes) >= MAX_WRITES:
            return
        # Avoid repr and str: model text can contain email addresses
        # or tokens that name-based filters miss.
        self.writes.append({
            "model": sender._meta.label,
            "pk": short(getattr(instance, "pk", None), 80),
            "action": action,
        })

    def template_rendered(self, name, context):
        if len(self.templates) < MAX_TEMPLATES:
            self.templates.append({"name": name, "context": clean_context(context)})

    def exception_raised(self, exc_type, exc_value, tb):
        try:
            self.exception = ExceptionReporter(self.request, exc_type, exc_value, tb).get_traceback_text()
        except Exception as error:  # noqa: BLE001
            self.exception = f"{exc_type.__name__}: {exc_value} ({_('without traceback')}: {error})"

    def _request_data(self):
        request = self.request
        return {
            "method": request.method,
            "path": names_only(request.get_full_path())[:2000],
            "get": clean_get(request),
            "post": clean_post(request),
            "files": [{"field": name, "name": _extension_only(f.name), "size": f.size,
                       "content_type": getattr(f, "content_type", "")}
                      for name, f in list(request.FILES.items())[:20]],
            "content_type": request.headers.get("Content-Type", "")[:200],
            "referer": names_only(request.headers.get("Referer", ""))[:500],
        }

    def _sql_data(self):
        writes = sum(1 for q in self.queries
                     if q["sql"].lstrip().split(" ", 1)[0].upper() in WRITE_VERBS)
        return {"count": self.query_count, "writes": writes,
                "ms": round(sum(q["ms"] for q in self.queries), 1), "queries": self.queries}

    def payload(self, response):
        view = pagecontext.view_info(self.request, show=lambda v: short(v, 120))
        data = {
            "request": self._request_data(),
            "session": clean_session(self.request),
            "view": view,
            "templates": self.templates,
            "writes": self.writes,
            "sql": self._sql_data(),
            "response": {
                "status": getattr(response, "status_code", None),
                "content_type": response.get("Content-Type", "") if response is not None else "",
                "location": names_only(response.get("Location", "")) if response is not None else "",
            },
            "exception": self.exception,
        }
        return fit(data, conf.current().debug_record_max_bytes)


def current():
    return _current.get()


def save(collector, response, username, duration_ms):
    """Save the request record in the ticket database."""
    from .models import DebugRecord

    alias = conf.database()
    config = conf.current()
    # Approximate limit: concurrent requests may exceed it by one.
    count = DebugRecord.objects.using(alias).filter(
        project=config.project, recording_id=collector.recording).count()
    if count >= config.debug_record_max_requests:
        return None
    data = collector.payload(response)
    match = getattr(collector.request, "resolver_match", None)
    return DebugRecord.objects.using(alias).create(
        project=config.project,
        recording_id=collector.recording,
        request_id=collector.request_id,
        username=username[:150],
        method=collector.request.method[:10],
        path=names_only(collector.request.get_full_path())[:2000],
        view_name=(match.view_name if match else "")[:200],
        status_code=getattr(response, "status_code", None),
        duration_ms=round(duration_ms, 1),
        failed=bool(collector.exception),
        data=data,
        size_bytes=size_of(data),
    )


# receivers

def _on_save(sender, instance, created, **kwargs):
    collector = _current.get()
    if collector is not None:
        collector.model_written(sender, instance, "alta" if created else "cambio")


def _on_delete(sender, instance, **kwargs):
    collector = _current.get()
    if collector is not None:
        collector.model_written(sender, instance, "borrado")


def _on_template(name, context):
    collector = _current.get()
    if collector is not None:
        collector.template_rendered(name, context)


def install_signal_receivers():
    # Module-level functions stay alive, so weak references suffice.
    post_save.connect(_on_save, dispatch_uid="ticketshot.debug.save")
    post_delete.connect(_on_delete, dispatch_uid="ticketshot.debug.delete")
    pagecontext.on_template(_on_template)
