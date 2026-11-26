// Editor and bar decision contract without emulating the DOM.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { controls, load, text, withGlobals } from './helpers.mjs';

const { Editor, dominantColor, editorHtml, editorKeyAction, markFromPointer, markIsValid, marksAfterAction,
  markWidth, perimeterPoints, pointFromRect, previewMark, textMark } =
  await load('editor.js');

test('Ctrl Z undoes marks except while typing and Escape cancels without open text', () => {
  const key = (k, extra = {}) => ({ key: k, ctrlKey: false, metaKey: false, shiftKey: false, ...extra });
  assert.equal(editorKeyAction(key('z', { ctrlKey: true }), false, false), 'undo');
  assert.equal(editorKeyAction(key('Z', { metaKey: true, shiftKey: true }), false, false), 'redo');
  assert.equal(editorKeyAction(key('z', { ctrlKey: true }), false, true), null);
  assert.equal(editorKeyAction(key('z'), false, false), null);
  assert.equal(editorKeyAction(key('Escape'), false, false), 'cancel');
  assert.equal(editorKeyAction(key('Escape'), true, false), null);
});
const { Bar, captureDetails, errorMessage, focusTargetForRail, hashAction, railAction, shortcutAction, ticketQuestion } = await load('bar.js');
const { captureAllowed, drawerHtml, miniHtml, railHtml, recordingHtml, shellView, ticketsHtml } = await load('views.js');
const { embeddedInPanel } = await load('util.js');

function editor(tool = 'pen') {
  const instance = Object.create(Editor.prototype);
  instance.tool = tool;
  instance.color = '#e5484d';
  instance.redactColor = 'auto';
  instance.size = 'medio';
  instance.ops = [];
  instance.redo = [];
  instance.canvas = { setPointerCapture() {} };
  instance.point = (event) => event.p;
  instance.scale = () => 2;
  instance.render = () => {};
  instance.sample = () => 'rgb(12,34,56)';
  return instance;
}

test('pointer creates marks with current coordinates width and color', () => {
  for (const [tool, expected] of [
    ['pen', { t: 'pen', color: '#e5484d', w: 8, pts: [[5, 6], [8, 10]] }],
    ['redact-brush', { t: 'redact-brush', color: 'rgb(12,34,56)', w: 52, pts: [[5, 6], [8, 10]] }],
    ['arrow', { t: 'arrow', color: '#e5484d', w: 8, k: 2, x1: 5, y1: 6, x2: 8, y2: 10 }],
    ['box', { t: 'box', color: '#e5484d', w: 8, k: 2, x1: 5, y1: 6, x2: 8, y2: 10 }],
    ['redact', { t: 'redact', color: 'rgb(12,34,56)', w: 8, k: 2, x1: 5, y1: 6, x2: 8, y2: 10 }]
  ]) {
    const e = editor(tool);
    let prevented = false;
    e.down({ p: [5, 6], pointerId: 1, preventDefault: () => { prevented = true; } });
    e.move({ p: [8, 10] });
    e.up();
    assert.equal(prevented, true);
    assert.deepEqual(e.ops, [expected]);
  }
});

test('short taps drop shapes but retain one-point strokes', () => {
  for (const tool of ['arrow', 'box', 'redact']) {
    const e = editor(tool);
    e.down({ p: [5, 6], pointerId: 1, preventDefault() {} });
    e.move({ p: [7, 8] });
    e.up();
    assert.deepEqual(e.ops, []);
  }
  const e = editor('pen');
  e.down({ p: [5, 6], pointerId: 1, preventDefault() {} });
  e.up();
  assert.equal(e.ops[0].pts.length, 1);
});

test('empty text is omitted and confirmed text keeps point size and color', () => {
  const e = editor('text');
  e.textPoint = [10, 20];
  e.textInput = { hidden: false, value: '  Hola  ' };
  e.commitText();
  assert.deepEqual(e.ops, [{ t: 'text', text: 'Hola', x: 10, y: 20, size: 32, color: '#e5484d' }]);
  e.textInput = { hidden: false, value: '  ' };
  e.commitText();
  assert.equal(e.ops.length, 1);
});

test('undo redo and clear preserve history order', () => {
  const e = editor();
  e.ops = [{ t: 'pen', id: 1 }, { t: 'box', id: 2 }, { t: 'arrow', id: 3 }];
  e.action('undo');
  e.action('undo');
  assert.deepEqual(e.ops.map((op) => op.id), [1]);
  assert.deepEqual(e.redo.map((op) => op.id), [3, 2]);
  e.action('redo');
  assert.deepEqual(e.ops.map((op) => op.id), [1, 2]);
  e.action('clear');
  assert.deepEqual(e.ops, []);
  assert.deepEqual(e.redo.map((op) => op.id), [2, 1]);
  e.action('redo');
  assert.deepEqual(e.ops.map((op) => op.id), [1]);
  e.push({ t: 'pen', id: 4 });
  assert.deepEqual(e.redo, []);
  const closed = [];
  e.close = (ops) => closed.push(ops);
  e.action('done');
  e.action('cancel');
  assert.deepEqual(closed, [e.ops, null]);
});

test('closing editor returns marks and caption or nothing on cancel', async () => {
  const { Editor } = await load('editor.js');
  const results = [];
  const make = (caption) => {
    const e = new Editor({ removeEventListener() {} }, { ops: [], caption: 'antes' }, null, 0, 1);
    e.el = { remove() {}, querySelector: () => ({ value: caption }) };
    e.resolve = (value) => results.push(value);
    return e;
  };
  await withGlobals({ URL: { revokeObjectURL() {} } }, () => {
    make('  el total no cuadra  ').close([{ t: 'pen' }]);
    make('x'.repeat(600)).close([]);
    make('se ignora').close(null);
  });
  assert.deepEqual(results[0], { ops: [{ t: 'pen' }], caption: 'el total no cuadra' });
  assert.equal(results[1].caption.length, 500);
  assert.equal(results[2], null);
  // Open with the capture note and a copy of its red marks.
  const marks = [{ t: 'pen' }];
  const opened = new Editor({}, { ops: marks, caption: 'antes' }, null, 0, 1);
  assert.equal(opened.caption, 'antes');
  assert.deepEqual(opened.ops, marks);
  assert.notEqual(opened.ops, marks);
  assert.equal(opened.color, '#e5484d');
  assert.equal(new Editor({}, {}, null, 0, 1).caption, '');
});

test('bar dispatches controls and preserves chosen focus', () => {
  const b = Object.create(Bar.prototype);
  b.drawerOpen = false;
  b.prefs = () => ({ side: 'left' });
  const events = [];
  b.render = (focus) => events.push(['render', focus]);
  b.setPrefs = (patch) => events.push(['prefs', patch]);
  for (const name of ['shot', 'edit', 'compose', 'discard', 'startRecording', 'step', 'stopRecording', 'cancelRecording']) {
    b[name] = (...args) => events.push([name, ...args]);
  }
  b.tickets = { clearChain: () => events.push(['clearChain']) };
  b.ticketAction = (...args) => events.push(['ticket', ...args]);
  const click = (act, data = {}) => b.onClick({ target: { closest: () => ({ disabled: false, dataset: { act, ...data } }) } });
  click('drawer');
  click('close');
  click('restore');
  click('minimize');
  click('side');
  click('shot', { mode: 'full' });
  click('edit', { id: 'i1' });
  for (const act of ['compose', 'discard', 'record', 'step', 'stop', 'cancel-rec', 'chain-cancel']) click(act);
  click('tk-chain', { key: 'TS-1', reject: '1', mode: 'over' });
  assert.deepEqual(events, [
    ['render', '[data-act="close"]'], ['render', '[data-act="drawer"]'],
    ['prefs', { min: false }], ['render', '[data-act="minimize"]'],
    ['prefs', { min: true }], ['render', '[data-act="restore"]'],
    ['prefs', { side: 'right' }], ['render', '[data-act="side"]'],
    ['shot', 'full'], ['edit', 'i1'], ['compose'], ['discard'], ['startRecording'], ['step'], ['stopRecording'],
    ['cancelRecording'], ['clearChain'], ['render', undefined], ['ticket', 'TS-1', 'tk-chain', true, 'over']
  ]);
});

test('comparison and chain hashes use current message and rejection', async () => {
  const b = Object.create(Bar.prototype);
  const events = [];
  b.tickets = { find: (key) => key === 'TS-1' ? { key, canApprove: true } : null,
                setChain: (...args) => events.push(['chain', ...args]) };
  b.compare = { open: (ticket) => events.push(['compare', ticket.key]) };
  b.toast = (...args) => events.push(['toast', ...args]);
  b.render = () => events.push(['render']);
  const history = { replaceState: (...args) => events.push(['replace', ...args]) };
  for (const hash of ['#ticketshot-compare=TS-1', '#ticketshot-compare=TS-9', '#ticketshot-chain=TS-1', '#ticketshot-chain=TS-9']) {
    await withGlobals({ location: { hash, pathname: '/pos/', search: '?a=1' }, history }, () => b.handleHash());
  }
  assert.deepEqual(events, [
    ['replace', null, '', '/pos/?a=1'], ['compare', 'TS-1'],
    ['replace', null, '', '/pos/?a=1'], ['toast', 'TS-9 no está abierto en esta vista.', 'error'],
    ['replace', null, '', '/pos/?a=1'], ['chain', 'TS-1', true], ['render'],
    ['toast', 'Captura la vista para levantar el ticket encadenado a TS-1.'],
    ['replace', null, '', '/pos/?a=1'], ['chain', 'TS-9', false], ['render'],
    ['toast', 'Captura la vista para levantar el ticket encadenado a TS-9.']
  ]);
});

test('permission denial has its own message while other errors keep detail', async () => {
  const b = Object.create(Bar.prototype);
  b.host = { style: { display: 'none' } };
  b.toast = (...args) => messages.push(args);
  const messages = [];
  await withGlobals({ window: { console: null } }, () => {
    b.fail({ name: 'NotAllowedError', message: 'denied' });
    b.fail({ message: 'Sin red' });
    b.fail(null);
  });
  assert.deepEqual(messages, [
    ['El navegador no dio permiso para capturar.', 'error'], ['Sin red', 'error'], ['Algo falló.', 'error']
  ]);
  assert.equal(b.host.style.display, '');
});

test('pure decisions preserve marks history and dominant color', () => {
  assert.deepEqual(markFromPointer('pen', [1, 2], 'rojo', 4, 2, null),
    { t: 'pen', color: 'rojo', w: 4, pts: [[1, 2]] });
  assert.deepEqual(markFromPointer('redact-brush', [1, 2], 'rojo', 20, 2, 'beige'),
    { t: 'redact-brush', color: 'beige', w: 20, pts: [[1, 2]] });
  assert.equal(markIsValid({ t: 'box', x1: 0, y1: 0, x2: 2, y2: 2 }), false);
  assert.equal(markIsValid({ t: 'arrow', x1: 0, y1: 0, x2: 3, y2: 0 }), true);
  assert.equal(markIsValid({ t: 'pen', pts: [[0, 0]] }), true);
  const ops = [{ id: 1 }, { id: 2 }];
  const redo = [{ id: 3 }];
  assert.deepEqual(marksAfterAction(ops, redo, 'undo'), { ops: [{ id: 1 }], redo: [{ id: 3 }, { id: 2 }] });
  assert.deepEqual(marksAfterAction(ops, redo, 'redo'), { ops: [{ id: 1 }, { id: 2 }, { id: 3 }], redo: [] });
  assert.deepEqual(marksAfterAction(ops, redo, 'clear'), { ops: [], redo: [{ id: 2 }, { id: 1 }] });
  assert.deepEqual(ops.map((item) => item.id), [1, 2]);
  assert.equal(dominantColor([]), '#ffffff');
  assert.equal(dominantColor([[250, 248, 240], [251, 249, 242], [0, 0, 0]]), 'rgb(251,249,242)');
  assert.equal(previewMark({ t: 'redact', color: 'beige' }, 'auto').color, 'rgba(120,120,120,0.55)');
  assert.equal(previewMark({ t: 'redact', color: 'beige' }, '#fff').color, 'beige');
});

test('bar decisions cover controls hashes capture and questions', () => {
  assert.deepEqual(railAction('drawer', {}, false, 'left'),
    { kind: 'view', drawerOpen: true, focus: '[data-act="close"]' });
  assert.deepEqual(railAction('side', {}, false, 'right'),
    { kind: 'view', prefs: { side: 'left' }, focus: '[data-act="side"]' });
  assert.deepEqual(railAction('shot', { mode: 'exact' }, false, 'left'),
    { kind: 'call', method: 'shot', value: 'exact' });
  assert.deepEqual(railAction('tk-reject', { key: 'TS-2' }, false, 'left'),
    { kind: 'ticket', key: 'TS-2', act: 'tk-reject', reject: false, mode: undefined });
  assert.equal(railAction('desconocida', {}, false, 'left'), null);
  assert.equal(hashAction('#otro=TS-1', null), null);
  assert.deepEqual(hashAction('#ticketshot-compare=TS-9', null),
    { kind: 'missing', key: 'TS-9', message: 'TS-9 no está abierto en esta vista.' });
  assert.equal(hashAction('#ticketshot-chain=TS-1', { canApprove: true }).reject, true);
  assert.equal(hashAction('#ticketshot-chain=TS-1', null).reject, false);
  assert.deepEqual(captureDetails('', false, 2000, null, 'mobile', { url: '/a', title: 'A', token: 't' }),
    { role: 'manual', method: 'dom', pageUrl: '/a', pageTitle: 'A', pageToken: 't',
      capturedAt: '1970-01-01T00:00:02.000Z', offsetMs: null, device: 'mobile' });
  assert.equal(captureDetails('step', true, 3000, { startedAt: 1000 }, 'desktop',
    { url: '/a', title: 'A', token: 't' }).offsetMs, 2000);
  assert.equal(ticketQuestion('TS-1', 'tk-approve').ok, 'Aprobar');
  assert.equal(ticketQuestion('TS-1', 'tk-reject').required, true);
  assert.equal(errorMessage(null), 'Algo falló.');
  assert.equal(shortcutAction({ altKey: true, shiftKey: true, code: 'KeyS' }, false), 'shot');
  assert.equal(shortcutAction({ altKey: true, shiftKey: true, code: 'KeyS' }, true), 'step');
  assert.equal(shortcutAction({ altKey: true, shiftKey: true, code: 'KeyR' }, false), 'startRecording');
  assert.equal(shortcutAction({ altKey: true, shiftKey: true, code: 'KeyR' }, true), 'stopRecording');
  assert.equal(shortcutAction({ altKey: true, shiftKey: true, code: 'KeyX' }, false), null);
  assert.equal(shortcutAction({ altKey: false, shiftKey: true, code: 'KeyS' }, false), null);
});

test('pure view chooses rail drawer collapsed state and recording', () => {
  const state = { draft: null, drawerOpen: false, chain: null, tickets: [], loaded: true,
    path: '/a', panelUrl: '', maxImages: 4, canExact: false, persistent: true };
  const prefs = { side: 'left', min: false };
  const rail = shellView(state, prefs, null, false, 8, 0);
  assert.equal(rail.className, 'ts-shell ts-left');
  assert.match(rail.html, /data-act="record"/);
  assert.equal(rail.thumbs, false);
  assert.match(shellView({ ...state, drawerOpen: true }, prefs, null, true, 8, 0).html, /ts-drawer/);
  assert.match(shellView(state, { ...prefs, min: true }, null, false, 8, 0).html, /data-act="restore"/);
  const draft = { kind: 'note', images: [{ id: 'i' }] };
  assert.equal(shellView({ ...state, draft }, prefs, null, false, 8, 0).thumbs, true);
  const recording = shellView(state, prefs, { startedAt: 0, steps: 1 }, false, 8, 60000);
  assert.equal(recording.ticking, true);
  assert.match(text(recording.html), /01:00 Grabando Captura 1\/8/);
});

test('editor keyboard handles cancel undo redo and text', () => {
  const e = editor();
  const actions = [];
  e.action = (act) => actions.push(act);
  e.textInput = { hidden: true };
  const event = (key, extra = {}) => ({ key, preventDefault() {}, stopPropagation() {}, ...extra });
  e.handleKey(event('Escape'));
  e.handleKey(event('z', { ctrlKey: true }));
  e.handleKey(event('z', { metaKey: true, shiftKey: true }));
  e.textInput.hidden = false;
  e.handleKey(event('Escape'));
  assert.deepEqual(actions, ['cancel', 'undo', 'redo']);
  e.commitText = () => actions.push('text');
  e.cancelText = () => actions.push('cancelText');
  e.handleTextKey(event('Enter'));
  e.handleTextKey(event('Enter', { shiftKey: true }));
  e.handleTextKey(event('Escape'));
  assert.deepEqual(actions.slice(3), ['text', 'cancelText']);
  const chosen = [];
  e.setTool = (value) => chosen.push(value);
  e.setColor = (value) => chosen.push(value);
  e.handleClick({ target: { closest: () => null } });
  e.handleClick({ target: { closest: () => ({ dataset: { tool: 'box', color: '#fff', act: 'undo' } }) } });
  assert.deepEqual(chosen, ['box', '#fff']);
  assert.equal(actions.at(-1), 'undo');
});

test('render sets view thumbnails and focus without an inactive ticker', async () => {
  const b = Object.create(Bar.prototype);
  const draft = { kind: 'note', images: [{ id: 'i' }] };
  const events = [];
  b.drawerOpen = true;
  b.cfg = { deviceBreakpoint: 700, limits: { recordingSteps: 8, maxImages: 4 }, can: { view: false }, endpoints: {} };
  b.deps = { capture: { canExact: () => false } };
  b.drafts = { current: async () => draft, persistent: () => true,
               fillThumbs: (_shell, images) => events.push(['thumbs', images.length]) };
  b.tickets = { chain: () => null, list: [], loaded: true };
  b.recorder = { active: () => false, stopTicker: () => events.push(['stopTicker']) };
  b.prefs = () => ({ side: 'right', min: false });
  b.shell = { querySelector: () => ({ focus: () => events.push(['focus']) }) };
  await withGlobals({ window: { innerWidth: 600 }, location: { pathname: '/pos/', search: '?x=1' } },
    () => b.render('[data-act="close"]'));
  assert.equal(b.shell.className, 'ts-shell ts-right ts-mobile');
  assert.match(b.shell.innerHTML, /data-act="edit"/);
  assert.match(b.shell.innerHTML, /ts-drawer/);
  assert.deepEqual(events, [['stopTicker'], ['thumbs', 1], ['focus']]);
  b.recorder = { active: () => true, state: () => ({ startedAt: 0, steps: 1 }),
                 startTicker: () => events.push(['startTicker']) };
  await withGlobals({ window: { innerWidth: 900 }, location: { pathname: '/pos/', search: '' } }, () => b.render());
  assert.match(b.shell.innerHTML, /data-act="stop"/);
  assert.equal(events.at(-1)[0], 'startTicker');
});

test('DOM capture attaches page data and releases busy while exact capture hides host', async () => {
  const b = Object.create(Bar.prototype);
  const draft = { id: 'd', images: [] };
  const events = [];
  b.busy = false;
  b.drawerOpen = true;
  b.host = { style: { display: '' } };
  b.cfg = { pageToken: 'p' };
  // Mask every capture title through the bar.
  b.deps = { capture: { dom: async (full) => { events.push(['dom', full]); return 'blob'; },
                        exact: async () => { events.push(['exact', b.host.style.display]); return 'screen'; } },
             mask: { text: (t) => t.replace(/\S+@\S+/g, '•••') } };
  b.drafts = { current: async () => null, create: async (kind) => { events.push(['create', kind]); return draft; },
               addImage: async (_draft, blob, details) => { events.push(['add', blob, details]); return draft; } };
  b.recorder = { state: () => null };
  b.defaultDevice = () => 'desktop';
  b.toast = () => {};
  await withGlobals({ location: { href: 'https://site.test/a' }, document: { title: 'Perfil de ana@site.test' },
    requestAnimationFrame: (fn) => fn() }, async () => {
    await b.capture('full', 'manual', 'note');
    await b.capture('exact', 'step', 'recording');
  });
  assert.deepEqual(events.filter((item) => item[0] === 'add').map((item) => item[2].pageTitle),
                   ['Perfil de •••', 'Perfil de •••']);
  assert.deepEqual(events.slice(0, 2), [['dom', true], ['create', 'note']]);
  assert.deepEqual(events.filter((item) => item[0] === 'exact'), [['exact', 'none']]);
  assert.equal(events.filter((item) => item[0] === 'add')[1][2].method, 'display');
  assert.equal(b.busy, false);
  assert.equal(b.host.style.display, '');
  await assert.rejects(async () => { b.busy = true; await b.capture('visible'); }, /Ya hay una captura/);
});

test('exhausted step warns and failed step restores the counter', async () => {
  const b = Object.create(Bar.prototype);
  const rec = { steps: 2 };
  const events = [];
  b.cfg = { limits: { recordingSteps: 2 } };
  b.busy = false;
  b.recorder = { active: () => true, state: () => rec, save: (s) => events.push(['save', s.steps]),
                 record: () => events.push(['record']) };
  b.drafts = { current: async () => ({ images: [] }) };
  b.toast = (message) => events.push(['toast', message]);
  b.render = () => events.push(['render']);
  b.fail = (error) => events.push(['fail', error.message]);
  b.capture = async () => { throw new Error('Sin pantalla'); };
  await b.step();
  assert.deepEqual(events, [['toast', 'Ya agregaste 2 capturas a esta grabación.']]);
  rec.steps = 1;
  await b.step();
  assert.deepEqual(events.slice(1), [['save', 2], ['render'], ['save', 1], ['render'], ['fail', 'Sin pantalla']]);
});

test('timer updates time and warns once on expiry', () => {
  const b = Object.create(Bar.prototype);
  const events = [];
  const rec = { startedAt: Date.now() - 61000, expired: false };
  const time = { textContent: '' };
  b.shell = { querySelector: () => time };
  b.recorder = { state: () => rec, active: () => events.push('active'),
    expired: () => true, stopTicker: () => events.push('stopTicker') };
  b.render = () => events.push('render');
  b.toast = (message) => events.push(message);
  b.tickRecording();
  assert.equal(time.textContent, '01:01');
  assert.deepEqual(events, ['active', 'render', 'Se alcanzó el tiempo máximo de grabación. Detén para revisar.']);
  b.recorder.state = () => null;
  b.tickRecording();
  assert.deepEqual(events.slice(-2), ['stopTicker', 'render']);
});

test('recording draft stays when user declines discard', async () => {
  const b = Object.create(Bar.prototype);
  let discarded = 0;
  const draft = { images: [{ id: 'i' }] };
  b.drafts = { current: async () => draft, discard: async () => { discarded++; } };
  await withGlobals({ window: { confirm: () => false } }, async () => {
    assert.equal(await b.clearDraftForRecording(), false);
  });
  assert.equal(discarded, 0);
  await withGlobals({ window: { confirm: () => true } }, async () => {
    assert.equal(await b.clearDraftForRecording(), true);
  });
  assert.equal(discarded, 1);
});

test('edit skips absent images reports missing blobs and saves confirmed marks', async () => {
  const b = Object.create(Bar.prototype);
  const errors = [];
  const saved = [];
  const image = { id: 'i1', ops: [] };
  const draft = { images: [image] };
  b.drawerOpen = true;
  b.shell = { hidden: false };
  b.drafts = { current: async () => draft, blob: async () => null, save: async (value) => saved.push(value) };
  b.fail = (error) => errors.push(error.message);
  b.render = async () => {};
  await b.edit('other');
  assert.deepEqual(errors, []);
  await b.edit('i1');
  assert.deepEqual(errors, ['La imagen ya no está en este navegador.']);
  assert.equal(b.shell.hidden, false);
  // Saving does not open the current-page ticket list; tell where to send.
  const toasts = [];
  b.toast = (message) => toasts.push(message);
  b.drawerOpen = false;
  await b.finishEdit(draft, image, { ops: [{ t: 'pen' }], caption: 'el total no cuadra' });
  assert.deepEqual(image.ops, [{ t: 'pen' }]);
  assert.equal(image.caption, 'el total no cuadra');
  assert.deepEqual(saved, [draft]);
  assert.equal(b.drawerOpen, false);
  assert.deepEqual(toasts, ['Captura guardada. Envíala con «Enviar» o sigue capturando.']);
  b.composer = { refresh: () => saved.push('refresh') };
  await b.finishEdit(draft, image, null);
  assert.deepEqual(saved, [draft]);
});

test('ticket actions compare or confirm approval and rejection', async () => {
  const b = Object.create(Bar.prototype);
  const events = [];
  const ticket = { key: 'TS-1' };
  b.drawerOpen = true;
  b.tickets = { find: (key) => key === 'TS-1' ? ticket : null,
    load: async () => events.push('load') };
  b.compare = { open: (_ticket, mode) => events.push(['compare', mode]) };
  b.render = async () => events.push('render');
  b.askAndAct = async (_key, action, prompt) => {
    events.push(['ask', action, prompt.ok]);
    return { message: 'Hecho.' };
  };
  b.toast = (message) => events.push(['toast', message]);
  b.fail = (error) => { throw error; };
  b.ticketAction('TS-9', 'tk-compare', false, 'side');
  b.ticketAction('TS-1', 'tk-compare', false, 'side');
  b.ticketAction('TS-1', 'tk-approve', false);
  await new Promise((resolve) => setImmediate(resolve));
  b.ticketAction('TS-1', 'tk-reject', false);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, [
    'render', ['compare', 'side'], ['ask', 'approve', 'Aprobar'], ['toast', 'Hecho.'], 'load', 'render',
    ['ask', 'reject', 'Rechazar'], ['toast', 'Hecho.'], 'load', 'render'
  ]);
});

test('stop stores events even if final capture fails', async () => {
  const b = Object.create(Bar.prototype);
  const events = [];
  const draft = { images: [] };
  b.recorder = { record: (...args) => events.push(['record', args[0]]),
    mergedEvents: () => [{ type: 'stop' }], end: () => events.push(['end']) };
  b.capture = async () => { throw new Error('Sin pantalla'); };
  b.drafts = { current: async () => draft, save: async () => events.push(['save']) };
  b.deps = { api: { recordingCookie: { clear: () => events.push(['cookie']) } } };
  b.toast = (message) => events.push(['toast', message]);
  b.render = async () => events.push(['render']);
  b.compose = () => events.push(['compose']);
  await b.finishRecording({ startedAt: Date.now() - 1000 });
  assert.deepEqual(draft.events, [{ type: 'stop' }]);
  assert.ok(draft.durationMs >= 1000);
  assert.deepEqual(events.map((item) => typeof item === 'string' ? item : item[0]),
    ['toast', 'record', 'save', 'end', 'cookie', 'render', 'compose']);
});

test('notice expires on schedule and errors last longer', async () => {
  const b = Object.create(Bar.prototype);
  const delays = [];
  const classes = [];
  let removed = 0;
  b.toasts = { appendChild() {} };
  const document = { createElement: () => ({ classList: { add: (name) => classes.push(name) },
    remove: () => { removed++; } }) };
  await withGlobals({ document, setTimeout: (fn, delay) => { delays.push(delay); fn(); } }, () => {
    b.toast('Hola');
    b.toast('Error', 'error');
  });
  assert.deepEqual(delays, [3500, 3900, 6000, 6400]);
  assert.deepEqual(classes, ['ts-out', 'ts-out']);
  assert.equal(removed, 2);
});

test('mark borders and tied colors preserve current result', () => {
  assert.equal(markIsValid({ t: 'box', x1: 9, y1: 8, x2: 7, y2: 5 }), true);
  assert.equal(markIsValid({ t: 'box', x1: 9, y1: 8, x2: 7, y2: 6 }), false);
  assert.deepEqual(markFromPointer('redact-brush', [4, 5], 'rojo', 12, 3, 'beige'),
    { t: 'redact-brush', color: 'beige', w: 12, pts: [[4, 5]] });
  assert.equal(dominantColor([[248, 240, 232], [2, 2, 2]]), 'rgb(248,240,232)');
  assert.equal(dominantColor([[248, 240, 232], [249, 241, 233]]), 'rgb(249,241,233)');
  const e = editor('box');
  assert.deepEqual(e.perimeter({ x: 10, y: 20, w: 8, h: 16 }).slice(0, 4),
    [[10, 14], [10, 42], [4, 20], [24, 20]]);
  assert.equal(e.perimeter({ x: 10, y: 20, w: 8, h: 16 }).length, 36);
});

test('pure editor calculations preserve coordinates perimeter width and text', () => {
  assert.deepEqual(pointFromRect({ clientX: 21.2, clientY: 39.8 },
    { left: 10, top: 20, width: 100 }, 200), [22, 40]);
  assert.deepEqual(perimeterPoints({ x: 10, y: 20, w: 8, h: 16 }, 6).slice(0, 4),
    [[10, 14], [10, 42], [4, 20], [24, 20]]);
  assert.equal(perimeterPoints({ x: 0, y: 0, w: 8, h: 8 }, 2).length, 36);
  assert.equal(markWidth('redact-brush', 'fino', 2), 52);
  assert.equal(markWidth('pen', 'fino', 2), 4);
  assert.equal(markWidth('box', 'fino', 0.1), 1);
  assert.deepEqual(textMark('  Hola  ', [10, 20], 16, 2, 'rojo'),
    { t: 'text', text: 'Hola', x: 10, y: 20, size: 32, color: 'rojo' });
  assert.equal(textMark('   ', [10, 20], 16, 2, 'rojo'), null);
});

test('editor maps coordinates and samples canvas borders', () => {
  const e = editor('redact');
  e.point = Editor.prototype.point;
  e.scale = Editor.prototype.scale;
  e.sample = Editor.prototype.sample;
  e.canvas = { width: 200, clientWidth: 100,
    getBoundingClientRect: () => ({ left: 10, top: 20, width: 100 }) };
  assert.deepEqual(e.point({ clientX: 21.2, clientY: 39.8 }), [22, 40]);
  assert.equal(e.scale(), 2);
  e.sampler = { width: 10, height: 20 };
  const points = [];
  e.samplerCtx = { getImageData: (x, y) => {
    points.push([x, y]);
    return { data: [250, 249, 240] };
  } };
  assert.equal(e.sample([[-5, -2], [20, 30]]), 'rgb(250,249,240)');
  assert.deepEqual(points, [[0, 0], [9, 19]]);
  e.tool = 'redact-brush';
  assert.equal(e.width(), 52);
  e.tool = 'pen';
  e.size = 'fino';
  assert.equal(e.width(), 4);
});

test('text and tool state preserve focus options and marks', async () => {
  const e = editor('text');
  const events = [];
  e.hint = { textContent: '' };
  e.canvas.style = {};
  const buttons = [{ dataset: { tool: 'text', color: '#e5484d' }, setAttribute: (...args) => events.push(args) },
    { dataset: { tool: 'pen', color: '#ffffff' }, setAttribute: (...args) => events.push(args) }];
  const draw = { hidden: false };
  const redact = { hidden: true };
  e.el = { querySelectorAll: () => buttons, querySelector: (selector) => ({
    '.ts-draw-opts': draw, '.ts-redact-opts': redact,
    '.ts-canvas-wrap': { getBoundingClientRect: () => ({ left: 10, top: 20 }) }
  })[selector] };
  e.textInput = { hidden: true, value: 'viejo', style: {}, focus: () => events.push('focus') };
  e.setTool('redact');
  assert.deepEqual([draw.hidden, redact.hidden, e.canvas.style.cursor], [true, false, 'crosshair']);
  e.setTool('text');
  e.setColor('#ffffff');
  assert.equal(e.hint.textContent, 'Toca donde va el texto, escríbelo y pulsa Intro.');
  assert.equal(e.canvas.style.cursor, 'text');
  await withGlobals({ setTimeout: () => {} }, () => e.startText([7, 9], { clientX: 31, clientY: 45 }));
  assert.deepEqual([e.textInput.hidden, e.textInput.value, e.textInput.style.left, e.textInput.style.top],
    [false, '', '21px', '25px']);
  assert.equal(e.textInput.style.fontSize, '16px');
  assert.equal(events.at(-1), 'focus');
  e.textInput.value = ' texto ';
  e.commitText();
  assert.deepEqual(e.ops[0], { t: 'text', text: 'texto', x: 7, y: 9, size: 32, color: '#ffffff' });
});

test('views distinguish limits thumbnails plurals and persistence', () => {
  assert.match(miniHtml(2), /2 abiertos/);
  assert.doesNotMatch(miniHtml(0), /abiertos/);
  assert.equal(captureAllowed({ recording: { steps: 2 }, maxSteps: 2 }).allowed, false);
  assert.equal(captureAllowed({ recording: { steps: 1 }, maxSteps: 2 }).allowed, true);
  const draft = { kind: 'note', images: [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }] };
  const state = { draft, tickets: [], canExact: true, drawerOpen: false, panelUrl: '' };
  const rail = railHtml(state);
  assert.match(rail, /ts-tray-more">\+1</);
  assert.equal(controls(rail).filter((item) => item.startsWith('edit ')).length, 3);
  assert.doesNotMatch(rail, /data-act="record"/);
  const ticket = { key: 'TS-1', status: 'open', statusLabel: 'Abierto', note: 'nota',
    deviceLabel: 'Celular', images: [{ url: '/a.png' }], exact: false, canApprove: false };
  assert.match(text(ticketsHtml([ticket], true, '')), /1 captura · otra URL/);
  assert.match(text(ticketsHtml([{ ...ticket, images: [{ url: '/a.png' }, { url: '/b.png' }], exact: true }], true, '')),
    /2 capturas/);
  assert.doesNotMatch(text(ticketsHtml([{ ...ticket, exact: true }], true, '')), /otra URL/);
  assert.match(drawerHtml({ ...state, path: '/a', loaded: true, persistent: false, chain: null }), /no guarda borradores/);
  assert.doesNotMatch(drawerHtml({ ...state, path: '/a', loaded: true, persistent: true, chain: null }), /no guarda borradores/);
  assert.match(recordingHtml({ steps: 2, startedAt: 0, expired: true }, 2, 1000), /Tiempo agotado/);
});

test('embedded panel requires same origin as top frame', () => {
  const here = { location: { href: 'https://local.test/page' } };
  const top = { location: { href: 'https://local.test/panel/list' } };
  const win = { top, location: here.location };
  assert.equal(embeddedInPanel(win, 'https://local.test/panel'), true);
  assert.equal(embeddedInPanel(win, 'https://externo.test/panel'), false);
  assert.equal(embeddedInPanel({ ...win, top: { location: { href: 'https://externo.test/panel' } } },
    'https://local.test/panel'), false);
  assert.equal(embeddedInPanel(win, ''), false);
  assert.equal(embeddedInPanel({ ...win, top: win }, 'https://local.test/panel'), false);
});

test('pure controls respect exact states and count boundaries', () => {
  assert.deepEqual(markFromPointer('arrow', [4, 9], 'azul', 3, 2, 'beige'),
    { t: 'arrow', color: 'azul', w: 3, k: 2, x1: 4, y1: 9, x2: 4, y2: 9 });
  assert.deepEqual(marksAfterAction([], [{ id: 1 }], 'undo'), { ops: [], redo: [{ id: 1 }] });
  assert.deepEqual(marksAfterAction([{ id: 1 }], [], 'redo'), { ops: [{ id: 1 }], redo: [] });
  assert.deepEqual(marksAfterAction([], [{ id: 1 }], 'clear'), { ops: [], redo: [{ id: 1 }] });
  assert.equal(dominantColor([[8, 16, 24], [0, 16, 24], [8, 16, 24]]), 'rgb(8,16,24)');
  assert.equal(dominantColor([[8, 16, 24], [8, 8, 24], [8, 16, 24]]), 'rgb(8,16,24)');
  assert.equal(dominantColor([[8, 16, 24], [8, 16, 8], [8, 16, 24]]), 'rgb(8,16,24)');
  assert.deepEqual(perimeterPoints({ x: 10, y: 20, w: 16, h: 8 }, 2).slice(-4),
    [[26, 18], [26, 30], [8, 28], [28, 28]]);
  const html = editorHtml(0, 2);
  assert.match(text(html), /Captura 1 de 2/);
  // A capture note can precede marks; the ticket note comes on submit.
  assert.match(html, /<input type="text" data-caption maxlength="500" value=""/);
  assert.match(text(html), /Al enviar el ticket podrás agregar una nota general/);
  assert.match(editorHtml(0, 1, 'el <b>total</b>'), /value="el &lt;b&gt;total&lt;\/b&gt;"/);
  assert.deepEqual(controls(html).filter((item) => item.includes('tool=')).length, 0);
  assert.equal((html.match(/data-tool=/g) || []).length, 6);
  assert.equal((html.match(/data-color=/g) || []).length, 5);
  assert.match(html, /data-act="clear" aria-label="Quitar todo"/);
  assert.deepEqual(railAction('close', {}, true, 'left'),
    { kind: 'view', drawerOpen: false, focus: '[data-act="drawer"]' });
  assert.deepEqual(railAction('minimize', {}, true, 'left'),
    { kind: 'view', drawerOpen: false, prefs: { min: true }, focus: '[data-act="restore"]' });
  assert.equal(focusTargetForRail('drawer'), '[data-act="drawer"]');
  assert.equal(ticketQuestion('TS-4', 'tk-approve').title, 'Aprobar TS-4');
  assert.equal(ticketQuestion('TS-4', 'tk-reject').title, 'TS-4 sigue sin funcionar');
  assert.equal(captureAllowed({ recording: { steps: 0 }, maxSteps: 1 }).allowed, true);
  const state = { draft: { kind: 'note', images: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] },
    tickets: [], canExact: false, drawerOpen: false, panelUrl: '' };
  assert.doesNotMatch(railHtml(state), /ts-tray-more/);
  assert.match(railHtml({ ...state, draft: null }), /class="ts-rail-button ts-record-button" data-act="record"/);
  const rec = recordingHtml({ startedAt: 0, steps: 1 }, 3, 1000);
  assert.match(text(rec), /Captura 1\/3/);
  assert.deepEqual([shellView({ ...state, draft: null }, { side: 'left', min: true }, null, false, 3, 0).thumbs,
    shellView({ ...state, draft: null }, { side: 'left', min: true }, null, false, 3, 0).ticking], [false, false]);
});

test('keyboard distinguishes editable fields and Shift Enter', () => {
  const e = editor();
  e.textInput = { hidden: true };
  const actions = [];
  e.action = (act) => actions.push(act);
  const event = (target) => ({ key: 'z', ctrlKey: true, target, preventDefault() {} });
  e.handleKey(event({ isContentEditable: true, tagName: 'DIV' }));
  e.handleKey(event({ tagName: 'INPUT' }));
  e.handleKey(event({ tagName: 'DIV' }));
  assert.deepEqual(actions, ['undo']);
  e.commitText = () => actions.push('text');
  e.handleTextKey({ key: 'Enter', shiftKey: true, preventDefault() {} });
  assert.deepEqual(actions, ['undo']);
});

test('Escape outside click and width changes preserve focus and bar state', async () => {
  const b = Object.create(Bar.prototype);
  const events = [];
  b.drawerOpen = true;
  b.host = { contains: (value) => value === 'inside' };
  b.shell = { classList: { toggle: (...args) => events.push(['mobile', ...args]) },
    querySelector: () => ({ focus: () => events.push('focus') }) };
  b.root = { querySelector: (selector) => selector === '[role="dialog"]' ? null : null };
  b.compare = { close: () => events.push('closeCompare') };
  b.render = (focus) => events.push(['render', focus]);
  b.cfg = { deviceBreakpoint: 700, position: 'bottom-left' };
  await withGlobals({ window: { innerWidth: 699 } }, () => {
    b.onResize();
    assert.equal(b.defaultDevice(), 'mobile');
    assert.equal(b.contains('inside'), true);
    assert.equal(b.contains('outside'), false);
    assert.equal(b.isFromUi({ composedPath: () => [b.host] }), true);
    assert.equal(b.isFromUi({ composedPath: () => [] }), false);
    b.onOutside({ composedPath: () => [b.host] });
    assert.equal(b.drawerOpen, true);
    b.onOutside({ composedPath: () => [] });
    assert.equal(b.drawerOpen, false);
    b.drawerOpen = true;
    b.onEscape({ key: 'Escape', preventDefault: () => events.push('prevent') });
    assert.equal(b.drawerOpen, false);
    b.root.querySelector = (selector) => selector === '.ts-compare' ? {} : null;
    b.onEscape({ key: 'Escape', preventDefault: () => events.push('prevent') });
  });
  assert.deepEqual(events, [['mobile', 'ts-mobile', true], ['render', undefined],
    ['render', '[data-act="drawer"]'], 'prevent', 'closeCompare', 'focus']);
  await withGlobals({ window: { innerWidth: 700 } }, () => {
    b.onResize();
    assert.equal(b.defaultDevice(), 'desktop');
  });
  assert.deepEqual(events.at(-1), ['mobile', 'ts-mobile', false]);
});

test('preferences and notices retain content and class', async () => {
  const b = Object.create(Bar.prototype);
  b.cfg = { position: 'bottom-left' };
  const saved = new Map();
  const elements = [];
  b.toasts = { appendChild: (el) => elements.push(el) };
  await withGlobals({ localStorage: { getItem: (key) => saved.get(key) ?? null,
    setItem: (key, value) => saved.set(key, value) },
  document: { createElement: () => ({ classList: { add() {} } }) },
  setTimeout: () => {} }, () => {
    assert.deepEqual(b.prefs(), { side: 'left', min: false });
    b.setPrefs({ min: true });
    assert.deepEqual(b.prefs(), { side: 'left', min: true });
    b.toast('Hola', 'ok');
    b.toast('Fallo', 'error');
  });
  assert.deepEqual(elements.map((el) => [el.className, el.textContent]),
    [['ts-toast ts-toast-ok', 'Hola'], ['ts-toast ts-toast-error', 'Fallo']]);
});

test('discard confirms and recording start or close respects busy state', async () => {
  const b = Object.create(Bar.prototype);
  const events = [];
  const draft = { images: [{ id: 'a' }] };
  b.drafts = { current: async () => draft, discard: async () => events.push('discard') };
  b.recorder = { active: () => true, state: () => ({ startedAt: 1 }) };
  b.render = () => events.push('render');
  b.toast = (message) => events.push(message);
  b.finishRecording = async () => events.push('finish');
  b.busy = true;
  b.startRecording();
  b.stopRecording();
  assert.deepEqual(events, []);
  await withGlobals({ window: { confirm: () => false } }, async () => {
    b.discard();
    await new Promise((resolve) => setImmediate(resolve));
  });
  assert.deepEqual(events, []);
  await withGlobals({ window: { confirm: () => true } }, async () => {
    b.discard();
    await new Promise((resolve) => setImmediate(resolve));
  });
  assert.deepEqual(events, ['discard', 'render', 'Borrador descartado.']);
  assert.equal(b.drawerOpen, false);
  b.busy = false;
  b.stopRecording();
  assert.equal(events.at(-1), 'finish');
});

test('start records initial capture with ID and closes bar', async () => {
  const b = Object.create(Bar.prototype);
  const events = [];
  const draft = { id: 'd1', images: [] };
  b.cfg = { pageToken: 'page' };
  b.deps = { api: { recordingCookie: { set: (id) => events.push(['cookie', id]) } } };
  b.drafts = { create: async (kind) => { events.push(['create', kind]); return draft; },
    save: async () => events.push('save') };
  b.recorder = { clearEvents: () => events.push('clear'),
    save: (state) => events.push(['rec', state]),
    listen: () => events.push('listen'),
    record: (...args) => events.push(['record', ...args]),
    recordPage: (token) => events.push(['page', token]),
    // Initial title comes from the recorder after masking.
    pageTitle: () => 'Vista (ocultada)' };
  b.clearDraftForRecording = async () => true;
  b.render = async () => events.push('render');
  b.capture = async (...args) => events.push(['capture', ...args]);
  b.toast = (message) => events.push(['toast', message]);
  b.drawerOpen = true;
  await withGlobals({ document: { title: 'Vista' } }, () => b.beginRecording());
  assert.equal(draft.recordingId, events[2][1]);
  assert.deepEqual(events.map((item) => typeof item === 'string' ? item : item[0]),
    ['create', 'clear', 'cookie', 'rec', 'save', 'listen', 'record', 'page', 'render',
      'capture', 'record', 'toast']);
  assert.deepEqual(events[3][1].draftId, 'd1');
  assert.deepEqual([events[3][1].steps, events[3][1].count], [0, 0]);
  assert.deepEqual(events[6], ['record', 'start', { label: 'Vista (ocultada)' }, true]);
  assert.deepEqual(events[10], ['record', 'capture', { label: 'inicio' }, true]);
  assert.deepEqual(events[9], ['capture', 'visible', 'start', 'recording']);
  assert.equal(b.drawerOpen, false);
});

test('editor ignores secondary button and redaction samples nearby pixels', () => {
  const e = editor('redact-brush');
  const samples = [];
  e.sample = (points) => { samples.push(points); return 'beige'; };
  e.down({ button: 1, p: [8, 9], pointerId: 1, preventDefault() {} });
  assert.equal(e.current, undefined);
  e.down({ button: 0, p: [8, 9], pointerId: 1, preventDefault() {} });
  assert.deepEqual(samples, [[[8, 9], [14, 9], [8, 15], [2, 9]]]);
  assert.equal(e.current.color, 'beige');
  e.up();
  e.redactColor = '#ffffff';
  e.down({ button: 0, p: [4, 5], pointerId: 1, preventDefault() {} });
  assert.equal(e.current.color, '#ffffff');
  assert.equal(samples.length, 1);
  const pen = editor('pen');
  pen.down({ button: 0, p: [4, 5], pointerId: 1, preventDefault() {} });
  assert.equal(pen.current.color, '#e5484d');
});

test('rail capture applies limit saves and opens the new image', async () => {
  const b = Object.create(Bar.prototype);
  const events = [];
  const draft = { kind: 'note', images: [{ id: 'i1' }] };
  b.cfg = { limits: { maxImages: 1 } };
  b.drafts = { current: async () => draft };
  b.toast = (...args) => events.push(['toast', ...args]);
  b.capture = async (...args) => { events.push(['capture', ...args]); return { images: [{ id: 'i2' }] }; };
  b.edit = async (id) => events.push(['edit', id]);
  b.fail = (error) => events.push(['fail', error.message]);
  await b.shot('visible');
  assert.deepEqual(events, [['toast', 'Límite de 1 capturas', 'error']]);
  b.cfg.limits.maxImages = 2;
  await b.shot('full');
  assert.deepEqual(events.slice(1), [['capture', 'full', 'manual', 'note'],
    ['toast', 'Captura 1 guardada.'], ['edit', 'i2']]);
  b.capture = async () => { throw new Error('Sin pantalla'); };
  await b.shot('visible');
  assert.deepEqual(events.at(-1), ['fail', 'Sin pantalla']);
});

test('chains empty composition and canceled recording keep notices', async () => {
  const b = Object.create(Bar.prototype);
  const events = [];
  b.tickets = { setChain: (...args) => events.push(['chain', ...args]) };
  b.render = () => events.push('render');
  b.toast = (...args) => events.push(['toast', ...args]);
  b.startChain('TS-4', false);
  b.startChain('TS-5', true);
  assert.deepEqual(events.filter((item) => Array.isArray(item) && item[0] === 'chain'),
    [['chain', 'TS-4', false], ['chain', 'TS-5', true]]);
  assert.match(events.at(-2)[1], /rechazará TS-5/);
  b.drafts = { current: async () => null, discard: async () => events.push('discard') };
  b.compose();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events.at(-1), ['toast', 'No hay capturas en el borrador.', 'error']);
  assert.equal(b.drawerOpen, false);
  b.drafts.current = async () => ({ images: [] });
  b.compose();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events.at(-1), ['toast', 'No hay capturas en el borrador.', 'error']);
  b.drafts.current = async () => null;
  b.recorder = { end: () => events.push('end') };
  b.deps = { api: { recordingCookie: { clear: () => events.push('cookie') } } };
  await withGlobals({ window: { confirm: () => false } }, async () => {
    b.cancelRecording();
    await new Promise((resolve) => setImmediate(resolve));
  });
  assert.equal(events.includes('end'), false);
  await withGlobals({ window: { confirm: () => true } }, async () => {
    b.cancelRecording();
    await new Promise((resolve) => setImmediate(resolve));
  });
  assert.deepEqual(events.slice(-5), ['end', 'cookie', 'discard', 'render', ['toast', 'Grabación cancelada.']]);
});

test('rail data uses current path and permissions', async () => {
  const b = Object.create(Bar.prototype);
  b.drawerOpen = true;
  b.cfg = { deviceBreakpoint: 700, position: 'bottom-right', can: { view: true },
    endpoints: { panel: '/panel/' }, limits: { recordingSteps: 3, maxImages: 2 } };
  b.tickets = { chain: () => ({ key: 'TS-2' }), list: [{ key: 'TS-2' }], loaded: true };
  b.drafts = { persistent: () => false };
  b.deps = { capture: { canExact: () => true } };
  await withGlobals({ location: { pathname: '/view', search: '?x=1' } }, () => {
    assert.deepEqual(b.viewState(null), { draft: null, drawerOpen: true,
      chain: { key: 'TS-2' }, tickets: [{ key: 'TS-2' }], loaded: true,
      path: '/view?x=1', panelUrl: '/panel/', maxImages: 2, canExact: true, persistent: false });
  });
});

test('bar starts with no busy capture or open drawer', () => {
  const cfg = {};
  const drafts = {};
  const recorder = {};
  const tickets = {};
  const b = new Bar({ cfg, drafts, recorder, api: { tickets } });
  assert.equal(b.busy, false);
  assert.equal(b.drawerOpen, false);
  assert.equal(b.composer, null);
  assert.equal(b.tickets, tickets);
});

test('redo with multiple marks preserves stack and full control drawing', () => {
  const first = { id: 1 };
  const second = { id: 2 };
  const third = { id: 3 };
  assert.deepEqual(marksAfterAction([first], [second, third], 'redo'),
    { ops: [first, third], redo: [second] });
  const html = editorHtml(1, 3);
  assert.equal((html.match(/class="ts-tool(?: ts-tool-redact)?"/g) || []).length, 9);
  assert.equal((html.match(/aria-pressed="false"/g) || []).length, 11);
  assert.match(text(html), /Captura 2 de 3/);
  const rec = shellView({ tickets: [] }, { side: 'right' },
    { startedAt: 0, steps: 1 }, false, 3, 1000);
  assert.equal(rec.thumbs, false);
  assert.equal(rec.ticking, true);
  assert.match(rec.html, /^<div class="ts-dock"><div class="ts-rail ts-rail-recording"/);
  const own = { location: { href: 'https://local.test/panel/list' } };
  own.top = own;
  assert.equal(embeddedInPanel(own, 'https://local.test/panel'), false);
});

test('editor buttons announce selected tool and color', () => {
  const e = editor();
  const selected = [];
  const toolButtons = ['pen', 'redact'].map((tool) => ({
    dataset: { tool }, setAttribute: (_name, value) => selected.push([tool, value]) }));
  const colorButtons = ['#e5484d', '#ffffff'].map((color) => ({
    dataset: { color }, setAttribute: (_name, value) => selected.push([color, value]) }));
  const draw = { hidden: false };
  const redact = { hidden: true };
  e.hint = { textContent: '' };
  e.canvas.style = {};
  e.el = { querySelectorAll: (selector) => selector === '[data-tool]' ? toolButtons : colorButtons,
    querySelector: (selector) => ({ '.ts-draw-opts': draw, '.ts-redact-opts': redact })[selector] };
  e.setTool('redact');
  e.setColor('#ffffff');
  assert.deepEqual(selected, [['pen', 'false'], ['redact', 'true'],
    ['#e5484d', 'false'], ['#ffffff', 'true']]);
  assert.deepEqual([draw.hidden, redact.hidden], [true, false]);
  e.textInput = { hidden: false, value: 'hola' };
  e.cancelText();
  assert.equal(e.textInput.hidden, true);
});

test('sampling separates axes and requests one image pixel', () => {
  const e = editor('redact');
  e.sample = Editor.prototype.sample;
  e.sampler = { width: 20, height: 30 };
  const calls = [];
  e.samplerCtx = { getImageData: (...args) => {
    calls.push(args);
    return { data: [11, 22, 33] };
  } };
  assert.equal(e.sample([[3, 8], [0, 29]]), 'rgb(11,22,33)');
  assert.deepEqual(calls, [[3, 8, 1, 1], [0, 29, 1, 1]]);
});

test('text hides input on confirm and ignores other keys', async () => {
  const e = editor('text');
  e.textInput = { hidden: false, value: 'Hola' };
  e.textPoint = [5, 7];
  e.handleTextKey({ key: 'a', shiftKey: false, preventDefault() {} });
  assert.equal(e.ops.length, 0);
  e.commitText();
  assert.equal(e.textInput.hidden, true);
  assert.equal(e.ops[0].text, 'Hola');
  const delayed = [];
  e.el = { querySelector: () => ({ getBoundingClientRect: () => ({ left: 0, top: 0 }) }) };
  e.textInput = { hidden: true, value: '', style: {}, focus() {} };
  await withGlobals({ setTimeout: (_fn, ms) => delayed.push(ms) },
    () => e.startText([1, 2], { clientX: 3, clientY: 4 }));
  assert.deepEqual(delayed, [0]);
});

test('editor HTML identifies redaction tools and keeps icons', () => {
  const html = editorHtml(0, 1);
  assert.equal((html.match(/class="ts-tool ts-tool-redact"/g) || []).length, 2);
  assert.doesNotMatch(html, /undefined/);
  assert.match(html, /data-tool="redact-brush"/);
});

test('dominant color distinguishes red and green changes when grouping pixels', () => {
  assert.equal(dominantColor([[8, 16, 24], [16, 16, 24]]), 'rgb(8,16,24)');
  assert.equal(dominantColor([[8, 16, 24], [8, 24, 24]]), 'rgb(8,16,24)');
});

test('rectangle redaction samples only after drawing ends', () => {
  const e = editor('redact');
  const sampled = [];
  e.sample = (points) => { sampled.push(points); return 'beige'; };
  e.down({ p: [4, 5], pointerId: 1, preventDefault() {} });
  assert.deepEqual(sampled, []);
  e.move({ p: [10, 15] });
  e.up();
  assert.equal(sampled.length, 1);
});

test('mounting bar registers keys and pointer during capture', async () => {
  const b = Object.create(Bar.prototype);
  const listeners = [];
  const root = { appendChild() {} };
  const element = () => ({ style: {}, setAttribute() {}, appendChild() {},
    attachShadow: () => root, addEventListener: (...args) => listeners.push(args) });
  const document = { createElement: element,
    documentElement: { appendChild() {} },
    addEventListener: (...args) => listeners.push(args) };
  b.cfg = { assets: { css: '/ticketshot.css' } };
  b.toast = () => {};
  await withGlobals({ document, window: { addEventListener: (...args) => listeners.push(args) } },
    () => b.mount());
  assert.deepEqual(listeners.filter((item) => item[0] === 'keydown').map((item) => item[2]), [true, true]);
  assert.equal(listeners.find((item) => item[0] === 'pointerdown')[2], true);
  assert.equal(listeners.find((item) => item[0] === 'resize')[2], undefined);
  assert.equal(b.shell.className, 'ts-shell');
});

test('permission error is not logged and ordinary failure resets capture', async () => {
  const b = Object.create(Bar.prototype);
  const messages = [];
  const logs = [];
  b.host = { style: { display: 'none' } };
  b.toast = (...args) => messages.push(args);
  b.busy = true;
  await withGlobals({ window: { console: true },
    console: { info: (...args) => logs.push(args) } }, () => {
    b.fail({ name: 'NotAllowedError', message: 'denied' });
    b.fail({ name: 'NetworkError', message: 'Sin red' });
  });
  assert.deepEqual(messages, [
    ['El navegador no dio permiso para capturar.', 'error'],
    ['Sin red', 'error']]);
  assert.deepEqual(logs.map((item) => item[0]), ['[ticketshot]']);
  assert.equal(logs[0][1].name, 'NetworkError');
  assert.equal(b.busy, false);
  assert.equal(b.host.style.display, '');
});

test('missing focus does not break Escape or render and expiry warns once', async () => {
  const b = Object.create(Bar.prototype);
  const events = [];
  b.drawerOpen = false;
  b.root = { querySelector: (selector) => selector === '.ts-compare' ? {} : null };
  b.shell = { querySelector: () => null };
  b.compare = { close: () => events.push('close') };
  b.onEscape({ key: 'Escape', preventDefault: () => events.push('prevent') });
  assert.deepEqual(events, ['prevent', 'close']);
  b.cfg = { deviceBreakpoint: 700, can: { view: false }, endpoints: {},
    limits: { recordingSteps: 3, maxImages: 2 } };
  b.deps = { capture: { canExact: () => false } };
  b.drafts = { current: async () => null, persistent: () => true };
  b.tickets = { chain: () => null, list: [], loaded: true };
  b.recorder = { active: () => false, stopTicker: () => events.push('stop') };
  b.prefs = () => ({ side: 'right', min: false });
  await withGlobals({ window: { innerWidth: 700 },
    location: { pathname: '/', search: '' } }, () => b.render('[data-act="close"]'));
  assert.equal(b.shell.className, 'ts-shell ts-right');
  const rec = { startedAt: Date.now() - 1000, expired: true };
  b.recorder = { state: () => rec, expired: () => true };
  b.toast = () => events.push('toast');
  b.render = () => events.push('render');
  b.tickRecording();
  assert.deepEqual(events, ['prevent', 'close', 'stop']);
});

test('discard and chain text include correct count and key', async () => {
  const b = Object.create(Bar.prototype);
  const prompts = [];
  const messages = [];
  const draft = { images: [{ id: 'a' }, { id: 'b' }] };
  b.drafts = { current: async () => draft, discard: async () => {} };
  b.recorder = {};
  b.tickets = { setChain() {} };
  b.render = () => {};
  b.toast = (message) => messages.push(message);
  await withGlobals({ window: { confirm: (message) => { prompts.push(message); return false; } } }, async () => {
    b.discard();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(await b.clearDraftForRecording(), false);
  });
  assert.deepEqual(prompts, [
    '¿Descartar el borrador con 2 capturas? No se puede deshacer.',
    'Hay un borrador con 2 capturas. ¿Descartarlo para grabar?'
  ]);
  b.startChain('TS-4', false);
  b.startChain('TS-5', true);
  assert.deepEqual(messages, [
    'Captura la vista: el ticket nuevo se encadenará a TS-4.',
    'Captura la vista como se ve ahora: el ticket nuevo rechazará TS-5.'
  ]);
});

test('Escape leaves dialog intact and returns focus to drawer on close', async () => {
  const b = Object.create(Bar.prototype);
  const events = [];
  b.drawerOpen = true;
  let dialog = true;
  b.root = { querySelector: (selector) => selector === '[role="dialog"]' && dialog ? {} : null };
  b.shell = { querySelector: () => ({ focus: () => events.push('focus') }) };
  b.render = () => events.push('render');
  b.onEscape({ key: 'Escape' });
  await Promise.resolve();
  assert.deepEqual(events, []);
  dialog = false;
  b.focusDrawerAfterDialog();
  assert.deepEqual(events, ['focus']);
  b.drawerOpen = false;
  b.focusDrawerAfterDialog();
  assert.deepEqual(events, ['focus']);
  b.drawerOpen = true;
  b.shell.querySelector = () => null;
  b.focusDrawerAfterDialog();
  assert.deepEqual(events, ['focus']);
});

test('disabled click does nothing and close preserves drawer state', () => {
  const b = Object.create(Bar.prototype);
  const events = [];
  b.drawerOpen = true;
  b.render = (focus) => events.push(focus);
  b.onClick({ target: { closest: () => null } });
  b.onClick({ target: { closest: () => ({ disabled: true, dataset: { act: 'close' } }) } });
  assert.equal(b.drawerOpen, true);
  b.onClick({ target: { closest: () => ({ disabled: false, dataset: { act: 'close' } }) } });
  assert.equal(b.drawerOpen, false);
  assert.deepEqual(events, ['[data-act="drawer"]']);
});

test('capture marks busy and closes drawer before requesting image', async () => {
  const b = Object.create(Bar.prototype);
  const seen = [];
  b.busy = false;
  b.drawerOpen = true;
  b.host = { style: { display: '' } };
  b.cfg = { pageToken: 'p' };
  b.deps = { capture: { dom: async () => {
    seen.push([b.busy, b.drawerOpen, b.host.style.display]);
    return 'blob';
  } }, mask: { text: (t) => t } };
  b.drafts = { current: async () => ({ id: 'd', images: [] }),
    addImage: async (_draft, _blob, details) => details };
  b.recorder = { state: () => null };
  b.defaultDevice = () => 'desktop';
  b.toast = () => {};
  await withGlobals({ location: { href: 'https://local.test/a' },
    document: { title: 'A' } }, () => b.capture('visible'));
  assert.deepEqual(seen, [[true, false, '']]);
  assert.equal(b.busy, false);
});

test('recording limit restores exactly one step even when state is zero', async () => {
  const b = Object.create(Bar.prototype);
  const events = [];
  const rec = { steps: 0 };
  b.recorder = { state: () => rec, save: (state) => events.push(state.steps) };
  b.capture = async () => { throw new Error('Fallo'); };
  b.render = () => events.push('render');
  b.fail = (error) => events.push(error.message);
  await b.captureStep(rec, 3);
  assert.deepEqual(events, [0, 'render', 'Fallo']);
  rec.steps = 2;
  await b.captureStep(rec, 3);
  assert.deepEqual(events.slice(-3), [1, 'render', 'Fallo']);
});

test('lost capture keeps rail visible and closes drawer', async () => {
  const b = Object.create(Bar.prototype);
  const events = [];
  b.root = {};
  b.cfg = { limits: { noteLength: 100 } };
  b.tickets = { action: (...args) => events.push(args) };
  const draft = { images: [{ id: 'i' }] };
  b.drafts = { current: async () => draft, blob: async () => null };
  b.shell = { hidden: false };
  b.fail = (error) => events.push(error.message);
  b.drawerOpen = true;
  await b.edit('i');
  assert.equal(b.drawerOpen, false);
  assert.equal(b.shell.hidden, false);
  assert.deepEqual(events, ['La imagen ya no está en este navegador.']);
  b.drafts.current = async () => null;
  await b.edit('i');
  assert.deepEqual(events, ['La imagen ya no está en este navegador.']);
});

test('capture without draft creates note and attaches view metadata', async () => {
  const b = Object.create(Bar.prototype);
  const events = [];
  b.busy = false;
  b.host = { style: { display: '' } };
  b.cfg = { pageToken: 'p' };
  b.deps = { capture: { dom: async () => 'blob' }, mask: { text: (t) => t } };
  b.drafts = { current: async () => null,
    create: async (kind) => { events.push(['create', kind]); return { id: 'd' }; },
    addImage: async (_draft, blob, details) => {
      events.push(['add', blob, details]);
      return 'ok';
    } };
  b.recorder = { state: () => null };
  b.defaultDevice = () => 'desktop';
  b.toast = () => {};
  await withGlobals({ document: { title: 'Página' },
    location: { href: 'https://local.test/a' } }, () => b.capture('visible'));
  assert.deepEqual(events[0], ['create', 'note']);
  assert.deepEqual(events[1][2].pageUrl, 'https://local.test/a');
  assert.equal(events[1][2].pageTitle, 'Página');
});

test('comparing ticket closes drawer and chain hash reopens it', async () => {
  const b = Object.create(Bar.prototype);
  const events = [];
  const ticket = { key: 'TS-1', canApprove: true };
  b.tickets = { find: (key) => key === 'TS-1' ? ticket : null,
    setChain: (...args) => events.push(['chain', ...args]) };
  b.compare = { open: () => events.push(['compare', b.drawerOpen]) };
  b.render = () => events.push('render');
  b.toast = () => {};
  b.drawerOpen = true;
  b.ticketAction('TS-1', 'tk-compare', false, 'side');
  assert.deepEqual(events.slice(0, 2), ['render', ['compare', false]]);
  const history = { replaceState() {} };
  await withGlobals({ location: { hash: '#ticketshot-chain=TS-1',
    pathname: '/', search: '' }, history }, () => b.handleHash());
  assert.equal(b.drawerOpen, true);
  assert.deepEqual(events.at(-2), ['chain', 'TS-1', true]);
});

test('stop preserves exact duration and capture error detail', async () => {
  const b = Object.create(Bar.prototype);
  const events = [];
  const draft = { images: [] };
  b.capture = async () => { throw new Error('No hay pantalla'); };
  b.recorder = { record: (...args) => events.push(args), mergedEvents: () => [], end() {} };
  b.drafts = { current: async () => draft, save: async () => {} };
  b.deps = { api: { recordingCookie: { clear() {} } } };
  b.toast = (...args) => events.push(args);
  b.render = async () => {};
  b.compose = () => {};
  await withGlobals({ Date: class extends Date { static now() { return 5000; } } },
    () => b.finishRecording({ startedAt: 1000 }));
  assert.deepEqual(events, [
    ['No se pudo tomar la captura final: No hay pantalla', 'error'],
    ['stop', { label: 'Detenida' }, true]
  ]);
  assert.equal(draft.durationMs, 4000);
});

test('step ignores missing recording or busy bar and restores failed step', async () => {
  const b = Object.create(Bar.prototype);
  const events = [];
  const rec = { steps: 0 };
  b.cfg = { limits: { recordingSteps: 2 } };
  b.recorder = { active: () => events.push('active'), state: () => rec,
    save: (state) => events.push(['save', state.steps]),
    record: (...args) => events.push(['record', ...args]) };
  b.drafts = { current: async () => ({ images: [] }) };
  b.render = () => events.push('render');
  b.capture = async () => events.push('capture');
  b.toast = (...args) => events.push(['toast', ...args]);
  b.fail = (error) => events.push(['fail', error.message]);
  b.busy = true;
  await b.step();
  assert.deepEqual(events, ['active']);
  b.busy = false;
  b.recorder.state = () => null;
  await b.step();
  assert.deepEqual(events, ['active', 'active']);
  b.recorder.state = () => rec;
  await b.step();
  assert.deepEqual(events.slice(2), ['active', ['save', 1], 'render', 'capture',
    ['record', 'capture', { label: 'paso 1' }, true], ['toast', 'Captura 1 de 2 guardada.']]);
  b.capture = async () => { throw new Error('Sin pantalla'); };
  await b.step();
  assert.deepEqual(events.slice(-6), ['active', ['save', 2], 'render', ['save', 1], 'render', ['fail', 'Sin pantalla']]);
});

test('panel hash links compare or chain even after the hash is cleared', async () => {
  const done = [];
  const bar = Object.create(Bar.prototype);
  bar.tickets = { find: (key) => (key === 'TS-3' ? { key: 'TS-3', canApprove: true, images: [{}] } : null),
                  setChain: (key, reject) => done.push(['chain', key, reject]) };
  bar.compare = { open: (ticket) => done.push(['compare', ticket.key]) };
  bar.toast = (message, kind) => done.push(['toast', kind || '']);
  bar.render = () => done.push(['render']);
  const loc = { hash: '', pathname: '/page/', search: '' };
  const history = { replaceState: () => { loc.hash = ''; } };
  await withGlobals({ location: loc, history }, () => {
    loc.hash = '#ticketshot-compare=TS-3';
    bar.handleHash();
    loc.hash = '#ticketshot-chain=TS-3';
    bar.handleHash();
    loc.hash = '#ticketshot-compare=TS-99';
    bar.handleHash();
    loc.hash = '#otra-cosa';
    bar.handleHash();
  });
  assert.deepEqual(done, [['compare', 'TS-3'], ['chain', 'TS-3', true], ['render'], ['toast', ''], ['toast', 'error']]);
  assert.equal(bar.drawerOpen, true);
  assert.equal(loc.hash, '#otra-cosa');
});
