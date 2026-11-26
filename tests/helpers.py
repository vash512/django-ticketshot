import json
import re
from io import BytesIO

from django.contrib.auth import get_user_model
from django.contrib.auth.models import Permission
from django.core.files.uploadedfile import SimpleUploadedFile
from django.test import TestCase, override_settings
from PIL import Image

from . import settings as base_settings

CONFIG = re.compile(r'<script id="ticketshot-config" type="application/json">(.*?)</script>', re.S)
ENDPOINT = "/__ticketshot/tickets/"

# Permission matrix roles.
TESTER = ("add_ticket",)
REVIEWER = ("add_ticket", "view_ticket", "approve_ticket")
TEAM = ("view_ticket", "change_ticket")


def ts(**overrides):
    """Override TICKETSHOT settings while preserving the test ticket database."""
    return override_settings(TICKETSHOT={**base_settings.TICKETSHOT, **overrides})


def png(width=40, height=30, color=(250, 245, 236), exif=False, fmt="PNG"):
    buffer = BytesIO()
    image = Image.new("RGB", (width, height), color)
    options = {}
    if exif:
        info = Image.Exif()
        # Make test objects.
        options["exif"] = info
    image.save(buffer, fmt, **options)
    return buffer.getvalue()


def upload(name="image_0.png", data=None, content_type="image/png"):
    return SimpleUploadedFile(name, data if data is not None else png(),
                              content_type=content_type)


def json_upload(name, value):
    return SimpleUploadedFile(name, json.dumps(value).encode("utf-8"),
                              content_type="application/json")


def make_user(username="probador", perms=TESTER, staff=False, superuser=False):
    user = get_user_model().objects.create_user(
        username=username, password="x", first_name="Ana", last_name="Prueba",
        is_staff=staff or superuser, is_superuser=superuser)
    for codename in perms:
        user.user_permissions.add(
            Permission.objects.get(content_type__app_label="ticketshot",
                                   codename=codename))
    return user


def config_of(response):
    match = CONFIG.search(response.content.decode())
    return json.loads(match.group(1)) if match else None


class TicketShotTestCase(TestCase):
    """Use both databases: primary for users and ticketshot for tickets."""

    databases = {"default", "ticketshot"}

    def page_token(self, path, client=None):
        html = (client or self.client).get(path).content.decode()
        return json.loads(CONFIG.search(html).group(1))["pageToken"]

    def post(self, payload, files=None, client=None):
        data = {"payload": json.dumps(payload)}
        data.update(files or {})
        return (client or self.client).post(ENDPOINT, data)

    def note_payload(self, images=1, token=None, path="/item/5/", **extra):
        token = token if token is not None else self.page_token(path)
        url = f"http://testserver{path}"
        payload = {
            "kind": "note",
            "note": "El botón de cobrar queda debajo del pie.",
            "pageUrl": url,
            "pageTitle": "Página de prueba",
            "pageToken": token,
            "client": {"viewport": {"width": 1280, "height": 800}},
            "images": [{"field": f"image_{i}", "role": "manual", "method": "dom",
                        "pageUrl": url, "pageToken": token,
                        "capturedAt": "2026-11-07T10:00:00.000Z", "edited": True,
                        "redactions": 2} for i in range(images)],
        }
        payload.update(extra)
        files = {f"image_{i}": upload(f"image_{i}.png") for i in range(images)}
        return payload, files

    def raise_ticket(self, client=None, **extra):
        payload, files = self.note_payload(**extra)
        response = self.post(payload, files, client=client)
        self.assertEqual(response.status_code, 201, response.content)
        from ticketshot.models import Ticket
        return Ticket.objects.get(pk=response.json()["id"])
