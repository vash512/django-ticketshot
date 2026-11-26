// Helpers for bar and board tests (node --test).
import { readdirSync } from 'node:fs';

// Find the versioned bar directory instead of hardcoding its version.
const STATIC = new URL('../../src/ticketshot/static/ticketshot/', import.meta.url);
export const dir = readdirSync(STATIC).find((name) => name.startsWith('bar-'));
export const load = (name) => import(new URL(dir + '/' + name, STATIC));

// These suites check the Spanish UI; English-only checks pass a language to `t()`.
(await load('i18n.js')).setLanguage('es');

/** Buttons and links as used by the bar: action, data, state, and text. */
export function controls(html) {
  return [...html.matchAll(/<(button|a)\b([^>]*)>(.*?)<\/\1>/gs)].map(([, , attrs, inner]) => {
    const attr = (name) => (attrs.match(new RegExp('\\s' + name + '="([^"]*)"')) || [])[1];
    const parts = [attr('data-act') || attr('href')];
    for (const name of ['data-key', 'data-id', 'data-mode', 'data-reject', 'aria-label', 'title']) {
      if (attr(name) !== undefined) parts.push(name.replace('data-', '') + '=' + attr(name));
    }
    if (/\sdisabled\b/.test(attrs)) parts.push('deshabilitado');
    return parts.join(' ') + ' «' + inner.replace(/<[^>]+>/g, '').trim() + '»';
  });
}

/** Text visible on screen. */
export const text = (html) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

export function fakeBrowser(href) {
  const store = new Map();
  globalThis.location = new URL(href);
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
    key: (i) => Array.from(store.keys())[i] ?? null,
    get length() { return store.size; }
  };
  const listeners = [];
  globalThis.window = {
    addEventListener: (type, fn, capture) => listeners.push({ type, fn, capture: capture === true }),
    /** Like the browser, resource errors are only seen during capture. */
    dispatch(type, event) {
      const resource = Boolean(event.target && event.target.tagName);
      listeners.filter((l) => l.type === type && (l.capture || !resource)).forEach((l) => l.fn(event));
    },
  };
  globalThis.XMLHttpRequest = function () { this.handlers = {}; this.status = 0; };
  XMLHttpRequest.prototype.open = function () {};
  XMLHttpRequest.prototype.send = function () {};
  XMLHttpRequest.prototype.addEventListener = function (type, fn) { this.handlers[type] = fn; };
  /** Complete the request as a browser would. */
  XMLHttpRequest.prototype.finish = function (status) { this.status = status; (this.handlers.loadend || (() => {}))(); };
  return store;
}

/** Restore the console even if the test fails; createLogs wraps it. */
export async function withQuietConsole(fn) {
  const original = { error: console.error, warn: console.warn };
  console.error = console.warn = () => {};
  try { await fn(); } finally { Object.assign(console, original); }
}

/** Set browser globals for `fn` and then restore Node's originals. */
export async function withGlobals(values, fn) {
  const saved = Object.keys(values).map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]);
  for (const [name, value] of Object.entries(values)) {
    Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  }
  try { return await fn(); } finally {
    for (const [name, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  }
}

/** Fake fetch records calls and responds through `reply`. */
export function withFetch(reply, fn) {
  const calls = [];
  return withGlobals({ fetch: async (url, init) => { calls.push({ url, init }); return reply(url, init); } },
                     () => fn(calls));
}

export const reply = (data, status = 200) => async () => ({ ok: status < 400, status, json: async () => data });

/** As in store.js, drafts use draft IDs and blobs use explicit keys. */
export function fakeStore() {
  const tables = { drafts: new Map(), blobs: new Map() };
  return {
    tables,
    get: async (table, key) => tables[table].get(key),
    put: async (table, value, key) => { tables[table].set(table === 'drafts' ? value.id : key, value); },
    del: async (table, key) => { tables[table].delete(key); },
    persistent: () => false,
  };
}

export async function withClock(now, fn) {
  const original = Date.now;
  Date.now = () => now;
  try { return await fn(); } finally { Date.now = original; }
}

