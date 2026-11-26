/*
 * Record a journey using paths and parameter names, never entered
 * values, prompt answers, or console text.
 */
import { maskedTitle } from './mask.js';
import { t } from './i18n.js';
import { LS, lsDel, lsGet, lsKeys, lsSet, recordedUrl } from './util.js';

const INTERACTIVE = 'a,button,input,select,textarea,label,summary,[role=button],[role=tab],[role=link],[role=menuitem],[onclick]';

/** Identify an element without reading its content. */
export function describe(el) {
  if (!el || el.nodeType !== 1) return '';
  const tag = el.tagName.toLowerCase();
  let out = tag;
  if (el.id) out += '#' + el.id;
  const name = el.getAttribute('name');
  if (name) out += '[name=' + name + ']';
  const type = el.getAttribute('type');
  if (type && tag === 'input') out += '[type=' + type + ']';
  const classes = Array.prototype.slice.call(el.classList || [], 0, 2);
  if (classes.length) out += '.' + classes.join('.');
  return out.slice(0, 140);
}

/** Describe a console or network log without its text. */
export function eventFromLog(entry) {
  const data = { status: entry.status, label: entry.level || entry.method || '' };
  if (entry.type === 'network') data.target = entry.url;
  return data;
}

/** Describe a click without reading form values. */
export function clickData(target, label, x, y) {
  return { target: describe(target), label: label, x: Math.round(x), y: Math.round(y) };
}

/** Describe an input by length, never value. */
export function inputData(target, label) {
  return { target: describe(target), label: label,
    size: target.value !== undefined ? String(target.value).length + ' caracteres' : '' };
}

/** Describe a change without storing entered text. */
export function fieldChangeData(target, label, type, checked, selectedText, hidden, maskText) {
  const data = { target: describe(target), label: label };
  if (type === 'checkbox' || type === 'radio') data.value = checked ? 'marcado' : 'desmarcado';
  else if (type === 'select' && !hidden) {
    data.value = selectedText ? maskText(selectedText.trim().slice(0, 60)) : '';
  }
  return data;
}

/** History navigation data. */
export function navigationData(kind) { return { label: kind }; }

/** Opened window data with a sanitized URL. */
export function openedWindowData(url) { return { url: recordedUrl(url || ''), label: 'window.open' }; }

/** Native dialog result without entered answer. */
export function nativeResult(name, result) {
  if (name === 'prompt') return result === null ? 'cancelado' : '(oculto)';
  if (name === 'confirm') return result ? 'aceptar' : 'cancelar';
  return '';
}

/** Native dialog data with its message masked. */
export function nativeDialogData(name, message, result, maskText) {
  return { label: name, message: maskText(String(message || '')).slice(0, 300),
    result: nativeResult(name, result) };
}

/** Page dialog data. */
export function pageDialogData(label, visible) {
  return { label: label, value: visible ? 'abierta' : 'cerrada' };
}

/** Choose control text without querying the DOM. */
export function controlLabel(data) {
  if (data.aria || data.title) return data.aria || data.title;
  if (data.field) return fieldControlLabel(data);
  return data.innerText || data.textContent || '';
}

function fieldControlLabel(data) {
  return data.associated || data.placeholder || data.name || '';
}

function fieldTag(tag) { return tag === 'input' || tag === 'select' || tag === 'textarea'; }

/** Whether a page dialog is visible. */
export function visibleDialog(data) {
  if (data.hidden || data.ariaHidden === 'true') return false;
  if (data.tag === 'DIALOG' && !data.open) return false;
  return data.display !== 'none' && data.visibility !== 'hidden' && data.rectCount > 0;
}

/** Choose a page dialog title. */
export function dialogLabel(aria, referenced, heading, fallback) {
  return aria || referenced || heading || fallback;
}

function wrapHistoryMethod(recorder, name) {
  const original = history[name];
  history[name] = function () {
    const result = original.apply(this, arguments);
    if (recorder.active()) recorder.record('nav', navigationData(name));
    return result;
  };
}

function wrapOpen(recorder) {
  const original = window.open;
  window.open = function (url) {
    if (recorder.active()) recorder.record('open', openedWindowData(url), true);
    return original.apply(this, arguments);
  };
}

function wrapNativeDialog(recorder, name) {
  const original = window[name];
  window[name] = function (message) {
    const result = original.apply(this, arguments);
    if (recorder.active()) recorder.record('native',
      nativeDialogData(name, message, result, recorder.options.mask.text), true);
    return result;
  };
}

function debounced(ms, fn) {
  let timer = null;
  return function () { clearTimeout(timer); timer = setTimeout(fn, ms); };
}

class Recorder {
  constructor(options) {
    this.options = options;
    this.buffer = [];
    this.flushTimer = null;
    this.listening = false;
    this.ticker = null;
    this.inputTimers = new WeakMap();
    this.openDialogs = new Set();
    this.dialogPending = false;
  }

  state() { return lsGet(LS.rec, null); }
  eventsKey() { return LS.events + this.options.tabId; }
  save(s) { lsSet(LS.rec, s); }
  expired(s) { return Date.now() - s.startedAt > this.options.limits.recordingMinutes * 60000; }

  active() {
    const s = this.state();
    if (!s) return false;
    if (this.expired(s) && !s.expired) { s.expired = true; this.save(s); }
    return true;
  }

  flush() {
    this.flushTimer = null;
    if (!this.buffer.length) return;
    const list = lsGet(this.eventsKey(), []).concat(this.buffer);
    this.buffer = [];
    if (!lsSet(this.eventsKey(), list)) {
// On quota failure, keep recent events and a warning.
      lsSet(this.eventsKey(), list.slice(-200).concat([{ t: list[list.length - 1].t, type: 'limit',
        message: t('The browser ran out of space: events were lost.') }]));
    }
  }

  limitReached(s) {
    if (s.limitHit) return;
    s.limitHit = true;
    this.save(s);
    this.buffer.push({ t: Date.now() - s.startedAt, type: 'limit', tab: this.options.tabId,
      message: t('The maximum of ') + this.options.limits.recordingEvents + t(' events was reached.') });
    this.flush();
  }

  record(type, data, immediate) {
    const s = this.state();
    if (!s) return;
    if (s.expired && type !== 'stop') return;
    if ((s.count || 0) >= this.options.limits.recordingEvents) { this.limitReached(s); return; }
    this.appendRecord(s, type, data, immediate);
  }

  appendRecord(s, type, data, immediate) {
    s.count = (s.count || 0) + 1;
    this.save(s);
    this.buffer.push(Object.assign({ t: Date.now() - s.startedAt, type: type, tab: this.options.tabId,
      url: recordedUrl(location.href) }, data || {}));
    if (immediate) this.flush();
    else if (!this.flushTimer) this.flushTimer = setTimeout(() => this.flush(), 400);
  }

  labelOf(el) {
    if (!el || el.nodeType !== 1) return '';
    if (this.options.mask.hidden(el)) return t('(hidden)');
    return this.options.mask.text(controlLabel(this.labelData(el)).replace(/\s+/g, ' ').trim().slice(0, 60));
  }

  labelData(el) {
    const tag = el.tagName.toLowerCase();
    const field = fieldTag(tag);
    const aria = el.getAttribute('aria-label');
    const title = el.getAttribute('title');
    return { aria: aria, title: title,
      field: field, associated: field && !aria && !title ? this.associatedLabel(el) : '',
      placeholder: field ? el.getAttribute('placeholder') : '',
      name: field ? el.getAttribute('name') : '',
      innerText: el.innerText, textContent: el.textContent };
  }

  associatedLabel(el) {
    const label = el.id && document.querySelector('label[for="' + CSS.escape(el.id) + '"]');
    return label && label.textContent;
  }

  changeData(el) {
    const hidden = el.tagName === 'SELECT' && this.options.mask.hidden(el);
    return fieldChangeData(el, this.labelOf(el), this.changeType(el),
      el.checked, this.selectedText(el, hidden), hidden, this.options.mask.text);
  }

  changeType(el) { return el.tagName === 'SELECT' ? 'select' : el.type; }
  selectedText(el, hidden) {
    if (el.tagName !== 'SELECT' || hidden) return '';
    const option = el.options[el.selectedIndex];
    return option && option.text;
  }

  on(target, type, handler, capture) {
    target.addEventListener(type, (event) => {
      if (this.active() && !(event && this.options.isFromUi(event))) handler.call(this, event);
    }, capture);
  }

  onClick(event) {
    const el = event.target.closest ? (event.target.closest(INTERACTIVE) || event.target) : event.target;
    this.record('click', clickData(el, this.labelOf(el), event.clientX, event.clientY));
  }

  onInput(event) {
    const el = event.target;
    clearTimeout(this.inputTimers.get(el));
    this.inputTimers.set(el, setTimeout(() => {
      this.record('input', inputData(el, this.labelOf(el)));
    }, 700));
  }

  onChange(event) { this.record('change', this.changeData(event.target)); }

  onSubmit(event) {
    const form = event.target;
    this.record('submit', { target: describe(form), label: this.labelOf(form.querySelector('[type=submit]') || form),
      url: recordedUrl(form.getAttribute('action') || location.href),
      value: (form.getAttribute('method') || 'get').toUpperCase() }, true);
  }

  onKeydown(event) {
    if (event.key === 'Enter' || event.key === 'Escape')
      this.record('key', { label: event.key, target: describe(event.target) });
  }

  listenDocument() {
    this.on(document, 'click', this.onClick, true);
    this.on(document, 'input', this.onInput, true);
    this.on(document, 'change', this.onChange, true);
    this.on(document, 'submit', this.onSubmit, true);
    this.on(document, 'keydown', this.onKeydown, true);
    this.on(document, 'visibilitychange', this.onVisibilityChange);
  }

  onVisibilityChange() {
    this.record('visibility', { label: document.visibilityState === 'hidden' ? 'oculta' : 'visible' }, true);
  }

  listenWindow() {
    const scrolled = debounced(600, () => { if (this.active()) this.record('scroll', { y: Math.round(window.scrollY) }); });
    const resized = debounced(600, () => {
      if (this.active()) this.record('resize', { size: window.innerWidth + '×' + window.innerHeight });
    });
    window.addEventListener('scroll', () => { if (this.active()) scrolled(); }, { passive: true });
    window.addEventListener('resize', () => { if (this.active()) resized(); });
    this.on(window, 'pagehide', this.onPagehide);
    this.on(window, 'hashchange', this.onHashchange);
    this.on(window, 'popstate', this.onPopstate);
    this.on(window, 'beforeprint', this.onBeforeprint);
  }

  onPagehide() { this.record('leave', { label: 'Left the page' }); this.flush(); }
  onHashchange() { this.record('nav', navigationData('hash')); }
  onPopstate() { this.record('nav', navigationData(t('back/forward'))); }
  onBeforeprint() { this.record('print', { label: t('Print') }, true); }

  dialogVisible(el) {
    const style = getComputedStyle(el);
    return visibleDialog({ hidden: el.hidden, ariaHidden: el.getAttribute('aria-hidden'),
      tag: el.tagName, open: el.open, display: style.display,
      visibility: style.visibility, rectCount: el.getClientRects().length });
  }

  dialogTitle(el) {
    const aria = el.getAttribute('aria-label');
    const referenced = this.referencedDialogTitle(el, aria);
    const heading = this.headingDialogTitle(el, aria, referenced);
    const label = dialogLabel(aria, referenced, heading, describe(el));
    return this.options.mask.text(String(label).replace(/\s+/g, ' ').trim().slice(0, 80));
  }

  referencedDialogTitle(el, aria) {
    const labelledby = el.getAttribute('aria-labelledby');
    if (aria || !labelledby) return '';
    const ref = document.getElementById(labelledby.split(' ')[0]);
    return ref && ref.textContent;
  }

  headingDialogTitle(el, aria, referenced) {
    if (aria || referenced) return '';
    const heading = el.querySelector('h1,h2,h3,h4,[role=heading]');
    return heading && heading.textContent;
  }

  scanDialogs() {
    this.dialogPending = false;
    if (!this.active()) return;
    const now = new Set();
    document.querySelectorAll(this.dialogSelectors).forEach((el) => {
      if (!this.options.isUiElement(el) && this.dialogVisible(el)) now.add(el);
    });
    now.forEach((el) => { if (!this.openDialogs.has(el)) this.record('dialog', pageDialogData(this.dialogTitle(el), true)); });
    this.openDialogs.forEach((el) => { if (!now.has(el)) this.record('dialog', pageDialogData(this.dialogTitle(el), false)); });
    this.openDialogs = now;
  }

  scheduleDialogScan() {
    if (!this.dialogPending) { this.dialogPending = true; setTimeout(() => this.scanDialogs(), 60); }
  }

  watchDialogs() {
    this.dialogSelectors = (this.options.dialogSelectors || []).join(',');
    if (!this.dialogSelectors || !window.MutationObserver) return;
    const schedule = () => this.scheduleDialogScan();
    document.addEventListener('transitionend', schedule, true);
    document.addEventListener('animationend', schedule, true);
    setTimeout(schedule, 600);
    new MutationObserver(schedule).observe(document.documentElement, {
      subtree: true, childList: true,
      attributes: true, attributeFilter: ['open', 'hidden', 'class', 'style', 'aria-hidden']
    });
    this.scanDialogs();
  }

/** Start listening to the page; return false if already listening. */
  listen() {
    if (this.listening) return false;
    this.listening = true;
    this.listenDocument();
    this.listenWindow();
    ['pushState', 'replaceState'].forEach((name) => wrapHistoryMethod(this, name));
    wrapOpen(this);
    ['alert', 'confirm', 'prompt'].forEach((name) => wrapNativeDialog(this, name));
    this.options.logs.onEntry((entry) => { if (this.active()) this.record(entry.type, eventFromLog(entry)); });
    this.watchDialogs();
    return true;
  }

  mergedEvents() {
    this.flush();
    let all = [];
    lsKeys(LS.events).forEach((key) => { all = all.concat(lsGet(key, [])); });
    all.sort((a, b) => a.t - b.t);
    return all;
  }

  clearEvents() { lsKeys(LS.events).forEach(lsDel); this.buffer = []; }
  stopTicker() { clearInterval(this.ticker); this.ticker = null; }

/** Short masked title for the event line. */
  pageTitle() { return maskedTitle(this.options.mask).slice(0, 120); }

  recordPage(pageToken) {
    const nav = performance.getEntriesByType ? performance.getEntriesByType('navigation')[0] : null;
    this.record('page', { label: this.pageTitle(), token: pageToken, value: nav ? nav.type : '' }, true);
  }

  end() { lsDel(LS.rec); this.clearEvents(); this.stopTicker(); }
  startTicker(fn) { if (!this.ticker) this.ticker = setInterval(fn, 1000); }
}

export function createRecorder(options) { return new Recorder(options); }
