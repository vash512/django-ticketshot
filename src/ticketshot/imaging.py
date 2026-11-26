"""Validate and re-encode every received image."""
import hashlib
from dataclasses import dataclass
from io import BytesIO

from django.core.exceptions import ValidationError
from django.utils.translation import gettext as _
from django.core.files.base import ContentFile
from PIL import Image, UnidentifiedImageError, features

from . import conf

ACCEPTED = {"PNG", "WEBP", "JPEG"}
EXTENSIONS = {"WEBP": "webp", "JPEG": "jpg", "PNG": "png"}


@dataclass(frozen=True)
class CleanImage:
    """Validated, re-encoded image ready for storage."""
    data: bytes
    ext: str
    width: int
    height: int
    @property
    def size(self):
        return len(self.data)
    @property
    def sha256(self):
        return hashlib.sha256(self.data).hexdigest()

    def content(self):
        return ContentFile(self.data)


def target_format():
    config = conf.current()
    if config.image_format == "WEBP" and not features.check("webp"):
        return "PNG"
    return config.image_format


def _open_checked(data):
    """Open an image and check format, dimensions, and integrity."""
    config = conf.current()
    try:
        probe = Image.open(BytesIO(data))
        if probe.format not in ACCEPTED:
            raise ValidationError(_("Unsupported image format."))
        width, height = probe.size
        if width * height > config.max_image_pixels:
            raise ValidationError(_("The image is %(width)s×%(height)s: too large.") %
                                  {"width": width, "height": height})
        probe.verify()
        image = Image.open(BytesIO(data))
        image.load()
    except (UnidentifiedImageError, OSError, SyntaxError) as exc:
        raise ValidationError(_("The file is not a valid image.")) from exc
    return image


def _has_alpha(image):
    return image.mode in ("RGBA", "LA") or (image.mode == "P" and "transparency" in image.info)


def _encode(image, fmt):
    if fmt == "JPEG" or not _has_alpha(image):
        image = image.convert("RGB")
    elif image.mode != "RGBA":
        image = image.convert("RGBA")
    options = {
        "WEBP": {"quality": conf.current().image_quality, "method": 4},
        "JPEG": {"quality": conf.current().image_quality},
        "PNG": {"optimize": True},
    }[fmt]
    out = BytesIO()
    image.save(out, fmt, **options)
    return out.getvalue()


def _check_size(size):
    max_bytes = conf.current().max_image_bytes
    if size > max_bytes:
        raise ValidationError(
            _("The image is %(size)s KB; the limit is %(limit)s KB.") %
            {"size": size // 1024, "limit": max_bytes // 1024})


def normalize(data):
    """Return a CleanImage from bytes or raise ValidationError."""
    _check_size(len(data))
    fmt = target_format()
    image = _open_checked(data)
    return CleanImage(_encode(image, fmt), EXTENSIONS[fmt], *image.size)


def normalize_upload(upload):
    """Normalize an upload after checking its size before reading."""
    _check_size(upload.size)
    return normalize(upload.read())
