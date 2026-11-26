"""Model changes always ship with their migration."""
from io import StringIO

from django.core.management import call_command
from django.test import SimpleTestCase


class MigrationsTests(SimpleTestCase):
    databases = {"default", "ticketshot"}

    def test_no_model_change_is_missing_a_migration(self):
        # Labels and choices count too: a project's `makemigrations` would
        # otherwise create a migration inside the installed package.
        out = StringIO()
        try:
            call_command("makemigrations", "ticketshot", check=True, dry_run=True, stdout=out)
        except SystemExit:
            self.fail("ticketshot has model changes without a migration:\n" + out.getvalue())
