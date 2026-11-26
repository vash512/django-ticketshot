from datetime import timedelta

from django.utils import translation
from django.core.exceptions import ValidationError

from ticketshot import keys, queries, urltemplate, users, workflow
from ticketshot.models import Ticket, TicketEvent, TicketSeen

from .helpers import REVIEWER, TEAM, TicketShotTestCase, make_user

ACTION = "/__ticketshot/tickets/{}/action/"
JSON = {"HTTP_X_REQUESTED_WITH": "ticketshot"}


class WorkflowTestCase(TicketShotTestCase):
    def setUp(self):
        self.tester = make_user()
        self.reviewer = make_user("revisora", perms=REVIEWER)
        self.team = make_user("equipo", perms=TEAM)
        self.client.force_login(self.tester)
        self.ticket = self.raise_ticket()

    def act(self, user, action, key=None, **fields):
        self.client.force_login(user)
        return self.client.post(ACTION.format(key or self.ticket.key),
                                {"action": action, **fields}, **JSON)

    def status(self):
        self.ticket.refresh_from_db()
        return self.ticket.status


class TransitionTests(WorkflowTestCase):
    def test_full_cycle_with_a_text_rejection(self):
        self.assertEqual(self.act(self.team, "status", to="in_progress").status_code, 200)
        self.assertEqual(self.status(), "in_progress")
        self.act(self.team, "status", to="in_review")
        self.assertEqual(self.status(), "in_review")
        # Rejection with text alone keeps the original capture.
        response = self.act(self.reviewer, "reject", text="El total sigue encimado.")
        self.assertEqual(response.status_code, 200, response.content)
        self.assertEqual(self.status(), "requested")
        rejected = self.ticket.history.get(kind=TicketEvent.Kind.REJECTED)
        self.assertEqual(rejected.text, "El total sigue encimado.")
        self.assertEqual(rejected.actor_username, "revisora")
        # The original note remains; rejection adds a new event.
        self.assertEqual(self.ticket.note, "El botón de cobrar queda debajo del pie.")
        self.act(self.team, "status", to="in_review")
        self.assertEqual(self.act(self.reviewer, "approve").status_code, 200)
        self.assertEqual(self.status(), "approved")
        self.assertIsNotNone(self.ticket.closed_at)
        kinds = list(self.ticket.history.values_list("kind", flat=True))
        self.assertEqual(kinds, ["created", "status", "status", "rejected", "status", "approved"])

    def test_reject_needs_text(self):
        self.act(self.team, "status", to="in_review")
        response = self.act(self.reviewer, "reject", text="  ")
        self.assertEqual(response.status_code, 400)
        self.assertIn("sigue sin funcionar", response.json()["error"])
        self.assertEqual(self.status(), "in_review")

    def test_only_tickets_in_review_are_approved(self):
        response = self.act(self.reviewer, "approve")
        self.assertEqual(response.status_code, 400)
        self.assertEqual(self.status(), "requested")

    def test_team_cannot_jump_to_approved(self):
        response = self.act(self.team, "status", to="approved")
        self.assertEqual(response.status_code, 400)

    def test_closed_tickets_do_not_move(self):
        self.act(self.team, "status", to="discarded")
        self.assertEqual(self.status(), "discarded")
        self.assertEqual(self.act(self.team, "status", to="requested").status_code, 400)

    def test_permissions_per_action(self):
        self.assertEqual(self.act(self.tester, "status", to="in_progress").status_code, 403)
        self.act(self.team, "status", to="in_review")
        self.assertEqual(self.act(self.team, "approve").status_code, 403)
        self.assertEqual(self.act(self.tester, "approve").status_code, 403)
        self.assertEqual(self.act(make_user("nadie", perms=()), "comment", text="x").status_code, 403)
        self.client.logout()
        response = self.client.post(ACTION.format(self.ticket.key), {"action": "comment", "text": "x"}, **JSON)
        self.assertEqual(response.status_code, 403)

    def test_comments_from_testers_and_viewers(self):
        self.assertEqual(self.act(self.tester, "comment", text="También en celular.").status_code, 200)
        self.assertEqual(self.act(self.team, "comment", text="Visto.").status_code, 200)
        self.assertEqual(self.ticket.history.filter(kind="comment").count(), 2)

    def test_unknown_action_and_ticket(self):
        self.assertEqual(self.act(self.team, "borrar").status_code, 400)
        self.assertEqual(self.act(self.team, "comment", key="TS-99", text="x").status_code, 404)

    def test_form_post_redirects_to_the_panel(self):
        self.client.force_login(self.team)
        response = self.client.post(ACTION.format(self.ticket.key), {"action": "status", "to": "in_progress"})
        self.assertEqual(response.status_code, 302)
        self.assertTrue(response["Location"].startswith("/__ticketshot/panel/TS-1/?ok="))


class TemplateTests(WorkflowTestCase):
    def test_team_sets_the_replicable_url(self):
        response = self.act(self.team, "template", template="/item/{articulo}/",
                            tags="articulo: una pieza con foto")
        self.assertEqual(response.status_code, 200, response.content)
        self.ticket.refresh_from_db()
        self.assertEqual(self.ticket.url_template, "/item/{articulo}/")
        self.assertEqual(self.ticket.url_tags, {"articulo": "una pieza con foto"})
        self.assertTrue(self.ticket.history.filter(kind=TicketEvent.Kind.TEMPLATE).exists())

    def test_every_tag_says_where_it_comes_from(self):
        response = self.act(self.team, "template", template="/item/{articulo}/", tags="")
        self.assertEqual(response.status_code, 400)
        self.assertIn("articulo", response.json()["error"])
        response = self.act(self.team, "template", template="/item/5/", tags="otro: x")
        self.assertEqual(response.status_code, 400)


class OpenTicketsTests(WorkflowTestCase):
    def open_for(self, path, user=None):
        self.client.force_login(user or self.reviewer)
        return self.client.get("/__ticketshot/tickets/open/", {"path": path}).json()

    def test_lists_open_tickets_of_the_url_first_exact_then_same_view(self):
        self.client.force_login(self.tester)
        other = self.raise_ticket(path="/item/8/")
        data = self.open_for("/item/5/")
        keys = [t["key"] for t in data["tickets"]]
        self.assertEqual(keys, [self.ticket.key, other.key])
        self.assertTrue(data["tickets"][0]["exact"])
        self.assertFalse(data["tickets"][1]["exact"])
        self.assertTrue(data["tickets"][0]["images"][0]["url"].startswith("/__ticketshot/images/"))
        self.assertEqual(data["panelUrl"], "/__ticketshot/panel/")

    def test_closed_tickets_are_not_listed(self):
        workflow.set_status(self.ticket, "discarded", users.Actor.named("equipo"))
        self.assertEqual(self.open_for("/item/5/")["tickets"], [])

    def test_tester_without_view_gets_no_images(self):
        data = self.open_for("/item/5/", user=self.tester)
        self.assertNotIn("images", data["tickets"][0])
        self.assertEqual(data["panelUrl"], "")

    def test_can_approve_only_in_review(self):
        self.assertFalse(self.open_for("/item/5/")["tickets"][0]["canApprove"])
        workflow.set_status(self.ticket, "in_review", users.Actor.named("equipo"))
        self.assertTrue(self.open_for("/item/5/")["tickets"][0]["canApprove"])

    def test_bad_path(self):
        self.client.force_login(self.reviewer)
        self.assertEqual(self.client.get("/__ticketshot/tickets/open/", {"path": "http://x"}).status_code, 400)


class NewsAndHelpersTests(WorkflowTestCase):
    def test_news_since_the_last_visit(self):
        self.assertEqual(queries.news([self.ticket], "equipo"), {self.ticket.pk: True})
        queries.mark_seen(self.ticket, "equipo")
        self.assertEqual(queries.news([self.ticket], "equipo"), {self.ticket.pk: False})
        # Last visit predates the event without relying on clock resolution.
        seen = TicketSeen.objects.get()
        TicketSeen.objects.filter(pk=seen.pk).update(seen_at=seen.seen_at - timedelta(seconds=5))
        workflow.comment(self.ticket, users.Actor.named("Ana", "probador"), text="Otra cosa")
        self.assertEqual(queries.news([self.ticket], "equipo"), {self.ticket.pk: True})
        # A user's own actions do not count as unread changes.
        queries.mark_seen(self.ticket, "equipo")
        workflow.comment(self.ticket, users.Actor.named("Equipo", "equipo"), text="Mío")
        self.assertEqual(queries.news([self.ticket], "equipo"), {self.ticket.pk: False})

    def test_keys_in_a_commit_message(self):
        self.assertEqual(keys.mentioned_in("fix(pos): TS-12 y ts-3, no ASN-4"), [3, 12])
        self.assertEqual(keys.parse("TS-7"), 7)
        self.assertEqual(keys.parse("7"), 7)
        self.assertIsNone(keys.parse("XX-7"))

    def test_suggest_template(self):
        self.assertEqual(urltemplate.suggest("customers/<int:pk>/record/", {"pk": "3"}, "/customers/3/record/"),
                         urltemplate.UrlTemplate("/customers/{pk}/record/", {"pk": "(en la captura: 3)"}))
        self.assertEqual(urltemplate.suggest("", {}, "/pos/search/?q=1"),
                         urltemplate.UrlTemplate("/pos/search/", {}))

    def test_link_commit_moves_to_review_once(self):
        actor = users.Actor.named("skill")
        workflow.link_commit(self.ticket, actor, commit="a" * 40, branch="origin/staging", message="fix TS-1")
        self.assertEqual(self.status(), "in_review")
        self.assertEqual(self.ticket.implemented_commit, "a" * 40)
        workflow.link_commit(self.ticket, actor, commit="b" * 40)
        self.assertEqual(self.status(), "in_review")
        self.assertEqual(self.ticket.history.filter(kind="commit").count(), 2)

    def test_set_status_validates(self):
        with self.assertRaises(ValidationError):
            workflow.set_status(self.ticket, "nada", users.Actor.named("x"))
        self.assertEqual(Ticket.objects.get().status, "requested")
