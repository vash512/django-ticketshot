"""Display language without changing status keys or stored data."""

import re

from django.utils.translation import override

from .helpers import REVIEWER, TicketShotTestCase, config_of, make_user, ts

PROBE = re.compile(r"<p id='probe'>(.*?)</p>")


class ProjectLanguageTests(TicketShotTestCase):
    """The bar's language must never leak into the project's own views."""

    def setUp(self):
        self.client.force_login(make_user(perms=REVIEWER))

    def probe(self):
        response = self.client.get("/locale-probe/")
        return PROBE.search(response.content.decode()).group(1), response

    def test_a_spanish_variant_keeps_its_language_and_formats(self):
        with override("es-mx"), ts():
            seen, response = self.probe()
        self.assertEqual(seen, "es-mx|6.00")
        self.assertEqual(config_of(response)["language"], "es")

    def test_another_language_is_not_switched_to_english(self):
        with override("fr"), ts():
            seen, response = self.probe()
        self.assertEqual(seen, "fr|6,00")
        self.assertEqual(config_of(response)["language"], "en")

    def test_a_disabled_bar_leaves_the_language_alone(self):
        with override("es-mx"), ts(ENABLED=False):
            seen, _response = self.probe()
        self.assertEqual(seen, "es-mx|6.00")


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

