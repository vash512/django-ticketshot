# ticketshot architecture

## Glossary

| Term | Meaning | In the code |
|---|---|---|
| **Ticket** | A change requested on a view, with its original capture. | `models.Ticket` |
| **Key** | The ticket's visible name: prefix + number per project (`TS-12`). | `keys`, `Ticket.key` |
| **Project** | A space for tickets and numbering inside a shared database. | `TICKETSHOT["PROJECT"]` |
| **Original capture** | How the view looked before the change. The approved version is the live view, not a capture. | `TicketImage` |
| **Annotations** | Pen, arrow, box, and text on the capture; flattened in the browser. | `bar-*/draw.js`, `editor.js` |
| **Redaction** | An annotation that covers with a solid color; what it covers never leaves the browser. | `draw.js` (`redact`) |
| **Automatic masking** | What the capture hides on its own: selectors, passwords, emails, phone numbers. | `bar-*/mask.js` |
| **Anonymized URL** | A stored URL whose emails and phone numbers became `(email)` and `(phone)` (same patterns as masking). | `anonymize`, `ANONYMIZE_URLS` |
| **Draft** | The ticket built in the browser before sending (IndexedDB). Its id is the `client_id`. | `bar-*/drafts.js` |
| **Capture note** | A note for one capture, written in the editor. | `TicketImage.caption` |
| **Trigger URL** | The ticket's first URL: the ticket belongs to it. | `Ticket.trigger_url` |
| **Replicable URL** | A path with tags (`/customers/{customer}/`) to get back to the view. | `urltemplate` |
| **Chain** | Link a new ticket to an open one (related change or rejection with a new capture). | `Ticket.parent` |
| **Rejection** | "Still not working": back to "Requested". It is an event, not an edit. | `workflow.reject` |
| **History** | The ticket's events; append-only. | `TicketEvent` |
| **News** | A ticket someone else moved since you last read it. | `queries.news` |
| **Review branch** | The branch where reviews happen; a commit there that mentions the key moves the ticket to "In review". | `REVIEW_BRANCH`, `ticketshot_sync` |
| **Signed context** | What the server knows about the page (view, timings, templates), signed inside the page. Signed is not encrypted. | `pagecontext` |
| **Recording** | A flow with events and captures (start, steps, end). | `bar-*/recorder.js` |
| **Debug log** | What the server saw on each request of a recording; never sent to the browser. | `debuglog`, `DebugRecord` |
| **Separate database** | A `DATABASES` alias only for tickets. | `routers`, `autoconfig`, `TICKETSHOT["DATABASE"]` |
| **Storage mode** | `media` (local disk, tests) or `storage` (a `STORAGES` alias). | `storage` |
| **Submission hash** | A hash of a submission's content: an identical retry returns the same ticket. | `submission.submission_hash` |
| **Permissions class** | One object that makes every access decision. | `permissions`, `TICKETSHOT["PERMISSIONS"]` |

## Module map

Boundaries (outside data enters here and is validated once):

- `conf.py`: `TICKETSHOT` → validated `Config` (cached until the setting changes).
- `autoconfig.py`: the package's own SQLite database and router when the project does not declare them.
- `submission.py`: the bar's submission or the skill's arguments → `intake.NewTicket`.
- `imaging.py`: received bytes → validated, re-encoded image (no metadata).
- `revision.py`: version and commit (configuration or `.git`, never the environment).

Domain (pure, no database):

- `states.py`: vocabulary, transition table, and the permission for each action.
- `urltemplate.py`, `keys.py`, `timeline.py`.
- `anonymize.py`: emails and phone numbers out of stored URLs (used by the
  boundaries: `submission`, `pagecontext.build`, and the open-tickets lookup in `api`).

Writing (one writer per thing):

- `workflow.py`: statuses, comments, template, and commits, with the row locked.
- `intake.py`: creates a `NewTicket` in one idempotent transaction.

Reading and presentation:

- `queries.py`: open tickets for a URL, news, reads.
- `api.py` (bar), `panel.py` (board, list, and review queue),
  `admin.py` (read-only fallback).

Infrastructure:

- `middleware.py` (orchestration), `pagecontext.py` (signed context and timing),
  `debuglog.py` (cleaned log), `storage.py`, `routers.py`, `checks.py`,
  `assets.py`, `users.py`, `permissions.py`.

The bar (`static/ticketshot/bar-<version>/`): `main.js` reads the configuration
and avoids mounting inside the panel's iframe (`util.embeddedInPanel`); `app.js`
wires the pieces without side effects on import; `i18n.js` holds the English
source strings' Spanish catalog (`t()` translates whole strings only);
`views.js` draws the rail and decides whether a capture is allowed
(`captureAllowed()`, button and shortcut); `util`, `mask`, and `draw` are pure
pieces (tested with Node). `store`, `capture`, and `recorder` talk to the
browser; `editor`, `composer`, `compare`, `ask`, and `bar` are the interface.
`board.js` drives the panel's board and queue.

## Decisions

- **One writer for status.** Every transition goes through
  `workflow.change_status`, which locks the row, rereads the status, and asks
  `states.next_status`. A stale copy of a ticket cannot reject one that someone
  else already approved.
- **History is immutable in the model,** not by convention: `save()` on an
  existing row, `delete()`, and bulk `update()`/`delete()` fail. Cascading
  deletion of the ticket does remove it.
- **Idempotent creation.** The bar sends the draft id. Same id, same author,
  and same hash: 200 with the ticket already created. Different content or
  author: 409. The skill sends no id (null, no clash with the unique constraint).
- **Creation does not run inside `ATOMIC_REQUESTS`:** it saves files and
  deletes them if its transaction fails; an outer transaction rolled back later
  would leave orphaned files.
- **Ordering and paging in the database.** The panel and the open tickets for a
  URL are ordered in SQL before slicing.
- **URL privacy.** The recorder and the debug log store paths with parameter
  names, not values. The trigger URL and each capture's URL keep their values:
  they are needed to get back to the view. The previous page (`referrer` of the
  submission and `Referer` of the signed context) is not needed for that and
  carries no values (`recordedUrl` in the bar, `pagecontext.names_only` on the
  server).
- **Anonymized URLs by default (`ANONYMIZE_URLS`, owner's decision,
  2026-11-26).** Every URL stored with the ticket (trigger, each capture, the
  visited ones, the browser's, events', and logs') and what the server derives
  from it (path and query of the signed context, view arguments) goes through
  `anonymize`: each email or phone number becomes `(email)` or `(phone)`, with
  the same patterns as capture masking (`MASK_PATTERNS`). It happens on the
  server, at its boundaries (`submission`, `pagecontext.build`), because the
  server already sees these URLs on every request: what matters is not storing
  them, especially in a shared database. The open-tickets lookup masks the
  requested path so it matches the stored one. A URL piece (path segment, query
  name or value, fragment) without emails or phone numbers stays identical; one
  that had one is re-encoded, keeping its usual separators unencoded. User and
  password before the host are dropped. An email's local part is capped at 64
  characters on both sides: without that cap, a long text without "@" took
  quadratic time. Cost: a number of 10 or more digits in the URL (a long id) is
  also hidden, and the URL no longer leads to that view; the replicable URL
  (`urltemplate`) is the way back, and `ANONYMIZE_URLS: False` stores full URLs.
  `tests/fixtures/mask_cases.json` pins that `mask.js` and `anonymize.py`
  recognize the same things. The debug log stays out by the owner's decision
  (2026-11-26): its paths already drop query values, its values are cleaned
  with `SafeExceptionReporterFilter`, only debug users see it, and there the
  values are useful for debugging.
- **What the recorder guarantees, bounded:** no values typed in fields (for a
  text field, only its length), no URL query values, no `prompt` answers, no
  console text. What the site sets is kept: paths, element attributes, the page
  title, checkbox and radio states, and the text of the selected `<select>`
  option. The title and that option go through masking (emails, phone numbers,
  and anything marked to hide), and a hidden `<select>` leaves no option. The
  title is read in one place, `mask.maskedTitle`, for the recording, each
  capture, and the submission, so it matches what the image hides. A site that
  builds paths, titles, or options from typed text will show it there.
- **Console logs: an exception the checkbox decides.** They are optional (a
  checkbox with their count before sending). With the checkbox on, they keep
  the full text the page writes to the console, objects with their values
  included (JSON, up to 2000 characters per message), with emails and phone
  numbers hidden. If a page writes what the user types there, it will be in the
  logs. Owner's decision (2026-11-25): without the values the logs are useless
  for debugging, and the checkbox already lets people choose. The recorder
  never receives that text.
- **Console JSON is cut without walking the rest** (`util.JsonWriter`): a page
  that logs a huge object does not freeze, and a throwing getter or Proxy does
  not break the log ("[unreadable]").
- **One meter per request.** `pagecontext.Tracker` measures time and queries;
  the debug log (`debuglog.Collector`) receives each query as a listener and
  the duration when saving. Each query goes through a single wrapper.
- **No big factories in the bar.** A function with many closures cannot be
  measured or tested in parts (crapper counts nested functions inside their
  parent). Every `createX` is a thin constructor over classes or module
  functions; `app.js` wires the pieces and `main.js` only reads the
  configuration and starts.
- **Approved interface (2026-11-25):** the bar is a rail on the edge of the
  screen with a drawer for the view's tickets; the panel is a board by columns
  with a one-at-a-time review queue. Draft and recording live in the rail;
  collapsing it leaves a tab. On phones, the rail sits at the bottom. The editor
  keeps the tools on the left and color and thickness at the bottom.
- **Board columns: fixed for now (2026-11-25).** One per status: Requested, In
  progress, In review, Approved, and Closed. They cannot be added, removed, or
  reordered. Dragging a card to another column is an action the server
  validates as always (one writer, locked row, history): move (team), approve
  (In review to Approved, reviewer), or "Still not working" (In review to
  Requested, with a note). Approved and Closed are not reopened. A forbidden
  move returns the card and says why; a "Move to…" menu serves keyboard and
  phone users. The pointer is captured only once a drag really starts, so a
  click opens the ticket; "Open TS-12" is an explicit button.
- **Later: limited flexibility (decided, no date).** Free columns only between
  Requested and In review (all count as open), per project, in the separate
  database: stable key, name, order, and color. Requested, In review, Approved,
  and Closed stay fixed because the code depends on them: the entry point of
  the bar and of rejections, the automatic move to "In review" when the commit
  reaches the review branch, approving, and the rule that a view without open
  tickets is approved. History will keep the column name at that moment, so
  renaming does not rewrite the past.
- **Debug log without models' free text:** a write keeps model, id, and
  operation. A model's `__str__` may carry data no name-based filter catches.
- **ES modules without a bundler,** in a folder carrying the package version so
  the browser cache never mixes versions.
- **Works without configuration (2026-11-26, first trial in a real project).**
  With only the app, the middleware, and the URL, `autoconfig` adds in
  `ready()` the package's own SQLite database (`ticketshot.sqlite3` next to
  `BASE_DIR`, alias `ticketshot`) and the router (first in the list, resetting
  any router list Django already read), if the project does not declare them;
  images go to `media`. A project that declares the alias uses its own (for
  example a shared database).
- **Permissions in a replaceable class (`PERMISSIONS`, 2026-11-26).** One
  decision per method (`_can_add`, `_can_view`…); anything a subclass does not
  define is denied. Default `StaffPermissions`: bar and creation for staff and
  superusers, panel and everything else for superusers only, with no database
  queries. `ModelPermissions` uses Django permissions. Seeing the bar is not
  enough to create tickets: creation asks `can_add`. Whoever sees the bar does
  see the view's open tickets (note, author, path): that is what the drawer
  shows, to avoid duplicates and to chain; the panel asks `can_view`. The Django
  admin follows the class too (view: `can_view`; debug: `can_debug`; delete:
  view plus `can_work`), so it is not a back door.
- **`PROJECT` separates tickets in a shared database (2026-11-26).** Everything
  goes through `workflow.tickets()`, filtered by project, and numbering is per
  project; so local, staging, and production can share database and storage.
  The name is validated (letters, digits, "-", "_"): it is part of the images'
  path. A panel shared across projects is left for later.
- **Capture notes (2026-11-26).** The editor asks for "Note for this capture"
  before annotating (`TicketImage.caption`) and says a general note can be
  added when sending; if the general note is empty, the ticket carries the
  capture notes, cut to the note length limit.
- **Saving a capture does not open the drawer (2026-11-26).** The drawer lists
  sent tickets; opening it made people think the new one did not exist. Now a
  toast says where to send it, and the drawer shows the pending draft with
  "Send". The panel opens in another tab so the reviewed page stays.
- **English source, Spanish translation (2026-11-26).** Code, identifiers,
  URLs, comments, and docstrings are in English. User-facing text is English
  in the source, with a Spanish catalog (`locale/es` on the server, `i18n.js`
  in the bar). The language is Django's active one, not a ticketshot option.
  The bar translates whole strings only, so a missing entry shows English
  instead of a mixed sentence.
- **The project's pages keep their language (2026-11-26).** The middleware
  used to wrap the whole request in `override("es"|"en")`, so a project in
  `es-mx` rendered its own pages with Spain's formats (`6,00` instead of
  `6.00`), even with the bar disabled. Now `own_language()` only wraps
  ticketshot's own views and what it adds to a page (the bar and the debug
  record), and a Spanish variant is left active because it already reads the
  `es` catalog.

## How it got here

This version was rewritten from the previous package with an external
reviewer (Codex) that audited, refuted the design, and reviewed the
implementation until consensus. Each defect it found has a test that fails
without its fix (`tests/test_hardening.py`), checked by removing each fix one
at a time.
