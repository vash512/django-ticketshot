"""Observable boundaries for ticket flows and outputs."""

import json
import subprocess
import tempfile
from io import StringIO
from pathlib import Path
from unittest import mock

from django.core.exceptions import ValidationError
from django.core.management import call_command
from django.core.management.base import CommandError

from ticketshot import conf, queries, states, users, workflow
from ticketshot.models import Counter, TicketEvent, TicketSeen

from .helpers import REVIEWER, TicketShotTestCase, make_user, ts


PANEL = "/__ticketshot/panel/"


def command(name, *args):
    output = StringIO()
    call_command(name, *args, stdout=output)
    return output.getvalue()


class DomainFlowLimits(TicketShotTestCase):
    def setUp(self):
        self.client.force_login(make_user())
        self.actor = users.Actor.named("equipo")
        self.ticket = self.raise_ticket()

    def test_rejection_outside_review_explains_the_action(self):
        with self.assertRaisesMessage(states.TransitionError, "Solo se rechaza"):
            states.next_status(states.Status.REQUESTED, states.Action.REJECT)
        with self.assertRaisesMessage(states.TransitionError, "Solo se aprueba"):
            states.next_status(states.Status.REQUESTED, states.Action.APPROVE)

    def test_note_at_its_exact_limit_is_accepted(self):
        with ts(MAX_NOTE_LENGTH=5):
            self.assertEqual(workflow.clean_text("abcde", required=False), "abcde")
            with self.assertRaises(ValidationError):
                workflow.clean_text("abcdef", required=False)

    def test_numbering_recovers_a_reset_counter_and_keeps_an_advanced_one(self):
        counter = Counter.objects.using(conf.database()).get(project=conf.current().project)
        counter.value = 0
        counter.save(using=conf.database(), update_fields=["value"])
        self.assertEqual(self.raise_ticket(note="Siguiente").number, 2)
        counter.value = 5
        counter.save(using=conf.database(), update_fields=["value"])
        self.assertEqual(self.raise_ticket(note="Posterior").number, 6)

    def test_commit_event_keeps_its_message(self):
        workflow.link_commit(self.ticket, self.actor, commit="a" * 40,
                             message="Corrección del total")
        event = TicketEvent.objects.using(conf.database()).get(ticket=self.ticket, kind="commit")
        self.assertEqual(event.data["message"], "Corrección del total")

    def test_news_without_a_reader_and_at_the_read_time(self):
        self.assertEqual(queries.news([self.ticket], ""), {})
        queries.mark_seen(self.ticket, "revisora")
        created = self.ticket.history.using(conf.database()).get(kind="created")
        TicketSeen.objects.using(conf.database()).filter(
            ticket=self.ticket, username="revisora").update(seen_at=created.created_at)
        self.assertEqual(queries.news([self.ticket], "revisora"), {self.ticket.pk: False})


class StatusOutputLimits(TicketShotTestCase):
    def setUp(self):
        self.client.force_login(make_user())
        self.ticket = self.raise_ticket(note="Primera línea\nSegunda línea")
        self.actor = users.Actor.named("equipo")

    def test_text_uses_the_first_line_and_only_reviewer_thread_events(self):
        workflow.set_status(self.ticket, "in_progress", self.actor, text="Avance interno")
        workflow.comment(self.ticket, self.actor, text="Comentario visible")
        output = command("ticketshot_status")
        self.assertIn("Primera línea", output)
        self.assertNotIn("Segunda línea", output)
        self.assertIn("Comentario visible", output)
        self.assertNotIn("Avance interno", output)
        data = json.loads(command("ticketshot_status", "--json"))[0]
        self.assertEqual([event["kind"] for event in data["thread"]], ["comment"])

    def test_markdown_shows_only_a_distinct_replicable_url_and_its_tags(self):
        workflow.set_template(self.ticket, self.actor, template="/item/5/", tags={})
        output = command("ticketshot_status", "--markdown")
        self.assertNotIn("URL replicable:", output)
        workflow.set_template(self.ticket, self.actor, template="/item/{pieza}/",
                              tags={"pieza": "la pieza elegida"})
        output = command("ticketshot_status", "--markdown")
        self.assertIn("URL replicable: `/item/{pieza}/`", output)
        self.assertIn("`pieza`: la pieza elegida", output)

    def test_json_preserves_unicode_characters(self):
        data = command("ticketshot_status", "--json")
        self.assertIn("Primera línea", data)
        self.assertNotIn("\\u00ed", data)


class PanelFlowLimits(TicketShotTestCase):
    def setUp(self):
        self.reviewer = make_user("revisora", perms=REVIEWER)
        self.client.force_login(self.reviewer)
        self.ticket = self.raise_ticket(images=2)

    def test_board_counts_and_links_follow_the_visible_columns(self):
        html = self.client.get(PANEL).content.decode()
        requested = html.split('data-column="requested"', 1)[1].split('data-column="in_progress"', 1)[0]
        approved = html.split('data-column="approved"', 1)[1].split('data-column="discarded"', 1)[0]
        self.assertNotIn('class="tsp-more"', requested)
        self.assertNotIn('class="tsp-more"', approved)
        self.assertIn('data-count>0</span>', approved)
        workflow.set_status(self.ticket, "discarded", users.Actor.named("equipo"))
        html = self.client.get(PANEL).content.decode()
        discarded = html.split('data-column="discarded"', 1)[1]
        self.assertIn('data-count>1</span>', discarded)
        self.assertIn('class="tsp-more"', discarded)

    def test_list_marks_one_tab_and_does_not_invent_news(self):
        html = self.client.get(PANEL, {"view": "list", "status": "requested"}).content.decode()
        tabs = html.split('class="tsp-tabs"', 1)[1].split('</nav>', 1)[0]
        self.assertIn('status=requested" aria-current="page"', tabs)
        self.assertEqual(tabs.count('aria-current="page"'), 1)
        self.assertNotIn('class="tsp-new"', html)
        self.assertIn("2 capturas", html)

    def test_queue_with_one_ticket_returns_to_queue(self):
        workflow.set_status(self.ticket, "in_review", users.Actor.named("equipo"))
        html = self.client.get(PANEL + "queue/").content.decode()
        self.assertIn("1 de 1", html)
        self.assertIn("Volver a la cola", html)
        self.assertNotIn("Saltar", html)

    def test_detail_keeps_unicode_in_technical_context(self):
        self.ticket.server_context = {"mensaje": "Revisión"}
        self.ticket.save(using=conf.database(), update_fields=["server_context"])
        html = self.client.get(PANEL + self.ticket.key + "/").content.decode()
        self.assertIn("Revisión", html)
        self.assertNotIn("\\u00f3", html)

    def test_board_without_a_username_does_not_invent_news(self):
        self.reviewer.username = ""
        self.reviewer.save(update_fields=["username"])
        self.client.force_login(self.reviewer)
        html = self.client.get(PANEL, {"unread": "1"}).content.decode()
        self.assertNotIn(f'data-key="{self.ticket.key}"', html)


class SyncFlowLimits(TicketShotTestCase):
    def setUp(self):
        self.client.force_login(make_user())
        self.ticket = self.raise_ticket()
        self.folder = tempfile.TemporaryDirectory(prefix="ticketshot-sync-limits-")
        self.addCleanup(self.folder.cleanup)
        self.repo = Path(self.folder.name)
        self.git("init", "-q", "-b", "staging")
        self.git("config", "user.email", "pruebas@example.test")
        self.git("config", "user.name", "Pruebas")
        self.git("commit", "-q", "--allow-empty", "-m", "fix: TS-1")

    def git(self, *args):
        subprocess.run(["git", "-C", str(self.repo), *args], check=True,
                       capture_output=True)

    def test_invalid_ref_reports_a_git_error(self):
        with self.assertRaisesMessage(CommandError, "git log rama-inexistente falló"):
            command("ticketshot_sync", "--repo", str(self.repo), "--ref", "rama-inexistente")

    def test_failed_fetch_does_not_prevent_local_sync(self):
        real_run = subprocess.run

        def run_with_failed_fetch(args, **kwargs):
            if "fetch" in args:
                if kwargs.get("check"):
                    raise subprocess.CalledProcessError(1, args)
                return subprocess.CompletedProcess(args, 1)
            return real_run(args, **kwargs)

        with mock.patch("ticketshot.management.commands.ticketshot_sync.subprocess.run",
                        side_effect=run_with_failed_fetch):
            output = command("ticketshot_sync", "--repo", str(self.repo), "--ref", "staging", "--fetch")
        self.assertIn("TS-1", output)
        self.assertIn("Sin --apply", output)
