import json
import os

from ticketshot import assets, pagecontext, revision

from .helpers import REVIEWER, TicketShotTestCase, config_of, make_user, ts


class InjectionTests(TicketShotTestCase):
    def setUp(self):
        self.user = make_user()
        self.client.force_login(self.user)

    def test_injects_before_body_end_for_a_tester(self):
        response = self.client.get("/page/")
        html = response.content.decode()
        self.assertIn('id="ticketshot-config"', html)
        self.assertLess(html.index(assets.BAR_ENTRY), html.lower().rindex("</body>"))
        if response.has_header("Content-Length"):
            self.assertEqual(int(response["Content-Length"]), len(response.content))

    def test_page_token_carries_what_the_server_saw(self):
        response = self.client.get("/item/7/?tab=2")
        page, ok = pagecontext.unsign(config_of(response)["pageToken"])
        self.assertTrue(ok)
        self.assertEqual(page["view"]["name"], "item")
        self.assertEqual(page["view"]["route"], "item/<int:pk>/")
        self.assertEqual(page["view"]["kwargs"], {"pk": "7"})
        self.assertEqual(page["view"]["func"], "tests.urls.page")
        self.assertEqual(page["request"]["get_keys"], ["tab"])
        self.assertIn("page.html", page["response"]["templates"])
        self.assertEqual(page["user"]["username"], "probador")
        self.assertEqual(page["app"]["project"], "pruebas")
        self.assertEqual(page["response"]["status"], 200)

    def test_the_token_has_no_session_values(self):
        session = self.client.session
        session["secreto"] = "no-debe-salir"
        session.save()
        response = self.client.get("/page/")
        page, _ = pagecontext.unsign(config_of(response)["pageToken"])
        self.assertIn("secreto", page["request"]["session_keys"])
        self.assertNotIn("no-debe-salir", json.dumps(page))

    def test_tampered_token_is_not_verified(self):
        token = config_of(self.client.get("/page/"))["pageToken"]
        self.assertEqual(pagecontext.unsign(token[:-2] + "xx"), ({}, False))

    def test_config_exposes_endpoints_limits_and_permissions(self):
        cfg = config_of(self.client.get("/page/"))
        self.assertEqual(cfg["endpoints"]["create"], "/__ticketshot/tickets/")
        self.assertEqual(cfg["endpoints"]["open"], "/__ticketshot/tickets/open/")
        self.assertEqual(cfg["endpoints"]["action"], "/__ticketshot/tickets/{key}/action/")
        self.assertEqual(cfg["limits"]["recordingSteps"], 8)
        self.assertEqual(cfg["user"], "Ana Prueba (probador)")
        self.assertEqual(cfg["recordingCookie"], "ticketshot_rec")
        self.assertEqual(cfg["deviceBreakpoint"], 768)
        self.assertEqual(cfg["can"], {"view": False, "comment": True, "work": False,
                                      "approve": False, "debug": False})
        self.assertTrue(cfg["csrf"])

    def test_reviewer_flags(self):
        self.client.force_login(make_user("revisora", perms=REVIEWER))
        cfg = config_of(self.client.get("/page/"))
        self.assertTrue(cfg["can"]["approve"])
        self.assertTrue(cfg["can"]["view"])

    def test_no_bar_without_permission(self):
        self.client.force_login(make_user("sin_permiso", perms=()))
        self.assertIsNone(config_of(self.client.get("/page/")))

    def test_no_bar_for_anonymous(self):
        self.client.logout()
        self.assertIsNone(config_of(self.client.get("/page/")))

    def test_superuser_sees_the_bar(self):
        self.client.force_login(make_user("jefa", perms=(), superuser=True))
        self.assertIsNotNone(config_of(self.client.get("/page/")))

    def test_skips_fragments_json_and_own_urls(self):
        self.assertNotIn(b"ticketshot-config", self.client.get("/fragment/").content)
        self.assertNotIn(b"ticketshot-config", self.client.get("/data/").content)

    @ts(ENABLED=False)
    def test_disabled_injects_nothing(self):
        self.assertIsNone(config_of(self.client.get("/page/")))

    @ts(EXCLUDE_PATHS=["/item/"])
    def test_excluded_paths(self):
        self.assertIsNone(config_of(self.client.get("/item/3/")))
        self.assertIsNotNone(config_of(self.client.get("/page/")))

    def test_custom_show_bar_method(self):
        from ticketshot.permissions import ModelPermissions

        class CustomBarPermissions(ModelPermissions):
            def _show_bar(self, request):
                return True

        self.client.force_login(make_user("sin_permiso", perms=()))
        with ts(PERMISSIONS=CustomBarPermissions):
            self.assertIsNotNone(config_of(self.client.get("/page/")))
            self.client.logout()
            self.assertIsNone(config_of(self.client.get("/page/")))

    @ts(CONTEXT_EXTRA=lambda request, response: {"sucursal": "Centro"})
    def test_context_extra(self):
        page, _ = pagecontext.unsign(config_of(self.client.get("/page/"))["pageToken"])
        self.assertEqual(page["extra"], {"sucursal": "Centro"})

    @ts(CONTEXT_EXTRA=lambda request, response: 1 / 0)
    def test_a_broken_extra_never_breaks_the_page(self):
        response = self.client.get("/page/")
        self.assertEqual(response.status_code, 200)
        page, _ = pagecontext.unsign(config_of(response)["pageToken"])
        self.assertIn("ZeroDivisionError", page["extra"]["error"])

    def test_admin_pages_get_the_bar_too(self):
        self.client.force_login(make_user("revisora", perms=REVIEWER, staff=True))
        self.assertIsNotNone(config_of(self.client.get("/admin/")))

    def test_panel_never_gets_the_bar(self):
        self.client.force_login(make_user("revisora", perms=REVIEWER))
        response = self.client.get("/__ticketshot/panel/")
        self.assertEqual(response.status_code, 200)
        self.assertNotIn(b"ticketshot-config", response.content)


class RevisionTests(TicketShotTestCase):
    def test_revision_never_comes_from_the_environment(self):
        os.environ["GIT_COMMIT"] = "abc1234"
        try:
            with self.settings(BASE_DIR="/no/existe"):
                self.assertEqual(revision.revision(), {})
        finally:
            del os.environ["GIT_COMMIT"]

    @ts(REVISION="deadbeef", APP_VERSION="2.1")
    def test_revision_and_version_from_settings(self):
        self.assertEqual(revision.revision()["commit"], "deadbeef")
        self.assertEqual(revision.app_version(), "2.1")


class AssetTests(TicketShotTestCase):
    def test_bar_modules_live_in_a_folder_named_after_the_version(self):
        from django.contrib.staticfiles import finders
        # If this fails after a version bump, rename the versioned static directory.
        self.assertIsNotNone(finders.find(assets.BAR_ENTRY))
