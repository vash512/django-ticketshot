// Bar composer, comparison, and question decisions and rendering.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { controls, fakeBrowser, load, text } from './helpers.mjs';

const {
  Composer, cardHtml, composerChoices, composerHtml, moveImageUp, rejectDefault, relationHtml, relationList,
  rejectVisible, sentHtml, ticketNote
} = await load('composer.js');
const { compareHtml, initialCompareState, nextCompareState } = await load('compare.js');
const { askHtml, checkAnswer } = await load('ask.js');

const CFG = { user: 'Ana (revisora)', limits: { noteLength: 2000 }, recordingCookie: 'ticketshot_rec' };

test('chain to open tickets and an absent pending target', () => {
  const open = [{ key: 'TS-1', note: 'a' }];
  const find = (key) => open.find((t) => t.key === key);
  assert.deepEqual(relationList(open, null, find), open);
  assert.deepEqual(relationList(open, { key: 'TS-1', reject: true }, find), open);
  assert.deepEqual(relationList(open, { key: 'TS-9', reject: true }, find).map((t) => [t.key, t.canApprove]),
                   [['TS-9', true], ['TS-1', undefined]]);
  assert.deepEqual(relationList([], { key: 'TS-9' }, () => null)[0], { key: 'TS-9', note: '', canApprove: false });
});

test('relation lists tickets and marks selection and rejection option', () => {
  assert.equal(relationHtml([], '', false), '');
  const html = relationHtml([{ key: 'TS-1', note: 'x'.repeat(80) }, { key: 'TS-2', note: '' }], 'TS-2', true);
  assert.match(html, /<option value="">Ticket nuevo<\/option>/);
  assert.match(html, new RegExp('<option value="TS-1">Encadenar a TS-1 · ' + 'x'.repeat(59) + '…</option>'));
  assert.match(html, /<option value="TS-2" selected>Encadenar a TS-2<\/option>/);
  assert.match(html, /data-reject checked>/);
  assert.doesNotMatch(relationHtml([{ key: 'TS-1' }], '', false), /checked/);
});

test('rejection option appears only with approval permission', () => {
  assert.equal(rejectVisible('', { canApprove: true }, null), false);
  assert.equal(rejectVisible('TS-1', { canApprove: true }, null), true);
  assert.equal(rejectVisible('TS-1', { canApprove: false }, null), false);
  assert.equal(rejectVisible('TS-9', null, { key: 'TS-9', reject: true }), true);
  assert.equal(rejectVisible('TS-9', null, { key: 'TS-9', reject: false }), false);
  assert.equal(rejectVisible('TS-9', null, { key: 'TS-8', reject: true }), false);
});

test('extra submission data depends on recording status', () => {
  const note = text(sentHtml({ kind: 'note', logs: [1, 2] }, CFG));
  assert.match(note, /Tu usuario: Ana \(revisora\)\./);
  assert.match(note, /Registros de consola y red \(2\)/);
  assert.doesNotMatch(note, /Eventos/);
  const flow = text(sentHtml({ kind: 'recording', logs: [], events: [1, 2, 3] }, CFG));
  assert.match(flow, /Registros de consola y red \(0\) Eventos del recorrido \(3\), sin lo que se escribió/);
  assert.match(flow, /el servidor guardó un registro técnico/);
  assert.doesNotMatch(text(sentHtml({ kind: 'recording' }, { ...CFG, recordingCookie: '' })), /registro técnico/);
});

test('dialog identifies ticket kind and device', () => {
  const note = composerHtml({ kind: 'note' }, CFG, 'mobile', '<p>REL</p>');
  assert.match(note, /<h2 id="ts-compose-title">Levantar ticket<\/h2>/);
  assert.match(note, /maxlength="2000"/);
  assert.match(note, /value="mobile" checked/);
  assert.doesNotMatch(note, /value="desktop" checked/);
  assert.ok(note.indexOf('ts-device') < note.indexOf('<p>REL</p>'));
  assert.deepEqual(controls(note).filter((c) => !c.startsWith('close aria')),
                   ['discard «Descartar»', 'close «Seguir capturando»', 'send «Levantar ticket»']);
  const flow = composerHtml({ kind: 'recording' }, CFG, 'desktop', '');
  assert.match(flow, /Levantar ticket del flujo grabado/);
  assert.ok(controls(flow).includes('close «Volver»'));
});

test('each image can be edited reordered and removed within limits', () => {
  fakeBrowser('https://site.test/start/');
  const img = (id, extra) => ({ id, role: 'manual', pageUrl: 'https://site.test/a/?b=1', ...extra });
  assert.deepEqual(controls(cardHtml({ kind: 'note' }, img('a'), 0)),
                   ['edit id=a aria-label=Editar captura 1 «»', 'edit id=a «Editar»', 'remove id=a «Quitar»']);
  assert.deepEqual(controls(cardHtml({ kind: 'note' }, img('b'), 1)).slice(2, 3), ['up id=b aria-label=Subir «↑»']);
  assert.ok(!controls(cardHtml({ kind: 'recording' }, img('c'), 1)).some((c) => c.startsWith('up')));
  assert.match(text(cardHtml({ kind: 'note' }, img('a'), 0)), /1 · Captura \/a\/\?b=1 Sin editar/);
  const edited = img('d', { role: 'step', ops: [{ t: 'redact' }, { t: 'pen' }] });
  assert.match(text(cardHtml({ kind: 'recording' }, edited, 2)), /3 · Paso .* 2 marcas · 1 ocultas/);
  // Show each capture note on its card.
  assert.match(cardHtml({ kind: 'note' }, img('e', { caption: 'el <b>total</b>' }), 0),
               /<p class="ts-card-caption">el &lt;b&gt;total&lt;\/b&gt;<\/p>/);
  assert.doesNotMatch(cardHtml({ kind: 'note' }, img('f'), 0), /ts-card-caption/);
});

test('capture notes become the ticket note when the general note is empty', () => {
  const images = [{ caption: 'el total no cuadra' }, { caption: '' }, { caption: 'falta el IVA' }];
  assert.equal(ticketNote('  Revisar la caja  ', images), 'Revisar la caja');
  assert.equal(ticketNote('  ', images), 'Captura 1: el total no cuadra\nCaptura 3: falta el IVA');
  assert.equal(ticketNote('', [{}, { caption: '' }]), '');
  // Ten 500-character notes stay within the ticket note limit.
  const long = Array.from({ length: 10 }, () => ({ caption: 'x'.repeat(500) }));
  const joined = ticketNote('', long, 5000);
  assert.equal(joined.length, 5000);
  assert.ok(joined.endsWith('…'));
  assert.equal(ticketNote('', [{ caption: 'corta' }], 5000), 'Captura 1: corta');
  // The dialog says the general note is optional when capture notes exist.
  assert.match(composerHtml({ kind: 'note', images }, CFG, 'desktop', ''), /placeholder="Opcional: ya escribiste en las capturas/);
  assert.match(composerHtml({ kind: 'note', images: [{}] }, CFG, 'desktop', ''), /placeholder="Qué viste, qué esperabas/);
});

test('submission options come from the form', () => {
  assert.deepEqual(composerChoices({ device: '', parent: '', reject: true, rejectShown: false }, 'desktop'),
                   { logs: false, events: false, device: 'desktop', parent: '', rejectParent: false });
  assert.deepEqual(composerChoices({ device: 'both', parent: 'TS-1', reject: true, rejectShown: true,
                                     logs: true, events: true }, 'desktop'),
                   { logs: true, events: true, device: 'both', parent: 'TS-1', rejectParent: true });
});

test('moving an image up swaps it with the previous one', () => {
  const images = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  assert.equal(moveImageUp(images, 'a'), false);
  assert.equal(moveImageUp(images, 'zz'), false);
  assert.equal(moveImageUp(images, 'c'), true);
  assert.deepEqual(images.map((i) => i.id), ['a', 'c', 'b']);
});

// ------------------------------------------------ dialog fakes

/** Fake element whose querySelector returns the given fields. */
function fakeEl(fields) {
  return { querySelector: (selector) => fields[selector] || null, remove() { this.removed = true; } };
}

test('rejection is preselected only for the rejection chain target', () => {
  const chain = { key: 'TS-9', reject: true };
  assert.equal(rejectDefault('TS-9', chain), true);
  assert.equal(rejectDefault('TS-1', chain), false);
  assert.equal(rejectDefault('', chain), false);
  assert.equal(rejectDefault('TS-9', { key: 'TS-9', reject: false }), false);
  assert.equal(rejectDefault('TS-9', null), false);
  // The draft targets TS-1 while rejection chain targets TS-9; do not reject TS-1.
  const { composer } = composerWith();
  composer.tickets.chain = () => chain;
  composer.tickets.list = [{ key: 'TS-1', canApprove: true }];
  composer.draft.parent = 'TS-1';
  assert.match(composer.relationHtml(), /<option value="TS-1" selected>/);
  assert.doesNotMatch(composer.relationHtml(), /data-reject checked/);
  // A new ticket selection updates rejection for that ticket.
  const box = { checked: true };
  composer.el = fakeEl({ '[data-reject]': box });
  const pick = (value) => composer.onChange({ target: { name: '', value, matches: () => true } });
  pick('TS-1');
  assert.equal(box.checked, false);
  pick('TS-9');
  assert.equal(box.checked, true);
  pick('');
  assert.equal(box.checked, false);
});

function composerWith({ submit, fields = {}, note = 'Arreglar el total' } = {}) {
  const calls = [];
  const bar = { edit: (id) => calls.push(['edit', id]), render: () => calls.push(['render']),
                toast: (m, k) => calls.push(['toast', m, k]), defaultDevice: () => 'desktop' };
  const tickets = { list: [], chain: () => null, find: () => null, clearChain: () => calls.push(['clearChain']),
                    load: async () => calls.push(['load']) };
  const drafts = { discard: async () => calls.push(['discard']), save: async () => {} };
  const composer = new Composer(bar, { cfg: CFG, drafts, api: { tickets, submit } }, { id: 'd', kind: 'note', images: [] });
  const error = { hidden: true, textContent: '' };
  composer.el = fakeEl({ '[data-error]': error, ...fields });
  composer.note = { value: note, focus: () => calls.push(['focus']) };
  return { composer, calls, error };
}

test('composer buttons perform their actions only when idle', () => {
  const { composer, calls } = composerWith();
  const click = (act, id) => composer.onClick({ target: { closest: () => ({ dataset: { act, id }, disabled: false }) } });
  click('edit', 'a');
  click('desconocida');
  composer.sending = true;
  click('edit', 'b');
  composer.sending = false;
  composer.onClick({ target: { closest: () => null } });
  composer.onClick({ target: { closest: () => ({ dataset: { act: 'edit', id: 'c' }, disabled: true }) } });
  assert.deepEqual(calls, [['edit', 'a']]);
});

test('empty note warns successful send clears and reloads errors restore button', async () => {
  const empty = composerWith({ note: '   ' });
  assert.equal(empty.composer.send({}), null);
  assert.deepEqual([empty.error.hidden, empty.error.textContent], [false, 'Escribe qué quieres cambiar y dónde.']);

  const sentPayloads = [];
  const ok = composerWith({ submit: async (draft, note, choices) => { sentPayloads.push([note, choices.device]); return { key: 'TS-7' }; } });
  const button = {};
  await ok.composer.send(button);
  assert.deepEqual(sentPayloads, [['Arreglar el total', 'desktop']]);
  assert.deepEqual(ok.calls, [['clearChain'], ['discard'], ['toast', 'Ticket TS-7 levantado. Gracias.', 'ok'], ['load'], ['render']]);

  const failed = composerWith({ submit: async () => { throw new Error('Ya existe.'); } });
  const again = {};
  await failed.composer.send(again);
  assert.deepEqual([again.disabled, again.textContent, failed.composer.sending], [false, 'Levantar ticket', false]);
  assert.deepEqual([failed.error.hidden, failed.error.textContent], [false, 'Ya existe.']);
});

test('options and rejection are read from the form', () => {
  const wrap = { hidden: true };
  const { composer } = composerWith({ fields: {
    'input[name="ts-device"]:checked': { value: 'mobile' }, '[data-parent]': { value: 'TS-1' },
    '[data-reject]': { checked: true }, '[data-reject-wrap]': wrap, '[data-logs]': { checked: true } } });
  composer.tickets.find = () => ({ canApprove: true });
  composer.syncReject();
  assert.equal(wrap.hidden, false);
  assert.deepEqual(composer.choices(), { logs: true, events: false, device: 'mobile', parent: 'TS-1', rejectParent: true });
});

// ------------------------------------------------ arranque y metadatos

test('bar requests are recognized by their prefix', async () => {
  fakeBrowser('https://site.test/pos/');
  const { ownUrlCheck } = await load('app.js');
  const own = ownUrlCheck({ endpoints: { create: '/__ticketshot/tickets/' } });
  assert.equal(own('/__ticketshot/tickets/TS-1/action/'), true);
  assert.equal(own('https://site.test/__ticketshot/images/3/'), true);
  assert.equal(own('/api/customers/'), false);
  assert.equal(own('http://[mal'), false);
});

test('recording and draft changes in another tab appear here', async () => {
  const { LS } = await load('util.js');
  const { onStorage, resumeRecording, storageChange } = await load('app.js');
  assert.equal(storageChange(LS.rec), 'recording');
  assert.equal(storageChange(LS.draft), 'draft');
  assert.equal(storageChange('otra'), null);
  const calls = [];
  // `started` means this tab joined the recording and logs its page once.
  const app = (active, started) => ({ bar: { render: () => calls.push('render') },
    deps: { cfg: { pageToken: 'p' }, recorder: { active: () => active,
      listen: () => { calls.push('listen'); return started; },
      recordPage: (token) => calls.push('page:' + token) } } });
  onStorage(app(true, true), LS.rec);
  onStorage(app(true, false), LS.rec);
  onStorage(app(false, true), LS.rec);
  onStorage(app(true, true), LS.draft);
  onStorage(app(true, true), 'otra');
  assert.deepEqual(calls, ['listen', 'page:p', 'render', 'listen', 'render', 'render', 'render']);
  const cookie = [];
  const recorder = (active, state) => ({ active: () => active, listen: () => cookie.push('listen'),
                                         recordPage: (token) => cookie.push('page:' + token), state: () => state });
  const api = { recordingCookie: { set: (id) => cookie.push('cookie:' + id) } };
  assert.equal(resumeRecording(recorder(false, null), api, 't'), false);
  assert.equal(resumeRecording(recorder(true, { recordingId: 'r1' }), api, 't'), true);
  assert.equal(resumeRecording(recorder(true, {}), api, 'u'), true);
  assert.deepEqual(cookie, ['listen', 'page:t', 'cookie:r1', 'listen', 'page:u']);
});

test('each submitted image carries metadata and marks', async () => {
  const { imageMeta } = await load('api.js');
  const meta = imageMeta({ role: 'step', method: 'dom', pageUrl: '/a/', pageTitle: 'A', pageToken: 't',
                           capturedAt: 'x', offsetMs: 5, ops: [{ t: 'redact' }, { t: 'pen' }] }, 'image_0');
  assert.deepEqual(meta, { field: 'image_0', role: 'step', method: 'dom', pageUrl: '/a/', pageTitle: 'A', pageToken: 't',
                           capturedAt: 'x', offsetMs: 5, caption: '', device: '', edited: true, redactions: 1 });
  const plain = imageMeta({ caption: 'nota', device: 'mobile' }, 'image_1');
  assert.deepEqual([plain.caption, plain.device, plain.edited, plain.redactions], ['nota', 'mobile', false, 0]);
});

test('memory store returns saved data without IndexedDB', async () => {
  const { createStore } = await load('store.js');
  const store = createStore();
  const draft = { id: 'd1', images: [] };
  const blob = { size: 3 };
  await store.put('drafts', draft);
  await store.put('blobs', blob, 'b1');
  assert.equal(await store.get('drafts', 'd1'), draft);
  assert.equal(await store.get('blobs', 'b1'), blob);
  await store.del('blobs', 'b1');
  assert.equal(await store.get('blobs', 'b1'), undefined);
  assert.equal(store.persistent(), false);
});

// ------------------------------------------------ comparar y preguntar

test('comparison starts beside the page changes mode and cycles captures', () => {
  assert.deepEqual(initialCompareState(), { mode: 'side', index: 0, opacity: 50 });
  assert.equal(initialCompareState('over').mode, 'over');
  const start = initialCompareState('side');
  assert.equal(nextCompareState(start, 'over', 3).mode, 'over');
  assert.equal(nextCompareState(start, 'prev', 3).index, 2);
  assert.equal(nextCompareState({ ...start, index: 2 }, 'next', 3).index, 0);
  assert.equal(nextCompareState(start, 'otra', 3), start);
});

test('comparison renders beside or over the page with transparency', () => {
  const ticket = { key: 'TS-1' };
  const images = [{ url: '/i/1/', device: 'mobile' }, { url: '/i/2/' }];
  const side = compareHtml({ mode: 'side', index: 1, opacity: 50 }, ticket, images);
  assert.match(side, /<img alt="Captura original 2 de TS-1" src="\/i\/2\/">/);
  assert.match(text(side), /TS-1 Captura original ‹ 2\/2 ›/);
  const over = compareHtml({ mode: 'over', index: 0, opacity: 30 }, ticket, images);
  assert.match(over, /class="ts-compare-ghost" alt="" src="\/i\/1\/" style="opacity:0.3"/);
  assert.match(text(over), /Captura original · Celular/);
  assert.match(over, /value="30" data-cmp-opacity/);
  assert.doesNotMatch(compareHtml({ mode: 'side', index: 0, opacity: 50 }, ticket, [images[0]]), /data-cmp="next"/);
});

test('question requires text only when requested', () => {
  assert.deepEqual(checkAnswer('  hola  ', {}), { answer: 'hola' });
  assert.deepEqual(checkAnswer('', {}), { answer: '' });
  assert.deepEqual(checkAnswer(' ', { required: true }), { error: 'Escribe algo antes de continuar.' });
  assert.deepEqual(checkAnswer(null, { required: true, requiredText: 'Di qué falla.' }), { error: 'Di qué falla.' });
  const html = askHtml({ title: '<b>', label: 'Nota', ok: 'Listo', text: 'Ayuda' }, 300);
  assert.match(html, /<h2 id="ts-ask-title">&lt;b&gt;<\/h2>/);
  assert.match(html, /maxlength="300"/);
  assert.match(text(html), /Ayuda Nota/);
  assert.doesNotMatch(askHtml({ title: 't', label: 'l', ok: 'o' }, 1), /ts-note/);
});

// ------------------------------------------------ boundary cases

/** Fake node with class, HTML, listeners, and children. */
function fakeNode(fields = {}) {
  const listeners = {};
  return {
    fields, listeners, className: '', innerHTML: '', children: [],
    querySelector: (selector) => fields[selector] || null,
    addEventListener: (type, fn) => { listeners[type] = fn; },
    appendChild(child) { this.children.push(child); return child; },
    remove() { this.removed = true; }
  };
}

async function withDocument(node, fn) {
  const { withGlobals } = await import('./helpers.mjs');
  return withGlobals({ document: { createElement: () => node } }, fn);
}

test('submission preview includes thumbnail and mode buttons', () => {
  assert.match(text(sentHtml({ kind: 'note' }, CFG)), /^También se envía La URL y el título de cada captura\. La vista/);
  const card = cardHtml({ kind: 'note' }, { id: 'a', role: 'manual', pageUrl: '/a/' }, 0);
  assert.match(card, /<img alt="Captura 1" data-thumb="a">/);
  const html = compareHtml({ mode: 'over', index: 0, opacity: 50 }, { key: 'TS-1' }, [{ url: '/i/1/' }]);
  assert.match(html, /<button type="button" class="ts-btn ts-sm" data-cmp="side">A un lado<\/button>/);
  assert.match(html, /<button type="button" class="ts-btn ts-sm ts-on" data-cmp="over">Encima<\/button>/);
});

test('moving the second image makes it first and one mark counts as edited', async () => {
  const images = [{ id: 'a' }, { id: 'b' }];
  assert.equal(moveImageUp(images, 'b'), true);
  assert.deepEqual(images.map((i) => i.id), ['b', 'a']);
  const { imageMeta } = await load('api.js');
  assert.equal(imageMeta({ ops: [{ t: 'pen' }] }, 'image_0').edited, true);
});

test('interface checks work before mounting the bar', async () => {
  const { uiChecks } = await load('app.js');
  const app = { bar: null };
  const checks = uiChecks(app);
  assert.equal(checks.isFromUi({}), false);
  assert.equal(checks.isUiElement({}), false);
  app.bar = { isFromUi: (e) => e.mine, contains: (el) => el.inside };
  assert.equal(checks.isFromUi({ mine: true }), true);
  assert.equal(checks.isUiElement({ inside: false }), false);
});

test('comparison opens changes mode adjusts opacity and closes', async () => {
  const { createCompare } = await load('compare.js');
  const toasts = [];
  const root = fakeNode();
  const ghost = { style: {} };
  const el = fakeNode({ '.ts-compare-ghost': ghost });
  await withDocument(el, () => {
    const compare = createCompare(root, (m, k) => toasts.push([m, k]));
    compare.open({ key: 'TS-1' });
    assert.deepEqual(toasts, [['Este ticket no tiene capturas que puedas ver.', 'error']]);
    compare.open({ key: 'TS-1', images: [{ url: '/i/1/' }] }, 'over');
    assert.equal(el.className, 'ts-compare ts-cmp-mode-over');
    const click = (cmp) => el.listeners.click({ target: { closest: () => (cmp ? { dataset: { cmp } } : null) } });
    click(null);
    click('side');
    assert.equal(el.className, 'ts-compare ts-cmp-mode-side');
    el.listeners.input({ target: { matches: () => false, value: '10' } });
    el.listeners.input({ target: { matches: () => true, value: '30' } });
    assert.equal(ghost.style.opacity, 0.3);
    click('close');
    assert.equal(el.removed, true);
  });
});

test('question validates required text confirms cancels and handles Escape', async () => {
  const { ask } = await load('ask.js');
  const make = () => {
    const input = { value: '', focus() { this.focused = (this.focused || 0) + 1; } };
    const error = { hidden: true, textContent: '' };
    return { node: fakeNode({ '[data-answer]': input, '[data-error]': error }), input, error };
  };
  const click = (node, act) => node.listeners.click({ target: { closest: () => (act ? { dataset: { act } } : null) } });
  const first = make();
  await withDocument(first.node, async () => {
    const answer = ask(fakeNode(), 300, { title: 't', label: 'l', ok: 'o', required: true });
    click(first.node, null);
    click(first.node, 'ok');
    assert.deepEqual([first.error.hidden, first.error.textContent], [false, 'Escribe algo antes de continuar.']);
    first.input.value = '  sigue mal  ';
    click(first.node, 'ok');
    assert.equal(await answer, 'sigue mal');
    assert.equal(first.node.removed, true);
  });
  const second = make();
  await withDocument(second.node, async () => {
    const answer = ask(fakeNode(), 300, { title: 't', label: 'l', ok: 'o' });
    second.node.listeners.keydown({ key: 'a', preventDefault() {} });
    assert.equal(second.node.removed, undefined);
    second.node.listeners.keydown({ key: 'Escape', preventDefault() {} });
    assert.equal(await answer, null);
  });
  const third = make();
  await withDocument(third.node, async () => {
    const answer = ask(fakeNode(), 300, { title: 't', label: 'l', ok: 'o' });
    click(third.node, 'cancel');
    assert.equal(await answer, null);
  });
});

test('composer handles chain keys changes reorder discard and refresh', async () => {
  const { composer, calls } = composerWith();
  composer.tickets.chain = () => ({ key: 'TS-9', reject: true });
  assert.match(composer.relationHtml(), /<option value="TS-9" selected>/);
  assert.match(composer.relationHtml(), /data-reject checked/);
  composer.tickets.chain = () => ({ key: 'TS-9', reject: false });
  assert.doesNotMatch(composer.relationHtml(), /data-reject checked/);
  composer.draft.parent = 'TS-1';
  composer.tickets.list = [{ key: 'TS-1' }];
  assert.match(composer.relationHtml(), /<option value="TS-1" selected>/);
  composer.syncReject();
  // Without a relation selector, there are no open tickets to sync.
  const wrap = { hidden: true };
  composer.el = fakeNode({ '[data-reject-wrap]': wrap });
  composer.syncReject();
  assert.equal(wrap.hidden, true);
  const saved = [];
  composer.drafts.save = async (draft) => { saved.push(draft.device || draft.parent); };
  composer.onChange({ target: { name: 'ts-device', value: 'mobile', matches: () => false } });
  composer.onChange({ target: { name: 'otro', value: 'TS-1', matches: () => true } });
  assert.deepEqual(saved, ['mobile', 'mobile']);
  assert.equal(composer.draft.parent, 'TS-1');
  composer.close = () => calls.push(['close']);
  composer.onKey({ key: 'a', preventDefault() {} });
  assert.equal(calls.filter((c) => c[0] === 'close').length, 0);
  composer.onKey({ key: 'Escape', preventDefault() {} });
  assert.deepEqual(calls.slice(-1), [['close']]);
  composer.refresh = async () => calls.push(['refresh']);
  composer.draft.images = [{ id: 'a' }, { id: 'b' }];
  composer.moveUp('a');
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(calls.filter((c) => c[0] === 'refresh'), []);
  composer.moveUp('b');
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(composer.draft.images.map((i) => i.id), ['b', 'a']);
  assert.deepEqual(calls.filter((c) => c[0] === 'refresh'), [['refresh']]);
  const realConfirm = globalThis.window && globalThis.window.confirm;
  globalThis.window = { ...(globalThis.window || {}), confirm: () => false };
  composer.discard();
  assert.ok(composer.draft);
  globalThis.window.confirm = () => true;
  composer.discard();
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(composer.draft, null);
  assert.deepEqual(calls.slice(-2), [['render'], ['toast', 'Borrador descartado.', undefined]]);
  globalThis.window.confirm = realConfirm;
});

test('refresh without draft closes and send clears errors while waiting', async () => {
  const gone = composerWith();
  gone.composer.drafts.current = async () => null;
  gone.composer.close = () => gone.calls.push(['close']);
  await gone.composer.refresh();
  assert.deepEqual(gone.calls, [['close']]);
  let finish;
  const slow = composerWith({ submit: () => new Promise((resolve) => { finish = resolve; }) });
  slow.error.hidden = false;
  const button = {};
  const sending = slow.composer.send(button);
  assert.deepEqual([slow.error.hidden, button.disabled, button.textContent, slow.composer.sending],
                   [true, true, 'Enviando…', true]);
  finish({ key: 'TS-8' });
  await sending;
});

test('opening composer renders dialog note and event listeners', async () => {
  const { composer, calls } = composerWith();
  const note = { value: '', listeners: {}, addEventListener(t, fn) { this.listeners[t] = fn; }, focus() { this.focused = true; } };
  const grid = { innerHTML: '' };
  const el = fakeNode({ '[data-note]': note, '[data-grid]': grid });
  composer.draft = { id: 'd', kind: 'note', note: 'nota previa', device: '', images: [{ id: 'a', role: 'manual', pageUrl: '/a/' }] };
  composer.drafts.current = async () => composer.draft;
  composer.drafts.fillThumbs = () => calls.push(['thumbs']);
  composer.bar.root = fakeNode();
  await withDocument(el, async () => {
    composer.open();
    await new Promise((r) => setTimeout(r, 0));
  });
  assert.equal(el.className, 'ts-modal');
  assert.match(el.innerHTML, /value="desktop" checked/);
  assert.equal(note.value, 'nota previa');
  assert.equal(note.focused, true);
  assert.deepEqual(Object.keys(el.listeners).sort(), ['change', 'click', 'keydown']);
  assert.match(grid.innerHTML, /data-thumb="a"/);
  assert.equal(composer.bar.root.children[0], el);
});
