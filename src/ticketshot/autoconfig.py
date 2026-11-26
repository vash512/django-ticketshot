"""Defaults supplied when a project does not configure ticketshot.

Without `TICKETSHOT`, tickets use a separate SQLite database beside
`BASE_DIR` and images use `MEDIA_ROOT/ticketshot`. A configured database
alias takes precedence. The router is added once in `ready()`.
"""
from pathlib import Path

from django.conf import settings
from django.db import connections, router

from . import conf
from .checks import ROUTER_PATH

SQLITE_NAME = "ticketshot.sqlite3"


def provide(databases, routers, alias, base_dir):
    """Add the missing ticket database and router.

    Return what was added. The default database needs neither.
    """
    added = []
    if alias == "default":
        return added
    if alias not in databases:
        databases[alias] = {"ENGINE": "django.db.backends.sqlite3", "NAME": str(Path(base_dir) / SQLITE_NAME)}
        added.append("database")
    if ROUTER_PATH not in routers:
        # Put ours first; it only handles ticketshot models.
        routers.insert(0, ROUTER_PATH)
        added.append("router")
    return added


def install():
    """Apply defaults and make Django reread the settings."""
    routers = list(getattr(settings, "DATABASE_ROUTERS", None) or [])
    base_dir = getattr(settings, "BASE_DIR", None) or Path.cwd()
    added = provide(settings.DATABASES, routers, conf.database(), base_dir)
    if "router" in added:
        settings.DATABASE_ROUTERS = routers
        # Another app may have cached the old router list and instances.
        router._routers = None
        router.__dict__.pop("routers", None)
    if "database" in added:
        connections.__dict__.pop("settings", None)
