"""Behavior of configurable permission classes."""
from django.core.exceptions import ImproperlyConfigured
from django.db import connections
from django.test import SimpleTestCase
from django.test.utils import CaptureQueriesContext

from ticketshot import conf, permissions
from ticketshot.permissions import BasePermissions, StaffPermissions

from .helpers import TicketShotTestCase, config_of, make_user, ts


def not_a_class():
    return None


class SpecialPermissions(BasePermissions):
    """Grant every action to one test user."""

    def _allowed(self, user):
        return user.username == "especial"

    _can_add = _allowed
    _can_view = _allowed
    _can_comment = _allowed
    _can_work = _allowed
    _can_approve = _allowed
    _can_debug = _allowed


class StaffPermissionTests(TicketShotTestCase):
    def test_default_is_staff_permissions(self):
        self.assertIs(conf.parse({}).permissions, StaffPermissions)

    @ts(PERMISSIONS=StaffPermissions)
    def test_staff_can_raise_ticket_but_cannot_see_panel_or_approve(self):
        staff = make_user("staff", perms=(), staff=True)
        self.client.force_login(staff)
        config = config_of(self.client.get("/page/"))
        self.assertIsNotNone(config)
        self.assertEqual(config["can"], {
            "view": False, "comment": True, "work": False,
            "approve": False, "debug": False,
        })
        ticket = self.raise_ticket()
        self.assertEqual(self.client.get("/__ticketshot/panel/").status_code, 403)
        response = self.client.post(
            f"/__ticketshot/tickets/{ticket.key}/action/",
            {"action": "approve"}, HTTP_X_REQUESTED_WITH="ticketshot")
        self.assertEqual(response.status_code, 403)

    @ts(PERMISSIONS=StaffPermissions)
    def test_superuser_sees_panel(self):
        self.client.force_login(make_user("jefa", perms=(), superuser=True))
        self.assertIsNotNone(config_of(self.client.get("/page/")))
        self.assertEqual(self.client.get("/__ticketshot/panel/").status_code, 200)

    @ts(PERMISSIONS=StaffPermissions)
    def test_regular_and_inactive_users_have_no_access(self):
        regular = make_user("normal", perms=())
        self.client.force_login(regular)
        self.assertIsNone(config_of(self.client.get("/page/")))
        self.assertEqual(self.post({}).status_code, 403)
        inactive = make_user("inactivo", perms=(), staff=True)
        inactive.is_active = False
        inactive.save(update_fields=["is_active"])
        self.assertFalse(permissions.StaffPermissions().can_add(inactive))
        self.assertEqual(permissions.flags(inactive), {
            "view": False, "comment": False, "work": False,
            "approve": False, "debug": False,
        })
        self.client.force_login(inactive)
        self.assertIsNone(config_of(self.client.get("/page/")))
        self.assertEqual(self.post({}).status_code, 403)

    @ts(PERMISSIONS=StaffPermissions)
    def test_bar_only_reads_session_and_user(self):
        self.client.force_login(make_user("staff", perms=(), staff=True))
        self.client.get("/page/")
        with CaptureQueriesContext(connections["default"]) as main, \
                CaptureQueriesContext(connections["ticketshot"]) as tickets:
            response = self.client.get("/page/")
        self.assertIsNotNone(config_of(response))
        self.assertEqual(len(tickets), 0)
        tables = {query["sql"].split(" FROM ")[1].split()[0].strip('"')
                  for query in main}
        self.assertLessEqual(tables, {"django_session", "auth_user"})
        self.assertLessEqual(len(main), 2)


class ReplacementTests(TicketShotTestCase):
    def test_class_and_import_path_change_visible_access(self):
        special = make_user("especial", perms=())
        ordinary = make_user("otro", perms=(), staff=True)
        for setting in (SpecialPermissions, "tests.test_permission_classes.SpecialPermissions"):
            with self.subTest(setting=setting), ts(PERMISSIONS=setting):
                self.assertIs(conf.current().permissions, SpecialPermissions)
                self.assertIs(conf.permissions(), conf.permissions())
                self.client.force_login(special)
                self.assertIsNotNone(config_of(self.client.get("/page/")))
                self.assertEqual(self.client.get("/__ticketshot/panel/").status_code, 200)
                self.client.force_login(ordinary)
                self.assertIsNone(config_of(self.client.get("/page/")))
                self.assertEqual(self.client.get("/__ticketshot/panel/").status_code, 403)

    def test_inactive_user_cannot_use_replacement_permissions(self):
        user = make_user("especial", perms=())
        user.is_active = False
        user.save(update_fields=["is_active"])
        with ts(PERMISSIONS=SpecialPermissions):
            self.assertFalse(conf.permissions().show_bar(type("Request", (), {"user": user})()))
            self.assertFalse(conf.permissions().can_add(user))
            self.assertEqual(permissions.flags(user), {
                "view": False, "comment": False, "work": False,
                "approve": False, "debug": False,
            })

    def test_extending_view_does_not_extend_other_superuser_actions(self):
        class ViewOnlyPermissions(StaffPermissions):
            def _can_view(self, user):
                return user.is_superuser or user.username == "revisora"

        reviewer = make_user("revisora", perms=())
        with ts(PERMISSIONS=ViewOnlyPermissions):
            self.assertEqual(permissions.flags(reviewer), {
                "view": True, "comment": False, "work": False,
                "approve": False, "debug": False,
            })
            self.client.force_login(reviewer)
            self.assertEqual(self.client.get("/__ticketshot/panel/").status_code, 200)

    def test_extending_add_does_not_extend_comments(self):
        class AddOnlyPermissions(StaffPermissions):
            def _can_add(self, user):
                return user.is_superuser or user.is_staff or user.username == "capturista"

        user = make_user("capturista", perms=())
        with ts(PERMISSIONS=AddOnlyPermissions):
            self.assertTrue(conf.permissions().can_add(user))
            self.assertFalse(conf.permissions().can_comment(user))

    def test_the_admin_follows_the_configured_class(self):
        # Django permissions cannot open admin if the configured class denies it.
        staff = make_user("auditora", perms=("view_ticket", "view_debug", "delete_ticket"), staff=True)
        self.client.force_login(staff)
        with ts(PERMISSIONS=StaffPermissions):
            ticket = self.raise_ticket()
            self.assertEqual(self.client.get("/admin/ticketshot/ticket/").status_code, 403)
            self.assertEqual(self.client.get("/admin/ticketshot/debugrecord/").status_code, 403)
            self.assertEqual(self.client.get(f"/admin/ticketshot/ticket/{ticket.pk}/delete/").status_code, 403)
        self.client.force_login(make_user("especial", perms=(), staff=True))
        with ts(PERMISSIONS=SpecialPermissions):
            self.assertEqual(self.client.get("/admin/ticketshot/ticket/").status_code, 200)
            self.assertEqual(self.client.get("/admin/ticketshot/debugrecord/").status_code, 200)

    def test_the_admin_only_deletes_what_it_can_see(self):
        # Working on tickets without view access does not grant deletion.
        from django.contrib import admin as django_admin

        from ticketshot.admin import DebugRecordAdmin, TicketAdmin
        from ticketshot.models import DebugRecord, Ticket

        class WorkBlind(BasePermissions):
            def _can_work(self, user):
                return True

        user = make_user("ciega", perms=("delete_ticket", "delete_debugrecord"), staff=True)
        request = type("Request", (), {"user": user})()
        tickets = TicketAdmin(Ticket, django_admin.site)
        records = DebugRecordAdmin(DebugRecord, django_admin.site)
        with ts(PERMISSIONS=WorkBlind):
            self.assertFalse(tickets.has_delete_permission(request))
            self.assertFalse(records.has_delete_permission(request))
        with ts(PERMISSIONS=SpecialPermissions):
            self.assertFalse(records.has_delete_permission(request))
        user.username = "especial"
        with ts(PERMISSIONS=SpecialPermissions):
            self.assertTrue(tickets.has_delete_permission(request))
            self.assertTrue(records.has_delete_permission(request))

    def test_seeing_the_bar_does_not_grant_raising_tickets(self):
        # Showing the bar to more users does not grant ticket creation.
        class LookOnlyPermissions(StaffPermissions):
            def _show_bar(self, request):
                return True

        self.client.force_login(make_user("mirona", perms=()))
        with ts(PERMISSIONS=LookOnlyPermissions):
            self.assertIsNotNone(config_of(self.client.get("/page/")))
            payload, files = self.note_payload()
            self.assertEqual(self.post(payload, files).status_code, 403)

    def test_a_subclass_only_says_what_it_allows(self):
        # Undefined subclass permissions remain denied without AttributeError.
        class OnlyComments(BasePermissions):
            def _can_comment(self, user):
                return True

        user = make_user("comentarista", perms=())
        with ts(PERMISSIONS=OnlyComments):
            self.assertEqual(permissions.flags(user), {
                "view": False, "comment": True, "work": False,
                "approve": False, "debug": False,
            })
            self.assertFalse(conf.permissions().can_add(user))
            self.assertFalse(permissions.show_bar(type("Request", (), {"user": user})()))


class PermissionConfigurationTests(SimpleTestCase):
    def test_invalid_class_settings_fail_at_configuration_boundary(self):
        for value in ("tests.no_such.Permissions",
                      "tests.test_permission_classes.not_a_class",
                      not_a_class, 7, None):
            with self.subTest(value=value), ts(PERMISSIONS=value):
                with self.assertRaisesMessage(ImproperlyConfigured, "PERMISSIONS"):
                    conf.current()

    def test_show_bar_option_was_removed(self):
        with ts(SHOW_BAR=lambda request: True):
            with self.assertRaisesMessage(ImproperlyConfigured, "SHOW_BAR"):
                conf.current()
