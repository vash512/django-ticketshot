import assert from 'node:assert/strict';
import { test } from 'node:test';
import { load, reply, withFetch, withGlobals } from './helpers.mjs';

import { actionForMove, archivedFilter, BoardController, canMove, capturePointerIfActive, countChange, decisionBody, dragPhase, dropDestination,
  hasModifier, isEditableTarget, menuIsOpen, moveFocusTarget, noteForMove, noteResult,
  pointerCanStart, pointerMatches, queueErrorText, queueShortcut, requestBody,
  restoredControl, restoreNoteOpener, reviewActionsEnabled,
  sameRestoredControl, scrollStep, send, shouldReopenMenu, targetsForCard
} from '../../src/ticketshot/static/ticketshot/bar-0.3.0/board.js';

function pointerBoard() {
  const captured = [];
  const card = {
    dataset: { targets: 'in_review' },
    getAttribute: () => null,
    setPointerCapture: (id) => captured.push(id),
    hasPointerCapture: (id) => captured.includes(id),
    releasePointerCapture: (id) => captured.splice(captured.indexOf(id), 1),
    contains: (target) => target === linkTarget,
  };
  const link = { closest: (selector) => selector === '[data-key]' ? card : null };
  const linkTarget = { closest: (selector) => {
    if (selector === '.tsp-card-link') return link;
    if (selector === '[data-key]') return card;
    return null;
  } };
  const controller = Object.create(BoardController.prototype);
  controller.drag = null;
  controller.suppressClick = null;
  controller.startDrag = (drag) => { drag.active = true; drag.ghost = {}; };
  controller.positionGhost = () => {};
  controller.autoScroll = () => {};
  controller.stopScroll = () => {};
  controller.endDrag = () => {};
  controller.moveAfterDrop = () => {};
  const event = (type, x, target = linkTarget) => ({
    type, target, pointerId: 7, clientX: x, clientY: 10, isPrimary: true, button: 0,
    preventDefault() { this.prevented = true; },
  });
  return { card, captured, controller, event, linkTarget };
}

function actionBoard(status, targets, canApprove = false, withActions = true) {
  const controller = Object.create(BoardController.prototype);
  const removed = [];
  let actions;
  const card = {
    dataset: { key: 'TS-12', status },
    draggable: true,
    querySelector: (selector) => selector === '.tsp-card-actions'
      ? (withActions ? { remove: () => removed.push('actions') } : null)
      : { href: '/tickets/TS-12/' },
    append: (node) => { actions = node; },
  };
  controller.targetMap = targets;
  controller.board = { dataset: { canApprove: String(canApprove) } };
  const document = { createElement: (tagName) => ({
    tagName, children: [], dataset: {}, setAttribute() {},
    append(...nodes) { this.children.push(...nodes); },
    prepend(node) { this.children.unshift(node); },
  }) };
  return { card, controller, document, removed, get actions() { return actions; } };
}

test('card data provides destinations', () => {
  assert.deepEqual(targetsForCard('requested,approved'), ['requested', 'approved']);
  assert.deepEqual(targetsForCard(''), []);
});

test('approve and reject use actions rather than manual moves', () => {
  assert.equal(actionForMove('in_review', 'approved'), 'approve');
  assert.equal(actionForMove('in_review', 'requested'), 'reject');
  assert.equal(actionForMove('requested', 'in_review'), 'status');
  assert.equal(actionForMove('requested', 'discarded'), 'status');
});

test('manual moves send a destination and preserve the note', () => {
  assert.deepEqual(requestBody('in_review', 'approved', 'Bien'), { action: 'approve', text: 'Bien' });
  assert.deepEqual(requestBody('in_review', 'requested', 'Falta el total'), { action: 'reject', text: 'Falta el total' });
  assert.deepEqual(requestBody('requested', 'discarded', 'Duplicado'),
    { action: 'status', to: 'discarded', text: 'Duplicado' });
});

test('focus follows the card and returns on a failed move', () => {
  assert.equal(moveFocusTarget(true, true), '.tsp-move-toggle');
  assert.equal(moveFocusTarget(true, false), '.tsp-card-link');
  assert.equal(moveFocusTarget(false, true), 'origin');
});

test('empty destinations forbid moves and ordinary statuses keep their destination', () => {
  assert.deepEqual(targetsForCard(null), []);
  assert.deepEqual(targetsForCard('approved,discarded'), ['approved', 'discarded']);
  assert.deepEqual(requestBody('in_review', 'discarded'),
    { action: 'status', to: 'discarded', text: '' });
});

test('board module imports without a document', async () => {
  const module = await load('board.js');
  assert.equal(module.actionForMove('in_progress', 'in_review'), 'status');
});

test('only allowed unoccupied transitions accept a card', () => {
  assert.equal(canMove('approved,requested', 'approved'), true);
  assert.equal(canMove('approved,requested', 'discarded'), false);
  assert.equal(canMove('approved,requested', 'approved', true), false);
  assert.equal(dropDestination('approved,requested', 'requested'), 'requested');
  assert.equal(dropDestination('approved,requested', 'discarded'), null);
  assert.equal(dropDestination('approved,requested', undefined), null);
});

test('drag waits six pixels and edge scrolling activates near borders', () => {
  assert.equal(dragPhase(100, 100, 103, 104, false), 'pending');
  assert.equal(dragPhase(100, 100, 106, 100, false), 'dragging');
  assert.equal(dragPhase(100, 100, 101, 101, true), 'dragging');
  assert.equal(scrollStep(118, 100, 300), -16);
  assert.equal(scrollStep(280, 100, 300), 16);
  assert.equal(scrollStep(200, 100, 300), 0);
  assert.equal(pointerCanStart(true, 0, false, 'approved', false), true);
  assert.equal(pointerCanStart(false, 0, false, 'approved', false), false);
  assert.equal(pointerCanStart(true, 1, false, 'approved', false), false);
  assert.equal(pointerCanStart(true, 0, true, 'approved', false), false);
  assert.equal(pointerCanStart(true, 0, false, '', false), false);
  assert.equal(pointerCanStart(true, 0, false, 'approved', true), false);
  assert.equal(pointerMatches({ pointerId: 3 }, 3), true);
  assert.equal(pointerMatches({ pointerId: 3 }, 4), false);
  assert.equal(pointerMatches(null, 3), false);
});

test('scroll border is exclusive and an ended pointer does not break the gesture', () => {
  assert.equal(scrollStep(140, 100, 300), 0);
  assert.equal(scrollStep(260, 100, 300), 0);
  assert.equal(scrollStep(139, 100, 300), -16);
  assert.equal(scrollStep(261, 100, 300), 16);
  const captured = [];
  capturePointerIfActive({ setPointerCapture: (id) => captured.push(id) }, 7);
  capturePointerIfActive({ setPointerCapture: () => { const error = new Error('caducó');
    error.name = 'NotFoundError'; throw error; } }, 8);
  assert.deepEqual(captured, [7]);
  assert.throws(() => capturePointerIfActive({ setPointerCapture: () => {
    throw new TypeError('fallo inesperado');
  } }, 9), /fallo inesperado/);
});

test('a click without dragging preserves the link and does not capture the pointer', () => {
  const { captured, controller, event } = pointerBoard();
  controller.onPointerDown(event('pointerdown', 10));
  assert.deepEqual(captured, []);
  controller.onPointerMove(event('pointermove', 15));
  assert.deepEqual(captured, []);
  controller.onPointerEnd(event('pointerup', 15));
  const click = event('click', 15);
  controller.onClick(click);
  assert.equal(click.prevented, undefined);
  assert.equal(controller.suppressClick, null);
});

test('drag captures after threshold and suppresses the release click', async () => {
  const { card, captured, controller, event } = pointerBoard();
  controller.onPointerDown(event('pointerdown', 10));
  assert.deepEqual(captured, []);
  controller.onPointerMove(event('pointermove', 16));
  assert.deepEqual(captured, [7]);
  assert.equal(controller.drag.card, card);
  await withGlobals({ document: { elementFromPoint: () => null } }, () => {
    controller.onPointerEnd(event('pointerup', 16));
  });
  assert.equal(controller.suppressClick, card);
  const click = event('click', 16);
  click.stopPropagation = () => { click.stopped = true; };
  controller.onClick(click);
  assert.equal(click.prevented, true);
  assert.equal(click.stopped, true);
});

test('Open persists after actions refresh and controls do not start dragging', async () => {
  const { controller, event } = pointerBoard();
  let actions;
  const card = {
    dataset: { key: 'TS-12', status: 'requested' },
    querySelector: (selector) => selector === '.tsp-card-actions'
      ? { remove() {} } : { href: '/tickets/TS-12/' },
    append: (node) => { actions = node; },
  };
  controller.targetMap = { requested: [{ status: 'in_progress', label: 'En progreso' }] };
  controller.board = { dataset: { canApprove: 'false' } };
  await withGlobals({ document: { createElement: (tagName) => ({
    tagName, children: [], dataset: {}, setAttribute() {},
    append(...nodes) { this.children.push(...nodes); },
    prepend(node) { this.children.unshift(node); },
  }) } }, () => controller.rebuildActions(card));
  const open = actions.children.find((node) => node.tagName === 'a');
  assert.equal(open?.href, '/tickets/TS-12/');
  assert.equal(open?.textContent, 'Abrir TS-12');
  const toggle = actions.children.find((node) => node.className?.includes('tsp-move-toggle'));
  const menu = actions.children.find((node) => node.className === 'tsp-move-menu');
  for (const control of [open, toggle, menu]) {
    controller.onPointerDown(event('pointerdown', 10, {
      closest: (selector) => {
        if (selector === '[data-key]') return card;
        if (selector === '.tsp-card-actions') return actions;
        return selector === '.tsp-card-link' ? null : control;
      },
    }));
    assert.equal(controller.drag, null);
  }
});

test('menu starts closed and available destinations appear after refresh', async () => {
  const setup = actionBoard('requested', {
    requested: [{ status: 'in_progress', label: 'En progreso' }],
  });
  await withGlobals({ document: setup.document }, () => setup.controller.rebuildActions(setup.card));
  const menu = setup.actions.children.find((node) => node.className === 'tsp-move-menu');
  assert.equal(menu.hidden, true);
  assert.equal(menu.children[0].dataset.moveTo, 'in_progress');
  assert.equal(setup.card.dataset.targets, 'in_progress');
  assert.equal(setup.card.draggable, false);
  assert.deepEqual(setup.removed, ['actions']);
});

test('refresh accepts cards without prior controls or destinations', async () => {
  const setup = actionBoard('approved', {}, false, false);
  await withGlobals({ document: setup.document }, () => setup.controller.rebuildActions(setup.card));
  assert.equal(setup.card.dataset.targets, '');
  assert.equal(setup.actions.children[1].disabled, true);
  assert.deepEqual(setup.removed, []);
});

test('review actions require permission and review status', async () => {
  const targets = { in_review: [{ status: 'approved', label: 'Aprobado' }] };
  const allowed = actionBoard('in_review', targets, true);
  await withGlobals({ document: allowed.document }, () => allowed.controller.rebuildActions(allowed.card));
  assert.ok(allowed.actions.children.some((node) => node.dataset.moveTo === 'approved'));
  assert.ok(allowed.actions.children.some((node) => node.dataset.moveTo === 'requested'));
  const denied = actionBoard('in_review', targets, false);
  await withGlobals({ document: denied.document }, () => denied.controller.rebuildActions(denied.card));
  assert.equal(denied.actions.children.some((node) => node.dataset.moveTo === 'requested'), false);
});

test('controller disables native drag and captures clicks before the link', async () => {
  const card = { draggable: true };
  const thumbnail = { draggable: true };
  const listeners = [];
  const board = {
    querySelectorAll: (selector) => selector === '[data-key]' ? [card] :
      selector === '.tsp-thumbnail' ? [thumbnail] : [],
    closest: () => ({}),
    addEventListener: (type, handler, capture) => listeners.push({ type, handler, capture }),
  };
  const document = {
    querySelector: (selector) => ({
      '#tsp-board-live': {}, '[name=csrfmiddlewaretoken]': { value: 'csrf' },
      '#tsp-target-map': { textContent: '{}' },
    })[selector],
    addEventListener() {},
  };
  const controller = await withGlobals({ document }, () => new BoardController(board));
  assert.equal(card.draggable, false);
  assert.equal(thumbnail.draggable, false);
  const link = {};
  const click = { type: 'click', target: link,
    preventDefault() { this.prevented = true; },
    stopPropagation() { this.stopped = true; } };
  controller.suppressClick = { contains: (target) => target === link };
  const clickListener = listeners.find((item) => item.type === 'click');
  if (clickListener.capture) clickListener.handler.handleEvent(click);
  // The link stops propagation; the board sees only the capture click.
  click.stopPropagation();
  if (!click.stopped && !clickListener.capture) clickListener.handler.handleEvent(click);
  assert.equal(click.prevented, true);
});

test('ordinary click opens the menu while drag click does not', () => {
  const controller = Object.create(BoardController.prototype);
  const menu = { hidden: true };
  const toggle = { nextElementSibling: menu, setAttribute() {} };
  const target = { closest: (selector) => selector === '.tsp-move-toggle' ? toggle : null };
  const event = { target, preventDefault() { this.prevented = true; },
    stopPropagation() { this.stopped = true; } };
  controller.suppressClick = null;
  controller.onClick(event);
  assert.equal(menu.hidden, false);
  menu.hidden = true;
  controller.suppressClick = { contains: (candidate) => candidate === target };
  controller.onClick(event);
  assert.equal(menu.hidden, true);
  assert.equal(event.prevented, true);
  assert.equal(event.stopped, true);
});

test('a new touch forgets the pending click from the previous drag', () => {
  // The suppressed release click may land outside the card; the next tap
  // on that card's Move control must still work.
  const controller = Object.create(BoardController.prototype);
  const menu = { hidden: true };
  const toggle = { nextElementSibling: menu, setAttribute() {} };
  const actions = {};
  const target = { closest: (selector) => ({ '.tsp-move-toggle': toggle, '.tsp-card-actions': actions,
                                              '[data-key]': {} })[selector] || null };
  controller.drag = null;
  controller.suppressClick = { contains: (candidate) => candidate === target };
  controller.onPointerDown({ target, isPrimary: true, button: 0 });
  controller.onClick({ target, preventDefault() {}, stopPropagation() {} });
  assert.equal(menu.hidden, false);
});

test('stopping edge scrolling allows scheduling it again', async () => {
  const controller = Object.create(BoardController.prototype);
  controller.scrollFrame = 7;
  const cancelled = [];
  const scheduled = [];
  await withGlobals({
    cancelAnimationFrame: (id) => cancelled.push(id),
    requestAnimationFrame: (callback) => { scheduled.push(callback); return 8; },
  }, () => {
    controller.stopScroll();
    controller.scheduleScroll();
  });
  assert.deepEqual(cancelled, [7]);
  assert.deepEqual(scheduled, [controller.tickScroll]);
  assert.equal(controller.scrollFrame, 8);
});

test('releasing far away without movement does not capture an ended pointer', async () => {
  const { card, captured, controller, event } = pointerBoard();
  controller.onPointerDown(event('pointerdown', 10));
  await withGlobals({ document: { elementFromPoint: () => null } }, () => {
    controller.onPointerEnd(event('pointerup', 16));
  });
  assert.deepEqual(captured, []);
  assert.equal(controller.suppressClick, card);
});

test('free card space can start a drag', () => {
  const { card, captured, controller, event } = pointerBoard();
  controller.onPointerDown(event('pointerdown', 10, {
    closest: (selector) => selector === '[data-key]' ? card : null,
  }));
  assert.equal(controller.drag?.card, card);
  assert.deepEqual(captured, []);
});

test('releasing outside the board clears the pending gesture', async () => {
  const { event } = pointerBoard();
  const listeners = new Map();
  const board = {
    querySelectorAll: () => [],
    closest: () => ({}),
    addEventListener() {},
  };
  const document = {
    querySelector: (selector) => ({
      '#tsp-board-live': {}, '[name=csrfmiddlewaretoken]': { value: 'csrf' },
      '#tsp-target-map': { textContent: '{}' },
    })[selector],
    addEventListener: (type, handler) => listeners.set(type, handler),
  };
  await withGlobals({ document }, () => {
    const controller = new BoardController(board);
    controller.onPointerDown(event('pointerdown', 10));
    assert.ok(controller.drag);
    listeners.get('pointerup').handleEvent(event('pointerup', 10, { closest: () => null }));
    assert.equal(controller.drag, null);
    controller.onPointerDown(event('pointerdown', 10));
    assert.ok(controller.drag);
  });
});

test('notes and counts follow board transitions', () => {
  assert.deepEqual(noteForMove('in_review', 'requested'),
    { label: '¿Qué sigue sin funcionar?', required: true });
  assert.deepEqual(noteForMove('requested', 'discarded'),
    { label: 'Motivo (opcional)', required: false });
  assert.equal(noteForMove('in_review', 'approved'), null);
  assert.equal(countChange('in_review', 'in_review', 'approved'), -1);
  assert.equal(countChange('approved', 'in_review', 'approved'), 1);
  assert.equal(countChange('requested', 'in_review', 'approved'), 0);
  assert.equal(archivedFilter('approved'), 'approved');
  assert.equal(archivedFilter('discarded'), 'discarded');
  assert.equal(noteResult('confirm', '  motivo  '), 'motivo');
  assert.equal(noteResult('cancel', 'motivo'), null);
  assert.deepEqual(restoredControl('approved', true, false), { moveTo: 'approved', inMenu: true });
  assert.deepEqual(restoredControl('', false, true), { selector: '.tsp-move-toggle', inMenu: false });
  assert.deepEqual(restoredControl('', false, false), { selector: '.tsp-card-link', inMenu: false });
  assert.equal(reviewActionsEnabled('in_review', true), true);
  assert.equal(reviewActionsEnabled('in_review', false), false);
  assert.equal(reviewActionsEnabled('requested', true), false);
  const menuButton = { dataset: { moveTo: 'approved' }, closest: () => ({}) };
  assert.equal(sameRestoredControl({ moveTo: 'approved', inMenu: true }, menuButton), true);
  assert.equal(sameRestoredControl({ moveTo: 'requested', inMenu: true }, menuButton), false);
  assert.equal(sameRestoredControl({ moveTo: 'approved', inMenu: false }, menuButton), false);
  assert.equal(shouldReopenMenu(menuButton, true), true);
  assert.equal(shouldReopenMenu(null, true), false);
  assert.equal(shouldReopenMenu(menuButton, false), false);
  assert.equal(menuIsOpen({ hidden: false }), true);
  assert.equal(menuIsOpen({ hidden: true }), false);
  assert.equal(menuIsOpen(null), false);
  let focused = 0;
  restoreNoteOpener({ isConnected: true, focus: () => focused++ });
  restoreNoteOpener({ isConnected: false, focus: () => focused++ });
  restoreNoteOpener(null);
  assert.equal(focused, 1);
});

test('queue shortcuts respect editable fields and modifiers', () => {
  assert.equal(queueShortcut('A', false, false), 'approve');
  assert.equal(queueShortcut('r', false, false), 'reject');
  assert.equal(queueShortcut('ArrowRight', false, false), 'skip');
  assert.equal(queueShortcut('a', false, true), null);
  assert.equal(queueShortcut('ArrowRight', true, false), null);
  assert.equal(queueShortcut('Escape', false, false), null);
  assert.equal(isEditableTarget({ closest: () => ({}) }), true);
  assert.equal(isEditableTarget({ closest: () => null }), false);
  assert.equal(isEditableTarget({}), false);
  assert.equal(isEditableTarget(null), false);
  assert.equal(queueErrorText(new Error('Sin permiso')), 'Sin permiso');
  assert.equal(queueErrorText({}), 'No se pudo guardar la decisión.');
  assert.equal(hasModifier({ altKey: true }), true);
  assert.equal(hasModifier({ altKey: false, ctrlKey: true }), true);
  assert.equal(hasModifier({ altKey: false, ctrlKey: false, metaKey: true }), true);
  assert.equal(hasModifier({ altKey: false, ctrlKey: false, metaKey: false, shiftKey: true }), true);
  assert.equal(hasModifier({ altKey: false, ctrlKey: false, metaKey: false, shiftKey: false }), false);
  assert.deepEqual(decisionBody(new Map([['action', 'reject'], ['text', 'Falla']])),
    { action: 'reject', text: 'Falla' });
  assert.deepEqual(decisionBody(new Map([['action', 'approve']])), { action: 'approve', text: '' });
});

test('API sends status changes and reports server errors', async () => {
  await withFetch(reply({ ticket: { status: 'approved' }, message: 'Movido' }), async (calls) => {
    assert.equal((await send('/action', requestBody('in_review', 'approved'), 'csrf')).message, 'Movido');
    assert.equal(calls[0].url, '/action');
    assert.equal(calls[0].init.method, 'POST');
    assert.equal(calls[0].init.headers['X-CSRFToken'], 'csrf');
    assert.equal(calls[0].init.body.get('action'), 'approve');
  });
  await withFetch(reply({ error: 'Sin permiso' }, 403), async () => {
    await assert.rejects(send('/action', { action: 'reject', text: 'Falla' }, 'csrf'), /Sin permiso/);
  });
  await withFetch(reply({}, 500), async () => {
    await assert.rejects(send('/action', { action: 'approve' }, 'csrf'), /No se pudo guardar el cambio/);
  });
});
