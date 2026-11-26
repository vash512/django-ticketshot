"""Boundary cases for previously missed module behavior."""
import re
import tempfile
from io import BytesIO, StringIO
from pathlib import Path
from types import SimpleNamespace
from unittest import mock
from urllib.parse import quote

from django.contrib import admin
from django.contrib.auth.models import Group
from django.core.exceptions import ImproperlyConfigured, ValidationError
from django.core.management import CommandError, call_command
from django.db import connections
from django.http import HttpResponse, StreamingHttpResponse
from django.test import SimpleTestCase, override_settings
from django.test.utils import CaptureQueriesContext
from django.utils import timezone
from PIL import Image

from ticketshot import (admin as ts_admin, conf, imaging, middleware, permissions, revision,
                        timeline, urltemplate, users)
from ticketshot.checks import check_configuration
from ticketshot.management import destination
from ticketshot.management.commands.ticketshot_create import parse_tag_args
from ticketshot.models import Ticket, TicketImage, image_upload_to
from ticketshot.routers import TicketShotRouter

from .helpers import REVIEWER, TicketShotTestCase, make_user, png, ts

ACTION = "/__ticketshot/tickets/{}/action/"


def run(*args):
    out = StringIO()
    call_command(*args, stdout=out)
    return out.getvalue()


def person(**attrs):
    """Minimal user without attributes the test did not supply."""
    return SimpleNamespace(**attrs)


class AdminTests(TicketShotTestCase):
    def test_notes_and_sizes_shown_in_the_list(self):
        tickets = ts_admin.TicketAdmin(Ticket, admin.site)
        self.assertEqual(tickets.short_note(Ticket(note="x" * 80)), "x" * 80)
        self.assertEqual(tickets.short_note(Ticket(note="x" * 81)), "x" * 79 + "…")
        images = ts_admin.TicketImageInline(Ticket, admin.site)
        self.assertEqual(images.dimensions(TicketImage(width=10, height=20, size_bytes=2048)), "10×20 · 2 KB")
        self.assertEqual(images.dimensions(TicketImage(width=10, height=20, size_bytes=None)), "10×20 · 0 KB")
        self.assertIn('alt="Imagen 1"', images.preview(TicketImage(pk=7, position=0)))
        self.assertIn("canción", ts_admin._pretty({"t": "canción"}))

    def test_a_ticket_cannot_be_changed_from_the_admin(self):
        self.client.force_login(make_user())
        payload, files = self.note_payload()
        self.post(payload, files)
        ticket = Ticket.objects.get()
        self.client.force_login(make_user("admin", perms=(), superuser=True))
        response = self.client.post(f"/admin/ticketshot/ticket/{ticket.pk}/change/", {"note": "otra"})
        self.assertEqual(response.status_code, 403)


class ImageEndpointTests(TicketShotTestCase):
    def test_the_image_is_named_after_its_ticket_and_position(self):
        self.client.force_login(make_user())
        payload, files = self.note_payload()
        self.post(payload, files)
        item = TicketImage.objects.get()
        self.client.force_login(make_user("revisora", perms=REVIEWER))
        response = self.client.get(f"/__ticketshot/images/{item.pk}/")
        self.assertRegex(response["Content-Disposition"], r'^inline; filename="TS-1-1\.\w+"$')
        self.assertEqual(response["Cache-Control"], "private, max-age=300")

    def test_a_form_action_comes_back_to_the_panel_with_its_message(self):
        self.client.force_login(make_user())
        payload, files = self.note_payload()
        self.post(payload, files)
        done = self.client.post(ACTION.format("TS-1"), {"action": "comment", "text": "También en celular."})
        self.assertEqual(done["Location"], "/__ticketshot/panel/TS-1/?ok=" + quote("Comentario agregado."))
        failed = self.client.post(ACTION.format("TS-1"), {"action": "comment", "text": "  "})
        self.assertEqual(failed["Location"], "/__ticketshot/panel/TS-1/?error=" + quote("Escribe el comentario."))


class MiddlewareOrderTests(SimpleTestCase):
    def errors(self, order):
        with override_settings(MIDDLEWARE=order):
            return [m.id for m in check_configuration(None)]

    def test_the_bar_goes_after_authentication(self):
        auth = "django.contrib.auth.middleware.AuthenticationMiddleware"
        bar = "ticketshot.middleware.TicketShotMiddleware"
        session = "django.contrib.sessions.middleware.SessionMiddleware"
        self.assertNotIn("ticketshot.E003", self.errors([session, auth, bar]))
        self.assertIn("ticketshot.E003", self.errors([session, bar, auth]))


class ConfParserTests(SimpleTestCase):
    def test_numbers_and_texts_at_their_bounds(self):
        self.assertEqual(conf._positive("X", 1), 1)
        with self.assertRaises(ImproperlyConfigured):
            conf._positive("X", 0)
        self.assertEqual(conf._at_least(1024)("X", 1024), 1024)
        with self.assertRaises(ImproperlyConfigured):
            conf._at_least(1024)("X", 1023)
        self.assertEqual(conf._required_text(3)("X", "abc"), "abc")
        for bad in ("", "abcd"):
            with self.assertRaises(ImproperlyConfigured):
                conf._required_text(3)("X", bad)

    def test_lists_of_texts_must_be_lists(self):
        for bad in ("abc", 5, {"a"}):
            with self.assertRaises(ImproperlyConfigured):
                conf._texts("X", bad)

    def test_a_revision_may_be_empty_or_a_function(self):
        def current():
            return {"commit": "abc"}
        self.assertIsNone(conf._revision("X", None))
        self.assertIs(conf._revision("X", current), current)


class ImagingTests(TicketShotTestCase):
    def test_without_webp_support_webp_falls_back_to_png_and_others_stay(self):
        with mock.patch("ticketshot.imaging.features.check", return_value=False):
            with ts(IMAGE_FORMAT="WEBP"):
                self.assertEqual(imaging.target_format(), "PNG")
            with ts(IMAGE_FORMAT="JPEG"):
                self.assertEqual(imaging.target_format(), "JPEG")

    def test_an_image_of_exactly_the_pixel_cap_is_accepted(self):
        with ts(MAX_IMAGE_PIXELS=40 * 30):
            imaging.normalize(png(40, 30))
            with self.assertRaises(ValidationError):
                imaging.normalize(png(41, 30))

    def test_the_byte_cap_admits_exactly_the_cap(self):
        with ts(MAX_IMAGE_BYTES=1000):
            imaging._check_size(1000)
            with self.assertRaises(ValidationError):
                imaging._check_size(1001)

    def test_transparency_is_detected_and_kept_where_the_format_allows(self):
        palette = Image.new("P", (2, 2))
        palette.info["transparency"] = 0
        cases = {"RGBA": True, "LA": True, "RGB": False, "L": False}
        for mode, expected in cases.items():
            self.assertEqual(imaging._has_alpha(Image.new(mode, (2, 2))), expected, mode)
        self.assertTrue(imaging._has_alpha(palette))
        self.assertFalse(imaging._has_alpha(Image.new("P", (2, 2))))

        def mode_after(image, fmt):
            return Image.open(BytesIO(imaging._encode(image, fmt))).mode
        self.assertEqual(mode_after(Image.new("RGBA", (2, 2)), "PNG"), "RGBA")
        self.assertEqual(mode_after(Image.new("RGBA", (2, 2)), "JPEG"), "RGB")
        self.assertEqual(mode_after(Image.new("RGB", (2, 2)), "PNG"), "RGB")
        self.assertEqual(mode_after(palette, "PNG"), "RGBA")


class IntakeTests(TicketShotTestCase):
    def test_each_image_is_written_once(self):
        self.client.force_login(make_user())
        payload, files = self.note_payload(images=2)
        with CaptureQueriesContext(connections["ticketshot"]) as queries:
            self.assertEqual(self.post(payload, files).status_code, 201)
        writes = [q["sql"] for q in queries
                  if "ticketshot_ticketimage" in q["sql"] and q["sql"].lstrip().upper().startswith(("INSERT", "UPDATE"))]
        self.assertEqual(len(writes), 2)


class InjectionTests(TicketShotTestCase):
    def html(self, **headers):
        response = HttpResponse("<html><body></body></html>", content_type=headers.pop("content_type", "text/html"))
        for name, value in headers.items():
            response[name] = value
        return response

    def test_only_full_html_pages_get_the_bar(self):
        self.assertTrue(middleware.injectable(self.html()))
        self.assertFalse(middleware.injectable(StreamingHttpResponse(iter([b"x"]), content_type="text/html")))
        for status in (204, 304, 101):
            response = self.html()
            response.status_code = status
            self.assertFalse(middleware.injectable(response), status)
        self.assertFalse(middleware.injectable(self.html(content_type="application/json")))
        self.assertFalse(middleware.injectable(self.html(**{"Content-Encoding": "gzip"})))
        self.assertFalse(middleware.injectable(self.html(**{"Content-Disposition": "attachment; filename=a.html"})))

    def test_the_bar_goes_before_the_last_body_and_the_page_is_private(self):
        self.client.force_login(make_user())
        response = self.client.get("/two-bodies/")
        html = response.content.decode()
        self.assertGreater(html.index("data-ticketshot-ui"), html.index("<p>fin</p>"))
        self.assertIn("private", [d.strip() for d in response["Cache-Control"].split(",")])


class ModelTests(TicketShotTestCase):
    def test_upload_paths_keep_the_extension_or_use_png(self):
        image = TicketImage(ticket=Ticket(pk=1, project="pruebas", created_at=timezone.now()),
                            position=0, role="manual")
        self.assertTrue(image_upload_to(image, "captura.WEBP").endswith("/00-manual.webp"))
        self.assertTrue(image_upload_to(image, "sin-extension").endswith("/00-manual.png"))

    def test_an_image_names_its_ticket_and_position(self):
        image = TicketImage(ticket=Ticket(project="pruebas", number=3), position=0, role="manual")
        self.assertEqual(str(image), "TS-3 · 1 · Captura")


class PermissionTests(SimpleTestCase):
    def test_only_an_authenticated_and_active_user_counts(self):
        self.assertFalse(permissions._active(None))
        self.assertTrue(permissions._active(person(is_authenticated=True, is_active=True)))
        self.assertFalse(permissions._active(person(is_authenticated=True, is_active=False)))
        self.assertFalse(permissions._active(person(is_authenticated=False, is_active=True)))
        self.assertFalse(permissions._active(person(is_authenticated=True)))
        self.assertFalse(permissions._active(person(is_active=True)))


class RevisionTests(SimpleTestCase):
    def test_a_worktree_with_a_relative_gitdir(self):
        root = Path(tempfile.mkdtemp(prefix="ticketshot-git-"))
        worktree_git = root / "repo" / ".git" / "worktrees" / "wt"
        worktree_git.mkdir(parents=True)
        (worktree_git / "HEAD").write_text("0123456789abcdef0123456789abcdef01234567\n", encoding="utf-8")
        checkout = root / "wt"
        checkout.mkdir()
        (checkout / ".git").write_text("gitdir: ../repo/.git/worktrees/wt\n", encoding="utf-8")
        self.assertEqual(revision.read_git(checkout)["commit"], "0123456789abcdef0123456789abcdef01234567")

    def test_the_app_version_from_the_configuration_or_the_settings(self):
        with ts(APP_VERSION="1.2.3"), override_settings(APP_VERSION="9.9"):
            self.assertEqual(revision.app_version(), "1.2.3")
        with ts(APP_VERSION=""), override_settings(APP_VERSION="9.9"):
            self.assertEqual(revision.app_version(), "9.9")


class RouterTests(SimpleTestCase):
    def test_tickets_do_not_relate_to_project_models_in_a_separate_base(self):
        router = TicketShotRouter()
        self.assertFalse(router.allow_relation(Ticket(), Group()))
        with ts(DATABASE="default"):
            self.assertIsNone(router.allow_relation(Ticket(), Group()))


class SmallPieceTests(SimpleTestCase):
    def test_the_recording_shows_four_characters_of_the_tab(self):
        rows = timeline.rows([{"t": 0, "type": "click", "tab": "a1b2c3"}, {"t": 1, "type": "click"}])
        self.assertEqual([row["tab"] for row in rows], ["a1b2", ""])

    def test_the_url_template_comes_from_the_route_only_with_arguments_in_both(self):
        self.assertEqual(urltemplate.suggest("item/<int:pk>/", {}, "/item/5/").template, "/item/5/")
        self.assertEqual(urltemplate.suggest("", {"pk": 5}, "/item/5/").template, "/item/5/")
        # With a language prefix, resolved route differs from the URL.
        self.assertEqual(urltemplate.suggest("acerca/", {"pk": 5}, "/es/acerca/").template, "/es/acerca/")

    def test_tags_from_the_command_line(self):
        self.assertEqual(parse_tag_args(["cliente=un cliente=activo", "sin-igual"]), "cliente:un cliente=activo")


class UserTests(TicketShotTestCase):
    def test_who_the_user_is_without_querying_the_base(self):
        self.assertFalse(users.is_authenticated(None))
        self.assertEqual(users.summary(None), {"authenticated": False})
        user = make_user()
        user.first_name, user.last_name = "Ana", "Pérez"
        summary = users.summary(user)
        self.assertEqual((summary["authenticated"], summary["full_name"]), (True, "Ana Pérez"))
        bare = person(is_authenticated=True, pk=9, get_username=lambda: "bot")
        self.assertEqual(users.summary(bare), {"authenticated": True, "id": 9, "username": "bot",
                                               "full_name": "", "is_staff": False, "is_superuser": False})
        self.assertEqual(users.group_names(bare), [])

    def test_a_named_actor(self):
        self.assertEqual(users.Actor.named("Equipo", "eq"), users.Actor("eq", "Equipo"))
        self.assertEqual(users.Actor.named(None), users.Actor("", ""))


class DestinationTests(TicketShotTestCase):
    def test_where_the_tickets_go(self):
        self.assertNotIn("@", destination.describe()["where"])
        remote = {"ENGINE": "django.db.backends.postgresql", "USER": "u", "HOST": "h", "PORT": "5432", "NAME": "db"}
        with mock.patch.dict("django.conf.settings.DATABASES", {"remota": remote}), ts(DATABASE="remota"):
            self.assertEqual(destination.describe()["where"], "u@h:5432/db")

    def test_a_remote_base_needs_yes(self):
        info = {**destination.describe(), "remote": True}
        command = SimpleNamespace(stdout=StringIO())
        with self.assertRaises(CommandError):
            destination.require_yes(command, False, info)
        destination.require_yes(command, True, info)
        destination.require_yes(command, False, {**info, "remote": False})


class CommandTests(TicketShotTestCase):
    def test_create_requires_url_and_device(self):
        shot = Path(tempfile.mkdtemp(prefix="ticketshot-skill-")) / "antes.png"
        shot.write_bytes(png(400, 300))
        with self.assertRaisesRegex(CommandError, "--url"):
            run("ticketshot_create", "--device", "desktop", "--note", "x", "--image", str(shot))
        with self.assertRaisesRegex(CommandError, "--device"):
            run("ticketshot_create", "--url", "/x/", "--note", "x", "--image", str(shot))

    def test_config_shows_the_review_url_or_that_it_is_empty(self):
        self.assertIn("URL de revisión: https://staging.example.test", run("ticketshot_config"))
        with ts(REVIEW_URL=""):
            self.assertIn("URL de revisión: (vacía)", run("ticketshot_config"))

    def test_doctor_counts_every_problem(self):
        with override_settings(DATABASE_ROUTERS=[]), ts(STORAGE="media"):
            out = run("ticketshot_doctor")
        self.assertIn("Falta ticketshot.routers.TicketShotRouter en DATABASE_ROUTERS.", out)
        self.assertIn("El modo media es solo para pruebas locales (DEBUG).", out)
        self.assertIn("2 problemas.", out)

    def test_doctor_media_is_fine_in_debug_or_when_allowed(self):
        with ts(STORAGE="media"), override_settings(DEBUG=True):
            self.assertNotIn("solo para pruebas locales", run("ticketshot_doctor"))
        with ts(STORAGE="media", MEDIA_ALLOWED=True):
            self.assertNotIn("solo para pruebas locales", run("ticketshot_doctor"))

    def test_doctor_routers_matter_only_for_a_separate_base(self):
        with override_settings(DATABASE_ROUTERS=[]), ts(DATABASE="default"):
            self.assertNotIn("DATABASE_ROUTERS", run("ticketshot_doctor"))

    def test_doctor_counts_only_pending_ticketshot_migrations(self):
        plan = [(SimpleNamespace(app_label="ticketshot"), False), (SimpleNamespace(app_label="ticketshot"), False),
                (SimpleNamespace(app_label="otra"), False)]
        executor = mock.Mock()
        executor.migration_plan.return_value = plan
        with mock.patch("ticketshot.management.commands.ticketshot_doctor.MigrationExecutor", return_value=executor):
            self.assertIn("faltan 2 migraciones de ticketshot", run("ticketshot_doctor"))
