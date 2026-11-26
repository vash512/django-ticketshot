from ticketshot import keys, queries, users, workflow

from .helpers import REVIEWER, TEAM, TicketShotTestCase, make_user


class PanelTests(TicketShotTestCase):
    def setUp(self):
        self.tester = make_user()
        self.client.force_login(self.tester)
        self.first = self.raise_ticket()
        self.second = self.raise_ticket(path="/page/", note="Falta el total en celular.", device="mobile")
        workflow.set_status(self.second, "in_review", users.Actor.named("equipo"))
        self.reviewer = make_user("revisora", perms=REVIEWER)
        self.team = make_user("equipo", perms=TEAM)

    def test_login_and_permission(self):
        self.client.logout()
        response = self.client.get("/__ticketshot/panel/")
        self.assertEqual(response.status_code, 302)
        self.assertIn("/login/", response["Location"])
        self.client.force_login(self.tester)
        self.assertEqual(self.client.get("/__ticketshot/panel/").status_code, 403)

    def test_list_puts_review_first_with_counts(self):
        self.client.force_login(self.reviewer)
        html = self.client.get("/__ticketshot/panel/", {"view": "list"}).content.decode()
        self.assertLess(html.index("TS-2"), html.index("TS-1"))
        self.assertIn("Por revisar <span class=\"tsp-count\">1</span>", html)
        self.assertIn("Abiertos <span class=\"tsp-count\">2</span>", html)
        self.assertIn("Novedades", html)

    def test_filters(self):
        self.client.force_login(self.reviewer)
        html = self.client.get("/__ticketshot/panel/", {"view": "list", "status": "in-review"}).content.decode()
        self.assertIn("TS-2", html)
        self.assertNotIn("TS-1 ", html.replace("TS-1</", "TS-1 </"))
        html = self.client.get("/__ticketshot/panel/", {"view": "list", "q": "total"}).content.decode()
        self.assertIn("TS-2", html)
        self.assertNotIn(">TS-1<", html)
        html = self.client.get("/__ticketshot/panel/", {"view": "list", "device": "mobile"}).content.decode()
        self.assertIn(">TS-2<", html)
        self.assertNotIn(">TS-1<", html)
        html = self.client.get("/__ticketshot/panel/", {"view": "list", "q": "TS-1"}).content.decode()
        self.assertIn(">TS-1<", html)

    def test_detail_for_a_reviewer_offers_the_decision(self):
        self.client.force_login(self.reviewer)
        response = self.client.get("/__ticketshot/panel/TS-2/")
        self.assertEqual(response.status_code, 200)
        html = response.content.decode()
        self.assertIn("Tu revisión", html)
        self.assertIn("/page/#ticketshot-compare=TS-2", html)
        self.assertIn("/page/#ticketshot-chain=TS-2", html)
        self.assertIn(f"/__ticketshot/images/{self.second.images.get().pk}/", html)
        self.assertNotIn("Registro de depuración", html)
        self.assertNotIn("Guardar URL replicable", html)
        # Opening a ticket marks it as seen.
        self.assertEqual(queries.news([self.second], "revisora"), {self.second.pk: False})

    def test_detail_for_the_team(self):
        self.client.force_login(self.team)
        html = self.client.get("/__ticketshot/panel/TS-1/").content.decode()
        self.assertNotIn("Tu revisión", html)
        self.assertIn("Pasar a «En desarrollo»", html)
        self.assertIn("Guardar URL replicable", html)
        self.assertIn("/item/{pk}/", html)

    def test_unknown_ticket(self):
        self.client.force_login(self.reviewer)
        self.assertEqual(self.client.get("/__ticketshot/panel/TS-99/").status_code, 404)

    def test_panel_is_responsive_markup(self):
        self.client.force_login(self.reviewer)
        html = self.client.get("/__ticketshot/panel/").content.decode()
        self.assertIn('name="viewport"', html)
        self.assertIn("/static/ticketshot/panel.css", html)
