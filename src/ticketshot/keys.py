"""Visible ticket keys such as TS-12 with a configurable prefix."""
import re

from . import conf


def parse(key):
    """Parse a ticket number from TS-12, ts-12, or 12; otherwise return None."""
    prefix = re.escape(conf.current().key_prefix)
    match = re.fullmatch(rf"(?:{prefix}-)?(\d+)", str(key or "").strip(), re.I)
    return int(match.group(1)) if match else None


def mentioned_in(text):
    """Find ticket numbers mentioned in text, such as a commit message."""
    prefix = re.escape(conf.current().key_prefix)
    pattern = re.compile(rf"\b{prefix}-(\d+)\b", re.I)
    return sorted({int(n) for n in pattern.findall(text or "")})
