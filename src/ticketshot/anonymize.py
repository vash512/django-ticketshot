"""Remove email addresses and phone numbers from stored URLs.

Apply the same patterns as `mask.js` to incoming URLs and derived paths,
queries, and view arguments. When `ANONYMIZE_URLS` is false, URLs remain intact.
`tests/fixtures/mask_cases.json` keeps both sides consistent.
"""
import re
from urllib.parse import quote, quote_plus, unquote, unquote_plus, urlsplit

from . import conf

# Match mask.js; JS \w and \d are ASCII. Bound the local part to avoid
# quadratic matching on long text without an at sign.
EMAIL = re.compile(r"[A-Za-z0-9_.+-]{1,64}@[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)+")
# Require at least 10 digits so prices and dates remain visible. Match JS
# whitespace explicitly because Python's \s includes more characters.
PHONE = re.compile(r"\+?[0-9][0-9\t\n\v\f\r    - "
                   r"    　﻿().-]{6,}[0-9]")
DATE = re.compile(r"[0-9]{4}-[0-9]{2}-[0-9]{2}")

URL_MARKS = {"email": "(email)", "phone": "(phone)"}
# RFC 3986 safe characters for each URL part, excluding percent signs and
# its own separators so only masked text changes.
_PATH_SAFE = "!$&'()*+,;=:@~"
_QUERY_SAFE = "!$'()*,;:@/?~"
_FRAGMENT_SAFE = "/?:@!$&'()*+,;=~"


def bullets(kind, found):
    """Return bar bullets, capped at 12 for email and 14 for phone."""
    return "•" * min(len(found), 12 if kind == "email" else 14)


def url_mark(kind, _found):
    return URL_MARKS[kind]


def _is_phone(found):
    # A timestamp also contains 10 digits; leave it intact.
    return not DATE.search(found) and sum(c.isdigit() for c in found) >= 10


def mask_text(value, patterns, mark=bullets):
    """Mask email and phone text using the active patterns."""
    out = str(value or "")
    if "email" in patterns:
        out = EMAIL.sub(lambda m: mark("email", m.group()), out)
    if "phone" in patterns:
        out = PHONE.sub(lambda m: mark("phone", m.group()) if _is_phone(m.group()) else m.group(), out)
    return out


def _active_patterns():
    config = conf.current()
    return config.mask_patterns if config.anonymize_urls else ()


def _piece(raw, patterns, decode, encode):
    """Decode a URL part and re-encode it only if masking changed it."""
    text = decode(raw)
    masked = mask_text(text, patterns, url_mark)
    return raw if masked == text else encode(masked)


def _path(path, patterns):
    return "/".join(_piece(seg, patterns, unquote, lambda t: quote(t, safe=_PATH_SAFE))
                    for seg in path.split("/"))


def _query_item(item, patterns):
    """Mask both name and value; preserve valueless parameters."""
    def part(raw):
        return _piece(raw, patterns, unquote_plus, lambda t: quote_plus(t, safe=_QUERY_SAFE))
    name, sep, raw = item.partition("=")
    return part(name) + sep + part(raw)


def _host(parts):
    """Return host and port without URL credentials."""
    return parts.netloc.rpartition("@")[2]


def _joined(parts, host, path, query, fragment):
    """Rebuild the URL, omitting empty query and fragment markers."""
    head = (f"{parts.scheme}:" if parts.scheme else "") + (f"//{host}" if parts.netloc else "")
    return head + path + (f"?{query}" if query else "") + (f"#{fragment}" if fragment else "")


def url(value):
    """Mask email and phone in the path, query, and fragment.

    Unchanged parts retain their original encoding. Masked parts are re-encoded
    without changing separators. Keep the host and remove URL credentials.
    """
    raw = str(value or "")
    patterns = _active_patterns()
    if not raw or not patterns:
        return raw
    try:
        parts = urlsplit(raw)
    except ValueError:
        return mask_text(raw, patterns, url_mark)
    path = _path(parts.path, patterns)
    query = "&".join(_query_item(item, patterns) for item in parts.query.split("&"))
    fragment = _piece(parts.fragment, patterns, unquote, lambda t: quote(t, safe=_FRAGMENT_SAFE))
    host = _host(parts)
    if (host, path, query, fragment) == (parts.netloc, parts.path, parts.query, parts.fragment):
        return raw
    return _joined(parts, host, path, query, fragment)


def value(item):
    """Mask a value derived from the URL, such as a view argument."""
    return mask_text(str(item), _active_patterns(), url_mark)
