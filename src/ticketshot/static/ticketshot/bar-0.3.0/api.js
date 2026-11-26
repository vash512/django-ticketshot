/*
 * Calls from the bar to list open tickets for this URL, act on tickets,
 * submit new tickets, and link recording requests to debug records.
 */
import { flatten, redactionCount } from './draw.js';
import { t } from './i18n.js';
import { maskedTitle } from './mask.js';
import { LS, jsonOrError, lsDel, lsGet, lsSet, recordedUrl } from './util.js';

const HEADER = 'ticketshot';

function clientInfo(persistent, title) {
  let tz = '';
  try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone; } catch (e) { /* nada */ }
  return {
    url: location.href,
    title: title,
// The previous page URL needs no query values for navigation.
    referrer: document.referrer ? recordedUrl(document.referrer) : '',
    userAgent: navigator.userAgent,
    language: navigator.language,
    languages: (navigator.languages || []).slice(0, 5),
    timezone: tz,
    viewport: { width: window.innerWidth, height: window.innerHeight },
    screen: { width: screen.width, height: screen.height, dpr: window.devicePixelRatio || 1 },
    scroll: { x: Math.round(window.scrollX), y: Math.round(window.scrollY) },
    touch: navigator.maxTouchPoints || 0,
    colorScheme: matchMedia('(prefers-color-scheme: dark)').matches ? 'oscuro' : 'claro',
    online: navigator.onLine,
    storage: persistent ? 'indexeddb' : 'memoria',
    sentAt: new Date().toISOString()
  };
}

export function imageMeta(img, field) {
  return {
    field: field, role: img.role, method: img.method, pageUrl: img.pageUrl,
    pageTitle: img.pageTitle, pageToken: img.pageToken, capturedAt: img.capturedAt,
    offsetMs: img.offsetMs, caption: img.caption || '', device: img.device || '',
    edited: (img.ops || []).length > 0, redactions: redactionCount(img.ops)
  };
}

function jsonBlob(value) { return new Blob([JSON.stringify(value)], { type: 'application/json' }); }

function post(cfg, url, body) {
  return fetch(url, {
    method: 'POST', body: body, credentials: 'same-origin',
    headers: { 'X-CSRFToken': cfg.csrf, 'X-Requested-With': HEADER }
  }).then(jsonOrError);
}

/** Open tickets for this URL, their actions, and any pending chain. */
class Tickets {
  constructor(cfg) {
    this.cfg = cfg;
    this.list = [];
    this.loaded = false;
  }

  load() {
    const self = this;
    const open = this.cfg.endpoints.open;
    if (!open) return Promise.resolve([]);
    const url = open + '?path=' + encodeURIComponent(location.pathname + location.search);
    return fetch(url, { credentials: 'same-origin', headers: { 'X-Requested-With': HEADER } })
      .then(function (r) { return r.ok ? r.json() : { tickets: [] }; })
      .then(function (data) { self.list = data.tickets || []; self.loaded = true; return self.list; })
      .catch(function () { self.loaded = true; return []; });
  }

  find(key) {
    return this.list.filter(function (t) { return t.key === key; })[0] || null;
  }

  action(key, action, fields) {
    const body = new URLSearchParams(Object.assign({ action: action }, fields || {}));
    return post(this.cfg, this.cfg.endpoints.action.replace('{key}', encodeURIComponent(key)), body);
  }

// A chain survives navigation until the draft is submitted.
  chain() { return lsGet(LS.chain, null); }
  setChain(key, reject) { lsSet(LS.chain, { key: key, reject: !!reject }); }
  clearChain() { lsDel(LS.chain); }
}

/** Name and type of the image sent to the server. */
export function imageAttachment(index, type) {
  const field = 'image_' + index;
  return { field, filename: field + '.' + (type === 'image/webp' ? 'webp' : 'png') };
}

/** Flatten a capture with its marks and add it to the form. */
export async function appendImage(form, drafts, img, i) {
  const blob = await drafts.blob(img);
  if (!blob) throw new Error(t('Image ') + (i + 1) + t(' is missing in this browser.'));
  const flat = await flatten(blob, img.ops);
  const attachment = imageAttachment(i, flat.type);
  form.append(attachment.field, flat, attachment.filename);
  return imageMeta(img, attachment.field);
}

/** Process images one at a time to limit memory use. */
function appendImages(form, drafts, images) {
  const metas = [];
  return images.reduce(function (chain, img, i) {
    return chain.then(function () {
      return appendImage(form, drafts, img, i).then(function (meta) { metas.push(meta); });
    });
  }, Promise.resolve()).then(function () { return metas; });
}

/** Browser data submitted with a masked page title. */
export function payloadOf(cfg, client, draft, note, options, images) {
// The trigger URL comes from the first capture or recording start.
  const first = draft.images[0] || {};
  return {
    clientId: draft.id, kind: draft.kind, note: note,
    pageUrl: first.pageUrl || location.href,
    pageTitle: first.pageTitle || client.title,
    pageToken: first.pageToken || cfg.pageToken,
    durationMs: draft.durationMs,
    device: options.device,
    parent: options.parent || '',
    rejectParent: !!options.rejectParent,
    recordingId: draft.recordingId || '',
    client: client,
    images: images
  };
}

/** Attach a nonempty selected list of logs or events. */
function appendList(form, name, chosen, list) {
  if (chosen && list && list.length) form.append(name, jsonBlob(list), name + '.json');
}

/**
 * Submit the draft with its client ID. A retry after a network failure
 * returns the same ticket if the server already saved it.
 */
function submitDraft(cfg, drafts, mask, draft, note, options) {
  const form = new FormData();
  return appendImages(form, drafts, draft.images).then(function (images) {
    const client = clientInfo(drafts.persistent(), maskedTitle(mask));
    form.append('payload', JSON.stringify(payloadOf(cfg, client, draft, note, options, images)));
    appendList(form, 'logs', options.logs, draft.logs);
    appendList(form, 'events', options.events, draft.events);
    return post(cfg, cfg.endpoints.create, form);
  });
}

function cookieTail() {
  return '; SameSite=Lax' + (location.protocol === 'https:' ? '; Secure' : '');
}

// During recording, the server logs reviewer requests for debugging.
// The cookie carries the recording ID.
function setRecordingCookie(cfg, id) {
  if (!cfg.recordingCookie || !id) return;
  document.cookie = cfg.recordingCookie + '=' + encodeURIComponent(id) +
    '; path=/; max-age=' + (cfg.limits.recordingMinutes * 60 + 600) + cookieTail();
}

function clearRecordingCookie(cfg) {
  if (!cfg.recordingCookie) return;
  document.cookie = cfg.recordingCookie + '=; path=/; max-age=0' + cookieTail();
}

export function createApi(cfg, drafts, mask) {
  return {
    tickets: new Tickets(cfg),
    submit: function (draft, note, options) { return submitDraft(cfg, drafts, mask, draft, note, options); },
    recordingCookie: {
      set: function (id) { setRecordingCookie(cfg, id); },
      clear: function () { clearRecordingCookie(cfg); }
    }
  };
}
