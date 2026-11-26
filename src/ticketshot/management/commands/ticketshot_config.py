"""Describe ticketshot project configuration without secrets."""
import json

from django.conf import settings
from django.core.management.base import BaseCommand
from django.shortcuts import resolve_url
from django.urls import reverse
from django.utils.translation import gettext as _, gettext_lazy as _lazy

from ... import conf
from ..destination import describe, line


def snapshot():
    """Visible configuration without passwords or keys."""
    config = conf.current()
    try:
        login_url = resolve_url(settings.LOGIN_URL)
    except Exception:  # noqa: BLE001 - a named URL may not resolve
        login_url = str(settings.LOGIN_URL)
    return {
        "enabled": config.enabled,
        "installed": "ticketshot" in settings.INSTALLED_APPS,
        "project": config.project,
        "key_prefix": config.key_prefix,
        "review_branch": config.review_branch,
        "review_url": config.review_url.rstrip("/"),
        "panel_path": reverse("ticketshot:panel"),
        "login_url": login_url,
        "destination": describe(),
    }


class Command(BaseCommand):
    help = _lazy("Show project ticketshot configuration without secrets.")

    def add_arguments(self, parser):
        parser.add_argument("--json", action="store_true")

    def handle(self, *args, **options):
        data = snapshot()
        if options["json"]:
            self.stdout.write(json.dumps(data))
            return
        self.stdout.write(line(data["destination"]))
        self.stdout.write(_("Bar: %(state)s") % {"state": _("on") if data["enabled"] else _("off")})
        self.stdout.write(_("Review branch: %(branch)s") % {"branch": data["review_branch"] or _("(empty)")})
        self.stdout.write(_("Review URL: %(url)s") % {"url": data["review_url"] or _("(empty)")})
        self.stdout.write(f"Login: {data['login_url']}")
