/*
 * Compose a ticket note, device, relation to an open ticket, image review,
 * and submission.
 */
import { t } from './i18n.js';
import { redactionCount } from './draw.js';
import { DEVICE_LABELS, esc, relUrl, shorten } from './util.js';

const ROLE_LABELS = { manual: 'Capture', start: 'Start', step: 'Step', end: 'End' };

// ---------------------------------------------------------------- puras

/** Chainable tickets: open tickets plus a pending chain target. */
export function relationList(list, chain, find) {
  const out = list.slice();
  if (chain && !find(chain.key)) out.unshift({ key: chain.key, note: '', canApprove: !!chain.reject });
  return out;
}

function relationOption(ticket, selected) {
  const note = ticket.note ? ' · ' + shorten(ticket.note, 60) : '';
  return '<option value="' + esc(ticket.key) + '"' + (ticket.key === selected ? ' selected' : '') +
         t('>Chain to ') + esc(ticket.key) + esc(note) + '</option>';
}

export function relationHtml(list, selected, rejectChecked) {
  if (!list.length) return '';
  return t('<label class="ts-field"><span>Is this new or related to an open ticket?</span>') +
      t('<select data-parent><option value="">New ticket</option>') +
      list.map(function (t) { return relationOption(t, selected); }).join('') + '</select></label>' +
    '<label class="ts-check" data-reject-wrap hidden><input type="checkbox" data-reject' +
      (rejectChecked ? ' checked' : '') + t('> This rejects the selected ticket: the original capture is no longer enough</label>');
}

/** Preselect rejection only for a rejection chain. */
export function rejectDefault(value, chain) {
  return !!(chain && chain.reject && chain.key === value);
}

/** Rejection requires approval permission for that ticket. */
export function rejectVisible(value, ticket, chain) {
  if (!value) return false;
  if (ticket && ticket.canApprove) return true;
  return !!(chain && chain.key === value && chain.reject);
}

function recordingSentHtml(draft, cfg) {
  return t('<label class="ts-check"><input type="checkbox" data-events checked> Flow events (') +
    (draft.events || []).length + t(') excluding what was typed</label>') +
    (cfg.recordingCookie ? t('<p class="ts-note">During the flow, the server saved a technical log of each request for debugging. Only the team can see it.</p>') : '');
}

export function sentHtml(draft, cfg) {
  return t('<fieldset class="ts-fieldset"><legend>Also sent</legend>') +
      '<ul class="ts-sent">' +
        t('<li>The URL and title of each capture.</li>') +
        t('<li>The view, its templates and timings, according to the server.</li>') +
        t('<li>Your user: ') + esc(cfg.user) + '.</li>' +
        t('<li>Browser, screen size, language, and time zone.</li>') +
      '</ul>' +
      t('<label class="ts-check"><input type="checkbox" data-logs checked> Console and network logs (') +
        (draft.logs || []).length + ')</label>' +
      (draft.kind === 'recording' ? recordingSentHtml(draft, cfg) : '') +
    '</fieldset>';
}

function deviceHtml(device) {
  return t('<fieldset class="ts-fieldset"><legend>Which device is this for?</legend><div class="ts-seg" role="radiogroup">') +
    ['desktop', 'mobile', 'both'].map(function (d) {
      return '<label class="ts-seg-opt"><input type="radio" name="ts-device" value="' + d + '"' +
             (d === device ? ' checked' : '') + '><span>' + t(DEVICE_LABELS[d]) + '</span></label>';
    }).join('') + '</div></fieldset>';
}

/**
 * Use the submitted note, or derive one from capture notes when empty.
 * Prefix each capture note and truncate the combined result to limit;
 * each capture retains its complete note.
 */
export function ticketNote(note, images, limit) {
  const own = note.trim();
  if (own) return own;
  return shorten(images.map(function (img, i) { return img.caption ? t('Capture ') + (i + 1) + ': ' + img.caption : ''; })
    .filter(Boolean).join('\n'), limit);
}

function hasCaptions(draft) {
  return (draft.images || []).some(function (img) { return !!img.caption; });
}

/** Full dialog; relation may contain empty HTML. */
export function composerHtml(draft, cfg, device, relation) {
  const recording = draft.kind === 'recording';
  const placeholder = hasCaptions(draft)
    ? t('Optional: you already wrote on the captures. Add anything that applies to the whole ticket.')
    : t('What you saw, what you expected, and how you got there.');
  return '<div class="ts-sheet" role="dialog" aria-modal="true" aria-labelledby="ts-compose-title">' +
      '<header class="ts-sheet-head"><h2 id="ts-compose-title">' +
        (recording ? t('Create a ticket from the recorded flow') : t('Create ticket')) + '</h2>' +
        t('<button type="button" class="ts-icon-btn" data-act="close" aria-label="Close">×</button></header>') +
      '<div class="ts-sheet-body">' +
        t('<label class="ts-field"><span>What you want to change and where</span>') +
          '<textarea rows="4" maxlength="' + cfg.limits.noteLength + '" data-note ' +
          'placeholder="' + placeholder + '"></textarea></label>' +
        deviceHtml(device) + relation +
        t('<p class="ts-section-title">This is how the images will be sent</p>') +
        '<ol class="ts-grid" data-grid></ol>' +
        sentHtml(draft, cfg) +
        t('<p class="ts-warn">Anything you do not cover with the redaction tool is sent as is.</p>') +
        '<p class="ts-error" data-error hidden></p>' +
      '</div>' +
      '<footer class="ts-sheet-foot">' +
        t('<button type="button" class="ts-link" data-act="discard">Discard</button>') +
        '<span class="ts-grow"></span>' +
        '<button type="button" class="ts-btn" data-act="close">' + (recording ? t('Back') : t('Keep capturing')) + '</button>' +
        t('<button type="button" class="ts-btn ts-primary" data-act="send">Create ticket</button>') +
      '</footer>' +
    '</div>';
}

function editsHtml(img) {
  if (!img.ops || !img.ops.length) return t('<span>Unedited</span>');
  return '<span>' + img.ops.length + t(' marks · ') + redactionCount(img.ops) + t(' hidden</span>');
}

/** Render a draft image as it will be sent, preserving recording order. */
export function cardHtml(draft, img, i) {
  const canMove = draft.kind !== 'recording' && i > 0;
  return '<li class="ts-card">' +
    '<button type="button" class="ts-card-img" data-act="edit" data-id="' + img.id +
    t('" aria-label="Edit capture ') + (i + 1) + t('"><img alt="Capture ') + (i + 1) + '" data-thumb="' + img.id + '"></button>' +
    '<div class="ts-card-meta"><strong>' + (i + 1) + ' · ' + t(ROLE_LABELS[img.role]) + '</strong>' +
      '<span>' + esc(relUrl(img.pageUrl)) + '</span>' + editsHtml(img) +
      (img.caption ? '<p class="ts-card-caption">' + esc(img.caption) + '</p>' : '') +
    '</div>' +
    '<div class="ts-card-actions">' +
      '<button type="button" class="ts-btn ts-sm" data-act="edit" data-id="' + img.id + t('">Edit</button>') +
      (canMove ? '<button type="button" class="ts-btn ts-sm" data-act="up" data-id="' + img.id + '" aria-label="Subir">↑</button>' : '') +
      '<button type="button" class="ts-btn ts-sm" data-act="remove" data-id="' + img.id + t('">Remove</button>') +
    '</div></li>';
}

/**
 * Build submission data from the form fields:
 * {device, parent, reject, rejectShown, logs, events}.
 */
export function composerChoices(fields, defaultDevice) {
  return {
    logs: !!fields.logs, events: !!fields.events,
    device: fields.device || defaultDevice,
    parent: fields.parent || '',
    rejectParent: !!(fields.reject && fields.rejectShown)
  };
}

/** Move an image up; return false at the start or when absent. */
export function moveImageUp(images, id) {
  const i = images.findIndex(function (img) { return img.id === id; });
  if (i <= 0) return false;
  images.splice(i - 1, 0, images.splice(i, 1)[0]);
  return true;
}

const CLICKS = {
  close: function (c) { c.close(); },
  edit: function (c, id) { c.bar.edit(id); },
  remove: function (c, id) { c.remove(id); },
  up: function (c, id) { c.moveUp(id); },
  discard: function (c) { c.discard(); },
  send: function (c, id, button) { c.send(button); }
};

// ------------------------------------------------------------- dialog

function checked(el, selector) {
  const field = el.querySelector(selector);
  return !!(field && field.checked);
}

function valueOf(el, selector) {
  const field = el.querySelector(selector);
  return field ? field.value : '';
}

export class Composer {
/** Bar interface: edit, render, toast, and defaultDevice. */
  constructor(bar, deps, draft) {
    this.bar = bar;
    this.cfg = deps.cfg;
    this.drafts = deps.drafts;
    this.tickets = deps.api.tickets;
    this.api = deps.api;
    this.draft = draft;
    this.sending = false;
  }

  relationHtml() {
    const tickets = this.tickets;
    const chain = tickets.chain();
    const list = relationList(tickets.list, chain, function (key) { return tickets.find(key); });
    const selected = this.draft.parent || (chain ? chain.key : '');
    return relationHtml(list, selected, rejectDefault(selected, chain));
  }

  syncReject() {
    const select = this.el.querySelector('[data-parent]');
    const wrap = this.el.querySelector('[data-reject-wrap]');
    if (!select || !wrap) return;
    wrap.hidden = !rejectVisible(select.value, this.tickets.find(select.value), this.tickets.chain());
  }

  open() {
    const self = this;
    const el = document.createElement('div');
    el.className = 'ts-modal';
    el.innerHTML = composerHtml(this.draft, this.cfg, this.draft.device || this.bar.defaultDevice(), this.relationHtml());
    this.el = el;
    this.note = el.querySelector('[data-note]');
    this.note.value = this.draft.note || '';
    this.note.addEventListener('input', function () { self.onNote(); });
    el.addEventListener('change', function (event) { self.onChange(event); });
    el.addEventListener('click', function (event) { self.onClick(event); });
    el.addEventListener('keydown', function (event) { self.onKey(event); });
    this.bar.root.appendChild(el);
    this.syncReject();
    this.refresh();
    this.note.focus();
  }

  onNote() {
    const self = this;
    this.draft.note = this.note.value;
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(function () { self.drafts.save(self.draft); }, 400);
  }

  onKey(event) {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    this.close();
  }

  onChange(event) {
    const target = event.target;
    if (target.name === 'ts-device') { this.draft.device = target.value; this.drafts.save(this.draft); }
    if (!target.matches('[data-parent]')) return;
    this.draft.parent = target.value;
    this.drafts.save(this.draft);
// Selecting another ticket must clear the previous rejection choice.
    const box = this.el.querySelector('[data-reject]');
    if (box) box.checked = rejectDefault(target.value, this.tickets.chain());
    this.syncReject();
  }

  refresh() {
    const self = this;
    return this.drafts.current().then(function (draft) {
      if (!draft) return self.close();
      draft.note = self.note.value;
      self.draft = draft;
      const grid = self.el.querySelector('[data-grid]');
      grid.innerHTML = draft.images.map(function (img, i) { return cardHtml(draft, img, i); }).join('');
      self.drafts.fillThumbs(grid, draft.images);
    });
  }

  onClick(event) {
    const button = event.target.closest('button');
    if (!button || button.disabled || this.sending) return;
    const handler = CLICKS[button.dataset.act];
    if (handler) handler(this, button.dataset.id, button);
  }

  remove(id) {
    const self = this;
    return this.drafts.removeImage(this.draft, id).then(function (draft) {
      if (draft.images.length) return self.refresh().then(function () { self.bar.render(); });
      self.draft = null;
      self.close();
      return self.drafts.discard(draft).then(function () { self.bar.render(); });
    });
  }

  moveUp(id) {
    const self = this;
    if (!moveImageUp(this.draft.images, id)) return;
    this.drafts.save(this.draft).then(function () { return self.refresh(); });
  }

  discard() {
    const self = this;
    if (!window.confirm(t('Discard this draft? Its captures will be deleted.'))) return;
    const doomed = this.draft;
    this.draft = null;
    this.drafts.discard(doomed).then(function () {
      self.close();
      self.bar.render();
      self.bar.toast(t('Draft discarded.'));
    });
  }

  choices() {
    const el = this.el;
    const wrap = el.querySelector('[data-reject-wrap]');
    return composerChoices({
      device: valueOf(el, 'input[name="ts-device"]:checked'),
      parent: valueOf(el, '[data-parent]'),
      reject: checked(el, '[data-reject]'),
      rejectShown: !!(wrap && !wrap.hidden),
      logs: checked(el, '[data-logs]'),
      events: checked(el, '[data-events]')
    }, this.bar.defaultDevice());
  }

  showError(message) {
    const error = this.el.querySelector('[data-error]');
    error.textContent = message;
    error.hidden = false;
  }

  setSending(button, sending) {
    this.sending = sending;
    button.disabled = sending;
    button.textContent = sending ? 'Enviando…' : t('Create ticket');
  }

  send(button) {
    const self = this;
    const note = ticketNote(this.note.value, this.draft.images, this.cfg.limits.noteLength);
    this.el.querySelector('[data-error]').hidden = true;
    if (!note) { this.showError(t('Describe what you want to change and where.')); this.note.focus(); return null; }
    this.setSending(button, true);
    return this.api.submit(this.draft, note, this.choices()).then(function (data) {
      return self.sent(data);
    }).catch(function (err) {
      self.setSending(button, false);
      self.showError(err.message || t('Could not send.'));
    });
  }

  sent(data) {
    const self = this;
    const sent = this.draft;
    this.draft = null;
    this.tickets.clearChain();
    return this.drafts.discard(sent).then(function () {
      self.close();
      self.bar.toast('Ticket ' + data.key + ' levantado. Gracias.', 'ok');
      return self.tickets.load().then(function () { return self.bar.render(); });
    });
  }

  close() {
    if (this.draft) { this.draft.note = this.note ? this.note.value : this.draft.note; this.drafts.save(this.draft); }
    if (this.el) this.el.remove();
    this.bar.composer = null;
  }
}
