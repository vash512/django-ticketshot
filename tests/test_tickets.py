import json
import shutil
import tempfile
import time
from unittest import mock
from io import BytesIO
from pathlib import Path

from django.conf import settings
from django.core.files.storage import storages
from django.db import connections
from django.test import Client
from PIL import Image

from ticketshot import pagecontext
from ticketshot.models import Ticket, TicketEvent, TicketImage

from .helpers import (CONFIG, ENDPOINT, REVIEWER, TEAM, TicketShotTestCase, json_upload,
                      make_user, png, ts, upload)


class CreateTicketTests(TicketShotTestCase):
    def setUp(self):
        self.user = make_user()
        self.client.force_login(self.user)

    def test_creates_ticket_in_the_parallel_database(self):
        payload, files = self.note_payload(path="/item/5/?tab=2")
        files["logs"] = json_upload("logs.json", [{"type": "console", "message": "fallo"}])
        response = self.post(payload, files)
        self.assertEqual(response.status_code, 201, response.content)
        data = response.json()
        ticket = Ticket.objects.get(pk=data["id"])
        self.assertEqual(ticket._state.db, "ticketshot")
        self.assertEqual(data["key"], "TS-1")
        self.assertEqual(ticket.project, "pruebas")
        self.assertEqual(ticket.status, Ticket.Status.REQUESTED)
        self.assertEqual(ticket.author_username, "probador")
        self.assertEqual(ticket.author_label, "Ana Prueba (probador)")
        self.assertTrue(ticket.context_verified)
        self.assertEqual(ticket.view_name, "item")
        self.assertEqual(ticket.route, "item/<int:pk>/")
        self.assertEqual(ticket.trigger_path, "/item/5/?tab=2")
        # Suggest reproducible templates from resolved route patterns.
        self.assertEqual(ticket.url_template, "/item/{pk}/")
        self.assertEqual(ticket.url_tags, {"pk": "(en la captura: 5)"})
        self.assertEqual(ticket.device, Ticket.Device.DESKTOP)
        self.assertEqual(ticket.base_url, "http://testserver")
        self.assertEqual(ticket.logs[0]["message"], "fallo")
        image = ticket.images.get()
        self.assertEqual((image.width, image.height), (40, 30))
        self.assertTrue(image.edited)
        self.assertEqual(image.redactions, 2)
        self.assertTrue(image.image.name.endswith(".webp"))
        self.assertTrue(storages["ticketshot"].exists(image.image.name))
        created = ticket.history.get()
        self.assertEqual(created.kind, TicketEvent.Kind.CREATED)
        # Keep ticketshot tables out of the primary database.
        tables = connections["default"].introspection.table_names()
        self.assertNotIn("ticketshot_ticket", tables)

    def test_author_groups_are_read_when_the_ticket_is_raised(self):
        from django.contrib.auth.models import Group
        self.user.groups.add(Group.objects.create(name="Revisoras"))
        payload, files = self.note_payload()
        response = self.post(payload, files)
        self.assertEqual(response.status_code, 201, response.content)
        self.assertEqual(Ticket.objects.get().author_groups, ["Revisoras"])

    def test_numbers_are_per_project(self):
        first = self.raise_ticket()
        second = self.raise_ticket()
        self.assertEqual((first.key, second.key), ("TS-1", "TS-2"))
        with ts(PROJECT="otro"):
            other = self.raise_ticket()
        self.assertEqual(other.key, "TS-1")
        self.assertEqual(other.project, "otro")

    def test_device_from_the_payload_or_the_screen(self):
        self.assertEqual(self.raise_ticket(device="both").device, "both")
        payload, files = self.note_payload(client={"viewport": {"width": 390, "height": 844}})
        response = self.post(payload, files)
        self.assertEqual(Ticket.objects.get(pk=response.json()["id"]).device, "mobile")

    def test_image_device_is_kept(self):
        payload, files = self.note_payload(images=2, device="both")
        payload["images"][0]["device"] = "desktop"
        payload["images"][1]["device"] = "mobile"
        ticket = Ticket.objects.get(pk=self.post(payload, files).json()["id"])
        self.assertEqual(list(ticket.images.values_list("device", flat=True)), ["desktop", "mobile"])

    def test_a_stack_of_images_under_one_ticket(self):
        ticket = self.raise_ticket(images=4)
        self.assertEqual(list(ticket.images.values_list("position", flat=True)), [0, 1, 2, 3])
        names = list(ticket.images.values_list("image", flat=True))
        folders = {name.rsplit("/", 1)[0] for name in names}
        self.assertEqual(len(folders), 1)
        self.assertRegex(folders.pop(), rf"^tickets/pruebas/\d{{4}}/\d{{2}}/{ticket.pk}-[0-9a-f]{{16}}$")

    def test_chaining_to_an_open_ticket(self):
        parent = self.raise_ticket()
        child = self.raise_ticket(parent=parent.key)
        self.assertEqual(child.parent, parent)
        self.assertTrue(parent.history.filter(kind=TicketEvent.Kind.CHAINED,
                                              data__child=child.key).exists())
        parent.refresh_from_db()
        self.assertEqual(parent.status, Ticket.Status.REQUESTED)

    def test_chaining_as_a_rejection_needs_the_approve_permission(self):
        parent = self.raise_ticket()
        parent.status = Ticket.Status.IN_REVIEW
        parent.save()
        self.raise_ticket(parent=parent.key, rejectParent=True)
        parent.refresh_from_db()
        # A tester without approval permission cannot reject.
        self.assertEqual(parent.status, Ticket.Status.IN_REVIEW)
        reviewer = make_user("revisora", perms=REVIEWER)
        self.client.force_login(reviewer)
        child = self.raise_ticket(parent=parent.key, rejectParent=True)
        parent.refresh_from_db()
        self.assertEqual(parent.status, Ticket.Status.REQUESTED)
        rejected = parent.history.get(kind=TicketEvent.Kind.REJECTED)
        self.assertEqual(rejected.data["chained"], child.key)

    def test_unknown_parent_is_rejected(self):
        payload, files = self.note_payload(parent="TS-99")
        response = self.post(payload, files)
        self.assertEqual(response.status_code, 400)
        self.assertIn("TS-99", response.json()["error"])

    def test_deleting_a_ticket_deletes_its_files(self):
        ticket = self.raise_ticket(images=2)
        names = list(ticket.images.values_list("image", flat=True))
        self.assertTrue(all(storages["ticketshot"].exists(n) for n in names))
        with self.captureOnCommitCallbacks(using="ticketshot", execute=True):
            ticket.delete()
        self.assertFalse(any(storages["ticketshot"].exists(n) for n in names))

    def test_note_is_required(self):
        payload, files = self.note_payload(note="   ")
        response = self.post(payload, files)
        self.assertEqual(response.status_code, 400)
        self.assertIn("cambiar", response.json()["error"])
        self.assertFalse(Ticket.objects.exists())

    def test_a_capture_is_required(self):
        payload, files = self.note_payload(images=0)
        self.assertEqual(self.post(payload, files).status_code, 400)

    def test_image_limit(self):
        payload, files = self.note_payload(images=11)
        response = self.post(payload, files)
        self.assertEqual(response.status_code, 400)
        self.assertIn("10", response.json()["error"])

    def test_announced_image_must_be_present(self):
        payload, files = self.note_payload(images=2)
        files.pop("image_1")
        self.assertEqual(self.post(payload, files).status_code, 400)

    def test_rejects_a_file_that_is_not_an_image_and_saves_nothing(self):
        payload, files = self.note_payload(images=2)
        files["image_1"] = upload("image_1.png", b"no soy una imagen")
        response = self.post(payload, files)
        self.assertEqual(response.status_code, 400)
        self.assertFalse(Ticket.objects.exists())

    @ts(MAX_IMAGE_PIXELS=100)
    def test_rejects_huge_images(self):
        payload, files = self.note_payload()
        response = self.post(payload, files)
        self.assertEqual(response.status_code, 400)
        self.assertIn("demasiado grande", response.json()["error"])

    def test_metadata_is_removed(self):
        payload, files = self.note_payload()
        files["image_0"] = upload("image_0.jpg", png(exif=True, fmt="JPEG"), "image/jpeg")
        self.assertEqual(self.post(payload, files).status_code, 201)
        image = TicketImage.objects.get()
        with image.image.open("rb") as handle:
            stored = Image.open(BytesIO(handle.read()))
            self.assertEqual(stored.format, "WEBP")
            self.assertFalse(stored.getexif())

    def test_bad_token_is_kept_but_marked_unverified(self):
        ticket = self.raise_ticket(token="falso")
        self.assertFalse(ticket.context_verified)
        self.assertEqual(ticket.server_context, {})

    def test_user_without_permission_cannot_send(self):
        payload, files = self.note_payload()
        self.client.force_login(make_user("otra", perms=()))
        self.assertEqual(self.post(payload, files).status_code, 403)

    def test_anonymous_cannot_send(self):
        payload, files = self.note_payload()
        self.client.logout()
        self.assertEqual(self.post(payload, files).status_code, 403)

    def test_csrf_is_enforced(self):
        payload, files = self.note_payload()
        strict = Client(enforce_csrf_checks=True)
        strict.force_login(self.user)
        self.assertEqual(self.post(payload, files, client=strict).status_code, 403)

    def test_csrf_token_from_the_page_is_accepted(self):
        strict = Client(enforce_csrf_checks=True)
        strict.force_login(self.user)
        html = strict.get("/item/5/").content.decode()
        cfg = json.loads(CONFIG.search(html).group(1))
        payload, files = self.note_payload()
        data = {"payload": json.dumps(payload), **files}
        response = strict.post(ENDPOINT, data, HTTP_X_CSRFTOKEN=cfg["csrf"])
        self.assertEqual(response.status_code, 201, response.content)

    @ts(ENABLED=False)
    def test_disabled_endpoint_is_404(self):
        payload, files = self.note_payload(token="")
        self.assertEqual(self.post(payload, files).status_code, 404)


class RecordingTests(TicketShotTestCase):
    def setUp(self):
        self.user = make_user()
        self.client.force_login(self.user)

    def test_recording_with_events_visited_urls_and_verified_page_loads(self):
        token = self.page_token("/item/5/")
        other = self.page_token("/page/")
        events = [
            {"t": 0, "type": "start", "tab": "a1"},
            {"t": 5, "type": "page", "tab": "a1", "token": token, "url": "/item/5/"},
            {"t": 900, "type": "click", "target": "button.cobrar", "label": "Cobrar"},
            {"t": 1500, "type": "page", "tab": "a1", "token": other, "url": "/page/"},
            {"t": 1600, "type": "page", "tab": "b2", "token": "manipulado", "url": "/page/"},
            {"t": 2000, "type": "stop"},
        ]
        roles = ["start", "step", "step", "end"]
        payload, files = self.note_payload(images=4, token=token, kind="recording", durationMs=2000)
        for meta, role in zip(payload["images"], roles):
            meta["role"] = role
        payload["images"][3]["pageUrl"] = "http://testserver/page/"
        files["events"] = json_upload("events.json", events)
        response = self.post(payload, files)
        self.assertEqual(response.status_code, 201, response.content)
        ticket = Ticket.objects.get()
        self.assertEqual(ticket.kind, "recording")
        self.assertEqual(ticket.duration_ms, 2000)
        # Trigger URL is first; visited URLs retain order.
        self.assertEqual(ticket.trigger_path, "/item/5/")
        self.assertEqual(ticket.visited_urls, ["/item/5/", "/page/"])
        self.assertEqual(list(ticket.images.values_list("role", flat=True)), roles)
        pages = [e for e in ticket.events if e["type"] == "page"]
        self.assertEqual(pages[0]["server"]["view"], "item")
        self.assertEqual(pages[1]["server"]["view"], "page")
        self.assertTrue(pages[0]["verified"])
        self.assertFalse(pages[2]["verified"])
        self.assertNotIn("token", json.dumps(ticket.events))

    def test_recording_allows_start_eight_steps_and_end(self):
        payload, files = self.note_payload(images=10, kind="recording")
        self.assertEqual(self.post(payload, files).status_code, 201)

    def test_recording_rejects_more_than_ten_images(self):
        payload, files = self.note_payload(images=11, kind="recording")
        self.assertEqual(self.post(payload, files).status_code, 400)

    @ts(MAX_JSON_BYTES=50)
    def test_events_file_size_is_capped(self):
        payload, files = self.note_payload(kind="recording")
        files["events"] = json_upload("events.json", [{"type": "click", "label": "x" * 100}])
        self.assertEqual(self.post(payload, files).status_code, 400)


class StorageAndServingTests(TicketShotTestCase):
    def setUp(self):
        self.tester = make_user()
        self.client.force_login(self.tester)

    def create(self):
        return self.raise_ticket().images.get()

    def test_viewer_gets_the_image(self):
        image = self.create()
        self.client.force_login(make_user("equipo", perms=TEAM))
        response = self.client.get(f"/__ticketshot/images/{image.pk}/")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response["Content-Type"], "image/webp")
        self.assertIn("private", response["Cache-Control"])
        self.assertTrue(b"".join(response.streaming_content).startswith(b"RIFF"))

    def test_tester_without_view_permission_cannot_see_images(self):
        image = self.create()
        self.assertEqual(self.client.get(f"/__ticketshot/images/{image.pk}/").status_code, 403)

    def test_image_of_another_project_is_404(self):
        image = self.create()
        self.client.force_login(make_user("equipo", perms=TEAM))
        with ts(PROJECT="otro"):
            self.assertEqual(self.client.get(f"/__ticketshot/images/{image.pk}/").status_code, 404)

    def test_media_mode_has_no_public_url_and_stays_reachable(self):
        location = tempfile.mkdtemp(prefix="ticketshot-media-")
        self.addCleanup(shutil.rmtree, location, True)
        with ts(STORAGE="media", MEDIA_LOCATION=location):
            image = self.create()
            self.assertTrue((Path(location) / image.image.name).exists())
            with self.assertRaises(ValueError):
                image.image.url  # noqa: B018 - no public URL
        # Each image remembers its storage mode across changes.
        self.client.force_login(make_user("equipo", perms=TEAM))
        with ts(MEDIA_LOCATION=location):
            self.assertEqual(self.client.get(f"/__ticketshot/images/{image.pk}/").status_code, 200)

    @ts(SERVE="redirect")
    def test_redirect_mode_for_remote_storages(self):
        image = self.create()
        self.client.force_login(make_user("equipo", perms=TEAM))
        response = self.client.get(f"/__ticketshot/images/{image.pk}/")
        # InMemoryStorage is not local and redirects to its URL.
        self.assertEqual(response.status_code, 302)


class AdminTests(TicketShotTestCase):
    def test_changelist_and_change_page_open_read_only(self):
        tester = make_user()
        self.client.force_login(tester)
        payload, files = self.note_payload(images=2)
        files["events"] = json_upload("events.json", [{"t": 1, "type": "click", "label": "Cobrar"}])
        self.post(payload, files)
        ticket = Ticket.objects.get()
        self.client.force_login(make_user("admin", perms=(), superuser=True))
        self.assertEqual(self.client.get("/admin/ticketshot/ticket/").status_code, 200)
        page = self.client.get(f"/admin/ticketshot/ticket/{ticket.pk}/change/")
        self.assertEqual(page.status_code, 200)
        html = page.content.decode()
        self.assertIn(f"/__ticketshot/images/{ticket.images.first().pk}/", html)
        self.assertIn("Clic", html)
        self.assertIn("/__ticketshot/panel/TS-1/", html)
        self.assertEqual(self.client.get("/admin/ticketshot/ticket/add/").status_code, 403)


class ChecksTests(TicketShotTestCase):
    def run_checks(self):
        from ticketshot.checks import check_configuration
        return {issue.id for issue in check_configuration(None)}

    def test_test_configuration_is_clean(self):
        self.assertEqual(self.run_checks(), set())

    @ts(STORAGE="media")
    def test_media_mode_outside_debug_is_an_error(self):
        self.assertEqual(self.run_checks(), {"ticketshot.E005"})

    def test_media_mode_in_debug_is_fine(self):
        with self.settings(DEBUG=True), ts(STORAGE="media"):
            self.assertEqual(self.run_checks(), set())

    @ts(STORAGE="s3")
    def test_unknown_mode(self):
        self.assertEqual(self.run_checks(), {"ticketshot.E001"})

    @ts(STORAGE_ALIAS="nada")
    def test_missing_alias(self):
        self.assertIn("ticketshot.E002", self.run_checks())

    @ts(DATABASE="nada")
    def test_unknown_database(self):
        self.assertIn("ticketshot.E006", self.run_checks())

    def test_parallel_database_needs_the_router(self):
        with self.settings(DATABASE_ROUTERS=[]):
            self.assertIn("ticketshot.E007", self.run_checks())

    def test_middleware_before_auth(self):
        middleware = list(settings.MIDDLEWARE)
        middleware.remove("ticketshot.middleware.TicketShotMiddleware")
        middleware.insert(0, "ticketshot.middleware.TicketShotMiddleware")
        with self.settings(MIDDLEWARE=middleware):
            self.assertIn("ticketshot.E003", self.run_checks())

    def test_missing_middleware_warns(self):
        middleware = [m for m in settings.MIDDLEWARE if "ticketshot" not in m]
        with self.settings(MIDDLEWARE=middleware):
            self.assertIn("ticketshot.W001", self.run_checks())

    def test_unsign_rejects_old_tokens(self):
        token = pagecontext.sign({"v": 1})
        later = time.time() + 120
        with ts(PAGE_TOKEN_MAX_AGE=60), mock.patch("django.core.signing.time.time", return_value=later):
            self.assertEqual(pagecontext.unsign(token), ({}, False))
        self.assertEqual(pagecontext.unsign(token), ({"v": 1}, True))
