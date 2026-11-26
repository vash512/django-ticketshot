"""System checks, each focused on one configuration requirement."""
from django.conf import settings
from django.core.checks import Error, Tags, Warning, register
from django.core.exceptions import ImproperlyConfigured
from django.utils.translation import gettext as _

from . import conf

MIDDLEWARE_PATH = "ticketshot.middleware.TicketShotMiddleware"
AUTH_MIDDLEWARE = "django.contrib.auth.middleware.AuthenticationMiddleware"
ROUTER_PATH = "ticketshot.routers.TicketShotRouter"


def _media_outside_debug(config):
    if config.storage == conf.MEDIA and config.enabled and not settings.DEBUG \
            and not config.media_allowed:
        # Captures are private; outside local development they require
        # private storage.
        yield Error(
            _("ticketshot stores images on local disk ('media' mode) with DEBUG disabled. 'media' mode is only for local testing."),
            id="ticketshot.E005",
            hint=_("Use TICKETSHOT['STORAGE'] = 'storage' with private storage (S3)."))


def _storage_alias(config):
    if config.storage == conf.STORAGE and config.storage_alias not in (
            getattr(settings, "STORAGES", None) or {}):
        yield Error(
            _("'storage' mode uses alias %(alias)r, which is missing from STORAGES.") %
            {"alias": config.storage_alias},
            id="ticketshot.E002",
            hint=_("Define STORAGES[alias] or use TICKETSHOT['STORAGE'] = 'media'."))


def _database(config):
    if config.database not in settings.DATABASES:
        yield Error(_("TICKETSHOT['DATABASE'] = %(alias)r is missing from DATABASES.") %
                    {"alias": config.database},
                    id="ticketshot.E006")
    elif config.database != "default" and ROUTER_PATH not in (
            getattr(settings, "DATABASE_ROUTERS", None) or []):
        yield Error(_("Tickets use a separate database, but its router is missing."),
                    id="ticketshot.E007", hint=_("Add %(router)r to DATABASE_ROUTERS.") %
                    {"router": ROUTER_PATH})


def _middleware(config):
    middleware = list(getattr(settings, "MIDDLEWARE", []) or [])
    if MIDDLEWARE_PATH not in middleware:
        yield Warning(_("TicketShotMiddleware is missing from MIDDLEWARE: the bar will not appear."),
                      id="ticketshot.W001")
    elif AUTH_MIDDLEWARE in middleware[middleware.index(MIDDLEWARE_PATH):]:
        yield Error(_("TicketShotMiddleware must follow AuthenticationMiddleware."),
                    id="ticketshot.E003")


CHECKS = (_media_outside_debug, _storage_alias, _database, _middleware)


@register(Tags.compatibility)
def check_configuration(app_configs, **kwargs):
    try:
        config = conf.current()
    except ImproperlyConfigured as exc:
        return [Error(str(exc), id="ticketshot.E001")]
    return [issue for check in CHECKS for issue in check(config)]
