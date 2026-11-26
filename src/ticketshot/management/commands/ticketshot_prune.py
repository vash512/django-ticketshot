"""Remove debug records for recordings that were never submitted."""
from datetime import timedelta

from django.core.management.base import BaseCommand
from django.utils import timezone
from django.utils.translation import gettext as _, gettext_lazy as _lazy

from ... import conf
from ...models import DebugRecord
from ..destination import require_yes


class Command(BaseCommand):
    help = _lazy("Delete orphaned debug records older than N days.")

    def add_arguments(self, parser):
        parser.add_argument("--days", type=int, default=7)
        parser.add_argument("--apply", action="store_true")
        parser.add_argument("--yes", action="store_true")

    def handle(self, *args, **options):
        limit = timezone.now() - timedelta(days=options["days"])
        doomed = DebugRecord.objects.using(conf.database()).filter(
            project=conf.current().project, ticket__isnull=True, created_at__lt=limit)
        count = doomed.count()
        self.stdout.write(_("%(count)s orphaned records older than %(days)s days.") %
                          {"count": count, "days": options["days"]})
        if not options["apply"] or not count:
            return
        require_yes(self, options["yes"])
        doomed.delete()
        self.stdout.write(self.style.SUCCESS(_("%(count)s records deleted.") % {"count": count}))
