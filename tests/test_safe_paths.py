import re
from html.parser import HTMLParser

from django.test import Client

from ticketshot import conf, urltemplate, users, workflow

from .helpers import REVIEWER, TicketShotTestCase, make_user, ts


class Links(HTMLParser):
    def __init__(self):
        super().__init__()
        self.links = []
        self.iframes = []

    def handle_starttag(self, tag, attrs):
        values = dict(attrs)
        if tag == "a":
            self.links.append(values)
        if tag == "iframe":
            self.iframes.append(values)


@ts(PROJECT="rutas-seguras")
class SafePathTests(TicketShotTestCase):
    def setUp(self):
        self.reviewer = make_user("revisora-seguridad", perms=REVIEWER)
        self.client.force_login(self.reviewer)

    def test_relative_normalizes_browser_navigation(self):
        cases = {
            "/\\evil.test/x": "/x",
            "//evil.test/x": "/x",
            "/\t/evil.test": "/",
            "https://otro.test/a?b=1": "/a?b=1",
            "/customers/42/?tab=2": "/customers/42/?tab=2",
            "/ruta con espacio/?q=dos palabras": "/ruta con espacio/?q=dos palabras",
            "  /normal/\n?x=1  ": "/normal/?x=1",
        }
        for url, expected in cases.items():
            with self.subTest(url=url):
                self.assertEqual(urltemplate.relative(url), expected)

    def test_saved_unsafe_paths_have_no_navigation_targets(self):
        ticket = self.raise_ticket()
        workflow.set_status(ticket, "in_review", users.Actor.named("equipo"))
        for path in ("/\\evil.test/x", "//evil.test/x", "/\t/evil.test", "/\n/evil.test",
                     "https://otro.test/a?b=1"):
            with self.subTest(path=path):
                ticket.trigger_path = path
                ticket.save(using=conf.database(), update_fields=["trigger_path"])
                for url in ("/__ticketshot/panel/queue/", f"/__ticketshot/panel/{ticket.key}/"):
                    response = self.client.get(url)
                    self.assertEqual(response.status_code, 200)
                    html = response.content.decode()
                    parsed = Links()
                    parsed.feed(html)
                    self.assertIn("La ruta guardada de este ticket no es segura", html)
                    self.assertEqual(parsed.iframes, [])
                    hrefs = [link.get("href", "") for link in parsed.links]
                    self.assertNotIn(path, hrefs)
                    self.assertFalse(any("#ticketshot-compare=" in href for href in hrefs))
                    self.assertFalse(any("#ticketshot-chain=" in href for href in hrefs))

    def test_queue_iframe_uses_exact_safe_path(self):
        ticket = self.raise_ticket()
        workflow.set_status(ticket, "in_review", users.Actor.named("equipo"))
        ticket.trigger_path = "/customers/42/?tab=2"
        ticket.save(using=conf.database(), update_fields=["trigger_path"])
        parsed = Links()
        parsed.feed(self.client.get("/__ticketshot/panel/queue/").content.decode())
        self.assertEqual([frame["src"] for frame in parsed.iframes], [ticket.trigger_path])

    def test_board_action_requires_csrf_token_from_page(self):
        strict = Client(enforce_csrf_checks=True)
        strict.force_login(self.reviewer)
        ticket = self.raise_ticket()
        workflow.set_status(ticket, "in_review", users.Actor.named("equipo"))
        board = strict.get("/__ticketshot/panel/")
        self.assertEqual(board.status_code, 200)
        action = f"/__ticketshot/tickets/{ticket.key}/action/"
        data = {"action": "approve"}
        self.assertEqual(strict.post(action, data, HTTP_X_REQUESTED_WITH="ticketshot").status_code, 403)
        token = re.search(r'name="csrfmiddlewaretoken" value="([^"]+)"', board.content.decode())
        self.assertIsNotNone(token)
        response = strict.post(action, data, HTTP_X_REQUESTED_WITH="ticketshot",
                               HTTP_X_CSRFTOKEN=token.group(1))
        self.assertEqual(response.status_code, 200, response.content)
        self.assertEqual(response.json()["ticket"]["status"], "approved")
