"""Move tickets into review when their commits reach the configured branch."""
import subprocess
from datetime import datetime
from pathlib import Path

from django.conf import settings
from django.core.management.base import BaseCommand, CommandError
from django.utils import timezone
from django.utils.translation import gettext as _, gettext_lazy as _lazy

from ... import conf, keys, states, users, workflow
from ..destination import require_yes

SEP_FIELD = "\x1f"
SEP_RECORD = "\x1e"
WORKING = (states.Status.REQUESTED, states.Status.IN_PROGRESS)


def parse_log(out):
    """Parse git log output into commit records."""
    commits = []
    for record in out.split(SEP_RECORD):
        parts = record.strip("\n").split(SEP_FIELD)
        if len(parts) < 4:
            continue
        sha, date, subject, body = parts[0].strip(), parts[1], parts[2], parts[3]
        commits.append({"sha": sha, "date": datetime.fromisoformat(date),
                        "subject": subject, "text": f"{subject}\n{body}"})
    return commits


def git_log(repo, ref, since):
    command = ["git", "-C", str(repo), "log", ref, f"--since={since}",
               f"--format=%H{SEP_FIELD}%cI{SEP_FIELD}%s{SEP_FIELD}%b{SEP_RECORD}"]
    try:
        result = subprocess.run(command, capture_output=True, check=True,
                                encoding="utf-8", errors="replace")
    except FileNotFoundError as exc:
        raise CommandError(_("Git was not found.")) from exc
    except subprocess.CalledProcessError as exc:
        raise CommandError(_("git log %(ref)s failed: %(error)s") %
                           {"ref": ref, "error": exc.stderr.strip()}) from exc
    return parse_log(result.stdout)


def mentions(commits):
    """Group mentioning commits by ticket number, newest first."""
    found = {}
    for commit in commits:
        for number in keys.mentioned_in(commit["text"]):
            found.setdefault(number, []).append(commit)
    return found


def _threshold(ticket):
    threshold = workflow.reopen_threshold(ticket)
    if timezone.is_naive(threshold):
        # With USE_TZ false, projects store naive local time.
        threshold = timezone.make_aware(threshold)
    # Git records whole seconds, so compare to second precision.
    return threshold.replace(microsecond=0)


def plan(by_number):
    """Choose the newest commit after each ticket's last rejection."""
    candidates = workflow.tickets().filter(number__in=list(by_number), status__in=WORKING)
    steps = []
    for ticket in candidates:
        threshold = _threshold(ticket)
        fresh = [c for c in by_number[ticket.number] if c["date"] >= threshold]
        if fresh:
            steps.append((ticket, fresh[0]))
    return steps


class Command(BaseCommand):
    help = _lazy("Link commits on the review branch to tickets and move them into review.")

    def add_arguments(self, parser):
        parser.add_argument("--ref", default="", help=_("Branch or ref (defaults to origin/<REVIEW_BRANCH>)."))
        parser.add_argument("--since", default="90 days ago", help=_("How far back to search."))
        parser.add_argument("--repo", default="", help=_("Repository root (defaults to BASE_DIR)."))
        parser.add_argument("--fetch", action="store_true", help=_("Run git fetch first."))
        parser.add_argument("--apply", action="store_true", help=_("Write changes."))
        parser.add_argument("--yes", action="store_true", help=_("Confirm writing to the shared database."))

    def _ref(self, options):
        branch = conf.current().review_branch
        ref = options["ref"] or (f"origin/{branch}" if branch else "")
        if not ref:
            raise CommandError(_("Provide --ref or configure TICKETSHOT['REVIEW_BRANCH']."))
        return ref

    def handle(self, *args, **options):
        ref = self._ref(options)
        repo = Path(options["repo"] or getattr(settings, "BASE_DIR", "."))
        if options["fetch"]:
            subprocess.run(["git", "-C", str(repo), "fetch", "--quiet"], check=False)
        by_number = mentions(git_log(repo, ref, options["since"]))
        if not by_number:
            self.stdout.write(_("No commit on %(ref)s mentions a %(prefix)s-N key.") %
                              {"ref": ref, "prefix": conf.current().key_prefix})
            return
        steps = plan(by_number)
        if not steps:
            self.stdout.write(_("Nothing to move: matching commits predate the last rejection "
                                "or their tickets are no longer open."))
            return
        for ticket, commit in steps:
            self.stdout.write(_("%(key)s “%(status)s” → “In review” with %(sha)s %(subject)s") %
                              {"key": ticket.key, "status": ticket.get_status_display(),
                               "sha": commit["sha"][:10], "subject": commit["subject"][:80]})
        if not options["apply"]:
            self.stdout.write(_("Without --apply, nothing was written."))
            return
        self._apply(steps, ref, options["yes"])

    def _apply(self, steps, ref, yes):
        require_yes(self, yes)
        actor = users.Actor.named("sync")
        for ticket, commit in steps:
            workflow.link_commit(ticket, actor, commit=commit["sha"], branch=ref,
                                 message=commit["subject"])
        self.stdout.write(self.style.SUCCESS(_("%(count)s tickets moved to “In review”.") %
                                             {"count": len(steps)}))
