"""Image storage through local media or a configured storage alias."""
from pathlib import Path

from django.conf import settings
from django.core.exceptions import ImproperlyConfigured
from django.core.files.storage import (FileSystemStorage, InvalidStorageError,
                                       Storage, storages)
from django.utils.deconstruct import deconstructible
from django.utils.translation import gettext as _

from . import conf


class PrivateFileSystemStorage(FileSystemStorage):
    """Local disk without a public URL; serve through the protected view."""

    def url(self, name):
        raise ValueError(_("ticketshot does not publish image URLs; use the protected view."))


def media_location():
    config = conf.current()
    if config.media_location:
        return Path(config.media_location)
    return Path(settings.MEDIA_ROOT or ".") / config.media_subdir


def backend_for(mode):
    """Backend for the selected media or storage mode."""
    if mode == conf.MEDIA:
        return PrivateFileSystemStorage(location=str(media_location()))
    if mode != conf.STORAGE:
        raise ImproperlyConfigured(_("Unknown storage mode: %(mode)r") % {"mode": mode})
    alias = conf.current().storage_alias
    try:
        return storages[alias]
    except InvalidStorageError as exc:
        raise ImproperlyConfigured(
            _("ticketshot uses storage mode with alias %(alias)r, but STORAGES does not define it.") %
            {"alias": alias}) from exc


def current_backend():
    return backend_for(conf.current().storage)


def is_local(backend):
    """Whether a backend is local disk and must serve via file reads."""
    return isinstance(backend, FileSystemStorage)


@deconstructible
class ModeStorage(Storage):
    """Delegate operations to the backend for the current mode."""

    def _backend(self):
        return current_backend()

    def _open(self, name, mode="rb"):
        return self._backend().open(name, mode)

    def _save(self, name, content):
        return self._backend()._save(name, content)

    def get_available_name(self, name, max_length=None):
        return self._backend().get_available_name(name, max_length=max_length)

    def generate_filename(self, filename):
        return self._backend().generate_filename(filename)

    def get_valid_name(self, name):
        return self._backend().get_valid_name(name)

    def delete(self, name):
        return self._backend().delete(name)

    def exists(self, name):
        return self._backend().exists(name)

    def listdir(self, path):
        return self._backend().listdir(path)

    def size(self, name):
        return self._backend().size(name)

    def url(self, name):
        return self._backend().url(name)

    def path(self, name):
        return self._backend().path(name)


_storage = ModeStorage()


def get_storage():
    """Callable image field storage so migrations do not serialize an instance."""
    return _storage
