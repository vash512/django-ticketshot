/*
 * Review bar inside a Shadow DOM, isolated from page styles.
 * Coordinates captures, editing, recording, composition, and tickets.
 */
import { t } from './i18n.js';
import { ask } from './ask.js';
import { createCompare } from './compare.js';
import { Composer } from './composer.js';
import { Editor } from './editor.js';
import { maskedTitle } from './mask.js';
import { LS, clock, frame, lsGet, lsSet, uid } from './util.js';
import { captureAllowed, escapeTarget, shellView } from './views.js';

const UI_ATTR = 'data-ticketshot-ui';
const SIMPLE_ACTIONS = {
  shot: 'shot', edit: 'edit', compose: 'compose', discard: 'discard',
  record: 'startRecording', step: 'step', stop: 'stopRecording',
  'cancel-rec': 'cancelRecording'
};

export function railAction(act, data, drawerOpen, side) {
  if (act && act.indexOf('tk-') === 0) return { kind: 'ticket', key: data.key, act, reject: data.reject === '1', mode: data.mode };
  const view = railViewAction(act, drawerOpen, side);
  if (view) return view;
  if (act === 'chain-cancel') return { kind: 'chain-cancel' };
  if (SIMPLE_ACTIONS[act]) return { kind: 'call', method: SIMPLE_ACTIONS[act], value: act === 'shot' ? data.mode : data.id };
  return null;
}

function railViewAction(act, drawerOpen, side) {
  if (act === 'drawer') return { kind: 'view', drawerOpen: !drawerOpen, focus: focusTargetForRail('drawer', !drawerOpen) };
  if (act === 'close') return { kind: 'view', drawerOpen: false, focus: focusTargetForRail('close') };
  if (act === 'restore') return { kind: 'view', prefs: { min: false }, focus: focusTargetForRail('restore') };
  if (act === 'minimize') return { kind: 'view', drawerOpen: false, prefs: { min: true }, focus: focusTargetForRail('minimize') };
  if (act === 'side') return { kind: 'view', prefs: { side: side === 'left' ? 'right' : 'left' }, focus: focusTargetForRail('side') };
  return null;
}

export function hashAction(hash, ticket) {
  const match = /^#ticketshot-(compare|chain)=([A-Za-z]+-\d+)$/.exec(hash || '');
  if (!match) return null;
  if (match[1] === 'compare') return ticket ? { kind: 'compare', key: match[2] }
    : { kind: 'missing', key: match[2], message: match[2] + t(' is not open in this view.') };
  return { kind: 'chain', key: match[2], reject: !!(ticket && ticket.canApprove),
           message: t('Capture the view to create the ticket chained to ') + match[2] + '.' };
}

export function errorMessage(error) {
  return error && error.name === 'NotAllowedError' ? t('The browser did not grant permission to capture.')
    : (error && error.message) || t('Something went wrong.');
}

export function captureDetails(role, exact, started, rec, device, page) {
  return { role: role || 'manual', method: exact ? 'display' : 'dom', pageUrl: page.url,
           pageTitle: page.title, pageToken: page.token, capturedAt: new Date(started).toISOString(),
           offsetMs: rec ? started - rec.startedAt : null, device };
}

export function ticketQuestion(key, act) {
  return act === 'tk-approve' ? { action: 'approve', title: t('Approve ') + key,
    label: t('Comment (optional)'), ok: t('Approve') } : { action: 'reject',
    title: key + t(' is still not working'), ok: t('Reject'),
    text: t('The original capture still works: just describe what is missing.'),
    label: t('What is still not working?'), required: true, requiredText: t('Describe what is still not working.') };
}

export function shortcutModifiers(event) {
  return !!(event.altKey && event.shiftKey && !event.ctrlKey && !event.metaKey);
}

export function shortcutAction(event, recording) {
  if (!shortcutModifiers(event)) return null;
  if (event.code === 'KeyS') return recording ? 'step' : 'shot';
  if (event.code === 'KeyR') return recording ? 'stopRecording' : 'startRecording';
  return null;
}

export function focusTargetForRail(action, drawerOpen = false) {
  if (action === 'drawer') return drawerOpen ? '[data-act="close"]' : '[data-act="drawer"]';
  if (action === 'close') return '[data-act="drawer"]';
  if (action === 'minimize') return '[data-act="restore"]';
  if (action === 'restore') return '[data-act="minimize"]';
  if (action === 'side') return '[data-act="side"]';
  return null;
}

export class Bar {
  constructor(deps) {
    this.deps = deps;
    this.cfg = deps.cfg;
    this.drafts = deps.drafts;
    this.recorder = deps.recorder;
    this.tickets = deps.api.tickets;
    this.busy = false;
    this.drawerOpen = false;
    this.composer = null;
  }

  // ------------------------------------------------------------- montaje

  mount() {
    const host = document.createElement('div');
    host.setAttribute(UI_ATTR, '');
    host.style.cssText = 'position:fixed;top:0;left:0;width:0;height:0;z-index:2147483600;visibility:hidden;';
    const root = host.attachShadow({ mode: 'open' });
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = this.cfg.assets.css;
    link.onload = link.onerror = this.showHost.bind(this);
    root.appendChild(link);
    this.shell = document.createElement('div');
    this.shell.className = 'ts-shell';
    root.appendChild(this.shell);
    this.toasts = document.createElement('div');
    this.toasts.className = 'ts-toasts';
    this.toasts.setAttribute('role', 'status');
    this.toasts.setAttribute('aria-live', 'polite');
    root.appendChild(this.toasts);
    document.documentElement.appendChild(host);
    this.host = host;
    this.root = root;
    this.compare = createCompare(root, this.toast.bind(this));
    this.shell.addEventListener('click', this.onClick.bind(this));
    document.addEventListener('keydown', this.onShortcut.bind(this), true);
    document.addEventListener('keydown', this.onEscape.bind(this), true);
    document.addEventListener('pointerdown', this.onOutside.bind(this), true);
    window.addEventListener('resize', this.onResize.bind(this));
  }

  showHost() { this.host.style.visibility = 'visible'; }

  onEscape(event) {
    if (event.key !== 'Escape') return;
    const target = escapeTarget({ drawerOpen: this.drawerOpen,
      dialogOpen: !!this.root.querySelector('[role="dialog"]'),
      compareOpen: !!this.root.querySelector('.ts-compare') });
    if (target === 'dialog') queueMicrotask(this.focusDrawerAfterDialog.bind(this));
    if (target === 'compare') {
      event.preventDefault();
      this.compare.close();
      this.shell.querySelector(focusTargetForRail('drawer', this.drawerOpen))?.focus();
    }
    if (target === 'drawer') { this.drawerOpen = false; this.render(focusTargetForRail('close')); }
  }

  focusDrawerAfterDialog() {
    if (this.drawerOpen && !this.root.querySelector('[role="dialog"]')) {
      this.shell.querySelector(focusTargetForRail('drawer', true))?.focus();
    }
  }

  onOutside(event) {
    if (this.drawerOpen && event.composedPath().indexOf(this.host) < 0) { this.drawerOpen = false; this.render(); }
  }

  onResize() { this.shell.classList.toggle('ts-mobile', window.innerWidth < this.cfg.deviceBreakpoint); }

  isFromUi(event) { return !!this.host && (event.composedPath ? event.composedPath() : []).indexOf(this.host) >= 0; }
  contains(el) { return !!this.host && this.host.contains(el); }

  defaultDevice() { return window.innerWidth < this.cfg.deviceBreakpoint ? 'mobile' : 'desktop'; }

  prefs() { return lsGet(LS.ui, { side: this.cfg.position === 'bottom-left' ? 'left' : 'right', min: false }); }
  setPrefs(patch) { lsSet(LS.ui, Object.assign(this.prefs(), patch)); }

  toast(message, kind) {
    const el = document.createElement('div');
    el.className = 'ts-toast' + (kind ? ' ts-toast-' + kind : '');
    el.textContent = message;
    this.toasts.appendChild(el);
    setTimeout(this.hideToast.bind(this, el), kind === 'error' ? 6000 : 3500);
    setTimeout(this.removeToast.bind(this, el), kind === 'error' ? 6400 : 3900);
  }

  hideToast(el) { el.classList.add('ts-out'); }
  removeToast(el) { el.remove(); }

  fail(error) {
    this.busy = false;
    this.host.style.display = '';
    this.toast(errorMessage(error), 'error');
    if ((!error || error.name !== 'NotAllowedError') && window.console && console.info) console.info('[ticketshot]', error);
  }

  // ------------------------------------------------------------- dibujo

  async render(focusTarget = null) {
    const draft = await this.drafts.current();
    const recording = this.recorder.active() ? this.recorder.state() : null;
    const view = shellView(this.viewState(draft), this.prefs(), recording,
      window.innerWidth < this.cfg.deviceBreakpoint, this.cfg.limits.recordingSteps, Date.now());
    this.shell.className = view.className;
    this.shell.innerHTML = view.html;
    if (view.ticking) { this.recorder.startTicker(this.tickRecording.bind(this)); return; }
    this.recorder.stopTicker();
    if (view.thumbs) this.drafts.fillThumbs(this.shell, draft.images);
    if (focusTarget) this.shell.querySelector(focusTarget)?.focus();
  }

  viewState(draft) {
    return {
      draft: draft,
      drawerOpen: this.drawerOpen,
      chain: this.tickets.chain(),
      tickets: this.tickets.list,
      loaded: this.tickets.loaded,
      path: location.pathname + location.search,
      panelUrl: this.cfg.can.view ? this.cfg.endpoints.panel : '',
      maxImages: this.cfg.limits.maxImages,
      canExact: this.deps.capture.canExact(),
      persistent: this.drafts.persistent()
    };
  }

  tickRecording() {
    const s = this.recorder.state();
    if (!s) { this.recorder.stopTicker(); this.render(); return; }
    const time = this.shell.querySelector('[data-rec-time]');
    if (time) time.textContent = clock(Date.now() - s.startedAt);
    if (!s.expired && this.recorder.expired(s)) {
      this.recorder.active();
      this.render();
      this.toast(t('The recording time limit was reached. Stop to review.'), 'error');
    }
  }

  // ---------------------------------------------------------- eventos

  onShortcut(event) {
    if (!shortcutModifiers(event)) return;
    if (!['KeyS', 'KeyR'].includes(event.code)) return;
    const action = shortcutAction(event, this.recorder.active());
    if (!action) return;
    event.preventDefault();
    return action === 'shot' ? this.shot('visible') : this[action]();
  }

  onClick(event) {
    const button = event.target.closest('button');
    if (!button || button.disabled) return;
    const decision = railAction(button.dataset.act, button.dataset, this.drawerOpen,
      button.dataset.act === 'side' ? this.prefs().side : null);
    if (!decision) return;
    return this.runRailAction(decision);
  }

  runRailAction(decision) {
    if (decision.kind === 'ticket') return this.ticketAction(decision.key, decision.act, decision.reject, decision.mode);
    if (decision.kind === 'view') return this.applyRailView(decision);
    if (decision.kind === 'chain-cancel') { this.tickets.clearChain(); return this.render(); }
    return decision.value === undefined ? this[decision.method]() : this[decision.method](decision.value);
  }

  applyRailView(decision) {
    if (decision.drawerOpen !== undefined) this.drawerOpen = decision.drawerOpen;
    if (decision.prefs) this.setPrefs(decision.prefs);
    return this.render(decision.focus);
  }

  // ---------------------------------------------------------- tickets

  ticketAction(key, act, chainReject, mode) {
    const ticket = this.tickets.find(key);
    if (!ticket) return;
    if (act === 'tk-compare') { this.drawerOpen = false; this.render(); this.compare.open(ticket, mode); return; }
    if (act === 'tk-chain') { this.startChain(key, chainReject); return; }
    this.finishTicketAction(key, ticketQuestion(key, act)).catch(this.fail.bind(this));
  }

  async finishTicketAction(key, question) {
    const { action, ...prompt } = question;
    const data = await this.askAndAct(key, action, prompt);
    if (!data) return;
    this.toast(data.message || 'Listo.', 'ok');
    await this.tickets.load();
    return this.render();
  }

  askAndAct(key, action, question) {
    const self = this;
    return ask(this.root, this.cfg.limits.noteLength, question).then(function (text) {
      return text === null ? null : self.tickets.action(key, action, { text: text });
    });
  }

  startChain(key, reject) {
    this.tickets.setChain(key, reject);
    this.toast(reject ? t('Capture the view as it looks now: the new ticket will reject ') + key + '.'
                      : t('Capture the view: the new ticket will be chained to ') + key + '.');
    this.render();
  }

  // --------------------------------------------------------- captures

/** Capture and add an image to the draft, creating one if needed. */
  async capture(mode, role, kind) {
    if (this.busy) return Promise.reject(new Error(t('A capture is already in progress.')));
    const capture = this.deps.capture;
    const exact = mode === 'exact';
    const started = Date.now();
    this.busy = true;
    this.drawerOpen = false;
    if (exact) this.host.style.display = 'none';
    else this.toast(t('Capturing…'));
    try {
      if (exact) await frame();
      const blob = exact ? await capture.exact() : await capture.dom(mode === 'full');
      const current = await this.drafts.current();
      const draft = current || await this.drafts.create(kind || 'note');
      return await this.drafts.addImage(draft, blob, captureDetails(role, exact, started,
        this.recorder.state(), this.defaultDevice(), { url: location.href, title: maskedTitle(this.deps.mask), token: this.cfg.pageToken }));
    } finally {
      this.busy = false;
      if (exact) this.host.style.display = '';
    }
  }

  shot(mode) {
    const self = this;
    return this.drafts.current().then(function (draft) {
      const decision = captureAllowed({ draft: draft, maxImages: self.cfg.limits.maxImages });
      if (!decision.allowed) {
        self.toast(decision.reason, 'error');
        return;
      }
      return self.capture(mode, 'manual', 'note').then(function (updated) {
        self.toast(t('Capture ') + updated.images.length + ' guardada.');
        return self.edit(updated.images[updated.images.length - 1].id);
      });
    }).catch(function (error) { self.fail(error); });
  }

  async edit(id) {
    this.drawerOpen = false;
    try {
      const draft = await this.drafts.current();
      const index = draft ? draft.images.findIndex((img) => img.id === id) : -1;
      if (index < 0) return;
      const img = draft.images[index];
      const blob = await this.drafts.blob(img);
      if (!blob) throw new Error(t('The image is no longer in this browser.'));
      this.shell.hidden = true;
      const edited = await new Editor(this.root, img, blob, index, draft.images.length).open();
      this.shell.hidden = false;
      return this.finishEdit(draft, img, edited);
    } catch (error) { this.shell.hidden = false; this.fail(error); }
  }

/** Edited image marks and caption, or null on cancellation. */
  async finishEdit(draft, img, edited) {
    if (edited === null) return this.render();
    img.ops = edited.ops;
    img.caption = edited.caption;
    await this.drafts.save(draft);
    await this.render();
// The current page lists submitted tickets only. Keep the unsent
// draft in the rail, where the user can submit it.
    if (this.composer) this.composer.refresh();
    else this.toast(t('Capture saved. Send it with “Send” or keep capturing.'));
  }

  discard() {
    const self = this;
    this.drafts.current().then(function (draft) {
      if (!draft) return;
      if (!window.confirm(t('Discard the draft with ') + draft.images.length + t(' captures? This cannot be undone.'))) return;
      return self.drafts.discard(draft).then(function () {
        self.drawerOpen = false;
        self.render();
        self.toast(t('Draft discarded.'));
      });
    });
  }

  compose() {
    const self = this;
    this.drawerOpen = false;
    this.drafts.current().then(function (draft) {
      if (!draft || !draft.images.length) { self.toast(t('There are no captures in the draft.'), 'error'); return; }
      self.render();
      self.composer = new Composer(self, self.deps, draft);
      self.composer.open();
    });
  }

  // -------------------------------------------------------- recording

/** Confirm draft discard; return true if recording may begin. */
  async clearDraftForRecording() {
    const draft = await this.drafts.current();
    if (draft && draft.images.length &&
        !window.confirm(t('There is a draft with ') + draft.images.length + t(' captures. Discard it to record?'))) return false;
    await this.drafts.discard(draft);
    return true;
  }

  startRecording() {
    if (this.recorder.active()) return;
    this.beginRecording().catch(this.fail.bind(this));
  }

  async beginRecording() {
    if (!await this.clearDraftForRecording()) return;
    const draft = await this.drafts.create('recording');
    this.recorder.clearEvents();
// The ID links server debug records to the ticket.
    draft.recordingId = uid();
    this.deps.api.recordingCookie.set(draft.recordingId);
    this.recorder.save({ draftId: draft.id, startedAt: Date.now(), steps: 0, count: 0,
                         recordingId: draft.recordingId });
    await this.drafts.save(draft);
    this.recorder.listen();
    this.recorder.record('start', { label: this.recorder.pageTitle() }, true);
    this.recorder.recordPage(this.cfg.pageToken);
    this.drawerOpen = false;
    await this.render();
    await this.capture('visible', 'start', 'recording');
    this.recorder.record('capture', { label: 'inicio' }, true);
    this.toast(t('Recording. The first capture is already saved.'));
  }

  async step() {
    const max = this.cfg.limits.recordingSteps;
    this.recorder.active();
    const rec = this.recorder.state();
    if (!rec || this.busy) return;
    try { await this.takeStep(rec, max); }
    catch (error) { this.fail(error); }
  }

  async takeStep(rec, max) {
    const draft = await this.drafts.current();
    const decision = captureAllowed({ recording: rec, draft, maxSteps: max });
    if (!decision.allowed) { this.toast(decision.reason, 'error'); return; }
    rec.steps = (rec.steps || 0) + 1;
    this.recorder.save(rec);
    this.render();
    await this.captureStep(rec, max);
  }

  async captureStep(rec, max) {
    try {
      await this.capture('visible', 'step', 'recording');
      this.recorder.record('capture', { label: 'paso ' + rec.steps }, true);
      this.toast(t('Capture ') + rec.steps + t(' of ') + max + ' guardada.');
    } catch (error) {
      const s = this.recorder.state();
      if (s) { s.steps = Math.max(0, (s.steps || 1) - 1); this.recorder.save(s); }
      this.render();
      this.fail(error);
    }
  }

  stopRecording() {
    const rec = this.recorder.state();
    if (!rec || this.busy) return;
    this.finishRecording(rec).catch(this.fail.bind(this));
  }

  async finishRecording(rec) {
    try { await this.capture('visible', 'end', 'recording'); }
    catch (error) { this.toast(t('Could not take the final capture: ') + error.message, 'error'); }
    this.recorder.record('stop', { label: 'Detenida' }, true);
    const events = this.recorder.mergedEvents();
    const draft = await this.drafts.current();
    if (!draft) throw new Error(t('The recording draft was lost.'));
    draft.events = events;
    draft.durationMs = Date.now() - rec.startedAt;
    await this.drafts.save(draft);
    this.recorder.end();
    this.deps.api.recordingCookie.clear();
    await this.render();
    this.compose();
  }

  cancelRecording() {
    const self = this;
    if (!window.confirm(t('Cancel the recording? Its captures and events will be deleted.'))) return;
    this.recorder.end();
    this.deps.api.recordingCookie.clear();
    this.drafts.current().then(function (draft) { return self.drafts.discard(draft); }).then(function () {
      self.render();
      self.toast(t('Recording canceled.'));
    });
  }

// ------------------------------------------------- panel links

// #ticketshot-compare opens comparison; #ticketshot-chain prepares a chain.
  handleHash() {
// Read once: replaceState removes the hash before deciding what to do.
    const hash = location.hash || '';
    const match = /^#ticketshot-(compare|chain)=([A-Za-z]+-\d+)$/.exec(hash);
    if (!match) return;
    try { history.replaceState(null, '', location.pathname + location.search); } catch (e) { /* nada */ }
    const ticket = this.tickets.find(match[2]);
    const decision = hashAction(hash, ticket);
    if (decision.kind === 'compare') return this.compare.open(ticket);
    if (decision.kind === 'missing') return this.toast(decision.message, 'error');
    this.tickets.setChain(decision.key, decision.reject);
    this.drawerOpen = true;
    this.render();
    this.toast(decision.message);
  }
}
