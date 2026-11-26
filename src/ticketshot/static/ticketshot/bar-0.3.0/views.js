import { t } from './i18n.js';
import { clock, esc, shorten } from './util.js';

const SHOWN_TICKETS = 6;
// The panel opens in another tab, leaving this page and its draft here.
const NEW_TAB = ' target="_blank" rel="noopener"';
const ICONS = {
  visible: '<rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="12" cy="12" r="3"/>',
  full: '<rect x="4" y="3" width="16" height="18" rx="2"/><path d="M8 8h8M8 12h8M8 16h5"/>',
  exact: '<path d="M4 9V4h5m6 0h5v5M4 15v5h5m6 0h5v-5"/><circle cx="12" cy="12" r="3"/>',
  record: '<circle cx="12" cy="12" r="7"/><circle cx="12" cy="12" r="3" fill="currentColor" stroke="none"/>',
  drawer: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 10h18M8 15h8"/>',
  panel: '<rect x="4" y="4" width="16" height="16" rx="2"/><path d="M8 9h8M8 13h8M8 17h5"/>',
  side: '<path d="M5 4h14v16H5zM9 4v16m5-11 3 3-3 3"/>',
  minimize: '<path d="m8 8 4 4 4-4M5 17h14"/>',
  restore: '<path d="m8 15 4-4 4 4M5 6h14"/>',
  close: '<path d="M5 5 19 19M19 5 5 19"/>'
};

function icon(name) {
  return '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + ICONS[name] + '</svg>';
}

function iconButton(act, label, name, attrs = '') {
  return '<button type="button" class="ts-rail-button' + (act === 'record' ? ' ts-record-button' : '') +
    '" data-act="' + act + '"' + attrs + ' aria-label="' + label + '"' +
    (attrs.includes(' title=') ? '' : ' title="' + label + '"') + '>' + icon(name) + '</button>';
}

export function miniHtml(open) {
  const label = t('Show the review bar') + (open ? ' · ' + open + t(' open') : '');
  return '<button type="button" class="ts-mini' + (open ? ' ts-mini-open' : '') + '" data-act="restore" aria-label="' + label + '" title="' + label + '">' + icon('restore') + '</button>';
}

/** Whether another capture can be added, and why not. */
export function captureAllowed(state) {
  if (state.recording) {
    if (state.recording.expired) return { allowed: false, reason: t('Time is up: stop the recording to review.') };
    if ((state.recording.steps || 0) >= state.maxSteps) {
      return { allowed: false, reason: t('You have already added ') + state.maxSteps + t(' captures to this recording.') };
    }
    return { allowed: true, reason: '' };
  }
  if (state.draft && state.draft.kind === 'recording') {
    return { allowed: false, reason: t('The recording is stopped: send or discard it.') };
  }
  if (state.draft && state.draft.images.length >= state.maxImages) {
    return { allowed: false, reason: t('Limit of ') + state.maxImages + t(' captures') };
  }
  return { allowed: true, reason: '' };
}

/** Choose which open layer receives Escape. */
export function escapeTarget(state) {
  if (state.dialogOpen) return 'dialog';
  if (state.compareOpen) return 'compare';
  return state.drawerOpen ? 'drawer' : null;
}

function captureHtml(s) {
  if (s.draft && s.draft.kind === 'recording') return '';
  const decision = captureAllowed(s);
  const attrs = decision.allowed ? '' : ' disabled title="' + esc(decision.reason) + '"';
  return iconButton('shot', t('Capture visible area'), 'visible', ' data-mode="visible"' + attrs) +
    iconButton('shot', t('Full page'), 'full', ' data-mode="full"' + attrs) +
    (s.canExact ? iconButton('shot', t('Exact capture'), 'exact', ' data-mode="exact"' + attrs) : '');
}

function trayHtml(draft) {
  return t('<div class="ts-rail-tray" aria-label="Draft captures">') + draft.images.slice(0, 3).map(function (img, i) {
    return '<button type="button" class="ts-thumb" data-act="edit" data-id="' + esc(img.id) +
      t('" aria-label="Edit capture ') + (i + 1) + t('" title="Edit capture ') + (i + 1) + '"><img alt="" data-thumb="' + esc(img.id) + '"></button>';
  }).join('') + (draft.images.length > 3 ? '<span class="ts-tray-more">+' + (draft.images.length - 3) + '</span>' : '') + '</div>' +
    t('<button type="button" class="ts-btn ts-primary ts-rail-submit" data-act="compose">Send</button>') +
    t('<button type="button" class="ts-btn ts-rail-discard" data-act="discard">Discard</button>');
}

/** Regular rail, with or without a draft. */
export function railHtml(s) {
  const open = s.tickets.length;
  const count = s.draft ? s.draft.images.length : 0;
  return t('<div class="ts-rail" role="toolbar" aria-label="Review bar">') +
    captureHtml(s) + (!count ? iconButton('record', t('Record flow'), 'record') : '') +
    (count ? trayHtml(s.draft) : '') +
    '<span class="ts-rail-divider" aria-hidden="true"></span>' +
    t('<button type="button" class="ts-rail-button ts-drawer-toggle" data-act="drawer" aria-label="Tickets for this view" title="Tickets for this view" aria-pressed="') +
      Boolean(s.drawerOpen) + '">' + icon('drawer') + (open ? '<span class="ts-badge" aria-hidden="true">' + open + '</span>' : '') + '</button>' +
    (s.panelUrl ? '<a class="ts-rail-button" href="' + esc(s.panelUrl) + '"' + NEW_TAB + t(' aria-label="Ticket panel" title="Ticket panel">') + icon('panel') + '</a>' : '') +
    iconButton('side', t('Move to the other side'), 'side') +
    iconButton('minimize', t('Collapse the bar'), 'minimize') + '</div>';
}

function ticketActionsHtml(ticket) {
  const key = esc(ticket.key);
  const compare = ticket.images && ticket.images.length
    ? t('<div class="ts-compare-actions" role="group" aria-label="Compare"><span>Compare:</span>') +
      '<button type="button" class="ts-btn ts-sm" data-act="tk-compare" data-mode="over" data-key="' + key + t('">Overlay</button>') +
      '<button type="button" class="ts-btn ts-sm" data-act="tk-compare" data-mode="side" data-key="' + key + t('">Side by side comparison</button></div>') : '';
  const decide = ticket.canApprove
    ? '<button type="button" class="ts-btn ts-sm ts-primary" data-act="tk-approve" data-key="' + key + t('">Approve</button>') +
      '<button type="button" class="ts-btn ts-sm" data-act="tk-reject" data-key="' + key + t('">Still not working</button>') +
      '<button type="button" class="ts-btn ts-sm" data-act="tk-chain" data-reject="1" data-key="' + key + t('">Reject with a new capture</button>')
    : '<button type="button" class="ts-btn ts-sm" data-act="tk-chain" data-key="' + key + t('">Chain a change</button>');
  const detail = ticket.detailUrl ? '<a class="ts-link" href="' + esc(ticket.detailUrl) + '"' + NEW_TAB + '>' + t('View') + '</a>' : '';
  return '<div class="ts-ticket-actions">' + compare + decide + detail + '</div>';
}

function ticketHtml(ticket) {
  const images = ticket.images || [];
  const image = images[0] && images[0].url
    ? '<img src="' + esc(images[0].url) + '" alt="">'
    : '<span class="ts-ticket-placeholder" aria-hidden="true"></span>';
  return '<li class="ts-ticket"><div class="ts-ticket-main"><div class="ts-ticket-image">' + image + '</div><div class="ts-ticket-content">' +
    '<div class="ts-ticket-head"><strong>' + esc(ticket.key) + '</strong><span class="ts-pill ts-s-' + esc(ticket.status) + '">' + esc(ticket.statusLabel) + '</span></div>' +
    '<p class="ts-ticket-note">' + esc(shorten(ticket.note, 140)) + '</p>' +
    '<p class="ts-ticket-device">' + esc(ticket.deviceLabel) + ' · ' + images.length + (images.length === 1 ? t(' capture') : t(' captures')) +
      (ticket.exact ? '' : ' · otra URL') + '</p></div></div>' + ticketActionsHtml(ticket) + '</li>';
}

export function ticketsHtml(list, loaded, panelUrl) {
  if (!list.length) return loaded ? t('<p class="ts-empty">No open tickets for this view: it is considered approved.</p>') : '';
  return '<ul class="ts-tickets">' + list.slice(0, SHOWN_TICKETS).map(ticketHtml).join('') + '</ul>' +
    (list.length > SHOWN_TICKETS && panelUrl ? '<a class="ts-link ts-more-link" href="' + esc(panelUrl) + '"' + NEW_TAB + t('>View all ') + list.length + t(' in the panel</a>') : '');
}

function chainHtml(chain) {
  if (!chain) return '';
  return t('<div class="ts-chain" role="status"><span>Chaining to <strong>') + esc(chain.key) + '</strong>' +
    (chain.reject ? t(' · rejects it with a new capture') : '') + '</span>' +
    t('<button type="button" class="ts-link" data-act="chain-cancel">Remove</button></div>');
}

/** The unsent draft is absent from the page's ticket list. */
function draftHtml(draft) {
  if (!draft) return '';
  const count = draft.images.length;
  return '<div class="ts-draft-pending" role="status"><p>' + t('Your ') + (draft.kind === 'recording' ? t('flow') : 'ticket') +
    t(' has not been sent yet · ') + count + (count === 1 ? t(' capture') : t(' captures')) + '</p>' +
    t('<div class="ts-draft-actions"><button type="button" class="ts-btn ts-sm ts-primary" data-act="compose">Send</button>') +
    t('<button type="button" class="ts-btn ts-sm" data-act="discard">Discard</button></div></div>');
}

/** Ticket drawer beside the rail. */
export function drawerHtml(s) {
  return t('<section class="ts-drawer" aria-label="Tickets for this view">') +
    t('<header class="ts-drawer-head"><div><h2>This view</h2><code>') + esc(s.path || '/') + '</code><span class="ts-open-count">' + s.tickets.length + t(' open</span></div>') +
    t('<button type="button" class="ts-icon-btn" data-act="close" aria-label="Close drawer" title="Close drawer">') + icon('close') + '</button></header>' +
    '<div class="ts-drawer-body">' + draftHtml(s.draft) + chainHtml(s.chain) + ticketsHtml(s.tickets, s.loaded, s.panelUrl) + '</div>' +
    '<footer class="ts-drawer-foot">' +
    (s.panelUrl ? '<a class="ts-link" href="' + esc(s.panelUrl) + '"' + NEW_TAB + t('>View all in the panel</a>') : '') +
    (s.persistent ? '' : t('<p class="ts-note">This browser does not save drafts: do not leave the page before sending.</p>')) +
    t('<p class="ts-note">Shortcuts: Alt+Shift+S captures the visible area · Alt+Shift+R records.</p></footer></section>');
}

export function recordingHtml(rec, maxSteps, now) {
  const steps = rec.steps || 0;
  const decision = captureAllowed({ recording: rec, maxSteps: maxSteps });
  return t('<div class="ts-rail ts-rail-recording" role="group" aria-label="Recording in progress">') +
    '<span class="ts-rec-dot ts-live" aria-hidden="true"></span>' +
    '<span class="ts-rec-time" data-rec-time>' + clock(now - rec.startedAt) + '</span>' +
    '<span class="ts-rec-label">' + (rec.expired ? t('Time is up') : t('Recording')) + '</span>' +
    '<button type="button" class="ts-btn ts-rec-step" data-act="step"' +
      (decision.allowed ? '' : ' disabled title="' + esc(decision.reason) + '"') + t('>Capture ') + steps + '/' + maxSteps + '</button>' +
    t('<button type="button" class="ts-btn ts-danger" data-act="stop">Stop</button>') +
    iconButton('cancel-rec', t('Cancel recording'), 'close') + '</div>';
}

/** Choose container content from recording, draft, and collapsed state. */
export function shellView(state, prefs, recording, mobile, maxSteps, now) {
  const className = 'ts-shell ts-' + prefs.side + (mobile ? ' ts-mobile' : '');
  if (recording) return { className, html: '<div class="ts-dock">' + recordingHtml(recording, maxSteps, now) + '</div>', thumbs: false, ticking: true };
  if (prefs.min && !state.drawerOpen) return { className, html: miniHtml(state.tickets.length), thumbs: false, ticking: false };
  return { className, html: '<div class="ts-dock">' + railHtml(state) +
    (state.drawerOpen ? drawerHtml(state) : '') + '</div>', thumbs: !!state.draft, ticking: false };
}
/* Pure review bar views. */
