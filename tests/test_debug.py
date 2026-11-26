from ticketshot.models import DebugRecord, Ticket

from .helpers import REVIEWER, TicketShotTestCase, json_upload, make_user, ts

PERMS_DEBUG = REVIEWER + ("view_debug",)
REC = "2f1c0b8e-4a8a-4f7e-9f00-123456789abc"


class DebugRecordTests(TicketShotTestCase):
    def setUp(self):
        self.tester = make_user()
        self.client.force_login(self.tester)

    def recording(self, rec=REC):
        self.client.cookies["ticketshot_rec"] = rec

    def test_no_record_without_the_cookie(self):
        self.client.get("/page/")
        self.assertFalse(DebugRecord.objects.exists())

    def test_records_each_request_of_the_recording(self):
        self.recording()
        session = self.client.session
        session["carrito"] = [1, 2]
        session["api_token"] = "secreto-de-sesion"
        session.save()
        self.client.post("/save/", {"nombre": "Ana", "password": "nunca", "telefono": "5512345678"})
        record = DebugRecord.objects.get()
        self.assertEqual(record._state.db, "ticketshot")
        self.assertEqual(record.recording_id, REC)
        self.assertEqual(record.username, "probador")
        self.assertEqual(record.method, "POST")
        self.assertEqual(record.view_name, "save")
        data = record.data
        self.assertEqual(data["request"]["post"]["nombre"], ["'Ana'"])
        # Django's filter masks sensitive values.
        self.assertNotIn("nunca", str(data))
        self.assertNotIn("secreto-de-sesion", str(data))
        self.assertEqual(data["session"]["carrito"], "[1, 2]")
        # Touched records and primary database queries.
        self.assertTrue(any(w["model"] == "auth.Group" and w["action"] == "alta" for w in data["writes"]))
        self.assertGreaterEqual(data["sql"]["writes"], 1)
        self.assertTrue(any("auth_group" in q["sql"] for q in data["sql"]["queries"]))
        # Template context.
        self.assertEqual(data["templates"][0]["name"], "page.html")
        self.assertIn("pk", data["templates"][0]["context"])

    def test_the_record_measures_the_request_and_skips_the_tickets_base(self):
        self.recording()
        self.client.get("/touches-tickets/")
        record = DebugRecord.objects.get()
        self.assertGreater(record.duration_ms, 0)
        sql = record.data["sql"]
        self.assertEqual(sql["count"], len(sql["queries"]))
        self.assertTrue(any("auth_group" in q["sql"] for q in sql["queries"]))
        self.assertFalse(any("ticketshot_ticket" in q["sql"] for q in sql["queries"]))

    def test_an_exception_keeps_the_yellow_page_text(self):
        self.recording()
        self.client.raise_request_exception = False
        response = self.client.get("/boom/")
        self.assertEqual(response.status_code, 500)
        record = DebugRecord.objects.get()
        self.assertTrue(record.failed)
        self.assertIn("ZeroDivisionError", record.data["exception"])
        self.assertIn("Traceback", record.data["exception"])

    def test_without_permission_nothing_is_recorded(self):
        self.client.force_login(make_user("nadie", perms=()))
        self.recording()
        self.client.get("/page/")
        self.assertFalse(DebugRecord.objects.exists())

    def test_invalid_cookie_is_ignored(self):
        self.recording("<script>")
        self.client.get("/page/")
        self.assertFalse(DebugRecord.objects.exists())

    @ts(DEBUG_RECORD=False)
    def test_switch_off(self):
        self.recording()
        self.client.get("/page/")
        self.assertFalse(DebugRecord.objects.exists())

    @ts(DEBUG_RECORD_MAX_REQUESTS=2)
    def test_cap_per_recording(self):
        self.recording()
        for _ in range(4):
            self.client.get("/page/")
        self.assertEqual(DebugRecord.objects.count(), 2)

    @ts(DEBUG_RECORD_MAX_BYTES=4000)
    def test_big_records_are_trimmed(self):
        self.recording()
        self.client.get("/many-queries/")
        record = DebugRecord.objects.get()
        self.assertTrue(record.data["sql"].get("truncated"))

    def test_the_recording_ticket_takes_its_records_and_only_debuggers_see_them(self):
        self.recording()
        self.client.get("/item/5/")
        self.client.get("/page/")
        del self.client.cookies["ticketshot_rec"]
        payload, files = self.note_payload(images=2, kind="recording", recordingId=REC)
        files["events"] = json_upload("events.json", [{"t": 0, "type": "start"}])
        ticket = Ticket.objects.get(pk=self.post(payload, files).json()["id"])
        self.assertEqual(ticket.recording_id, REC)
        self.assertEqual(ticket.debug_records.count(), 2)
        record = ticket.debug_records.first()

        self.client.force_login(make_user("revisora", perms=REVIEWER))
        html = self.client.get(f"/__ticketshot/panel/{ticket.key}/").content.decode()
        self.assertNotIn("Registro de depuración", html)
        self.assertEqual(self.client.get(f"/__ticketshot/panel/{ticket.key}/debug/{record.pk}/").status_code, 403)

        self.client.force_login(make_user("dev", perms=PERMS_DEBUG))
        html = self.client.get(f"/__ticketshot/panel/{ticket.key}/").content.decode()
        self.assertIn("Registro de depuración", html)
        page = self.client.get(f"/__ticketshot/panel/{ticket.key}/debug/{record.pk}/")
        self.assertEqual(page.status_code, 200)
        self.assertIn("page.html", page.content.decode())

    def test_records_of_someone_else_are_not_taken(self):
        self.recording()
        self.client.get("/page/")
        other = make_user("otro")
        self.client.force_login(other)
        del self.client.cookies["ticketshot_rec"]
        payload, files = self.note_payload(kind="recording", recordingId=REC)
        ticket = Ticket.objects.get(pk=self.post(payload, files).json()["id"])
        self.assertEqual(ticket.debug_records.count(), 0)
