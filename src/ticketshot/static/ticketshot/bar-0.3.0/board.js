// The board uses the existing API; these decisions do not need a browser.
import { t, setLanguage } from './i18n.js';
export function targetsForCard(value) {
  return String(value || '').split(',').filter(Boolean);
}

export function actionForMove(from, to) {
  if (from === 'in_review' && to === 'approved') return 'approve';
  if (from === 'in_review' && to === 'requested') return 'reject';
  return 'status';
}

export function requestBody(from, to, text = '') {
  const action = actionForMove(from, to);
  return { action, ...(action === 'status' ? { to } : {}), text };
}

export function moveFocusTarget(succeeded, hasMoveAction) {
  if (!succeeded) return 'origin';
  return hasMoveAction ? '.tsp-move-toggle' : '.tsp-card-link';
}

export function canMove(targets, to, busy = false) {
  return !busy && targetsForCard(targets).includes(to);
}

export function dragPhase(startX, startY, x, y, active, threshold = 6) {
  return active || Math.hypot(x - startX, y - startY) >= threshold ? 'dragging' : 'pending';
}

export function dropDestination(targets, column) {
  return targetsForCard(targets).includes(column) ? column : null;
}

export function scrollStep(x, left, right, margin = 40) {
  if (x < left + margin) return -16;
  if (x > right - margin) return 16;
  return 0;
}

/** A pointer that ended between events can no longer be captured. */
export function capturePointerIfActive(card, pointerId) {
  try { card.setPointerCapture(pointerId); }
  catch (error) { if (error.name !== 'NotFoundError') throw error; }
}

export function noteForMove(from, to) {
  if (actionForMove(from, to) === 'reject') return { label: t('What is still not working?'), required: true };
  if (to === 'discarded') return { label: 'Motivo (opcional)', required: false };
  return null;
}

export function queueShortcut(key, modified, editable) {
  if (modified || editable) return null;
  if (key.toLowerCase() === 'a') return 'approve';
  if (key.toLowerCase() === 'r') return 'reject';
  return key === 'ArrowRight' ? 'skip' : null;
}

export function countChange(status, from, to) {
  return (status === to ? 1 : 0) - (status === from ? 1 : 0);
}

export function archivedFilter(status) {
  return status === 'approved' ? 'approved' : 'discarded';
}

export function pointerCanStart(primary, button, pending, targets, busy) {
  return primary && button === 0 && !pending && !busy && targetsForCard(targets).length > 0;
}

export function pointerMatches(drag, pointerId) {
  return drag !== null && drag.pointerId === pointerId;
}

export function restoredControl(moveTo, inMenu, wasToggle) {
  if (moveTo) return { moveTo, inMenu };
  return { selector: wasToggle ? '.tsp-move-toggle' : '.tsp-card-link', inMenu };
}

export function reviewActionsEnabled(status, canApprove) {
  return status === 'in_review' && canApprove;
}

export function sameRestoredControl(choice, button) {
  return button.dataset.moveTo === choice.moveTo && Boolean(button.closest('.tsp-move-menu')) === choice.inMenu;
}

export function shouldReopenMenu(target, inMenu) {
  return Boolean(target) && inMenu;
}

export function hasModifier(event) {
  return event.altKey || event.ctrlKey || event.metaKey || event.shiftKey;
}

export function decisionBody(data) {
  return { action: data.get('action'), text: data.get('text') || '' };
}

export function menuIsOpen(menu) {
  return menu?.hidden === false;
}

export function isEditableTarget(target) {
  return Boolean(target?.closest?.('input, textarea, select, [contenteditable]'));
}

export function queueErrorText(error) {
  return error.message || t('Could not save the decision.');
}

export async function send(url, body, csrf) {
  const response = await fetch(url, {
    method: 'POST', credentials: 'same-origin',
    headers: { 'X-Requested-With': 'ticketshot', 'X-CSRFToken': csrf,
      'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || t('Could not save the change.'));
  return data;
}

const notes = new WeakMap();
// Native dragstart on links and images cancels pointer events.
const boardEvents = { click: 'onClick', keydown: 'onKeydown', pointerdown: 'onPointerDown',
  pointermove: 'onPointerMove', pointerup: 'onPointerEnd', pointercancel: 'onPointerEnd',
  dragstart: 'onNativeDrag' };
const queueEvents = { click: 'onClick', input: 'onInput', submit: 'onSubmit', keydown: 'onKeydown' };

function closeNote(event) {
  const dialog = event.currentTarget;
  const { resolve, field, opener } = notes.get(dialog);
  notes.delete(dialog);
  restoreNoteOpener(opener);
  resolve(noteResult(dialog.returnValue, field.value));
}

export function restoreNoteOpener(opener) {
  if (opener?.isConnected) opener.focus();
}

export function noteResult(returnValue, value) {
  return returnValue === 'confirm' ? value.trim() : null;
}

function openNote(label, required, opener) {
  const dialog = document.querySelector('#tsp-move-dialog');
  const field = dialog.querySelector('textarea');
  dialog.querySelector('#tsp-dialog-label').textContent = label;
  field.value = '';
  field.required = required;
  dialog.returnValue = '';
  dialog.addEventListener('close', closeNote, { once: true });
  dialog.showModal();
  field.focus();
  return new Promise((resolve) => notes.set(dialog, { resolve, field, opener }));
}

function makeButton(label, className, to) {
  const button = document.createElement('button');
  button.className = className;
  button.type = 'button';
  button.textContent = label;
  if (to) button.dataset.moveTo = to;
  return button;
}

function makeActions(card, targets, canApprove) {
  const actions = targets.length ? availableActions(card, targets, canApprove) : disabledActions();
  const open = document.createElement('a');
  open.className = 'tsp-btn tsp-open-link';
  open.href = card.querySelector('.tsp-card-link').href;
  open.textContent = `Abrir ${card.dataset.key}`;
  actions.prepend(open);
  return actions;
}

function disabledActions() {
  const actions = document.createElement('div');
  actions.className = 'tsp-card-actions';
  const disabled = makeButton(t('Move to…'), 'tsp-btn');
  disabled.disabled = true;
  actions.append(disabled);
  return actions;
}

function availableActions(card, targets, canApprove) {
  const actions = document.createElement('div');
  actions.className = 'tsp-card-actions';
  const toggle = makeButton(t('Move to…'), 'tsp-btn tsp-move-toggle');
  toggle.setAttribute('aria-expanded', 'false');
  const menu = document.createElement('div');
  menu.className = 'tsp-move-menu';
  menu.hidden = true;
  appendTargets(menu, targets);
  actions.append(toggle, menu);
  if (reviewActionsEnabled(card.dataset.status, canApprove)) appendReviewActions(actions);
  return actions;
}

function appendTargets(menu, targets) {
  for (const target of targets) menu.append(makeButton(target.label, 'tsp-btn', target.status));
}

function appendReviewActions(actions) {
  actions.append(makeButton(t('Approve'), 'tsp-btn tsp-primary', 'approved'));
  actions.append(makeButton(t('Still not working'), 'tsp-btn', 'requested'));
}

function toggleMenu(toggle) {
  const menu = toggle.nextElementSibling;
  menu.hidden = !menu.hidden;
  toggle.setAttribute('aria-expanded', String(!menu.hidden));
}

function restoreMenuFocus(card, origin) {
  const inMenu = Boolean(origin.closest('.tsp-move-menu'));
  const choice = restoredControl(origin.dataset.moveTo, inMenu, origin.matches('.tsp-move-toggle'));
  const target = findRestoredControl(card, choice);
  reopenRestoredMenu(card, target, inMenu);
  focusRestoredControl(card, target);
}

function findRestoredControl(card, choice) {
  if (!choice.moveTo) return card.querySelector(choice.selector);
  return [...card.querySelectorAll('[data-move-to]')].find(sameRestoredControl.bind(null, choice));
}

function reopenRestoredMenu(card, target, inMenu) {
  if (!shouldReopenMenu(target, inMenu)) return;
  target.closest('.tsp-move-menu').hidden = false;
  card.querySelector('.tsp-move-toggle').setAttribute('aria-expanded', 'true');
}

function focusRestoredControl(card, target) {
  (target || card.querySelector('.tsp-move-toggle, .tsp-card-link')).focus();
}

function disableNativeDrag(board) {
  disableDraggable(board.querySelectorAll('[data-key]'));
  disableDraggable(board.querySelectorAll('.tsp-thumbnail'));
}

function disableDraggable(elements) {
  for (const element of elements) element.draggable = false;
}

export class BoardController {
  constructor(board) {
    this.board = board;
    this.live = document.querySelector('#tsp-board-live');
    this.csrf = document.querySelector('[name=csrfmiddlewaretoken]').value;
    this.targetMap = JSON.parse(document.querySelector('#tsp-target-map').textContent);
    this.columns = [...board.querySelectorAll('[data-column]')];
    this.scroll = board.closest('.tsp-board-scroll');
    this.drag = null;
    this.suppressClick = null;
    this.scrollFrame = 0;
    this.tickScroll = this.tickScroll.bind(this);
    disableNativeDrag(board);
    for (const type of Object.keys(boardEvents)) {
      board.addEventListener(type, this, type === 'click');
    }
    document.addEventListener('pointerup', this);
    document.addEventListener('pointercancel', this);
  }

  handleEvent(event) {
    this[boardEvents[event.type]](event);
  }

  rebuildActions(card) {
    card.querySelector('.tsp-card-actions')?.remove();
    const targets = this.targetMap[card.dataset.status] || [];
    card.dataset.targets = targets.map((target) => target.status).join(',');
    card.draggable = false;
    card.append(makeActions(card, targets, this.board.dataset.canApprove === 'true'));
  }

  async move(card, to) {
    const from = card.dataset.status;
    if (!canMove(card.dataset.targets, to, card.getAttribute('aria-busy') === 'true')) return;
    await this.performMove(card, from, to);
  }

  async performMove(card, from, to) {
    const origin = document.activeElement;
    const position = { parent: card.parentNode, next: card.nextSibling };
    const text = await this.moveText(from, to, origin);
    if (text === null) { this.live.textContent = 'Movimiento cancelado.'; return; }
    card.setAttribute('aria-busy', 'true');
    await this.saveMove(card, from, to, text, position, origin);
  }

  async saveMove(card, from, to, text, position, origin) {
    try {
      const result = await send(card.dataset.actionUrl, requestBody(from, to, text), this.csrf);
      this.applyMove(card, from, result);
    } catch (error) {
      this.restoreMove(card, from, position, origin, error);
    } finally {
      card.removeAttribute('aria-busy');
    }
  }

  async moveText(from, to, origin) {
    const note = noteForMove(from, to);
    return note ? openNote(note.label, note.required, origin) : '';
  }

  applyMove(card, from, result) {
    const to = result.ticket.status;
    const destination = this.columns.find((column) => column.dataset.column === to);
    if (!destination) throw new Error(t('The server returned an unknown status.'));
    destination.querySelector('[data-cards]').prepend(card);
    card.dataset.status = to;
    this.rebuildActions(card);
    this.updateColumns(from, to);
    this.updateReviewCount(from, to);
    this.updateArchiveIfNeeded(destination, to);
    this.live.textContent = result.message;
    this.focusMovedCard(card);
  }

  updateColumns(from, to) {
    for (const column of this.columns) this.updateColumn(column, from, to);
  }

  updateArchiveIfNeeded(destination, to) {
    if (['approved', 'discarded'].includes(to)) this.updateArchive(destination, to);
  }

  focusMovedCard(card) {
    card.querySelector(moveFocusTarget(true, !!card.querySelector('.tsp-move-toggle')))?.focus();
  }

  updateColumn(column, from, to) {
    const delta = countChange(column.dataset.column, from, to);
    if (!delta) return;
    const count = column.querySelector('[data-count]');
    count.textContent = Number(count.textContent) + delta;
    column.querySelector('[data-empty]')?.remove();
    this.ensureEmpty(column);
  }

  ensureEmpty(column) {
    if (!column.querySelector('[data-key]')) this.addEmpty(column);
  }

  addEmpty(column) {
    const empty = document.createElement('p');
    empty.className = 'tsp-column-empty';
    empty.dataset.empty = '';
    empty.textContent = t('No tickets');
    column.querySelector('[data-cards]').append(empty);
  }

  updateReviewCount(from, to) {
    const count = document.querySelector('[data-review-count]');
    if (count) count.textContent = Number(count.textContent) + countChange('in_review', from, to);
  }

  updateArchive(column, status) {
    const cards = [...column.querySelectorAll('[data-key]')];
    this.trimArchive(cards);
    const count = Number(column.querySelector('[data-count]').textContent);
    if (count <= 0) return;
    this.showArchiveLink(column, status, count);
  }

  trimArchive(cards) {
    for (const extra of cards.slice(10)) extra.remove();
  }

  showArchiveLink(column, status, count) {
    const more = column.querySelector('.tsp-more') || document.createElement('a');
    more.className = 'tsp-more';
    more.href = `?view=list&status=${archivedFilter(status)}`;
    more.textContent = `View all ${count}`;
    if (!more.isConnected) column.append(more);
  }

  restoreMove(card, from, position, origin, error) {
    this.restorePosition(card, position);
    this.restoreStatus(card, from);
    this.live.textContent = error.message || t('Could not save the change.');
    this.restoreErrorFocus(card, origin);
  }

  restorePosition(card, position) {
    if (card.parentNode !== position.parent) position.parent.insertBefore(card, position.next);
  }

  restoreStatus(card, from) {
    if (card.dataset.status === from) return;
    card.dataset.status = from;
    this.rebuildActions(card);
  }

  restoreErrorFocus(card, origin) {
    if (origin?.isConnected) { origin.focus(); return; }
    this.restoreDisconnectedFocus(card, origin);
  }

  restoreDisconnectedFocus(card, origin) {
    if (card.contains(origin)) restoreMenuFocus(card, origin);
  }

  onClick(event) {
    if (this.suppressDraggedClick(event)) return;
    this.handleControlClick(event);
  }

  suppressDraggedClick(event) {
    if (!this.suppressClick?.contains(event.target)) return false;
    event.preventDefault(); event.stopPropagation(); this.suppressClick = null;
    return true;
  }

  handleControlClick(event) {
    const toggle = event.target.closest('.tsp-move-toggle');
    if (toggle) { toggleMenu(toggle); return; }
    const button = event.target.closest('[data-move-to]');
    if (button) this.move(button.closest('[data-key]'), button.dataset.moveTo);
  }

  onKeydown(event) {
    if (event.key !== 'Escape') return;
    this.closeMenu(event);
  }

  closeMenu(event) {
    const menu = menuForTarget(event.target);
    if (!menuIsOpen(menu)) return;
    event.preventDefault();
    menu.hidden = true;
    const toggle = menu.parentNode.querySelector('.tsp-move-toggle');
    toggle.setAttribute('aria-expanded', 'false');
    toggle.focus();
  }

  onNativeDrag(event) {
    if (event.target.closest('[data-key]')) event.preventDefault();
  }

  onPointerDown(event) {
// A new touch means the previous drag click already happened or missed.
    this.suppressClick = null;
    const card = event.target.closest('[data-key]');
    if (!card || event.target.closest('.tsp-card-actions')) return;
    this.beginPointerIfAllowed(card, event);
  }

  beginPointerIfAllowed(card, event) {
    if (!pointerCanStart(event.isPrimary, event.button, !!this.drag, card.dataset.targets,
      card.getAttribute('aria-busy') === 'true')) return;
    this.drag = { card, pointerId: event.pointerId, x: event.clientX, y: event.clientY, active: false, ghost: null };
  }

  onPointerMove(event) {
    const drag = this.drag;
    if (!pointerMatches(drag, event.pointerId)) return;
    this.continuePointerMove(event, drag);
  }

  continuePointerMove(event, drag) {
    const phase = dragPhase(drag.x, drag.y, event.clientX, event.clientY, drag.active);
    if (phase === 'pending') return;
    this.activateDrag(drag);
    event.preventDefault();
    drag.currentX = event.clientX;
    this.positionGhost(drag.ghost, event.clientX, event.clientY);
    this.autoScroll(event.clientX);
  }

  activateDrag(drag, capturePointer = true) {
    if (drag.active) return;
    this.startDrag(drag);
    if (capturePointer) capturePointerIfActive(drag.card, drag.pointerId);
  }

  startDrag(drag) {
    drag.active = true;
    drag.ghost = drag.card.cloneNode(true);
    drag.ghost.classList.add('tsp-drag-ghost');
    drag.ghost.setAttribute('aria-hidden', 'true');
    drag.ghost.inert = true;
    drag.ghost.querySelectorAll('[id]').forEach((element) => element.removeAttribute('id'));
    drag.ghost.style.width = `${drag.card.getBoundingClientRect().width}px`;
    document.body.append(drag.ghost);
    drag.card.classList.add('is-dragging');
    for (const column of this.columns) {
      column.classList.toggle('is-target', canMove(drag.card.dataset.targets, column.dataset.column));
    }
  }

  positionGhost(ghost, x, y) {
    ghost.style.transform = `translate(${x + 12}px, ${y + 12}px)`;
  }

  autoScroll(x) {
    const rect = this.scroll.getBoundingClientRect();
    const before = this.scroll.scrollLeft;
    this.scroll.scrollLeft += scrollStep(x, rect.left, rect.right);
    if (this.scroll.scrollLeft !== before) this.scheduleScroll();
  }

  scheduleScroll() {
    if (this.scrollFrame) return;
    this.scrollFrame = requestAnimationFrame(this.tickScroll);
  }

  tickScroll() {
    this.scrollFrame = 0;
    if (this.drag === null) return;
    this.autoScroll(this.drag.currentX);
  }

  stopScroll() {
    if (this.scrollFrame) cancelAnimationFrame(this.scrollFrame);
    this.scrollFrame = 0;
  }

  onPointerEnd(event) {
    const drag = this.drag;
    if (!pointerMatches(drag, event.pointerId)) return;
    this.drag = null;
    this.stopScroll();
    this.releaseCapture(drag, event.pointerId);
// Releasing far from the start counts as a drag even without intermediate
// moves, as with a fast gesture or simulated pointer.
    if (dragPhase(drag.x, drag.y, event.clientX, event.clientY, drag.active) === 'pending') return;
    this.activateDrag(drag, false);
    this.finishDrag(event, drag);
  }

  releaseCapture(drag, pointerId) {
    if (drag.card.hasPointerCapture(pointerId)) drag.card.releasePointerCapture(pointerId);
  }

  finishDrag(event, drag) {
    this.suppressClick = drag.card;
    const column = document.elementFromPoint(event.clientX, event.clientY)?.closest('[data-column]');
    const to = dropDestination(drag.card.dataset.targets, column?.dataset.column);
    this.endDrag(drag);
    this.moveAfterDrop(event.type, drag.card, to);
  }

  moveAfterDrop(type, card, to) {
    if (type === 'pointerup' && to) this.move(card, to);
  }

  endDrag(drag) {
    drag.ghost.remove();
    drag.card.classList.remove('is-dragging');
    for (const column of this.columns) column.classList.remove('is-target');
  }
}

class QueueController {
  constructor(queue) {
    this.queue = queue;
    this.live = queue.querySelector('[role=status]');
    this.compare = queue.querySelector('[data-compare]');
    this.opacity = queue.querySelector('[data-opacity]');
    queue.addEventListener('click', this);
    queue.addEventListener('input', this);
    queue.addEventListener('submit', this);
    document.addEventListener('keydown', this);
  }

  handleEvent(event) {
    this[queueEvents[event.type]](event);
  }

  onClick(event) {
    const mode = event.target.closest('[data-mode]');
    if (!mode) return;
    const overlay = mode.dataset.mode === 'overlay';
    this.compare.classList.toggle('is-overlay', overlay);
    this.opacity.closest('label').hidden = !overlay;
    for (const button of this.queue.querySelectorAll('[data-mode]')) {
      button.setAttribute('aria-pressed', String(button === mode));
    }
  }

  onInput(event) {
    if (event.target !== this.opacity) return;
    this.compare.style.setProperty('--capture-opacity', String(Number(this.opacity.value) / 100));
  }

  async onSubmit(event) {
    const form = event.target.closest('[data-decision]');
    if (!form) return;
    event.preventDefault();
    await this.submitDecision(form);
  }

  async submitDecision(form) {
    const button = form.querySelector('[type=submit]');
    button.disabled = true;
    try {
      const data = new FormData(form);
      const result = await send(form.action, decisionBody(data), data.get('csrfmiddlewaretoken'));
      this.live.textContent = result.message;
      window.location.assign(this.queue.dataset.nextUrl);
    } catch (error) {
      this.live.textContent = queueErrorText(error);
      button.disabled = false;
    }
  }

  onKeydown(event) {
    const action = queueShortcut(event.key, hasModifier(event), isEditableTarget(event.target));
    if (!action) return;
    this.runShortcut(action, event);
  }

  runShortcut(action, event) {
    if (action === 'skip') { this.clickSkip(event); return; }
    this.submitShortcut(action);
  }

  clickSkip(event) {
    event.preventDefault();
    this.queue.querySelector('[data-skip]')?.click();
  }

  submitShortcut(action) {
    this.queue.querySelector(`[name=action][value=${action}]`)?.form.requestSubmit();
  }
}

function menuForTarget(target) {
  return target.closest('.tsp-card-actions')?.querySelector('.tsp-move-menu');
}

if (typeof document !== 'undefined') {
  setLanguage(document.documentElement?.lang);
  const board = document.querySelector('[data-board]');
  if (board) new BoardController(board);
  const queue = document.querySelector('[data-queue]');
  if (queue) new QueueController(queue);
}
