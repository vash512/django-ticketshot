"""Mask bar and skill URLs before storing them."""
import json
import shutil
import tempfile
from pathlib import Path

from ticketshot import submission, users
from ticketshot.models import Ticket

from .helpers import TicketShotTestCase, config_of, json_upload, make_user, png, ts


EMAIL = "ana@x.mx"
PHONE = "5512345678"
PATH = f"/u/{EMAIL}/?q=ana%40x.mx&tel={PHONE}"
URL = f"http://testserver{PATH}"
MASKED_PATH = "/u/(email)/?q=(email)&tel=(phone)"
MASKED_URL = f"http://testserver{MASKED_PATH}"


def stored_data(ticket):
    """Return every persisted ticket and capture field as JSON."""
    records = [ticket, *ticket.images.all()]
    return json.dumps([
        {field.name: getattr(record, field.attname) for field in record._meta.concrete_fields}
        for record in records
    ], ensure_ascii=False, default=str)


class BarFlowTests(TicketShotTestCase):
    def setUp(self):
        self.client.force_login(make_user())

    def create(self, *, path=PATH, token=None):
        payload, files = self.note_payload(path=path, token=token, kind="recording")
        payload["client"].update({"url": URL, "referrer": f"http://testserver/u/{EMAIL}/?old=1"})
        files["events"] = json_upload("events.json", [
            {"type": "page", "url": URL, "token": payload["pageToken"]},
            {"type": "network", "url": URL, "target": f"/api/{PHONE}/?email=ana%40x.mx"},
        ])
        # Console entries include page paths and, for errors,
        # the source file URL.
        files["logs"] = json_upload("logs.json", [
            {"type": "network", "url": URL, "message": "fallo", "page": f"/u/{EMAIL}/"},
            {"type": "error", "message": "x", "page": f"/u/{EMAIL}/", "source": f"/u/{EMAIL}/app.js:1:2"},
        ])
        response = self.post(payload, files)
        self.assertEqual(response.status_code, 201, response.content)
        return Ticket.objects.using("ticketshot").get(pk=response.json()["id"])

    def test_bar_masks_every_stored_url_and_route_value(self):
        response = self.client.get(PATH, HTTP_REFERER=f"http://testserver/u/{EMAIL}/?old=1")
        token = config_of(response)["pageToken"]
        context, ok = submission.pagecontext.unsign(token)
        self.assertTrue(ok)
        self.assertEqual(context["request"]["path"], "/u/(email)/")
        self.assertEqual(context["request"]["full_path"], MASKED_PATH)
        self.assertEqual(context["request"]["referer"], "http://testserver/u/(email)/?old=…")
        self.assertEqual(context["view"]["kwargs"], {"email": "(email)"})

        ticket = self.create(token=token)
        data = stored_data(ticket)
        self.assertNotIn(EMAIL, data)
        self.assertNotIn(PHONE, data)
        self.assertEqual(ticket.trigger_url, MASKED_URL)
        self.assertEqual(ticket.trigger_path, MASKED_PATH)
        self.assertEqual(ticket.images.get().page_url, MASKED_URL)
        self.assertEqual(ticket.client_context["url"], MASKED_URL)
        self.assertEqual(ticket.client_context["referrer"], "http://testserver/u/(email)/?old=1")
        self.assertEqual(ticket.server_context["request"]["full_path"], MASKED_PATH)
        self.assertEqual(ticket.server_context["request"]["referer"],
                         "http://testserver/u/(email)/?old=…")
        self.assertEqual(ticket.route_kwargs, {"email": "(email)"})
        self.assertEqual(ticket.visited_urls, [MASKED_PATH])
        self.assertEqual(ticket.events[0]["url"], MASKED_URL)
        self.assertEqual(ticket.events[1]["url"], MASKED_URL)
        self.assertEqual(ticket.events[1]["target"], "/api/(phone)/?email=(email)")
        self.assertEqual(ticket.logs[0]["url"], MASKED_URL)
        self.assertEqual(ticket.logs[1]["page"], "/u/(email)/")
        self.assertEqual(ticket.logs[1]["source"], "/u/(email)/app.js:1:2")
        self.assertEqual(ticket.url_template, "/u/{email}/")
        self.assertEqual(ticket.url_tags, {"email": "(en la captura: (email))"})

    def test_bar_masks_before_cutting_a_long_url(self):
        payload, files = self.note_payload(path="/u/public/")
        long_url = "http://testserver/" + "a" * 3973 + "/longlongana@x.mx"
        self.assertEqual(long_url.index("longlongana@x.mx"), 3992)
        payload["pageUrl"] = long_url
        payload["images"][0]["pageUrl"] = long_url
        response = self.post(payload, files)
        self.assertEqual(response.status_code, 201, response.content)
        ticket = Ticket.objects.using("ticketshot").get(pk=response.json()["id"])
        self.assertTrue(ticket.trigger_url.endswith("(email)"))
        self.assertTrue(ticket.images.get().page_url.endswith("(email)"))
        self.assertNotIn("longlongana", stored_data(ticket))

    def test_bar_keeps_complete_urls_when_setting_is_off(self):
        with ts():
            self.assertEqual(self.create().trigger_url, MASKED_URL)
        with ts(ANONYMIZE_URLS=False):
            ticket = self.create()
        data = stored_data(ticket)
        self.assertIn(EMAIL, data)
        self.assertIn(PHONE, data)
        self.assertEqual(ticket.trigger_url, URL)
        self.assertEqual(ticket.trigger_path, PATH)
        self.assertEqual(ticket.images.get().page_url, URL)
        self.assertEqual(ticket.client_context["url"], URL)
        self.assertEqual(ticket.route_kwargs, {"email": EMAIL})
        self.assertEqual(ticket.events[1]["target"], f"/api/{PHONE}/?email=ana%40x.mx")
        self.assertEqual(ticket.logs[0]["url"], URL)
        self.assertEqual(ticket.logs[1]["page"], f"/u/{EMAIL}/")
        self.assertEqual(ticket.logs[1]["source"], f"/u/{EMAIL}/app.js:1:2")

    def test_open_tickets_match_the_masked_exact_path_first(self):
        exact = self.create()
        other = self.create(path="/u/public/")
        response = self.client.get("/__ticketshot/tickets/open/", {"path": f"/u/{EMAIL}/"})
        self.assertEqual(response.status_code, 200)
        tickets = response.json()["tickets"]
        self.assertEqual(tickets[0]["key"], exact.key)
        self.assertTrue(tickets[0]["exact"])
        self.assertEqual(tickets[0]["path"], MASKED_PATH)
        self.assertEqual(tickets[1]["key"], other.key)
        self.assertFalse(tickets[1]["exact"])


class EventTargetTests(TicketShotTestCase):
    def test_only_network_targets_are_urls(self):
        # A click target describes a page element, not a URL.
        events = submission._verified_events([
            {"type": "click", "target": "tr#pedido-20261126001"},
            {"type": "network", "target": "/api/orders/20261126001/"},
        ])
        self.assertEqual(events[0]["target"], "tr#pedido-20261126001")
        self.assertEqual(events[1]["target"], "/api/orders/(phone)/")


class SkillFlowTests(TicketShotTestCase):
    def test_skill_masks_the_url_before_derived_fields(self):
        folder = Path(tempfile.mkdtemp(prefix="ticketshot-anonymize-"))
        self.addCleanup(shutil.rmtree, folder, True)
        shot = folder / "captura.png"
        shot.write_bytes(png())
        options = {"note_text": "Ajusta el encabezado.", "url": URL,
                   "images": [(shot, "desktop", "")], "device": "desktop",
                   "actor": users.Actor.named("equipo")}
        new = submission.from_files(**options)
        self.assertEqual(new.fields["trigger_url"], MASKED_URL)
        self.assertEqual(new.fields["trigger_path"], MASKED_PATH)
        self.assertEqual(new.fields["visited_urls"], [MASKED_PATH])
        self.assertEqual(new.images[0].fields["page_url"], MASKED_URL)
        with ts(ANONYMIZE_URLS=False):
            plain = submission.from_files(**options)
        self.assertEqual(plain.fields["trigger_url"], URL)
        self.assertEqual(plain.images[0].fields["page_url"], URL)
