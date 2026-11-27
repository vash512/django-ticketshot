# django-ticketshot

Review tickets for any Django project, without touching your templates:

- **Bar:** a rail on the edge of every page. Capture the view, annotate it with
  a pen, cover private data with the redaction tool, write a note, and create a
  ticket with the context the server knows about that page. Its drawer lists
  the open tickets for that view.
- **Panel:** its own board, list, and review queue.
- **Separate database:** tickets can live in a shared database of their own,
  so a developer can keep a local SQLite without credentials for the main one.
- **Recorded flows** with a server-side debug log.

Tested with Django 4.2, Python 3.10+, and Pillow 9.4+. The vocabulary and the
design decisions are in [`docs/architecture.md`](docs/architecture.md).

## The idea

- **Everything starts approved.** A view without tickets is considered approved.
- **The approved version is the live view,** not a screenshot.
- **An original only exists when there is a change:** it is the ticket's
  capture. Comparing needs a ticket with a capture.

## The ticket

| Status | Set by |
|---|---|
| Requested | The reviewer, when creating it |
| In progress | The team |
| In review | `ticketshot_sync`, when a commit that mentions `TS-12` reaches the review branch. Also by hand. |
| Approved | The reviewer |
| Discarded | The team |

- Approval is **per ticket**.
- Rejecting has two paths:
  - **"Still not working":** a text note on the same ticket, which goes back
    to "Requested". The original capture is still valid.
  - **A chained ticket with a new capture,** when the screen has changed.
- Before creating a ticket, the bar shows the open tickets for that URL, to
  avoid duplicates, chain, or compare.
- A ticket belongs to its **trigger URL** (the first one) and stores the URLs
  visited. If the URL is volatile, the team replaces it with a **replicable
  URL** with tags (`/customers/{customer}/`) and says where each tag comes from.
- History is append-only: the model forbids editing or deleting it (it only
  goes away with its ticket).
- Two reviewers deciding at the same time cannot leave contradictory states:
  every change locks the row.
- Resending the same draft (for example after a network failure) returns the
  ticket already created; if the content changed, the answer is 409.
- **Notes:** each capture can have its own note, written before or after
  annotating; the ticket has a general note. If the general note is empty, the
  ticket uses the capture notes.

## The panel

The board shows Requested, In progress, In review, Approved, and Closed. Cards
move by dragging them or with "Move to…"; the server validates every change.
"Open TS-12" opens a ticket. The list is at `?view=list`. `panel/queue/`
reviews one ticket at a time, comparing the original capture with the live
view side by side or overlaid; A approves, R rejects, and → skips.

Approved and closed tickets are not reopened. The decisions about the columns
are in [`docs/architecture.md`](docs/architecture.md#decisions).

## Installation

```bash
pip install django-ticketshot          # or pip install -e <repository folder>
pip install "django-ticketshot[s3]"    # with S3
```

### With the defaults (no `TICKETSHOT`)

Register the app, the middleware, and the URL. Tickets live in their own
SQLite database (`ticketshot.sqlite3` next to `BASE_DIR`, alias `ticketshot`,
with its router; the package adds both when the project does not declare them)
and images in `MEDIA_ROOT/ticketshot` (`media` mode: only with `DEBUG`).

```python
INSTALLED_APPS += ["ticketshot"]
MIDDLEWARE += ["ticketshot.middleware.TicketShotMiddleware"]  # after authentication
# urls.py
path("__ticketshot/", include("ticketshot.urls")),
```

```bash
python manage.py migrate                           # creates ticketshot's permissions
python manage.py migrate --database=ticketshot     # creates its database
```

By default the bar is shown to staff users and superusers (see
[Permissions](#permissions)). If the main database uses a relative path, start
the server from the project folder.

### With configuration

The package **reads no environment variables and ships no `.env` template:**
everything is declared in the project's `settings.py`, which can take the
values from wherever it wants. A complete example, with the bar off unless the
project turns it on:

```python
if TICKETSHOT_ENABLED:  # the project decides how it is turned on
    INSTALLED_APPS += ["ticketshot"]
    # After authentication: the bar depends on request.user.
    MIDDLEWARE.insert(
        MIDDLEWARE.index("django.contrib.auth.middleware.AuthenticationMiddleware") + 1,
        "ticketshot.middleware.TicketShotMiddleware")

    # Shared tickets database (optional): without it, tickets go to their own
    # SQLite; with TICKETSHOT["DATABASE"] = "default", to the main database.
    DATABASES["ticketshot"] = {
        "ENGINE": "django.db.backends.postgresql",
        "NAME": "...", "USER": "...", "PASSWORD": "...", "HOST": "...",
        "PORT": "5432", "OPTIONS": {"sslmode": "require"},
    }
    DATABASE_ROUTERS = ["ticketshot.routers.TicketShotRouter", *DATABASE_ROUTERS]

    # Images in a private S3 bucket (django-storages 1.13 or later).
    STORAGES = {
        "default": {"BACKEND": "django.core.files.storage.FileSystemStorage"},
        "staticfiles": {"BACKEND": "django.contrib.staticfiles.storage.StaticFilesStorage"},
        "ticketshot": {
            "BACKEND": "storages.backends.s3boto3.S3Boto3Storage",
            "OPTIONS": {
                "bucket_name": "...", "region_name": "...",
                "access_key": "...", "secret_key": "...",
                "location": "ticketshot/myproject",  # never media/ or static/
                "default_acl": "private", "querystring_auth": True,
                "querystring_expire": 300, "file_overwrite": False,
            },
        },
    }

    TICKETSHOT = {
        "PROJECT": "myproject",
        "DATABASE": "ticketshot",     # the alias above, or "default"
        "STORAGE": "storage",         # or "media" for local tests
        "STORAGE_ALIAS": "ticketshot",
        "SERVE": "redirect",          # signed bucket link
        "REVIEW_BRANCH": "staging",
        "REVIEW_URL": "https://staging.myproject.test",
    }
```

Every `TICKETSHOT` option, with its comment and type, is in
[`src/ticketshot/conf.py`](src/ticketshot/conf.py). Options are validated
once: an unknown option or a value of the wrong type is a `manage.py check`
error (`ticketshot.E001`), never silently ignored. The checks also warn when
the router or the storage alias is missing, or when the middleware comes
before authentication.

Migrations go to the tickets database:

```bash
python manage.py migrate ticketshot --database=ticketshot   # separate database
python manage.py ticketshot_config                          # where does it point?
python manage.py ticketshot_doctor                          # is everything ready?
```

### Several projects, one database

`TICKETSHOT["PROJECT"]` separates tickets, numbering, panel, and images inside
a shared database and storage, so local, staging, and production can share
them. Names use letters, digits, `-`, and `_` (for example `myproject-staging`).

## Permissions

By default, `ticketshot.permissions.StaffPermissions` shows the bar and lets
staff users and superusers create and comment on tickets. The panel, images,
status changes, approvals, and the debug log require a superuser. Anonymous
or inactive users have no access. Users who are neither staff nor superusers
do not get the bar.

`ticketshot.permissions.ModelPermissions` uses Django permissions instead:
`add_ticket` for the bar and creating tickets, `view_ticket` for the panel and
images, either of those to comment, `change_ticket` for statuses and the
replicable URL, `approve_ticket` to approve, and `view_debug` for the debug
log. These permissions live in the main users database.

Choose the class with a dotted path or the class itself:

```python
TICKETSHOT = {
    "PERMISSIONS": "myproject.permissions.MyPermissions",
}
```

A subclass overrides the internal decisions (`_can_add`, `_can_view`,
`_can_comment`, `_can_work`, `_can_approve`, `_can_debug`, `_show_bar`);
anything it does not define is denied, and the public methods keep the
active-user check:

```python
from ticketshot.permissions import StaffPermissions

class MyPermissions(StaffPermissions):
    def _can_view(self, user):
        return user.is_superuser or user.username == "reviewer"
```

Seeing the bar is not enough to create tickets: that needs `can_add`. Whoever
sees the bar also sees the open tickets of that view. Without panel access:
403; without a session: the login page. The Django admin is read-only, shows
only the configured project's tickets, and follows the same class.

## Separate database

With `TICKETSHOT["DATABASE"]` pointing to its own `DATABASES` alias, tickets
go there, and `ticketshot.routers.TicketShotRouter` sends only ticketshot's
tables to that alias. Nothing else migrates there. A ticket has no foreign
keys to the user: it stores the username and label.

Creating a ticket manages its own transaction (it saves files and deletes them
if something fails), so that view does not run inside `ATOMIC_REQUESTS`.

## Images: `media` and `storage`

- **`media`:** local disk, **for local tests only.** Outside `DEBUG` it is an
  error (`ticketshot.E005`).
- **`storage`:** a `STORAGES` alias (`TICKETSHOT["STORAGE_ALIAS"]`, default
  `ticketshot`). On servers, a private S3 bucket with signed links. Its folder
  (`location`) should not be `media/` or `static/`.

Images are only served through `/__ticketshot/images/<id>/`, which checks the
permission every time. Each image remembers which mode wrote it.

## Static files and caching

The bar is a set of ES modules (`static/ticketshot/bar-<version>/`) that import
each other. The folder carries the package version: after an upgrade, the
browser never mixes a new module with an old cached one. With
`ManifestStaticFilesStorage` you can also enable
`support_js_module_import_aggregation` in your subclass so imports carry the
hash. Pages with the bar are marked `Cache-Control: private`.

## Debug log

While a flow is recorded, the bar sets the `ticketshot_rec` cookie. Every
request from the person recording is logged on the server, like Django's
yellow debug page: parameters, session, view arguments, template context,
touched records (model, id, and operation), SQL queries with their timing, and
the traceback if there was an exception.

The browser never receives it, and only users with debug access can see it.
It is cleaned with `SafeExceptionReporterFilter` (POST, GET, session,
templates, and the parameters of queries whose SQL names something sensitive);
paths, the `Referer`, and a redirect's `Location` keep only parameter names;
an uploaded file keeps only its extension; a written record keeps only model,
id, and operation (never its text). There is a size cap per request (always
enforced) and an approximate cap of requests per recording.
`ticketshot_prune` deletes logs of recordings that were never sent.

## Commands

| Command | Purpose |
|---|---|
| `ticketshot_config [--json]` | How it is configured, without secrets. |
| `ticketshot_doctor [--write-test]` | Database, migrations, storage, and review branch. |
| `ticketshot_status [--markdown \| --json]` | Open tickets with what reviewers said. The Markdown quotes their text with `>` so an AI does not take it as instructions. |
| `ticketshot_create` | A ticket for an unrequested change, with captures from disk. |
| `ticketshot_sync [--apply]` | Moves to "In review" the tickets whose commit reached the review branch. Running it twice changes nothing more. |
| `ticketshot_prune [--apply]` | Deletes orphaned debug logs. |

Commands that write always state the target and ask for `--yes` when the
database is shared.

## Language

Ticketshot uses Django's active language (`LocaleMiddleware`, when enabled).
The interface is written in English and ships a Spanish translation: language
codes starting with `es` show Spanish. In the bar, every other language shows
English. On the server, a language without a catalog falls back to the
project's `LANGUAGE_CODE`, as Django does. Status keys, URLs, and stored data
are language independent.

The middleware never changes the language of the project's own pages: they
keep the active language and its number and date formats (`es-mx` stays
`es-mx`, not `es`). Only ticketshot's panel, its API, and the bar it injects
switch to English for a language without a catalog.

## Privacy

- The image is flattened in the browser with its annotations and redactions.
  Only the annotated capture is stored.
- **The redaction tool covers with a solid color.** A capture automatically
  hides:
  - anything with `data-ticketshot-mask` (or the `MASK_SELECTORS`);
  - password fields;
  - emails and phone numbers.
- The browser recorder never stores what is typed: for a field, only the
  number of characters; for a URL, the path and parameter names; for a
  `prompt`, nothing; for the console, no text. It does store each URL's path
  and the attributes the site gives its elements (`id`, `name`, classes): they
  belong to the site, not to the person typing. A site that builds paths from
  typed text will show it in the path.
- Console and network logs are **optional**: they are sent only if the person
  creating the ticket leaves their checkbox on, which shows how many there
  are. With the checkbox on, the full text the page writes to the console is
  stored (messages, errors, and objects with their values, as JSON, up to
  2000 characters per message), with emails and phone numbers hidden. If a
  page writes what the user types to the console, it will be in the logs. This
  is the only exception to "never typed values": the checkbox decides, and it
  never reaches the recorder.
- The page's signed context carries no session values, SQL, or settings:
  signed is not encrypted. `CONTEXT_EXTRA` must return a dict of up to 4 KB.
- **Anonymized URLs** (`ANONYMIZE_URLS`, on by default): in every URL stored
  with the ticket (the trigger URL, each capture's URL, the visited ones, the
  browser's, and what the server derives from them), emails and phone numbers
  from `MASK_PATTERNS` become `(email)` and `(phone)`. An id of 10 digits or
  more is also hidden; the replicable URL is the way back to the view. With
  `"ANONYMIZE_URLS": False` URLs are stored in full.

## The recorder: what it covers

| Situation | What happens |
|---|---|
| Navigating to another page of the site | Recording continues. Each load is an event with its verified view. |
| Page modals (DOM) | Captured; opening and closing are events (`DIALOG_SELECTORS`). |
| `alert`, `confirm`, and `prompt` | Not captured: their text and the answer are kept (a `prompt` answer is hidden). |
| Modal `<dialog>` | Makes the bar inert: use **Alt+Shift+S**. |
| Pages on another domain | Not recorded. |
| Another browser or device | No shared recording. |
| Limits | 30 minutes, 2000 events, 10 captures (start, 8 steps, and end). |

## Development

```bash
python -m venv venv
./venv/Scripts/pip install -e ".[dev]" "Django>=4.2,<4.3"
PYTHONPATH="src;." ./venv/Scripts/python -m django test tests --settings=tests.settings
node --test tests/js/bar.test.mjs tests/js/board.test.mjs tests/js/composer.test.mjs tests/js/capture.test.mjs tests/js/editor.test.mjs
```

On Linux or macOS use `PYTHONPATH=src:.`. The rebuilt capture uses
`modern-screenshot` 4.7.0 (MIT license), copied into `static/ticketshot/vendor/`
with its license.

Quality can be measured with the [ub-mode](https://github.com/unclebob/ub-mode)
tools: `crapper` (complexity weighted by missing coverage; no function at CRAP
10 or more), `dryer` (duplication at 0.8 or more), and `mutator` (mutation
testing). How to run them here: `CLAUDE.md`. They are expensive: use them for
foundations or bounded pieces.

## License

MIT. See [LICENSE](LICENSE).
