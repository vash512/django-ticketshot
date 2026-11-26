"""Display language without changing status keys or stored data."""

from django.utils.translation import override

from .helpers import REVIEWER, TicketShotTestCase, config_of, make_user, ts


class LanguageTests(TicketShotTestCase):
    def setUp(self):
        self.user = make_user(perms=REVIEWER)
        self.client.force_login(self.user)

    def test_spanish_for_mexican_spanish(self):
        with override("es-mx"), ts():
            html = self.client.get("/__ticketshot/panel/").content.decode()
            self.assertIn("Tablero de tickets", html)
            self.assertEqual(config_of(self.client.get("/page/"))["language"], "es")

    def test_french_uses_english(self):
        with override("fr"), ts():
            html = self.client.get("/__ticketshot/panel/").content.decode()
            self.assertIn("Ticket board", html)
            self.assertIn('lang="en"', html)
            self.assertEqual(config_of(self.client.get("/page/"))["language"], "en")
            error = self.client.get("/__ticketshot/tickets/open/", {"path": "bad"}).json()
            self.assertEqual(error["error"], "The path must start with '/'.")

    def test_english_uses_english(self):
        with override("en"), ts():
            html = self.client.get("/__ticketshot/panel/").content.decode()
            self.assertIn("Ticket board", html)
            self.assertEqual(config_of(self.client.get("/page/"))["language"], "en")

