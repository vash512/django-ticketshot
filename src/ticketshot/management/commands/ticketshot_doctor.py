"""Check database, migrations, storage, and review configuration."""
import uuid

from django.conf import settings
from django.core.files.base import ContentFile
from django.core.management.base import BaseCommand
from django.db import connections
from django.db.migrations.executor import MigrationExecutor
from django.utils.translation import gettext as _, gettext_lazy as _lazy

from ... import conf, storage
from ...checks import ROUTER_PATH
from ..destination import line


class Command(BaseCommand):
    help = _lazy("Check whether ticketshot is ready and report missing setup.")

    def add_arguments(self, parser):
        parser.add_argument("--write-test", action="store_true",
                            help=_("Write and delete a test file in storage."))

    def _ok(self, text):
        self.stdout.write(text)
        return 0

    def _problem(self, text):
        self.stdout.write(self.style.ERROR(text))
        return 1

    def _check_database(self, alias):
        try:
            connection = connections[alias]
            connection.ensure_connection()
            executor = MigrationExecutor(connection)
            pending = [m for m, _ in executor.migration_plan(executor.loader.graph.leaf_nodes())
                       if m.app_label == "ticketshot"]
        except Exception as exc:  # noqa: BLE001
            return self._problem(_("Database “%(alias)s” cannot connect (%(error)s).") %
                                 {"alias": alias, "error": f"{type(exc).__name__}: {exc}"})
        if pending:
            return self._problem(_("Database “%(alias)s” needs %(count)s ticketshot migrations. "
                                   "Run: manage.py migrate ticketshot --database=%(alias)s") %
                                 {"alias": alias, "count": len(pending)})
        return self._ok(_("Database “%(alias)s”: %(ok)s, migrations current.") %
                        {"alias": alias, "ok": self.style.SUCCESS("OK")})

    def _check_router(self, alias):
        if alias != "default" and ROUTER_PATH not in getattr(settings, "DATABASE_ROUTERS", []):
            return self._problem(_("Missing %(router)s in DATABASE_ROUTERS.") % {"router": ROUTER_PATH})
        return 0

    def _check_storage(self, config, write_test):
        try:
            backend = storage.current_backend()
            self.stdout.write(_("Storage “%(mode)s”: %(backend)s.") %
                              {"mode": config.storage, "backend": type(backend).__name__})
            problems = 0
            if config.storage == conf.MEDIA and not settings.DEBUG and not config.media_allowed:
                problems += self._problem(_("Media mode is only for local tests (DEBUG)."))
            if write_test:
                name = backend.save(f"_doctor/{uuid.uuid4().hex}.txt", ContentFile(b"ticketshot"))
                backend.delete(name)
                self._ok(_("Test write: %(ok)s.") % {"ok": self.style.SUCCESS("OK")})
            return problems
        except Exception as exc:  # noqa: BLE001
            return self._problem(_("Storage: %(error)s") % {"error": f"{type(exc).__name__}: {exc}"})

    def _report_review(self, config):
        for name, value in (("REVIEW_BRANCH", config.review_branch), ("REVIEW_URL", config.review_url)):
            if value:
                self.stdout.write(f"{name}: {value}")
            else:
                self.stdout.write(self.style.WARNING(
                     _("%(name)s is empty: the original version's capture location is unknown.") %
                     {"name": name}))

    def handle(self, *args, **options):
        config = conf.current()
        self.stdout.write(line())
        self.stdout.write(_("Bar: %(state)s") % {"state": _("on") if config.enabled else _("off")})
        problems = (self._check_database(config.database) + self._check_router(config.database)
                    + self._check_storage(config, options["write_test"]))
        self._report_review(config)
        if problems:
            self.stdout.write(self.style.ERROR(_("%(count)s problems.") % {"count": problems}))
        else:
            self.stdout.write(self.style.SUCCESS(_("ticketshot is ready.")))
