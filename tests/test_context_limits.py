"""Boundary cases for signed context and request measurements."""
from unittest import mock

from django.contrib.auth.models import Group
from django.core import signing
from django.http import HttpResponse
from django.template import Context, Template
from django.template.response import TemplateResponse
from django.test import RequestFactory

from ticketshot import pagecontext

from .helpers import TicketShotTestCase, ts


def clock(*values):
    """Fake perf_counter returns values in order, then repeats the last."""
    pending = list(values)
    return lambda: pending.pop(0) if len(pending) > 1 else pending[0]


class MeasureTests(TicketShotTestCase):
    def test_each_query_is_timed_in_milliseconds(self):
        seen = []
        with mock.patch("ticketshot.pagecontext.time.perf_counter", clock(10.0, 10.005)):
            with pagecontext.QueryTimer(lambda *args: seen.append(args)):
                Group.objects.count()
        self.assertEqual(len(seen), 1)
        self.assertAlmostEqual(seen[0][4], 5.0, places=6)

    def test_the_tracker_counts_queries_and_measures_the_request(self):
        with mock.patch("ticketshot.pagecontext.time.perf_counter", clock(100.0, 100.0, 100.0, 100.25)):
            with pagecontext.Tracker() as tracker:
                Group.objects.count()
        self.assertEqual(tracker.queries, 1)
        self.assertAlmostEqual(tracker.elapsed_ms, 250.0, places=6)

    def test_exceptions_go_through_the_timer_and_the_tracker(self):
        with self.assertRaises(ValueError):
            with pagecontext.QueryTimer(lambda *args: None):
                raise ValueError("de la vista")
        with self.assertRaises(ValueError):
            with pagecontext.Tracker():
                raise ValueError("de la vista")

    def test_templates_have_a_cap(self):
        with pagecontext.Tracker() as tracker:
            for i in range(pagecontext.MAX_TEMPLATES + 3):
                Template("x", name=f"t{i}.html").render(Context())
        self.assertEqual(len(tracker.templates), pagecontext.MAX_TEMPLATES)


class RequestAndResponseTests(TicketShotTestCase):
    def test_post_field_names_without_the_csrf_token(self):
        request = RequestFactory().post("/x/", {"b": "2", "a": "1", "csrfmiddlewaretoken": "t"})
        request.session = {}
        self.assertEqual(pagecontext._request_info(request)["post_keys"], ["a", "b"])
        self.assertEqual(pagecontext._request_info(RequestFactory().get("/x/?b=1"))["post_keys"], [])

    def test_the_referer_keeps_only_parameter_names(self):
        # Previous-page query values are unnecessary for navigation.
        request = RequestFactory().get("/x/", HTTP_REFERER="http://testserver/search/?q=ana@site.test&p=2")
        self.assertEqual(pagecontext._request_info(request)["referer"], "http://testserver/search/?q=…&p=…")
        self.assertEqual(pagecontext._request_info(RequestFactory().get("/x/"))["referer"], "")

    def test_a_broken_referer_does_not_break_the_page(self):
        # An invalid IPv6 host must not crash the page.
        request = RequestFactory().get("/x/", HTTP_REFERER="http://[mal/ana@x.mx?q=1")
        self.assertEqual(pagecontext._request_info(request)["referer"], "http://[mal/(email)")
        self.assertEqual(pagecontext.names_only("http://[mal/x?q=1#f"), "http://[mal/x")
        self.assertEqual(pagecontext.names_only("http://[mal/x#f?g"), "http://[mal/x")

    def test_a_url_without_scheme_keeps_its_two_slashes(self):
        self.assertEqual(pagecontext.names_only("//site.test/x?q=1"), "//site.test/x?q=…")

    def test_parameter_names_are_anonymized_like_the_url(self):
        request = RequestFactory().get("/x/?ana@x.mx=1&q=2")
        self.assertEqual(pagecontext._request_info(request)["get_keys"], ["(email)", "q"])
        with ts(ANONYMIZE_URLS=False):
            self.assertEqual(pagecontext._request_info(request)["get_keys"], ["ana@x.mx", "q"])

    def test_the_language_comes_from_the_request(self):
        request = RequestFactory().get("/x/")
        request.LANGUAGE_CODE = "es-mx"
        self.assertEqual(pagecontext._request_info(request)["language"], "es-mx")

    def test_the_response_template_is_used_only_when_none_was_tracked(self):
        response = TemplateResponse(RequestFactory().get("/x/"), "page.html")
        tracker = pagecontext.Tracker()
        self.assertEqual(pagecontext._response_info(response, tracker)["templates"], ["page.html"])
        tracker.templates.append("otra.html")
        self.assertEqual(pagecontext._response_info(response, tracker)["templates"], ["otra.html"])


def exactly_max_bytes(request, response):
    # Two thousand two-byte letters plus padding reach the exact UTF-8 limit.
    text = "ñ" * 2000
    overhead = len('{"t": ""}')
    return {"t": text + "a" * (pagecontext.MAX_EXTRA_BYTES - overhead - 2 * len(text))}


def one_byte_more(request, response):
    value = exactly_max_bytes(request, response)
    return {"t": value["t"] + "a"}


class ExtraAndTokenTests(TicketShotTestCase):
    def extra(self, func):
        with ts(CONTEXT_EXTRA=func):
            return pagecontext._extra(RequestFactory().get("/x/"), HttpResponse())

    def test_the_extra_cap_counts_utf8_bytes_and_admits_exactly_the_cap(self):
        self.assertNotIn("error", self.extra(exactly_max_bytes))
        self.assertIn("error", self.extra(one_byte_more))

    def test_the_token_is_compressed(self):
        context = {"request": {"get_keys": ["campo"] * 400}}
        self.assertLess(len(pagecontext.sign(context)),
                        len(signing.dumps(context, salt=pagecontext.SALT)))

    def test_a_token_that_is_not_text_is_not_valid(self):
        self.assertEqual(pagecontext.unsign(123), ({}, False))
