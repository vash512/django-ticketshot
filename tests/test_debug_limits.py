"""Debug record boundaries for limits, trimming, rounding, and errors."""
import copy

from django.contrib.auth.models import Group
from django.http import HttpResponse
from django.template import Context
from django.test import RequestFactory

from ticketshot import debuglog
from ticketshot.models import Ticket

from .helpers import TicketShotTestCase, make_user, ts

REC = "2f1c0b8e-4a8a-4f7e-9f00-123456789abc"


def record(**changes):
    """A record shaped like Collector.payload with test changes."""
    data = {
        "request": {"method": "GET", "path": "/x/", "get": {}, "post": {}, "files": [],
                    "content_type": "", "referer": ""},
        "session": {}, "view": {}, "templates": [], "writes": [],
        "sql": {"count": 0, "writes": 0, "ms": 0, "queries": []},
        "exception": "",
    }
    data.update(changes)
    return data


def sql(*queries):
    return {"count": len(queries), "writes": 0, "ms": 0, "queries": list(queries)}


class ShortAndNamesTests(TicketShotTestCase):
    def test_short_keeps_what_fits_and_cuts_with_an_ellipsis(self):
        self.assertEqual(debuglog.short("ab", limit=4), "'ab'")
        self.assertEqual(debuglog.short("abcdef", limit=5), "'abc…")

    def test_names_only_keeps_blank_parameters(self):
        self.assertEqual(debuglog.names_only("/x/?vacio=&q=1"), "/x/?vacio=…&q=…")

    def test_size_counts_utf8_bytes_not_escapes(self):
        self.assertEqual(debuglog.size_of({"a": "ñ"}), debuglog.size_of({"a": "n"}) + 1)

    def test_template_context_keeps_at_most_its_cap(self):
        context = Context({f"campo{i}": i for i in range(debuglog.MAX_CONTEXT_KEYS + 10)})
        self.assertEqual(len(debuglog.clean_context(context)), debuglog.MAX_CONTEXT_KEYS)


class FitTests(TicketShotTestCase):
    def test_a_record_that_fits_exactly_is_kept_whole(self):
        data = record(sql=sql({"sql": "SELECT 1", "ms": 1}))
        self.assertEqual(debuglog.fit(copy.deepcopy(data), debuglog.size_of(data)), data)

    def test_halving_stops_at_one_query_and_the_next_cut_follows(self):
        first, second = {"sql": "a" * 300, "ms": 1}, {"sql": "b" * 300, "ms": 1}
        templates = [{"name": "t.html", "context": {"c": "c" * 600}}]
        limit = debuglog.size_of(record(sql=sql(), templates=templates))
        result = debuglog.fit(record(sql=sql(first, second), templates=templates), limit)
        self.assertEqual(result["sql"]["queries"], [first])
        self.assertEqual(result["templates"], [{"name": "t.html", "context": {}}])

    def test_halving_stops_as_soon_as_it_fits_exactly(self):
        queries = [{"sql": letter * 200, "ms": 1} for letter in "abcd"]
        half = record(sql=sql(*queries[:2]))
        half["sql"].update(count=4, truncated=True)
        result = debuglog.fit(record(sql=sql(*queries)), debuglog.size_of(half))
        self.assertEqual(len(result["sql"]["queries"]), 2)

    def test_each_cut_says_what_it_dropped(self):
        post = {"campo": ["'" + "x" * 3000 + "'"]}
        data = record(sql=sql({"sql": "SELECT 1", "ms": 1}), session={"carrito": "[1, 2]"},
                      request={**record()["request"], "post": post})
        result = debuglog.fit(data, 1024)
        self.assertEqual((result["sql"]["queries"], result["sql"]["truncated"]), ([], True))
        self.assertEqual(result["session"], {"truncated": True})
        self.assertEqual(result["request"]["post"], {"truncated": True})

    def test_after_every_cut_a_record_that_fits_exactly_is_not_summarized(self):
        data = record(request={**record()["request"], "post": {"campo": ["x" * 500]}})
        cut = copy.deepcopy(data)
        for step in debuglog._CUTS:
            step(cut, 0)
        self.assertEqual(debuglog.fit(copy.deepcopy(data), debuglog.size_of(cut)), cut)

    def test_the_summary_keeps_the_exception_when_it_fits(self):
        data = record(request={**record()["request"], "path": "/" + "x" * 3000}, exception="boom")
        exception = "boom\n…(recortado)"
        summary = {"truncated": True, "exception": exception}
        self.assertEqual(debuglog.fit(data, debuglog.size_of(summary)), summary)


class CollectorTests(TicketShotTestCase):
    def collector(self):
        return debuglog.Collector(RequestFactory().get("/x/"), REC)

    def test_exceptions_go_through(self):
        with self.assertRaises(ValueError):
            with self.collector():
                raise ValueError("de la vista")

    def test_own_writes_are_not_the_flow_and_writes_have_a_cap(self):
        collector = self.collector()
        collector.model_written(Ticket, Ticket(pk=1), "alta")
        self.assertEqual(collector.writes, [])
        for pk in range(debuglog.MAX_WRITES + 3):
            collector.model_written(Group, Group(pk=pk), "alta")
        self.assertEqual(len(collector.writes), debuglog.MAX_WRITES)

    def test_templates_have_a_cap(self):
        collector = self.collector()
        for _ in range(debuglog.MAX_TEMPLATES + 2):
            collector.template_rendered("t.html", Context({}))
        self.assertEqual(len(collector.templates), debuglog.MAX_TEMPLATES)

    def test_queries_have_a_cap_but_all_are_counted(self):
        with ts(DEBUG_RECORD_MAX_QUERIES=3):
            collector = self.collector()
            for _ in range(5):
                collector.on_query("default", "SELECT 1", None, False, 1.26, None)
        data = collector._sql_data()
        self.assertEqual((data["count"], len(data["queries"])), (5, 3))
        self.assertEqual(data["ms"], 3.8)

    def test_the_saved_duration_keeps_one_decimal(self):
        request = RequestFactory().get("/x/")
        request.user = make_user()
        collector = debuglog.Collector(request, REC)
        saved = debuglog.save(collector, HttpResponse(), "probador", 12.34)
        self.assertEqual(saved.duration_ms, 12.3)
