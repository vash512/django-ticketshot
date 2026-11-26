"""Create a ticket for an unsolicited change from disk captures."""
import json
from pathlib import Path

from django.core.exceptions import ValidationError
from django.core.management.base import BaseCommand, CommandError
from django.urls import reverse
from django.utils.translation import gettext as _, gettext_lazy as _lazy

from ... import conf, intake, states, submission, urltemplate, users
from ..destination import describe, require_yes

IMAGE_DEVICES = tuple(states.IMAGE_DEVICES)


def parse_image(raw, ticket_device):
    """Parse an optional device prefix and image path."""
    device, path = "", raw
    for prefix in IMAGE_DEVICES:
        if raw.startswith(prefix + "="):
            device, path = prefix, raw[len(prefix) + 1:]
    if not Path(path).is_file():
        raise CommandError(_("Image %(path)s does not exist.") % {"path": path})
    return path, device or (ticket_device if ticket_device in IMAGE_DEVICES else ""), ""


def parse_tag_args(raws):
    """Convert tag assignments to text for urltemplate."""
    return "\n".join(raw.replace("=", ":", 1) for raw in raws if "=" in raw)


def panel_url(ticket):
    review = conf.current().review_url.rstrip("/")
    return f"{review}{reverse('ticketshot:panel_detail', args=[ticket.key])}" if review else ""


class Command(BaseCommand):
    help = _lazy("Create a ticket from disk captures (unsolicited change).")

    def add_arguments(self, parser):
        parser.add_argument("--url", required=True, help=_("View path, for example /pos/search/."))
        parser.add_argument("--device", required=True, choices=list(states.Device.values),
                            help=_("Device for this change."))
        parser.add_argument("--image", action="append", default=[], metavar="[DEVICE=]PATH",
                            help=_("Original capture. Repeatable. Prefix with desktop= or mobile=."))
        parser.add_argument("--note", default="", help=_("What changed and why, for the reviewer."))
        parser.add_argument("--note-file", default="", help=_("File containing the note."))
        parser.add_argument("--implementation", default="", help=_("What was implemented or its keys."))
        parser.add_argument("--parent", default="", help=_("Ticket to chain to (TS-12)."))
        parser.add_argument("--template", default="", help=_("Reproducible URL with tags: /customers/{customer}/."))
        parser.add_argument("--tag", action="append", default=[], metavar="TAG=DESCRIPTION",
                            help=_("Source of each reproducible URL tag. Repeatable."))
        parser.add_argument("--author", default="skill", help=_("Who created the ticket."))
        parser.add_argument("--base-url", default="", help=_("Capture location (defaults to REVIEW_URL)."))
        parser.add_argument("--commit", default="", help=_("Commit of the captured version."))
        parser.add_argument("--branch", default="", help=_("Branch of the captured version."))
        parser.add_argument("--status", default=states.Status.IN_PROGRESS,
                            choices=list(states.SKILL_START),
                            help=_("Initial status (defaults to In progress)."))
        parser.add_argument("--yes", action="store_true", help=_("Confirm writing to the shared database."))
        parser.add_argument("--dry-run", action="store_true", help=_("Validate without writing."))
        parser.add_argument("--json", action="store_true", help=_("JSON output."))

    def _new_ticket(self, options):
        note = options["note"]
        if options["note_file"]:
            note = Path(options["note_file"]).read_text(encoding="utf-8")
        revision = ({"commit": options["commit"], "branch": options["branch"]}
                    if options["commit"] else {})
        return submission.from_files(
            note_text=note, url=options["url"], device=options["device"],
            images=[parse_image(raw, options["device"]) for raw in options["image"]],
            actor=users.Actor.named(options["author"]), implementation=options["implementation"],
            parent_key=options["parent"], template=options["template"],
            tags=urltemplate.parse_tags(parse_tag_args(options["tag"])), status=options["status"],
            base_url=options["base_url"] or conf.current().review_url, revision=revision)

    def handle(self, *args, **options):
        info = describe()
        try:
            new = self._new_ticket(options)
            if options["dry_run"]:
                self.stdout.write(_("Dry run. %(images)s captures; destination %(alias)s.") %
                                  {"images": len(new.images), "alias": info["alias"]})
                return
            require_yes(self, options["yes"], info)
            ticket, _created = intake.create(new, users.Actor.named(options["author"]))
        except ValidationError as exc:
            raise CommandError(" ".join(exc.messages)) from exc
        self._report(ticket, len(new.images), options["json"])

    def _report(self, ticket, images, as_json):
        panel = panel_url(ticket)
        if as_json:
            self.stdout.write(json.dumps({"key": ticket.key, "status": ticket.status,
                                          "images": images, "panel": panel}))
            return
        self.stdout.write(self.style.SUCCESS(
            _("%(key)s created as “%(status)s” with %(images)s captures.") %
            {"key": ticket.key, "status": ticket.get_status_display(), "images": images})
            + (_(" Panel: %(url)s") % {"url": panel} if panel else ""))
