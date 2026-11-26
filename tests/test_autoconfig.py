"""Default to a separate SQLite database and local media."""
import os
import sqlite3
import subprocess
import sys
import tempfile
from pathlib import Path
from unittest import mock

from django.core.exceptions import ImproperlyConfigured
from django.test import SimpleTestCase

from ticketshot import autoconfig, conf
from ticketshot.checks import ROUTER_PATH

ROOT = Path(__file__).resolve().parent.parent


class OtherRouter:
    """Another project's router with no routing decisions."""


class ProvideTests(SimpleTestCase):
    def test_a_missing_alias_gets_its_own_sqlite_next_to_the_project(self):
        databases = {"default": {"NAME": "principal"}}
        routers = ["otro.Router"]
        added = autoconfig.provide(databases, routers, "ticketshot", Path("/proyecto"))
        self.assertEqual(added, ["database", "router"])
        self.assertEqual(databases["ticketshot"], {
            "ENGINE": "django.db.backends.sqlite3", "NAME": str(Path("/proyecto") / "ticketshot.sqlite3")})
        self.assertEqual(databases["default"], {"NAME": "principal"})
        # Put ticketshot's router first; it only handles its own models.
        self.assertEqual(routers, [ROUTER_PATH, "otro.Router"])

    def test_what_the_project_declares_is_kept(self):
        common = {"ENGINE": "django.db.backends.postgresql", "NAME": "comun"}
        databases = {"default": {}, "ticketshot": common}
        routers = ["otro.Router", ROUTER_PATH]
        self.assertEqual(autoconfig.provide(databases, routers, "ticketshot", Path("/p")), [])
        self.assertIs(databases["ticketshot"], common)
        self.assertEqual(routers, ["otro.Router", ROUTER_PATH])

    def test_tickets_in_the_main_database_need_nothing(self):
        databases, routers = {"default": {}}, []
        self.assertEqual(autoconfig.provide(databases, routers, "default", Path("/p")), [])
        self.assertEqual((databases, routers), ({"default": {}}, []))

    def test_the_project_name_is_a_safe_key(self):
        # Separate projects and environments in a shared database,
        # using safe project names in image paths.
        for good in ("shop", "shop-staging", "shop_prod2"):
            self.assertEqual(conf.parse({"PROJECT": good}).project, good)
        for bad in ("mi proyecto", "shop/prod", "../otro", "ñandú", "x" * 61, ""):
            with self.subTest(bad), self.assertRaisesMessage(ImproperlyConfigured, "PROJECT"):
                conf.parse({"PROJECT": bad})

    def test_the_default_alias_is_its_own(self):
        self.assertEqual(conf.parse({}).database, "ticketshot")
        self.assertEqual(conf.parse({}).storage, conf.MEDIA)


class InstallTests(SimpleTestCase):
    def test_install_forgets_what_django_already_read(self):
        fake_settings = mock.Mock(DATABASES={"default": {}}, DATABASE_ROUTERS=[], BASE_DIR=Path("/p"))
        fake_router, fake_connections = mock.Mock(), mock.Mock()
        fake_router.__dict__["routers"] = ["leído"]
        fake_connections.__dict__["settings"] = {"default": {}}
        with mock.patch.multiple(autoconfig, settings=fake_settings, router=fake_router,
                                 connections=fake_connections), \
                mock.patch.object(autoconfig.conf, "database", return_value="ticketshot"):
            autoconfig.install()
        self.assertEqual(fake_settings.DATABASES["ticketshot"]["NAME"], str(Path("/p") / "ticketshot.sqlite3"))
        self.assertEqual(fake_settings.DATABASE_ROUTERS, [ROUTER_PATH])
        self.assertNotIn("routers", fake_router.__dict__)
        self.assertNotIn("settings", fake_connections.__dict__)

    def test_a_router_django_already_read_gets_ours_too(self):
        # Another app may have requested the router before ready().
        from django.db.utils import ConnectionRouter
        from django.test import override_settings

        from ticketshot.routers import TicketShotRouter

        with override_settings(DATABASE_ROUTERS=["tests.test_autoconfig.OtherRouter"]):
            early = ConnectionRouter()
            self.assertEqual([type(r) for r in early.routers], [OtherRouter])
            with mock.patch.object(autoconfig, "router", early), \
                    mock.patch.object(autoconfig.conf, "database", return_value="ticketshot"):
                autoconfig.install()
            self.assertEqual([type(r) for r in early.routers], [TicketShotRouter, OtherRouter])

    def test_without_base_dir_the_file_goes_to_the_working_folder(self):
        fake_settings = mock.Mock(spec=["DATABASES", "DATABASE_ROUTERS"], DATABASES={}, DATABASE_ROUTERS=[])
        with mock.patch.multiple(autoconfig, settings=fake_settings, router=mock.Mock(),
                                 connections=mock.Mock()), \
                mock.patch.object(autoconfig.conf, "database", return_value="ticketshot"):
            autoconfig.install()
        self.assertEqual(fake_settings.DATABASES["ticketshot"]["NAME"], str(Path.cwd() / "ticketshot.sqlite3"))


class ZeroConfigProjectTests(SimpleTestCase):
    """Run a minimal project in another process with app, middleware, and URL."""

    def run_django(self, folder, *args):
        env = {**os.environ, "ZERO_CONFIG_DIR": str(folder), "DJANGO_SETTINGS_MODULE": "tests.zero_config.settings",
               "PYTHONPATH": os.pathsep.join([str(ROOT / "src"), str(ROOT)])}
        result = subprocess.run([sys.executable, "-m", "django", *args], cwd=ROOT, env=env,
                                capture_output=True, text=True, timeout=120)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        return result.stdout + result.stderr

    def test_it_works_with_only_the_registration_lines(self):
        folder = Path(tempfile.mkdtemp(prefix="ticketshot-cero-"))
        self.assertIn("no issues", self.run_django(folder, "check"))
        self.run_django(folder, "migrate", "--verbosity=0")
        self.run_django(folder, "migrate", "--database=ticketshot", "--verbosity=0")
        own, main = folder / "ticketshot.sqlite3", folder / "proyecto.sqlite3"
        self.assertTrue(own.exists())
        # Keep ticket tables out of the project database and vice versa.
        self.assertIn("ticketshot_ticket", tables(own))
        self.assertFalse(any(t.startswith("ticketshot_") for t in tables(main)))
        self.assertFalse(any(t.startswith("auth_") for t in tables(own)))
        self.assertIn("'storage': 'media'", self.run_django(folder, "ticketshot_config", "--json")
                      .replace('"', "'"))


def tables(path):
    with sqlite3.connect(path) as db:
        return {row[0] for row in db.execute("select name from sqlite_master where type='table'")}
