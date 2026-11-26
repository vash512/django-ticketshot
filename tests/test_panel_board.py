from django.db import connections
from django.test.utils import CaptureQueriesContext
from django.urls import reverse

from ticketshot import conf, queries, users, workflow
from ticketshot.models import Ticket

from .helpers import REVIEWER, TEAM, TicketShotTestCase, make_user, ts


class PanelBoardTests(TicketShotTestCase):
    def setUp(self):
        self.reviewer = make_user("revisora", perms=REVIEWER)
        self.team = make_user("equipo", perms=TEAM)
        self.client.force_login(self.reviewer)
        self.requested = self.raise_ticket()
        self.review = self.raise_ticket(note="Revisar el total")
        workflow.set_status(self.review, "in_review", users.Actor.named("equipo"))

    def test_board_is_default_with_fixed_columns_and_card_content(self):
        html = self.client.get("/__ticketshot/panel/").content.decode()
        self.assertLess(html.index('data-column="requested"'), html.index('data-column="in_progress"'))
        self.assertLess(html.index('data-column="in_progress"'), html.index('data-column="in_review"'))
        self.assertLess(html.index('data-column="in_review"'), html.index('data-column="approved"'))
        self.assertLess(html.index('data-column="approved"'), html.index('data-column="discarded"'))
        self.assertIn('data-targets="requested,approved"', html)
        self.assertIn("Sigue sin funcionar", html)
        self.assertIn(f'/__ticketshot/images/{self.review.images.get().pk}/', html)
        self.assertIn('type="module" src="/static/ticketshot/bar-0.3.0/board.js', html)
        self.assertIn("Cola de revisión (<span data-review-count>1</span>)", html)

    def test_every_card_has_open_button_to_ticket_detail(self):
        html = self.client.get("/__ticketshot/panel/").content.decode()
        for ticket in (self.requested, self.review):
            detail_url = reverse("ticketshot:panel_detail", args=[ticket.key])
            self.assertIn(
                f'<a class="tsp-btn tsp-open-link" href="{detail_url}">Abrir {ticket.key}</a>',
                html,
            )

    def test_board_filters_and_news_match_query_semantics(self):
        queries.mark_seen(self.requested, self.reviewer.username)
        html = self.client.get("/__ticketshot/panel/", {"unread": "1"}).content.decode()
        self.assertIn('data-key="TS-2"', html)
        self.assertNotIn('data-key="TS-1"', html)
        html = self.client.get("/__ticketshot/panel/", {"q": "total", "device": "desktop"}).content.decode()
        self.assertIn('data-key="TS-2"', html)
        self.assertNotIn('data-key="TS-1"', html)
        self.review.kind = "recording"
        self.review.source = "skill"
        self.review.save(using=conf.database(), update_fields=["kind", "source"])
        for params in ({"recordings": "1"}, {"unsolicited": "1"}):
            html = self.client.get("/__ticketshot/panel/", params).content.decode()
            self.assertIn('data-key="TS-2"', html)
            self.assertNotIn('data-key="TS-1"', html)

    def test_targets_follow_permissions_and_closed_cards_have_none(self):
        self.client.force_login(self.team)
        html = self.client.get("/__ticketshot/panel/").content.decode()
        self.assertIn('data-targets="in_progress,in_review,discarded"', html)
        self.assertIn('data-targets="in_progress,discarded"', html)
        self.assertNotIn("Sigue sin funcionar</button>", html)
        workflow.approve(self.review, users.Actor.named("revisora"))
        html = self.client.get("/__ticketshot/panel/").content.decode()
        self.assertIn('data-status="approved" data-targets=""', html)

    def test_closed_columns_limit_cards_and_link_to_list(self):
        for number in range(3, 16):
            Ticket.objects.using(conf.database()).create(
                project=conf.current().project, number=number, status="approved",
                note=f"Cerrado {number}", trigger_path="/page/")
        html = self.client.get("/__ticketshot/panel/").content.decode()
        approved = html.split('data-column="approved"', 1)[1].split('data-column="discarded"', 1)[0]
        self.assertEqual(approved.count('data-status="approved"'), 10)
        self.assertIn('data-count>13</span>', approved)
        self.assertIn('view=list&status=approved', approved)

    def test_board_query_budget_does_not_grow_per_card(self):
        for number in range(3, 13):
            Ticket.objects.using(conf.database()).create(
                project=conf.current().project, number=number, note=str(number), trigger_path="/page/")
        with CaptureQueriesContext(connections[conf.database()]) as captured:
            self.client.get("/__ticketshot/panel/")
        self.assertEqual(len(captured), 7)

    def test_queue_order_selection_and_permissions(self):
        first = self.client.get("/__ticketshot/panel/queue/").content.decode()
        self.assertIn("1 de 1", first)
        self.assertIn('title="Vista real de TS-2"', first)
        self.assertIn('data-mode="side"', first)
        self.assertIn('data-mode="overlay"', first)
        self.assertIn('data-opacity', first)
        self.assertIn('target="_blank" rel="noopener">Abrir en una pestaña', first)
        self.assertIn("Revisar el total", first)
        self.assertIn("Sigue sin funcionar", first)
        self.assertEqual(self.client.get("/__ticketshot/panel/queue/?ticket=TS-1").status_code, 404)
        self.client.force_login(self.team)
        html = self.client.get("/__ticketshot/panel/queue/").content.decode()
        self.assertNotIn('data-decision', html)
        self.assertIn("La decisión requiere permiso", html)

    def test_queue_uses_oldest_first_and_can_skip(self):
        later = self.raise_ticket(note="Segundo por revisar")
        workflow.set_status(later, "in_review", users.Actor.named("equipo"))
        first = self.client.get("/__ticketshot/panel/queue/").content.decode()
        self.assertIn("1 de 2", first)
        self.assertIn('data-next-url="/__ticketshot/panel/queue/?ticket=TS-3"', first)
        second = self.client.get("/__ticketshot/panel/queue/?ticket=TS-3").content.decode()
        self.assertIn("2 de 2", second)
        self.assertIn("Segundo por revisar", second)

    def test_queue_empty_and_project_isolation(self):
        with ts(PROJECT="otro"):
            html = self.client.get("/__ticketshot/panel/queue/").content.decode()
            self.assertIn("No hay tickets por revisar", html)
            self.assertNotIn('data-queue', html)

    def test_existing_endpoint_decides_from_queue(self):
        response = self.client.post(
            "/__ticketshot/tickets/TS-2/action/", {"action": "approve", "text": "Bien"},
            HTTP_X_REQUESTED_WITH="ticketshot")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["ticket"]["status"], "approved")
        self.assertIn("No hay tickets por revisar", self.client.get("/__ticketshot/panel/queue/").content.decode())
