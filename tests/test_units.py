"""Pure components tested without a database."""
from datetime import datetime, timezone as dt_timezone

from django.core.exceptions import ValidationError
from django.test import SimpleTestCase, override_settings

from ticketshot import states, submission, timeline, urltemplate


class UrlTemplateTests(SimpleTestCase):
    def test_tags_from_lines_json_or_dict(self):
        expected = {"cliente": "uno con libreta"}
        self.assertEqual(urltemplate.parse_tags("{cliente}: uno con libreta\nsin dos puntos"), expected)
        self.assertEqual(urltemplate.parse_tags('{"cliente": " uno con libreta "}'), expected)
        self.assertEqual(urltemplate.parse_tags({"cliente": "uno con libreta", " ": "x"}), expected)
        self.assertEqual(urltemplate.parse_tags('["list"]'), {})

    def test_bad_json_tags(self):
        with self.assertRaisesMessage(ValidationError, "JSON"):
            urltemplate.parse_tags('{"roto": }')

    def test_build_checks_tags_against_the_template(self):
        self.assertEqual(urltemplate.build("/c/{id}/", "id: uno").tags, {"id": "uno"})
        for template, tags, message in (("c/", "", "empieza"), ("/c/{id}/", "", "de dónde"),
                                        ("/c/", "id: uno", "no están")):
            with self.subTest(template=template), self.assertRaisesMessage(ValidationError, message):
                urltemplate.build(template, tags)

    def test_relative_keeps_path_and_query(self):
        self.assertEqual(urltemplate.relative("https://x.test/a/?b=1#c"), "/a/?b=1")
        self.assertEqual(urltemplate.relative(""), "/")


class CoercionTests(SimpleTestCase):
    def test_whole_numbers(self):
        self.assertEqual(submission.whole(3.7), 3)
        self.assertIsNone(submission.whole(True))
        self.assertIsNone(submission.whole("3"))
        self.assertIsNone(submission.whole(-1))
        self.assertIsNone(submission.whole(5, high=4))

    @override_settings(USE_TZ=True)
    def test_moment_with_time_zones(self):
        self.assertEqual(submission.moment("2026-11-07T10:00:00Z"),
                         datetime(2026, 11, 7, 10, tzinfo=dt_timezone.utc))
        self.assertIsNone(submission.moment("ayer"))
        self.assertIsNone(submission.moment(""))
        self.assertIsNotNone(submission.moment("2026-11-07T10:00:00").tzinfo)

    @override_settings(USE_TZ=False)
    def test_moment_without_time_zones_is_naive(self):
        self.assertIsNone(submission.moment("2026-11-07T10:00:00Z").tzinfo)


class StatesTests(SimpleTestCase):
    def test_the_transition_table(self):
        S, A = states.Status, states.Action
        self.assertEqual(states.next_status(S.IN_REVIEW, A.APPROVE), S.APPROVED)
        self.assertEqual(states.next_status(S.IN_REVIEW, A.REJECT), S.REQUESTED)
        self.assertEqual(states.next_status(S.REQUESTED, A.MOVE, "in_progress"), S.IN_PROGRESS)
        for current, action, to in ((S.APPROVED, A.MOVE, "requested"), (S.REQUESTED, A.APPROVE, ""),
                                    (S.REQUESTED, A.MOVE, "nada"), (S.REQUESTED, A.COMMENT, "")):
            with self.subTest(current=current, action=action), self.assertRaises(states.TransitionError):
                states.next_status(current, action, to)

    def test_a_commit_only_moves_work_in_progress(self):
        S = states.Status
        self.assertEqual(states.after_commit(S.IN_PROGRESS), S.IN_REVIEW)
        self.assertEqual(states.after_commit(S.APPROVED), S.APPROVED)

    def test_team_targets_follow_the_panel_order(self):
        S = states.Status
        self.assertEqual(states.team_targets(S.REQUESTED), (S.IN_REVIEW, S.IN_PROGRESS, S.DISCARDED))
        self.assertEqual(states.team_targets(S.APPROVED), ())


class TimelineTests(SimpleTestCase):
    def test_rows_are_readable(self):
        rows = timeline.rows([{"t": 65000, "type": "click", "label": "Cobrar", "server": {"view": "pos"}},
                              "no es un dict", {"type": "raro"}])
        self.assertEqual(rows[0]["at"], "01:05.0")
        self.assertEqual(rows[0]["label"], "Clic")
        self.assertIn("vista: pos", rows[0]["detail"])
        self.assertEqual(rows[1]["label"], "raro")
        self.assertEqual(timeline.clock(True), "")
