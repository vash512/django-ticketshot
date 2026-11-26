"""Ticketshot configuration from one `TICKETSHOT` settings dictionary.

Validate once and cache until the setting changes. Unknown keys and invalid
types are configuration errors.

The package reads no environment variables; the project declares its setup
in `settings.py`.
"""
import re
from dataclasses import dataclass, field, fields
from typing import Any, Callable, Optional

from django.conf import settings
from django.core.exceptions import ImproperlyConfigured
from django.core.signals import setting_changed
from django.utils.module_loading import import_string
from django.utils.translation import gettext as _, get_language

SETTING = "TICKETSHOT"
MEDIA = "media"
STORAGE = "storage"
PROXY = "proxy"
REDIRECT = "redirect"
IMAGE_FORMATS = ("WEBP", "PNG", "JPEG")
POSITIONS = ("bottom-right", "bottom-left")
MASK_PATTERNS = ("email", "phone")
_KEY_PREFIX = re.compile(r"[A-Za-z]{1,10}")
_PROJECT = re.compile(r"[A-Za-z0-9_-]{1,60}")


# ------------------------------------------------------------ parsers

def _bool(name, value):
    if not isinstance(value, bool):
        raise ImproperlyConfigured(_("%(setting)s[%(name)r] must be True or False.") %
                                   {"setting": SETTING, "name": name})
    return value


def _positive(name, value):
    if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
        raise ImproperlyConfigured(_("%(setting)s[%(name)r] must be a positive integer.") %
                                   {"setting": SETTING, "name": name})
    return value


def _at_least(minimum):
    def parse(name, value):
        value = _positive(name, value)
        if value < minimum:
            raise ImproperlyConfigured(_("%(setting)s[%(name)r] must be at least %(minimum)s.") %
                                       {"setting": SETTING, "name": name, "minimum": minimum})
        return value
    return parse


def _text(name, value):
    if value is None:
        return ""
    if not isinstance(value, str):
        raise ImproperlyConfigured(_("%(setting)s[%(name)r] must be text.") %
                                   {"setting": SETTING, "name": name})
    return value.strip()


def _required_text(limit):
    def parse(name, value):
        text = _text(name, value)
        if not text or len(text) > limit:
            raise ImproperlyConfigured(
                _("%(setting)s[%(name)r] must contain between 1 and %(limit)s characters.") %
                {"setting": SETTING, "name": name, "limit": limit})
        return text
    return parse


def _project(name, value):
    text = _text(name, value)
    if not _PROJECT.fullmatch(text):
        raise ImproperlyConfigured(
            _("%(setting)s[%(name)r] must contain 1 to 60 unaccented letters, digits, '-' or '_' (for example, 'project-staging').") %
            {"setting": SETTING, "name": name})
    return text


def _key_prefix(name, value):
    text = _text(name, value)
    if not _KEY_PREFIX.fullmatch(text):
        raise ImproperlyConfigured(
            _("%(setting)s[%(name)r] must contain 1 to 10 letters (for example, 'TS').") %
            {"setting": SETTING, "name": name})
    return text.upper()


def _choice(*options):
    def parse(name, value):
        if value not in options:
            raise ImproperlyConfigured(
                _("%(setting)s[%(name)r] must be one of %(options)s.") %
                {"setting": SETTING, "name": name, "options": ", ".join(map(repr, options))})
        return value
    return parse


def _upper_choice(*options):
    choose = _choice(*options)
    return lambda name, value: choose(name, str(value or "").upper())


def _texts(name, value):
    if isinstance(value, str) or not isinstance(value, (list, tuple)):
        raise ImproperlyConfigured(_("%(setting)s[%(name)r] must be a list of strings.") %
                                   {"setting": SETTING, "name": name})
    if not all(isinstance(item, str) for item in value):
        raise ImproperlyConfigured(_("%(setting)s[%(name)r] accepts strings only.") %
                                   {"setting": SETTING, "name": name})
    return tuple(value)


def _text_choices(*allowed):
    def parse(name, value):
        values = _texts(name, value)
        unknown = [item for item in values if item not in allowed]
        if unknown:
            raise ImproperlyConfigured(
                _("%(setting)s[%(name)r] does not recognize %(unknown)s; allowed values: %(allowed)s.") %
                {"setting": SETTING, "name": name, "unknown": ", ".join(unknown),
                 "allowed": ", ".join(allowed)})
        return values
    return parse


def _function(name, value):
    """Accept a function or import path; an empty value means None."""
    if not value:
        return None
    if callable(value):
        return value
    if not isinstance(value, str):
        raise ImproperlyConfigured(_("%(setting)s[%(name)r] must be a function or an import path.") %
                                   {"setting": SETTING, "name": name})
    try:
        return import_string(value)
    except ImportError as exc:
        raise ImproperlyConfigured(
            _("%(setting)s[%(name)r] points to %(value)r, which cannot be imported.") %
            {"setting": SETTING, "name": name, "value": value}) from exc


def _permission_class(name, value):
    """Accept a class or import path."""
    if isinstance(value, str):
        try:
            value = import_string(value)
        except ImportError as exc:
            raise ImproperlyConfigured(
                _("%(setting)s[%(name)r] points to %(value)r, which cannot be imported.") %
                {"setting": SETTING, "name": name, "value": value}) from exc
    if not isinstance(value, type):
        raise ImproperlyConfigured(
            _("%(setting)s[%(name)r] must be a class or an import path.") %
            {"setting": SETTING, "name": name})
    return value


def _text_or_function(name, value):
    return value if callable(value) else _text(name, value)


def _revision(name, value):
    if value is None or callable(value):
        return value
    if isinstance(value, dict):
        return dict(value)
    return _text(name, value) or None


def _option(default, parse):
    return field(default=default, metadata={"parse": parse})


# --------------------------------------------------------------- options

@dataclass(frozen=True)
class Config:
    # When disabled, middleware injects nothing and views return 404.
    enabled: bool = _option(True, _bool)
    # Project key in shared ticket databases and storage. It separates tickets,
    # numbering, and image paths across projects and environments.
    project: str = _option("default", _project)
    # Visible ticket key prefix (TS-12): letters only.
    key_prefix: str = _option("TS", _key_prefix)
    # Ticket database alias. Without a configured alias, autoconfig provides
    # a separate SQLite database and router. "default" uses the main database.
    database: str = _option("ticketshot", _required_text(100))
    # Review branch and deployment URL.
    review_branch: str = _option("", _text)
    review_url: str = _option("", _text)
    # Width in pixels below which the bar suggests Mobile.
    device_breakpoint: int = _option(768, _positive)
    # Server-side debug records for recordings.
    debug_record: bool = _option(True, _bool)
    debug_record_max_requests: int = _option(300, _positive)
    debug_record_max_queries: int = _option(200, _positive)
    # At least 1 KB so a truncated record summary fits.
    debug_record_max_bytes: int = _option(512 * 1024, _at_least(1024))
    # Tickets per panel page.
    panel_page_size: int = _option(50, _positive)
    # `media`: local disk for development; `storage`: a STORAGES alias.
    storage: str = _option(MEDIA, _choice(MEDIA, STORAGE))
    # Allow local media without DEBUG in test settings.
    media_allowed: bool = _option(False, _bool)
    storage_alias: str = _option("ticketshot", _required_text(100))
    # Subdirectory of MEDIA_ROOT or an absolute external path.
    media_subdir: str = _option("ticketshot", _required_text(200))
    media_location: str = _option("", _text)
    # `proxy` serves after permission checks; `redirect` uses storage.url().
    serve: str = _option(PROXY, _choice(PROXY, REDIRECT))
    # Class controlling permissions and bar visibility.
    permissions: type = field(
        default_factory=lambda: _permission_class(
            "PERMISSIONS", "ticketshot.permissions.StaffPermissions"),
        metadata={"parse": _permission_class})
    # Project data from a `(request, response) -> dict` function.
    context_extra: Optional[Callable] = _option(None, _function)
    # Path prefixes where the bar is not injected.
    exclude_paths: tuple = _option((), _texts)
    # Ticket limits.
    max_images: int = _option(10, _positive)
    recording_max_steps: int = _option(8, _positive)
    recording_max_minutes: int = _option(30, _positive)
    recording_max_events: int = _option(2000, _positive)
    max_image_bytes: int = _option(12 * 1024 * 1024, _positive)
    max_image_pixels: int = _option(60_000_000, _positive)
    max_note_length: int = _option(5000, _positive)
    max_json_bytes: int = _option(4 * 1024 * 1024, _positive)
    # Re-encode images to remove metadata; fall back from WEBP to PNG.
    image_format: str = _option("WEBP", _upper_choice(*IMAGE_FORMATS))
    image_quality: int = _option(90, _positive)
    # Automatic masking in captures; manual redaction is separate.
    mask_selectors: tuple = _option(("[data-ticketshot-mask]",), _texts)
    # Patterns masked in captures and, with ANONYMIZE_URLS, in URLs.
    mask_patterns: tuple = _option(MASK_PATTERNS, _text_choices(*MASK_PATTERNS))
    # Mask email and phone in stored URLs and their derived values. False
    # preserves complete URLs for navigation.
    anonymize_urls: bool = _option(True, _bool)
    # Selectors watched by the recorder for page dialogs.
    dialog_selectors: tuple = _option(("dialog", "[role=dialog]", "[aria-modal=true]"), _texts)
    # Bar position.
    position: str = _option("bottom-right", _choice(*POSITIONS))
    # Signed page context lifetime, in seconds.
    page_token_max_age: int = _option(24 * 60 * 60, _positive)
    # Track templates rendered for the view.
    track_templates: bool = _option(True, _bool)
    # Reviewed system version, as text or a function. Fall back to APP_VERSION.
    app_version: Any = _option("", _text_or_function)
    # Reviewed system commit, as text, dict, or function. Fall back to .git.
    revision: Any = _option(None, _revision)


_NAMES = {f.name.upper(): f for f in fields(Config)}


def parse(raw):
    """Return a validated Config or raise ImproperlyConfigured."""
    raw = raw or {}
    if not isinstance(raw, dict):
        raise ImproperlyConfigured(_("%(setting)s must be a dictionary.") % {"setting": SETTING})
    unknown = sorted(set(raw) - set(_NAMES))
    if unknown:
        raise ImproperlyConfigured(
            _("%(setting)s has no options named %(unknown)s.") %
            {"setting": SETTING, "unknown": ", ".join(unknown)})
    values = {spec.name: spec.metadata["parse"](name, raw[name])
              for name, spec in _NAMES.items() if name in raw}
    return Config(**values)


_cache = {}


def current():
    """Return the current configuration, validated once per setting value."""
    if "config" not in _cache:
        _cache["config"] = parse(getattr(settings, SETTING, None))
    return _cache["config"]


def permissions():
    """Return an instance of the configured permissions class."""
    if "permissions" not in _cache:
        _cache["permissions"] = current().permissions()
    return _cache["permissions"]


def _forget(*, setting, **kwargs):
    if setting == SETTING:
        _cache.clear()


setting_changed.connect(_forget, dispatch_uid="ticketshot.conf.forget")


def database():
    """Return the ticket database alias for the router and queries."""
    return current().database


def language():
    """Visible language: Django's active one. Only Spanish is translated; any other language is English."""
    return "es" if (get_language() or "").lower().split("-")[0] == "es" else "en"
