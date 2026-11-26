import { t } from './i18n.js';

/*
 * Stateless helpers that do not touch the page on import, allowing
 * tests with node --test.
 */

export const DEVICE_LABELS = { desktop: 'Desktop', mobile: 'Mobile', both: 'Desktop and mobile' };

export function uid() {
  if (globalThis.crypto && crypto.randomUUID) return crypto.randomUUID();
  return 'x' + Date.now().toString(36) + Math.random().toString(36).slice(2);
}

export function esc(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}

export function wait(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
export function frame() { return new Promise(function (r) { requestAnimationFrame(function () { r(); }); }); }

export function clock(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  return String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
}

/** Return a relative same-origin path, or the full outside URL. */
export function relUrl(url, base) {
  try {
    const here = new URL(base || location.href);
    const u = new URL(url, here);
    return u.origin === here.origin ? u.pathname + u.search + u.hash : u.href;
  } catch (e) { return String(url); }
}

/** Hide the bar when the top document is the same-origin panel. */
export function embeddedInPanel(win, panelUrl) {
  if (!panelUrl || win.top === win) return false;
  try {
    const here = new URL(win.location.href);
    const panel = new URL(panelUrl, here);
    const top = new URL(win.top.location.href);
    return panel.origin === here.origin && top.origin === here.origin &&
      top.pathname.startsWith(panel.pathname);
  } catch (e) { return false; }
}

/**
 * Recorder URL: path and query parameter names, never values.
 * GET forms can put entered text in query values.
 */
export function recordedUrl(url, base) {
  try {
    const here = new URL(base || location.href);
    const u = new URL(url, here);
    const keys = Array.from(new Set(Array.from(u.searchParams.keys())));
    const query = keys.length ? '?' + keys.map(function (k) { return k + '=…'; }).join('&') : '';
    const path = u.origin === here.origin ? u.pathname : u.origin + u.pathname;
    return path + query;
  } catch (e) { return ''; }
}

/** Maximum stored console message length. */
export const MAX_TEXT = 2000;

/**
 * Convert a console argument to bounded text, then mask it.
 * Preserve text; encode objects and arrays as JSON up to MAX_TEXT.
 * Unreadable getters or proxies become an unreadable marker rather
 * than raising an error.
 */
export function consoleText(value) {
  try {
    if (typeof value === 'string') return value;
    if (value instanceof Error) return errorText(value);
    if (value === null || typeof value !== 'object') return String(value);
    return boundedJson(value, MAX_TEXT);
  } catch (e) {
    return t('[unreadable]');
  }
}

function errorText(error) { return error.name + ': ' + error.message; }

const FULL = {};

/**
 * Serialize like JSON.stringify, including BigInt, errors, and cycles.
 * Stop when the character budget is exceeded; skip remaining content
 * so huge objects cannot stall the page.
 */
class JsonWriter {
  constructor(budget) {
    this.budget = budget;
    this.out = '';
    this.seen = new WeakSet();
  }

  write(text) {
    this.out += text;
    if (this.out.length > this.budget) throw FULL;
  }

  value(raw) {
    const v = jsonView(raw);
    if (typeof v === 'bigint') return this.write(JSON.stringify(String(v)));
    if (v instanceof Error) return this.write(JSON.stringify(errorText(v)));
    if (v === null || typeof v !== 'object') return this.write(primitiveJson(v));
    if (this.seen.has(v)) return this.write('"[referencia repetida]"');
    this.seen.add(v);
    return Array.isArray(v) ? this.array(v) : this.object(v);
  }

  array(list) {
    this.write('[');
    for (let i = 0; i < list.length; i++) {
      if (i) this.write(',');
      this.value(list[i]);
    }
    this.write(']');
  }

  object(obj) {
    let separator = '';
    this.write('{');
    for (const key in obj) {
      if (!Object.prototype.hasOwnProperty.call(obj, key)) continue;
// Read once, as JSON.stringify does; a getter may have state.
      const v = obj[key];
      if (!writable(v)) continue;
      this.write(separator + JSON.stringify(key) + ':');
      separator = ',';
      this.value(v);
    }
    this.write('}');
  }
}

function boundedJson(value, budget) {
  const writer = new JsonWriter(budget);
  try {
    writer.value(value);
    return writer.out;
  } catch (e) {
    if (e !== FULL) throw e;
    return writer.out.slice(0, budget) + '…';
  }
}

/** An object's own JSON representation, such as an ISO date. */
function jsonView(v) {
  return v !== null && typeof v === 'object' && typeof v.toJSON === 'function' ? v.toJSON() : v;
}

/** Values JSON.stringify omits from objects. */
function writable(v) {
  return v !== undefined && typeof v !== 'function' && typeof v !== 'symbol';
}

/** Simple JSON value; serialize unsupported values as null. */
function primitiveJson(v) {
  const text = JSON.stringify(v);
  return text === undefined ? 'null' : text;
}

export function shorten(text, max) {
  const value = String(text || '');
  return value.length > max ? value.slice(0, max - 1) + '…' : value;
}

// ------------------------------------------------------- safe localStorage

export function lsGet(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? fallback : JSON.parse(raw);
  } catch (e) { return fallback; }
}

export function lsSet(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); return true; }
  catch (e) { return false; }
}

export function lsDel(key) { try { localStorage.removeItem(key); } catch (e) { /* nada */ } }

export function lsKeys(prefix) {
  try {
    return Array.from({ length: localStorage.length }, function (_, i) { return localStorage.key(i); })
      .filter(function (k) { return k && k.indexOf(prefix) === 0; });
  } catch (e) { return []; }
}

/** Browser storage keys, defined in one place. */
export const LS = {
  draft: 'ticketshot:draft',
  rec: 'ticketshot:rec',
  events: 'ticketshot:rec-events:',
  ui: 'ticketshot:ui',
  chain: 'ticketshot:chain',
  tab: 'ticketshot:tab'
};

/** Tab ID, retained on reload but lost when the tab closes. */
export function tabId() {
  try {
    let id = sessionStorage.getItem(LS.tab);
    if (!id) { id = uid().slice(0, 8); sessionStorage.setItem(LS.tab, id); }
    return id;
  } catch (e) { return uid().slice(0, 8); }
}

/** Parse server JSON or throw an Error with its message. */
export function jsonOrError(response) {
  return response.json().catch(function () { return {}; }).then(function (data) {
    if (!response.ok) throw new Error(data.error || (t('The server responded ') + response.status + '.'));
    return data;
  });
}
