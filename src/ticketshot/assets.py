"""Versioned package static asset URLs for browser caching."""
import os
from functools import lru_cache

from django.conf import settings
from django.contrib.staticfiles import finders
from django.templatetags.static import static

from . import __version__

# Bar modules import each other without versioned URLs, so put them in
# a versioned directory. After upgrades, the browser cannot mix new
# modules with old cached ones.
BAR_DIR = f"ticketshot/bar-{__version__}"
BAR_ENTRY = f"{BAR_DIR}/main.js"
BAR_CSS = "ticketshot/ticketshot.css"
PANEL_CSS = "ticketshot/panel.css"
CAPTURE_LIB = "ticketshot/vendor/modern-screenshot.js"


def _mtime_stamp(path):
    found = finders.find(path)
    try:
        return str(int(os.path.getmtime(found))) if found else ""
    except OSError:
        return ""


@lru_cache(maxsize=16)
def _cached_stamp(path):
    return _mtime_stamp(path)


def url(path):
    """Return a versioned static URL; DEBUG also tracks file edits."""
    stamp = _mtime_stamp(path) if settings.DEBUG else _cached_stamp(path)
    version = f"{__version__}.{stamp}" if stamp else __version__
    return f"{static(path)}?v={version}"
