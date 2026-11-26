"""Validate bar or skill input into a NewTicket."""
import hashlib
import json
from datetime import datetime
from pathlib import Path

from django.conf import settings
from django.core.exceptions import ValidationError
from django.utils.translation import gettext as _
from django.utils import timezone

from . import anonymize, conf, imaging, pagecontext, permissions, queries, states, urltemplate, users, workflow
from .debuglog import VALID_ID
from .intake import NewImage, NewTicket

MAX_LOGS = 500
MAX_CLIENT_BYTES = 32 * 1024
MAX_VISITED = 50
MAX_REDACTIONS = 999
NAV_EVENTS = ("page", "nav", "submit")


# coercion

def text(value, limit):
    return str(value if value is not None else "")[:limit]


def whole(value, *, low=0, high=None):
    """Return an integer in range or None for unusual input types."""
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    number = int(value)
    if number < low or (high is not None and number > high):
        return None
    return number


def choice(value, options, default):
    return value if value in options else default


def moment(value):
    """Parse a browser ISO date into a Django-aware datetime."""
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError:
        return None
    if settings.USE_TZ:
        return parsed if timezone.is_aware(parsed) else timezone.make_aware(parsed)
    # Without time zones, Django stores naive local time.
    return timezone.make_naive(parsed) if timezone.is_aware(parsed) else parsed


def note(value):
    return workflow.clean_text(value, required=True, missing=_("Describe what you want to change and where."))


def parent(key):
    if not key:
        return None
    found = workflow.find(key)
    if found is None:
        raise ValidationError(_("Ticket %(key)s does not exist.") % {"key": key})
    if found.status == states.Status.DISCARDED:
        raise ValidationError(_("%(key)s is discarded; create a new ticket.") % {"key": found.key})
    return found


# Only content-defining fields belong in the submission fingerprint.
# Ignore changing retry details such as time, scroll, and context.
HASHED_FIELDS = ("kind", "device", "note", "trigger_url", "visited_urls", "logs", "events",
                 "duration_ms", "recording_id")


def submission_hash(fields, images, parent_key, reject_parent):
    """Fingerprint identical draft content identically across retries."""
    canonical = {
        "fields": {name: fields.get(name) for name in HASHED_FIELDS},
        "parent": parent_key or "",
        "reject": reject_parent,
        "images": [{"sha256": i.clean.sha256, **i.fields} for i in images],
    }
    raw = json.dumps(canonical, sort_keys=True, ensure_ascii=False, default=str)
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


# bar

def parse_payload(raw):
    try:
        payload = json.loads(raw or "{}")
    except json.JSONDecodeError as exc:
        raise ValidationError(_("The submission is not valid JSON.")) from exc
    if not isinstance(payload, dict):
        raise ValidationError(_("The submission must be an object."))
    return payload


def _json_file(files, name):
    """Parse a bounded attached JSON list, defaulting to empty."""
    upload = files.get(name)
    if upload is None:
        return []
    if upload.size > conf.current().max_json_bytes:
        raise ValidationError(_("“%(name)s” is too large.") % {"name": name})
    try:
        value = json.loads(upload.read().decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ValidationError(_("“%(name)s” is not valid JSON.") % {"name": name}) from exc
    return value if isinstance(value, list) else []


def _kind(payload):
    kind = payload.get("kind") or states.Kind.NOTE
    if kind not in states.Kind.values:
        raise ValidationError(_("Unknown ticket type."))
    return kind


def _image_limit(kind):
    config = conf.current()
    # Recording consists of start, steps, and end.
    return config.recording_max_steps + 2 if kind == states.Kind.RECORDING else config.max_images


def _image_metas(payload, files, kind):
    metas = payload.get("images") or []
    if not isinstance(metas, list):
        raise ValidationError(_("The image list is invalid."))
    if not metas:
        raise ValidationError(_("A ticket needs at least one capture."))
    if len(metas) > _image_limit(kind):
        raise ValidationError(_("A ticket allows up to %(limit)s images.") % {"limit": _image_limit(kind)})
    if any(not isinstance(m, dict) or m.get("field") not in files for m in metas):
        raise ValidationError(_("One of the listed images is missing."))
    return metas


def _client(payload):
    client = payload.get("client")
    if not isinstance(client, dict) or len(json.dumps(client)) > MAX_CLIENT_BYTES:
        return {}
    return client


def _device(value, client):
    if value in states.Device.values:
        return value
    viewport = client.get("viewport")
    width = whole(viewport.get("width")) if isinstance(viewport, dict) else None
    if width and width < conf.current().device_breakpoint:
        return states.Device.MOBILE
    return states.Device.DESKTOP


def _verified_events(events):
    """Replace each page token with its verified summary."""
    clean = []
    for event in events[: conf.current().recording_max_events]:
        if not isinstance(event, dict):
            continue
        event = dict(event)
        if "url" in event:
            event["url"] = anonymize.url(event["url"])
        if event.get("type") == "network" and "target" in event:
            event["target"] = anonymize.url(event["target"])
        token = event.pop("token", None)
        if token:
            context, ok = pagecontext.unsign(token)
            event["server"] = pagecontext.summary(context) if ok else {}
            event["verified"] = ok
        clean.append(event)
    return clean


def _visited(metas, events):
    """Return visited URLs in order without duplicates."""
    candidates = [m.get("pageUrl") for m in metas]
    candidates += [e.get("url") for e in events if e.get("type") in NAV_EVENTS]
    ordered = dict.fromkeys(urltemplate.relative(anonymize.url(url)) for url in candidates if url)
    return list(ordered)[:MAX_VISITED]


def _image_device(value, ticket_device):
    if value in states.IMAGE_DEVICES:
        return value
    return ticket_device if ticket_device in states.IMAGE_DEVICES else ""


def _bar_image(meta, files, device):
    image_context, _ok = pagecontext.unsign(meta.get("pageToken"))
    return NewImage(imaging.normalize_upload(files[meta["field"]]), {
        "role": choice(meta.get("role"), states.ImageRole.values, states.ImageRole.MANUAL),
        "method": choice(meta.get("method"), (states.ImageMethod.DOM, states.ImageMethod.DISPLAY),
                         states.ImageMethod.DOM),
        "device": _image_device(meta.get("device"), device),
        "edited": bool(meta.get("edited")),
        "redactions": whole(meta.get("redactions"), high=MAX_REDACTIONS) or 0,
        "caption": text(meta.get("caption"), 500),
        "page_url": text(anonymize.url(meta.get("pageUrl")), 4000),
        "page_title": text(meta.get("pageTitle"), 300),
        "view_name": text(image_context.get("view", {}).get("name"), 200),
        "captured_at": moment(meta.get("capturedAt")),
        "offset_ms": whole(meta.get("offsetMs")),
    })


def _client_id(payload):
    value = payload.get("clientId")
    if value in (None, ""):
        return None
    if not isinstance(value, str) or not VALID_ID.fullmatch(value):
        raise ValidationError(_("The draft ID is invalid."))
    return value


def _recording_id(payload, kind):
    value = payload.get("recordingId") if kind == states.Kind.RECORDING else None
    return value if isinstance(value, str) and VALID_ID.fullmatch(value) else ""


def _server_fields(server, trigger_path):
    """Return server page details such as view, route, and version."""
    view = server.get("view", {})
    app = server.get("app") or {}
    suggested = urltemplate.suggest(view.get("route", ""), view.get("kwargs") or {}, trigger_path)
    return {
        "view_name": text(view.get("name"), 200),
        "route": text(view.get("route"), 300),
        "route_kwargs": view.get("kwargs") or {},
        "url_template": suggested.template,
        "url_tags": suggested.tags,
        "app_version": text(app.get("version"), 100),
        "revision": app.get("revision") if isinstance(app.get("revision"), dict) else {},
    }


def _author_fields(request):
    actor = users.Actor.from_user(request.user)
    return {
        "author_username": actor.username,
        "author_label": actor.label,
        "author_groups": users.group_names(request.user),
        "base_url": request.build_absolute_uri("/").rstrip("/")[:300],
    }


def _recording_fields(payload, kind, files):
    events = _verified_events(_json_file(files, "events"))
    recording = kind == states.Kind.RECORDING
    return {
        "events": events,
        "duration_ms": whole(payload.get("durationMs")) if recording else None,
        "recording_id": _recording_id(payload, kind),
    }


# Bar logs may contain URLs for request, page, and error source.
LOG_URL_KEYS = ("url", "page", "source")


def _masked_log(entry):
    if not isinstance(entry, dict):
        return entry
    return {**entry, **{key: anonymize.url(entry[key]) for key in LOG_URL_KEYS if key in entry}}


def _masked_logs(files):
    """Copy logs with all stored URLs masked."""
    return [_masked_log(entry) for entry in _json_file(files, "logs")[:MAX_LOGS]]


def from_bar(request, payload, files):
    """Convert a bar submission to NewTicket or raise ValidationError."""
    note_text = note(payload.get("note"))
    kind = _kind(payload)
    metas = _image_metas(payload, files, kind)
    client = dict(_client(payload))
    for key in ("url", "referrer"):
        if key in client:
            client[key] = anonymize.url(client[key])
    device = _device(payload.get("device"), client)
    parent_ticket = parent(payload.get("parent"))
    recording = _recording_fields(payload, kind, files)
    # Validate and re-encode every image before storing any.
    images = tuple(_bar_image(meta, files, device) for meta in metas)
    server, verified = pagecontext.unsign(payload.get("pageToken"))
    trigger = text(anonymize.url(payload.get("pageUrl")), 4000) or \
        text(anonymize.url(metas[0].get("pageUrl")), 4000)
    trigger_path = urltemplate.relative(trigger)[:1000]
    fields = {
        "kind": kind,
        "status": states.Status.REQUESTED,
        "device": device,
        "source": states.Source.BAR,
        "note": note_text,
        "client_id": _client_id(payload),
        "trigger_url": trigger,
        "trigger_path": trigger_path,
        "page_title": text(payload.get("pageTitle"), 300),
        "visited_urls": _visited(metas, recording["events"]),
        "server_context": server,
        "context_verified": verified,
        "client_context": client,
        "logs": _masked_logs(files),
        "storage_mode": conf.current().storage,
        **_server_fields(server, trigger_path),
        **_author_fields(request),
        **recording,
    }
    reject = bool(payload.get("rejectParent")) and parent_ticket is not None \
        and permissions.can_approve(request.user)
    fields["submission_hash"] = submission_hash(fields, images, payload.get("parent"), reject)
    return NewTicket(fields, images, parent=parent_ticket, reject_parent=reject)


# skill

def _check_skill_args(device, status, images):
    if device not in states.Device.values:
        raise ValidationError(_("Device must be desktop, mobile, or both."))
    if status not in states.SKILL_START:
        raise ValidationError(_("A skill ticket starts In progress or Change requested."))
    if not images:
        raise ValidationError(_("The skill must attach at least one capture."))
    if len(images) > conf.current().max_images:
        raise ValidationError(_("A ticket allows up to %(limit)s images.") % {"limit": conf.current().max_images})


def _skill_images(images, url):
    """Validate images from disk with path, device, and caption."""
    now = timezone.now()
    return tuple(NewImage(imaging.normalize(Path(path).read_bytes()), {
        "role": states.ImageRole.MANUAL,
        "method": states.ImageMethod.AUTOMATED,
        "device": image_device if image_device in states.IMAGE_DEVICES else "",
        "caption": text(caption, 500),
        "page_url": text(url, 4000),
        "captured_at": now,
    }) for path, image_device, caption in images)


def from_files(*, note_text, url, images, device, actor, implementation="", parent_key="",
               template="", tags=None, status=states.Status.IN_PROGRESS, base_url="",
               revision=None, app_version=""):
    """Create a NewTicket from an unsolicited change and disk captures."""
    note_text = note(note_text)
    _check_skill_args(device, status, images)
    parent_ticket = parent(parent_key)
    url = anonymize.url(url)
    trigger_path = urltemplate.relative(url)[:1000]
    built = urltemplate.build(template or urltemplate.suggest("", {}, trigger_path).template,
                              tags or {})
    fields = {
        "kind": states.Kind.NOTE,
        "status": status,
        "device": device,
        "source": states.Source.SKILL,
        "note": note_text,
        "trigger_url": text(url, 4000),
        "trigger_path": trigger_path,
        "view_name": text(queries.resolve_view(trigger_path), 200),
        "url_template": built.template,
        "url_tags": built.tags,
        "visited_urls": [trigger_path],
        "author_username": actor.username,
        "author_label": actor.label,
        "base_url": text(base_url, 300),
        "app_version": text(app_version, 100),
        "revision": revision or {},
        "implementation_note": text(implementation, conf.current().max_note_length),
        "storage_mode": conf.current().storage,
    }
    return NewTicket(fields, _skill_images(images, url), parent=parent_ticket)
