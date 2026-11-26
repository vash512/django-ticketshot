/*
 * Place a ticket's original capture beside the live view, or overlay it
 * with transparency. Overlay alignment is approximate when scrolling
 * or viewport width has changed.
 */
import { t } from './i18n.js';
import { DEVICE_LABELS, esc } from './util.js';

function pictureHtml(state, ticket, img) {
  if (state.mode === 'over') {
    return '<img class="ts-compare-ghost" alt="" src="' + esc(img.url) + '" style="opacity:' + (state.opacity / 100) + '">';
  }
  return t('<div class="ts-compare-side"><img alt="Original capture ') + (state.index + 1) + t(' of ') + esc(ticket.key) +
         '" src="' + esc(img.url) + '"></div>';
}

function pagerHtml(state, total) {
  if (total < 2) return '';
  return t('<button type="button" class="ts-btn ts-sm" data-cmp="prev" aria-label="Previous capture">‹</button>') +
         '<span>' + (state.index + 1) + '/' + total + '</span>' +
         t('<button type="button" class="ts-btn ts-sm" data-cmp="next" aria-label="Next capture">›</button>');
}

function modeButton(state, mode, label) {
  return '<button type="button" class="ts-btn ts-sm' + (state.mode === mode ? ' ts-on' : '') +
         '" data-cmp="' + mode + '">' + label + '</button>';
}

export function compareHtml(state, ticket, images) {
  const img = images[state.index];
  return pictureHtml(state, ticket, img) +
    '<div class="ts-compare-bar" role="group" aria-label="' + esc(t('Compare with the original capture')) + '">' +
      '<strong>' + esc(ticket.key) + t('</strong><span class="ts-compare-label">Original capture') +
        (img.device ? ' · ' + esc(t(DEVICE_LABELS[img.device] || img.device)) : '') + '</span>' +
      pagerHtml(state, images.length) +
      modeButton(state, 'side', t('Side by side')) + modeButton(state, 'over', t('Overlay')) +
      (state.mode === 'over' ? t('<label class="ts-range"><span>Opacity</span><input type="range" min="10" max="90" step="5" value="') +
        state.opacity + '" data-cmp-opacity></label>' : '') +
      t('<button type="button" class="ts-icon-btn" data-cmp="close" aria-label="Close comparison">×</button>') +
    '</div>';
}

/** Initial comparison mode: side by side unless overlay was requested. */
export function initialCompareState(mode) {
  return { mode: mode === 'over' ? 'over' : 'side', index: 0, opacity: 50 };
}

const STEPS = { prev: -1, next: 1 };

/** State after pressing a comparison button. */
export function nextCompareState(state, act, total) {
  if (act === 'side' || act === 'over') return Object.assign({}, state, { mode: act });
  if (act in STEPS) return Object.assign({}, state, { index: (state.index + STEPS[act] + total) % total });
  return state;
}

/** Keep one comparison open within the bar's Shadow DOM. */
class Compare {
  constructor(root, toast) {
    this.root = root;
    this.toast = toast;
    this.el = null;
  }

  close() {
    if (this.el) { this.el.remove(); this.el = null; }
  }

  open(ticket, mode) {
    const self = this;
    this.close();
    this.ticket = ticket;
    this.images = ticket.images || [];
    if (!this.images.length) { this.toast(t('This ticket has no captures you can view.'), 'error'); return; }
    this.state = initialCompareState(mode);
    this.el = document.createElement('div');
    this.root.appendChild(this.el);
    this.el.addEventListener('click', function (event) { self.onClick(event); });
    this.el.addEventListener('input', function (event) { self.onInput(event); });
    this.paint();
  }

  paint() {
    this.el.className = 'ts-compare ts-cmp-mode-' + this.state.mode;
    this.el.innerHTML = compareHtml(this.state, this.ticket, this.images);
  }

  onClick(event) {
    const button = event.target.closest('button');
    if (!button) return;
    if (button.dataset.cmp === 'close') { this.close(); return; }
    this.state = nextCompareState(this.state, button.dataset.cmp, this.images.length);
    this.paint();
  }

  onInput(event) {
    if (!event.target.matches('[data-cmp-opacity]')) return;
    this.state.opacity = Number(event.target.value);
    const ghost = this.el.querySelector('.ts-compare-ghost');
    if (ghost) ghost.style.opacity = this.state.opacity / 100;
  }
}

export function createCompare(root, toast) { return new Compare(root, toast); }
