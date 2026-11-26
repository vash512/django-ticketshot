"""Boundary cases for bar and skill submission validation."""
import json
import shutil
import tempfile
from pathlib import Path
from types import SimpleNamespace

from django.core.exceptions import ValidationError
from django.core.files.uploadedfile import SimpleUploadedFile

from ticketshot import conf, submission, users
from ticketshot.models import Ticket

from .helpers import TicketShotTestCase, make_user, png, ts


def image(sha256="abc"):
    return SimpleNamespace(clean=SimpleNamespace(sha256=sha256), fields={"role": "manual", "device": "desktop"})


class CoercionTests(TicketShotTestCase):
    def test_whole_numbers_admit_their_bounds_and_nothing_outside(self):
        self.assertEqual(submission.whole(0), 0)
        self.assertIsNone(submission.whole(-1))
        self.assertEqual(submission.whole(5, high=5), 5)
        self.assertIsNone(submission.whole(6, high=5))

    def test_the_screen_width_switches_to_mobile_below_the_breakpoint(self):
        width = conf.current().device_breakpoint
        self.assertEqual(submission._device(None, {"viewport": {"width": width}}), "desktop")
        self.assertEqual(submission._device(None, {"viewport": {"width": width - 1}}), "mobile")

    def test_browser_info_must_be_an_object_up_to_its_cap(self):
        self.assertEqual(submission._client({"client": [1]}), {})
        fits = {"a": "x" * (submission.MAX_CLIENT_BYTES - len('{"a": ""}'))}
        self.assertEqual(submission._client({"client": fits}), fits)
        self.assertEqual(submission._client({"client": {"a": fits["a"] + "x"}}), {})

    def test_a_recording_admits_its_steps_plus_start_and_end(self):
        with ts(RECORDING_MAX_STEPS=3, MAX_IMAGES=10):
            self.assertEqual(submission._image_limit("recording"), 5)
            self.assertEqual(submission._image_limit("note"), 10)

    def test_an_attached_list_is_admitted_up_to_its_cap(self):
        body = json.dumps([{"t": "x" * 50}]).encode()
        with ts(MAX_JSON_BYTES=len(body)):
            files = {"logs": SimpleUploadedFile("logs.json", body)}
            self.assertEqual(submission._json_file(files, "logs"), [{"t": "x" * 50}])
            with self.assertRaises(ValidationError):
                submission._json_file({"logs": SimpleUploadedFile("logs.json", body + b" ")}, "logs")


class FingerprintTests(TicketShotTestCase):
    FIELDS = {"kind": "note", "device": "desktop", "note": "Año y señal", "trigger_url": "/item/5/",
              "logs": [{"type": "console", "message": "x"}]}

    def test_the_fingerprint_does_not_change_between_versions(self):
        # Retries after package upgrades must keep the same fingerprint.
        self.assertEqual(submission.submission_hash(self.FIELDS, [image()], "TS-1", False),
                         "48c616d088b295cc6c263ae186d570cede63c921db2aeaad6bc5a2ad85577933")

    def test_the_order_of_keys_in_the_sent_json_does_not_matter(self):
        reordered = {**self.FIELDS, "logs": [{"message": "x", "type": "console"}]}
        self.assertEqual(submission.submission_hash(self.FIELDS, [image()], "TS-1", False),
                         submission.submission_hash(reordered, [image()], "TS-1", False))


class TriggerTests(TicketShotTestCase):
    def setUp(self):
        self.client.force_login(make_user())

    def test_the_trigger_is_the_page_url_or_else_the_first_capture(self):
        payload, files = self.note_payload(images=2)
        payload["pageUrl"] = "http://testserver/page/"
        self.assertEqual(self.post(payload, files).status_code, 201)
        payload, files = self.note_payload(images=2)
        del payload["pageUrl"]
        payload["images"][1]["pageUrl"] = "http://testserver/page/"
        self.assertEqual(self.post(payload, files).status_code, 201)
        self.assertEqual(list(Ticket.objects.order_by("number").values_list("trigger_path", flat=True)),
                         ["/page/", "/item/5/"])


class SkillTests(TicketShotTestCase):
    def setUp(self):
        folder = Path(tempfile.mkdtemp(prefix="ticketshot-skill-"))
        self.addCleanup(shutil.rmtree, folder, True)
        self.shot = folder / "antes.png"
        self.shot.write_bytes(png(400, 300))

    def from_files(self, images, **extra):
        return submission.from_files(note_text="Se movió el total.", url="/item/5/", images=images,
                                     device="desktop", actor=users.Actor.named("equipo"), **extra)

    def test_the_skill_admits_exactly_the_image_cap(self):
        with ts(MAX_IMAGES=2):
            self.assertEqual(len(self.from_files([(self.shot, "", "")] * 2).images), 2)
            with self.assertRaises(ValidationError):
                self.from_files([(self.shot, "", "")] * 3)

    def test_a_given_url_template_wins_over_the_suggested_one(self):
        new = self.from_files([(self.shot, "", "")], template="/item/{pieza}/", tags={"pieza": "5"})
        self.assertEqual(new.fields["url_template"], "/item/{pieza}/")
