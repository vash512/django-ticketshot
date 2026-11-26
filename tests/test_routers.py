from django.test import SimpleTestCase

from ticketshot.routers import TicketShotRouter


class RouterTests(SimpleTestCase):
    def test_routes_only_ticketshot_to_its_alias(self):
        from django.contrib.auth.models import User

        from ticketshot.models import Ticket
        router = TicketShotRouter()
        with self.settings(TICKETSHOT={"DATABASE": "ticketshot"}):
            self.assertEqual(router.db_for_read(Ticket), "ticketshot")
            self.assertIsNone(router.db_for_write(User))
            self.assertTrue(router.allow_migrate("ticketshot", "ticketshot"))
            self.assertFalse(router.allow_migrate("default", "ticketshot"))
            self.assertFalse(router.allow_migrate("ticketshot", "auth"))
            self.assertIsNone(router.allow_migrate("default", "auth"))
        with self.settings(TICKETSHOT={"DATABASE": "default"}):
            self.assertTrue(router.allow_migrate("default", "ticketshot"))
            self.assertIsNone(router.allow_migrate("default", "auth"))
