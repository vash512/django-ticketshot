/*
 * Recent page console and network logs (up to 120 entries).
 *
 * Preserve console text, including objects, up to 2000 characters
 * per message after email and phone masking. Network URLs keep only
 * query parameter names. Send logs only when the ticket author opts in.
 * Exclude bar requests and library downloads during capture.
 */
import { MAX_TEXT, consoleText, recordedUrl, relUrl } from './util.js';
import { t } from './i18n.js';

const MAX = 120;

export function createLogs(options) {
  const items = [];
  const listeners = [];

  function push(entry) {
    entry.at = Date.now();
    entry.url = entry.url || '';
    entry.page = location.pathname;
    if (entry.message) entry.message = options.maskText(entry.message);
    items.push(entry);
    if (items.length > MAX) items.shift();
    listeners.forEach(function (fn) { try { fn(entry); } catch (e) { /* nada */ } });
  }

/** Exclude requests made by the bar or capture library. */
  function ignored(url) { return options.isOwnUrl(url) || options.isCapturing(); }

  hookConsole(push);
  hookErrors(push);
  hookFetch(push, ignored);
  hookXhr(push, ignored);

  return {
    all: function () { return items.slice(); },
    onEntry: function (fn) { listeners.push(fn); }
  };
}

function consoleMessage(args) {
  return Array.prototype.map.call(args, consoleText).join(' ').slice(0, MAX_TEXT);
}

function hookConsole(push) {
  ['error', 'warn'].forEach(function (level) {
    const original = console[level];
    if (typeof original !== 'function') return;
    console[level] = function () {
      try { push({ type: 'console', level: level, message: consoleMessage(arguments) }); } catch (e) { /* nada */ }
      return original.apply(this, arguments);
    };
  });
}

/** Browser error: failed resource load or JavaScript error. */
function errorEntry(event) {
  const target = event.target;
  if (target && target.tagName) {
    return { type: 'error', message: t('Failed to load ') + target.tagName.toLowerCase() + ': ' +
             recordedUrl(target.currentSrc || target.src || target.href || '') };
  }
  return { type: 'error', message: String(event.message || '').slice(0, 500), source: errorSource(event) };
}

function errorSource(event) {
  return relUrl(event.filename || '').split('?')[0] + ':' + (event.lineno || '') + ':' + (event.colno || '');
}

function hookErrors(push) {
// Resource errors for images and scripts do not bubble to window during capture.
  window.addEventListener('error', function (event) { push(errorEntry(event)); }, true);
  window.addEventListener('unhandledrejection', function (event) {
    push({ type: 'error', message: ('Promesa rechazada: ' + consoleText(event.reason)).slice(0, MAX_TEXT) });
  });
}

function network(push, request, started, extra) {
  push(Object.assign({ type: 'network', method: request.method, url: recordedUrl(request.url),
                       ms: Math.round(performance.now() - started) }, extra));
}

/** Method and URL of a fetch call, whether text or Request. */
function fetchRequest(input, init) {
  return {
    method: ((init && init.method) || (input && input.method) || 'GET').toUpperCase(),
    url: typeof input === 'string' ? input : (input && input.url) || String(input)
  };
}

function hookFetch(push, ignored) {
  if (!window.fetch) return;
  const originalFetch = window.fetch;
  window.fetch = function (input, init) {
    const started = performance.now();
    const request = fetchRequest(input, init);
    const own = ignored(request.url);
    return originalFetch.apply(this, arguments).then(function (response) {
      if (!own) network(push, request, started, { status: response.status });
      return response;
    }, function (error) {
      if (!own) network(push, request, started, { status: 0, message: consoleText(error).slice(0, 200) });
      throw error;
    });
  };
}

function hookXhr(push, ignored) {
  const xhrOpen = XMLHttpRequest.prototype.open;
  const xhrSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url) {
    this.__ticketshot = { method: String(method || 'GET').toUpperCase(), url: String(url) };
    return xhrOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function () {
    const request = this.__ticketshot;
    const xhr = this;
    if (request && !ignored(request.url)) {
      const started = performance.now();
      xhr.addEventListener('loadend', function () { network(push, request, started, { status: xhr.status }); });
    }
    return xhrSend.apply(this, arguments);
  };
}

/** Merge bounded log lists without duplicates. */
export function mergeLogs(current, fresh) {
  const seen = new Set();
  const out = [];
  current.concat(fresh).forEach(function (entry) {
    const key = [entry.at, entry.type, entry.message, entry.url, entry.status].join('|');
    if (seen.has(key)) return;
    seen.add(key);
    out.push(entry);
  });
  return out.slice(-300);
}
