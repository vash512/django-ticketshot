/*
 * Connects bar components. Importing has no side effects; main.js
 * starts the app when the page includes configuration.
 */
import { createApi } from './api.js';
import { Bar } from './bar.js';
import { createCapture } from './capture.js';
import { createDrafts } from './drafts.js';
import { createLogs } from './logs.js';
import { setLanguage } from './i18n.js';
import { createMask } from './mask.js';
import { createRecorder } from './recorder.js';
import { createStore } from './store.js';
import { LS, tabId } from './util.js';

/** Whether this is a bar request, which should not enter the network log. */
export function ownUrlCheck(cfg) {
  const prefix = cfg.endpoints.create.replace(/tickets\/$/, '');
  return function (url) {
    try { return new URL(url, location.href).pathname.indexOf(prefix) === 0; }
    catch (e) { return false; }
  };
}

/** Which draft or recording changed in another tab, if any. */
export function storageChange(key) {
  if (key === LS.rec) return 'recording';
  return key === LS.draft ? 'draft' : null;
}

/** Continue a recording across pages, logging the page and renewing the cookie. */
export function resumeRecording(recorder, api, pageToken) {
  if (!recorder.active()) return false;
  recorder.listen();
  recorder.recordPage(pageToken);
  const rec = recorder.state();
  if (rec && rec.recordingId) api.recordingCookie.set(rec.recordingId);
  return true;
}

/**
 * Reflect draft or recording changes from another tab. When this tab joins
 * a recording, log its page once, as on reload.
 */
export function onStorage(app, key) {
  const change = storageChange(key);
  const recorder = app.deps.recorder;
  if (change === 'recording' && recorder.active() && recorder.listen()) recorder.recordPage(app.deps.cfg.pageToken);
  if (change) app.bar.render();
}

/** Whether an event or element belongs to the bar. */
export function uiChecks(app) {
  return {
    isFromUi: function (event) { return !!app.bar && app.bar.isFromUi(event); },
    isUiElement: function (el) { return !!app.bar && app.bar.contains(el); }
  };
}

export function wire(cfg) {
  const mask = createMask(cfg.mask);
  const capture = createCapture({ libUrl: cfg.assets.capture, mask: mask });
  const logs = createLogs({ isOwnUrl: ownUrlCheck(cfg), isCapturing: capture.isCapturing, maskText: mask.text });
  const drafts = createDrafts(createStore(), logs);
  const deps = { cfg: cfg, mask: mask, capture: capture, logs: logs, drafts: drafts, api: createApi(cfg, drafts, mask) };
  const app = { deps: deps, bar: null };
  const checks = uiChecks(app);
  deps.recorder = createRecorder({
    limits: cfg.limits, mask: mask, tabId: tabId(), logs: logs, dialogSelectors: cfg.dialogSelectors,
    isFromUi: checks.isFromUi, isUiElement: checks.isUiElement
  });
  app.bar = new Bar(deps);
  return app;
}

export function start(cfg) {
  setLanguage(cfg.language);
  const app = wire(cfg);
  const bar = app.bar;
  bar.mount();
  resumeRecording(app.deps.recorder, app.deps.api, cfg.pageToken);
  bar.render();
  app.deps.api.tickets.load().then(function () { return bar.render(); }).then(function () { bar.handleHash(); });
// A panel link to this same page changes only the hash, without reloading.
  window.addEventListener('hashchange', function () { bar.handleHash(); });
  window.addEventListener('storage', function (event) { onStorage(app, event.key); });
  return app;
}
