"""Minimal settings for testing this package alone."""
import tempfile
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent
SECRET_KEY = "ticketshot-tests-only"
DEBUG = False
ALLOWED_HOSTS = ["testserver", "localhost"]
USE_TZ = True
TIME_ZONE = "America/Mexico_City"
LANGUAGE_CODE = "es-mx"

INSTALLED_APPS = [
    "django.contrib.admin",
    "django.contrib.auth",
    "django.contrib.contenttypes",
    "django.contrib.sessions",
    "django.contrib.messages",
    "django.contrib.staticfiles",
    "ticketshot",
]

MIDDLEWARE = [
    "django.middleware.security.SecurityMiddleware",
    "django.contrib.sessions.middleware.SessionMiddleware",
    "django.middleware.common.CommonMiddleware",
    "django.middleware.csrf.CsrfViewMiddleware",
    "django.contrib.auth.middleware.AuthenticationMiddleware",
    "ticketshot.middleware.TicketShotMiddleware",
    "django.contrib.messages.middleware.MessageMiddleware",
]

ROOT_URLCONF = "tests.urls"
TEMPLATES = [{
    "BACKEND": "django.template.backends.django.DjangoTemplates",
    "DIRS": [BASE_DIR / "templates"],
    "APP_DIRS": True,
    "OPTIONS": {"context_processors": [
        "django.template.context_processors.request",
        "django.contrib.auth.context_processors.auth",
        "django.contrib.messages.context_processors.messages",
    ]},
}]

DATABASES = {
    "default": {"ENGINE": "django.db.backends.sqlite3", "NAME": ":memory:"},
    "ticketshot": {"ENGINE": "django.db.backends.sqlite3", "NAME": ":memory:"},
}
DATABASE_ROUTERS = ["ticketshot.routers.TicketShotRouter"]
DEFAULT_AUTO_FIELD = "django.db.models.BigAutoField"
STATIC_URL = "/static/"
MEDIA_ROOT = tempfile.mkdtemp(prefix="ticketshot-tests-")
MEDIA_URL = "/media/"
LOGIN_URL = "/login/"
STORAGES = {
    "default": {"BACKEND": "django.core.files.storage.FileSystemStorage"},
    "staticfiles": {"BACKEND": "django.contrib.staticfiles.storage.StaticFilesStorage"},
    "ticketshot": {"BACKEND": "django.core.files.storage.InMemoryStorage"},
}
TICKETSHOT = {
    "PERMISSIONS": "ticketshot.permissions.ModelPermissions",
    "STORAGE": "storage",
    "DATABASE": "ticketshot",
    "PROJECT": "pruebas",
    "REVIEW_BRANCH": "staging",
    "REVIEW_URL": "https://staging.example.test",
}
