"""Reproducible ticket URLs with placeholders and source tags."""
import json
import re
from dataclasses import dataclass, field
from urllib.parse import urlsplit

from django.core.exceptions import ValidationError
from django.utils.translation import gettext as _

MAX_TEMPLATE = 1000
MAX_TAG_TEXT = 300
_ROUTE_ARG = re.compile(r"<(?:\w+:)?(\w+)>")
_TAG = re.compile(r"\{(\w+)\}")
_CONTROL = re.compile(r"[\x00-\x1f\x7f]")


@dataclass(frozen=True)
class UrlTemplate:
    template: str
    tags: dict = field(default_factory=dict)


def _tags_from_json(text):
    try:
        value = json.loads(text)
    except json.JSONDecodeError as exc:
        raise ValidationError(_("Tags are not valid JSON.")) from exc
    return value if isinstance(value, dict) else {}


def _tags_from_lines(text):
    pairs = (line.split(":", 1) for line in text.splitlines() if ":" in line)
    return {name.strip().strip("{}"): where for name, where in pairs}


def parse_tags(raw):
    """Parse tags from a dict, JSON, or name-and-source lines."""
    if isinstance(raw, dict):
        return _clean_tags(raw)
    text = str(raw or "").strip()
    # A placeholder line can start with a brace; JSON requires a full object.
    looks_like_json = text.startswith("{") and text.endswith("}")
    return _clean_tags((_tags_from_json if looks_like_json else _tags_from_lines)(text))


def _clean_tags(raw):
    return {str(name).strip(): str(text).strip()[:MAX_TAG_TEXT]
            for name, text in raw.items() if str(name).strip()}


def build(template, tags):
    """Ensure template placeholders and tags match exactly."""
    template = str(template or "").strip()[:MAX_TEMPLATE]
    if template and not template.startswith("/"):
        raise ValidationError(_("The reproducible URL must start with '/'."))
    names = set(_TAG.findall(template))
    tags = parse_tags(tags)
    unknown = sorted(set(tags) - names)
    if unknown:
        raise ValidationError(_("These tags are not in the URL: ") + ", ".join(unknown) + ".")
    missing = sorted(n for n in names if not tags.get(n))
    if missing:
        raise ValidationError(_("Provide a source for each tag: ") + ", ".join(missing) + ".")
    return UrlTemplate(template, tags)


def suggest(route, kwargs, path):
    """Suggest a template from the resolved route or raw path."""
    if kwargs and route and "<" in route:
        template = "/" + _ROUTE_ARG.sub(r"{\1}", route.lstrip("^").lstrip("/"))
        tags = {name: _("(in the capture: %(value)s)") % {"value": value} for name, value in kwargs.items()
                if f"{{{name}}}" in template}
        return UrlTemplate(template[:MAX_TEMPLATE], tags)
    return UrlTemplate(urlsplit(path or "/").path[:MAX_TEMPLATE], {})


def relative(url):
    """Return path and query without host or fragment."""
    cleaned = _CONTROL.sub("", str(url or "").replace("\\", "/")).strip(" ")
    try:
        parts = urlsplit(cleaned)
    except ValueError:
        return "/"
    path = "/" + parts.path.lstrip("/")
    return path + (f"?{parts.query}" if parts.query else "")
