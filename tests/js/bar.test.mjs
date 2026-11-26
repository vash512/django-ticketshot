// Pure bar component tests: node --test tests/js/
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { controls, dir, fakeBrowser, fakeStore, load, reply, text, withClock, withFetch, withGlobals,
         withQuietConsole } from './helpers.mjs';


const { rectOf, redactionCount } = await load('draw.js');
const { mergeLogs } = await load('logs.js');
const { maskedTitle, maskText } = await load('mask.js');
const { clock, embeddedInPanel, esc, recordedUrl, relUrl, shorten } = await load('util.js');
const { captureAllowed, drawerHtml, escapeTarget, miniHtml, railHtml, recordingHtml, ticketsHtml } = await load('views.js');
const { Bar, focusTargetForRail } = await load('bar.js');
const { t, setLanguage } = await load('i18n.js');

test('bar strings follow language and fall back to English', () => {
  setLanguage('en');
  assert.equal(t('Send'), 'Send');
  assert.equal(t('Unmapped phrase'), 'Unmapped phrase');
  setLanguage('fr');
  assert.equal(t('Send'), 'Send');
  setLanguage('es');
  assert.equal(t('Send'), 'Enviar');
  assert.equal(t('Unmapped phrase'), 'Unmapped phrase');
});

test('drawer and rail choose the focus target', () => {
  assert.equal(focusTargetForRail('drawer', true), '[data-act="close"]');
  assert.equal(focusTargetForRail('drawer', false), '[data-act="drawer"]');
  assert.equal(focusTargetForRail('close'), '[data-act="drawer"]');
  assert.equal(focusTargetForRail('minimize'), '[data-act="restore"]');
  assert.equal(focusTargetForRail('restore'), '[data-act="minimize"]');
  assert.equal(focusTargetForRail('side'), '[data-act="side"]');
});

test('Escape preserves focus in a dialog above the drawer', async () => {
  assert.equal(escapeTarget({ drawerOpen: true, dialogOpen: true }), 'dialog');
  assert.equal(escapeTarget({ drawerOpen: true, compareOpen: true }), 'compare');
  assert.equal(escapeTarget({ drawerOpen: true }), 'drawer');
  assert.equal(escapeTarget({ drawerOpen: false }), null);

  const listeners = [];
  let dialogOpen = true;
  let compareOpen = false;
  let focused = 'dialog';
  const root = { appendChild() {}, querySelector: (selector) =>
    (selector === '[role="dialog"]' && dialogOpen) ||
    (selector === '.ts-compare' && compareOpen) ? {} : null };
  const element = () => ({ style: {}, setAttribute() {}, addEventListener() {}, appendChild() {},
                          attachShadow: () => root,
                          querySelector: (selector) => selector === '[data-act="close"]'
                            ? { focus: () => { focused = 'drawer'; } } : null });
  const doc = { createElement: element, documentElement: { appendChild() {} },
                addEventListener: (type, fn, capture) => listeners.push({ type, fn, capture }) };
  await withGlobals({ document: doc, window: { addEventListener() {} } }, async () => {
    const bar = Object.create(Bar.prototype);
    bar.cfg = { assets: { css: '/bar.css' } };
    bar.drawerOpen = true;
    bar.render = () => assert.fail('Escape del diálogo no debe redibujar el cajón');
    bar.mount();
    const escape = listeners.filter(({ type, capture }) => type === 'keydown' && capture).at(-1).fn;
    escape({ key: 'Escape' });
    assert.equal(bar.drawerOpen, true);
    assert.equal(focused, 'dialog');
    dialogOpen = false;
    focused = null;
    await Promise.resolve();
    assert.equal(bar.drawerOpen, true);
    assert.equal(focused, 'drawer');

    compareOpen = true;
    focused = 'compare';
    bar.compare.close = () => { compareOpen = false; };
    let prevented = false;
    escape({ key: 'Escape', preventDefault: () => { prevented = true; } });
    assert.equal(prevented, true);
    assert.equal(compareOpen, false);
    assert.equal(bar.drawerOpen, true);
    assert.equal(focused, 'drawer');
  });
});
const { editorHtml } = await load('editor.js');

const BASE = 'https://site.test/pos/';

test('bar hides only inside the same-origin top panel', () => {
  const panelUrl = '/__ticketshot/panel/';
  const frame = { location: { href: BASE } };
  frame.top = frame;
  assert.equal(embeddedInPanel(frame, panelUrl), false);

  frame.top = { location: { href: 'https://site.test/__ticketshot/panel/queue/?ticket=TS-1' } };
  assert.equal(embeddedInPanel(frame, panelUrl), true);
  frame.top = { location: { href: 'https://site.test/__ticketshot/panel/' } };
  assert.equal(embeddedInPanel(frame, panelUrl), true);

  frame.top = { location: { href: 'https://site.test/other-page/' } };
  assert.equal(embeddedInPanel(frame, panelUrl), false);

  frame.top = { location: { href: 'https://otro.test/__ticketshot/panel/queue/' } };
  assert.equal(embeddedInPanel(frame, panelUrl), false);

  frame.top = { get location() { throw new Error('SecurityError'); } };
  assert.equal(embeddedInPanel(frame, panelUrl), false);

  frame.top = { location: { href: 'https://site.test/__ticketshot/panel/queue/' } };
  assert.equal(embeddedInPanel(frame, undefined), false);
});

test('recorder stores paths and parameter names without values', () => {
  assert.equal(recordedUrl('/search/?q=Ana+Pérez&page=2&q=otra', BASE), '/search/?q=…&page=…');
  assert.equal(recordedUrl('/search/', BASE), '/search/');
  assert.equal(recordedUrl('https://otro.test/x?token=abc', BASE), 'https://otro.test/x?token=…');
  assert.equal(recordedUrl('/pos/#tab', BASE), '/pos/');
});

test('relUrl makes same-origin URLs relative', () => {
  assert.equal(relUrl('https://site.test/a/?b=1#c', BASE), '/a/?b=1#c');
  assert.equal(relUrl('https://otro.test/a', BASE), 'https://otro.test/a');
});

test('masking hides email and phone but preserves dates and prices', () => {
  const patterns = ['email', 'phone'];
  assert.equal(maskText('escribe a ana@correo.mx', patterns), 'escribe a ••••••••••••');
  assert.equal(maskText('tel 55 1234 5678', patterns), 'tel ••••••••••••');
  assert.equal(maskText('2026-11-07 10:30', patterns), '2026-11-07 10:30');
  assert.equal(maskText('Total $1,250.00', patterns), 'Total $1,250.00');
  assert.equal(maskText('ana@correo.mx', []), 'ana@correo.mx');
  assert.equal(maskText('tel 55 1234 5678 o ana@correo.mx', ['phone']), 'tel •••••••••••• o ana@correo.mx');
});

test('bar masking agrees with shared server cases', async () => {
  const { readFile } = await import('node:fs/promises');
  const { cases } = JSON.parse(await readFile(new URL('../fixtures/mask_cases.json', import.meta.url), 'utf8'));
  assert.ok(cases.length >= 10);
  for (const c of cases) assert.equal(maskText(c.text, c.patterns), c.expected, c.text);
});

test('long text without an at sign masks in linear time', () => {
  // Long text without an at sign must not stall capture.
  const started = performance.now();
  maskText('a'.repeat(200000), ['email', 'phone']);
  assert.ok(performance.now() - started < 2000);
});

test('stored page title is masked', async () => {
  const mask = { text: (t) => maskText(t, ['email']) };
  await withGlobals({ document: { title: 'Resultados para ana@correo.mx' } }, () => {
    assert.equal(maskedTitle(mask), 'Resultados para ••••••••••••');
  });
  await withGlobals({ document: { title: '' } }, () => {
    assert.equal(maskedTitle(mask), '');
  });
});

test('esc escapes HTML-breaking characters', () => {
  assert.equal(esc('<a href="x">\'&'), '&lt;a href=&quot;x&quot;&gt;&#39;&amp;');
  assert.equal(esc(null), '');
});

test('clock and shorten', () => {
  assert.equal(clock(65500), '01:05');
  assert.equal(clock(-5), '00:00');
  assert.equal(shorten('abcdef', 4), 'abc…');
  assert.equal(shorten('abc', 4), 'abc');
  assert.equal(shorten('abcd', 4), 'abcd');
});

test('rectangle normalizes reverse dragging', () => {
  assert.deepEqual(rectOf({ x1: 10, y1: 30, x2: 4, y2: 10 }), { x: 4, y: 10, w: 6, h: 20 });
});

test('only redaction marks count as hidden', () => {
  assert.equal(redactionCount([{ t: 'pen' }, { t: 'redact' }, { t: 'redact-brush' }, { t: 'box' }]), 2);
  assert.equal(redactionCount(undefined), 0);
});

test('logs merge without duplicates within a limit', () => {
  const a = { at: 1, type: 'console', message: 'x' };
  const b = { at: 2, type: 'network', url: '/a', status: 200 };
  assert.deepEqual(mergeLogs([a], [a, b]), [a, b]);
  const many = Array.from({ length: 400 }, (_, i) => ({ at: i, type: 'console' }));
  assert.equal(mergeLogs(many, []).length, 300);
});


const VIEW = { draft: null, drawerOpen: false, chain: null, tickets: [], loaded: true,
               path: '/pos/?tab=1', panelUrl: '/panel/', maxImages: 4, canExact: true, persistent: true };
const TICKET = { key: 'TS-1', status: 'in_review', statusLabel: 'Por revisar', deviceLabel: 'Escritorio',
                 note: '<b>hola</b>', exact: true, canApprove: true,
                 images: [{ url: '/img/1/' }], detailUrl: '/panel/TS-1/' };

test('capture decision shares limits across recording and draft', () => {
  const rec = { startedAt: 1, steps: 2 };
  assert.deepEqual(captureAllowed({ recording: rec, maxSteps: 3 }), { allowed: true, reason: '' });
  assert.deepEqual(captureAllowed({ recording: { ...rec, steps: 3 }, maxSteps: 3 }),
    { allowed: false, reason: 'Ya agregaste 3 capturas a esta grabación.' });
  assert.deepEqual(captureAllowed({ recording: { ...rec, expired: true }, maxSteps: 3 }),
    { allowed: false, reason: 'Tiempo agotado: detén la grabación para revisar.' });
  assert.deepEqual(captureAllowed({ draft: { kind: 'recording', images: [] }, maxImages: 4 }),
    { allowed: false, reason: 'La grabación está detenida: envíala o descártala.' });
  assert.deepEqual(captureAllowed({ draft: { kind: 'note', images: [{}, {}, {}, {}] }, maxImages: 4 }),
    { allowed: false, reason: 'Límite de 4 capturas' });
  assert.deepEqual(captureAllowed({ draft: null, maxImages: 4 }), { allowed: true, reason: '' });
});

test('shortcut reports the limit and skips capture when full or stopped', async () => {
  for (const [recording, draft, expected] of [
    [{ startedAt: 1, steps: 0, expired: true }, { kind: 'recording', images: [] },
      'Tiempo agotado: detén la grabación para revisar.'],
    [null, { kind: 'recording', images: [] },
      'La grabación está detenida: envíala o descártala.'],
  ]) {
    const messages = [];
    const bar = Object.create(Bar.prototype);
    bar.cfg = { limits: { maxImages: 4, recordingSteps: 3 } };
    bar.recorder = { active: () => Boolean(recording), state: () => recording };
    bar.drafts = { current: async () => draft };
    bar.toast = (message) => messages.push(message);
    bar.capture = () => assert.fail('No debe capturar');
    let prevented = false;
    await bar.onShortcut({ altKey: true, shiftKey: true, ctrlKey: false, metaKey: false,
      code: 'KeyS', preventDefault: () => { prevented = true; } });
    assert.equal(prevented, true);
    assert.deepEqual(messages, [expected]);
  }
});

test('rail offers capture recording drawer panel and preferences', () => {
  const html = railHtml({ ...VIEW, tickets: [TICKET], drawerOpen: true });
  assert.deepEqual(controls(html), [
    'shot mode=visible aria-label=Capturar lo visible title=Capturar lo visible «»',
    'shot mode=full aria-label=Página completa title=Página completa «»',
    'shot mode=exact aria-label=Captura exacta title=Captura exacta «»',
    'record aria-label=Grabar recorrido title=Grabar recorrido «»',
    'drawer aria-label=Tickets de esta vista title=Tickets de esta vista «1»',
    '/panel/ aria-label=Panel de tickets title=Panel de tickets «»',
    'side aria-label=Mover al otro borde title=Mover al otro borde «»',
    'minimize aria-label=Plegar la barra title=Plegar la barra «»',
  ]);
  assert.match(html, /aria-pressed="true"/);
  assert.match(html, /<svg[^>]+aria-hidden="true"/);
  assert.doesNotMatch(railHtml({ ...VIEW, canExact: false, panelUrl: '' }), /data-mode="exact"|href=/);
  assert.match(railHtml(VIEW), /aria-pressed="false"/);
});

test('drawer shows an unsent draft with send and discard actions', () => {
  const draft = { kind: 'note', images: [{ id: 'a' }] };
  const html = drawerHtml({ ...VIEW, draft });
  assert.deepEqual(controls(html).slice(1, 3), ['compose «Enviar»', 'discard «Descartar»']);
  assert.match(html, /Tu ticket aún no se envía · 1 captura<\/p>/);
  assert.match(text(drawerHtml({ ...VIEW, draft: { kind: 'recording', images: [{ id: 'a' }, { id: 'b' }] } })),
               /Tu recorrido aún no se envía · 2 capturas/);
  assert.doesNotMatch(drawerHtml(VIEW), /aún no se envía|data-act="compose"/);
});

test('panel links open another tab', () => {
  const seven = Array.from({ length: 7 }, (_, i) => ({ ...TICKET, key: 'TS-' + (i + 1) }));
  const html = railHtml(VIEW) + drawerHtml({ ...VIEW, tickets: seven });
  const links = [...html.matchAll(/<a\b[^>]*>/g)].map(([tag]) => tag);
  assert.ok(links.length >= 4);
  for (const tag of links) assert.match(tag, / target="_blank" rel="noopener"/, tag);
});

test('drawer shows context chain tickets and notes', () => {
  const html = drawerHtml({ ...VIEW, tickets: [TICKET], chain: { key: 'TS-3', reject: true }, persistent: false });
  assert.deepEqual(controls(html), [
    'close aria-label=Cerrar el cajón title=Cerrar el cajón «»',
    'chain-cancel «Quitar»',
    'tk-compare key=TS-1 mode=over «Encima»',
    'tk-compare key=TS-1 mode=side «Lado a lado»',
    'tk-approve key=TS-1 «Aprobar»',
    'tk-reject key=TS-1 «Sigue sin funcionar»',
    'tk-chain key=TS-1 reject=1 «Rechazar con captura nueva»',
    '/panel/TS-1/ «Ver»',
    '/panel/ «Ver todos en el panel»',
  ]);
  assert.match(html, /<code>\/pos\/\?tab=1<\/code>/);
  assert.match(html, /src="\/img\/1\/"/);
  assert.match(text(html), /1 abiertos Encadenando a TS-3 · lo rechaza con captura nueva/);
  assert.match(text(html), /Este navegador no guarda borradores/);
  assert.match(text(html), /Alt\+Mayús\+S/);
  assert.match(html, /&lt;b&gt;hola&lt;\/b&gt;/);
  assert.match(html, /class="ts-pill ts-s-in_review"/);
  assert.doesNotMatch(drawerHtml(VIEW), /no cambies de página|Encadenando/);
});

test('without approval permission only chaining is available', () => {
  const other = { ...TICKET, canApprove: false, images: [], detailUrl: '', exact: false, note: 'x'.repeat(200) };
  const html = ticketsHtml([other], true, '');
  assert.deepEqual(controls(html), ['tk-chain key=TS-1 «Encadenar un cambio»']);
  assert.match(html, /ts-ticket-placeholder" aria-hidden="true"/);
  assert.match(text(html), /x{139}…/);
  assert.match(text(html), /Escritorio · 0 capturas · otra URL/);
  assert.equal(ticketsHtml([], false, ''), '');
  assert.equal(text(ticketsHtml([], true, '')), 'No hay tickets abiertos en esta vista: se considera aprobada.');
});

test('drawer shows six tickets and links to the total', () => {
  const seven = Array.from({ length: 7 }, (_, i) => ({ ...TICKET, key: 'TS-' + (i + 1) }));
  const html = drawerHtml({ ...VIEW, tickets: seven });
  assert.equal(html.match(/<li class="ts-ticket">/g).length, 6);
  assert.match(text(html), /7 abiertos/);
  assert.deepEqual(controls(ticketsHtml(seven, true, '/panel/')).slice(-1), ['/panel/ «Ver los 7 en el panel»']);
  assert.doesNotMatch(ticketsHtml(seven, true, ''), /en el panel/);
  assert.doesNotMatch(ticketsHtml(seven.slice(0, 6), true, '/panel/'), /Ver los/);
});

test('draft rail shows three thumbnails remaining count and limit', () => {
  const draft = { kind: 'note', images: ['a', 'b', 'c', 'd'].map((id) => ({ id })) };
  const full = railHtml({ ...VIEW, draft });
  assert.deepEqual(controls(full).slice(0, 8), [
    'shot mode=visible aria-label=Capturar lo visible title=Límite de 4 capturas deshabilitado «»',
    'shot mode=full aria-label=Página completa title=Límite de 4 capturas deshabilitado «»',
    'shot mode=exact aria-label=Captura exacta title=Límite de 4 capturas deshabilitado «»',
    'edit id=a aria-label=Editar captura 1 title=Editar captura 1 «»',
    'edit id=b aria-label=Editar captura 2 title=Editar captura 2 «»',
    'edit id=c aria-label=Editar captura 3 title=Editar captura 3 «»',
    'compose «Enviar»',
    'discard «Descartar»',
  ]);
  assert.match(full, /data-thumb="b"/);
  assert.match(text(full), /\+1/);
  assert.doesNotMatch(full, /data-id="d"/);
  const room = railHtml({ ...VIEW, draft, maxImages: 5 });
  assert.doesNotMatch(room, /disabled|Límite de/);
  const stopped = railHtml({ ...VIEW, draft: { ...draft, kind: 'recording' } });
  assert.doesNotMatch(stopped, /data-act="shot"|data-act="record"/);
  assert.match(stopped, /data-act="compose"/);
});

test('recording shows time step limit and expiry', () => {
  const live = recordingHtml({ startedAt: 1000, steps: 3 }, 8, 62000);
  assert.deepEqual(controls(live), [
    'step «Captura 3/8»', 'stop «Detener»',
    'cancel-rec aria-label=Cancelar la grabación title=Cancelar la grabación «»',
  ]);
  assert.match(live, /data-rec-time>01:01/);
  assert.match(text(live), /Grabando Captura 3\/8 Detener/);
  assert.equal(controls(recordingHtml({ startedAt: 0, steps: 8 }, 8, 0))[0],
    'step title=Ya agregaste 8 capturas a esta grabación. deshabilitado «Captura 8/8»');
  const expired = recordingHtml({ startedAt: 0, steps: 0, expired: true }, 8, 0);
  assert.equal(controls(expired)[0],
    'step title=Tiempo agotado: detén la grabación para revisar. deshabilitado «Captura 0/8»');
  assert.match(text(expired), /Tiempo agotado/);
});

test('collapsed tab shows open ticket count', () => {
  assert.deepEqual(controls(miniHtml(4)), [
    'restore aria-label=Mostrar la barra de revisión · 4 abiertos title=Mostrar la barra de revisión · 4 abiertos «»',
  ]);
  assert.deepEqual(controls(miniHtml(0)), [
    'restore aria-label=Mostrar la barra de revisión title=Mostrar la barra de revisión «»',
  ]);
  assert.match(miniHtml(4), /ts-mini-open/);
});

test('editor offers side tools and options while retaining data', () => {
  const html = editorHtml(1, 3);
  assert.match(text(html), /Captura 2 de 3/);
  assert.deepEqual(controls(html).slice(0, 2), ['cancel «Cancelar»', 'done «Guardar»']);
  assert.deepEqual([...html.matchAll(/data-tool="([^"]+)" aria-label="([^"]+)" title="([^"]+)" aria-pressed="false"/g)]
    .map((m) => m.slice(1)), [
      ['pen', 'Lápiz', 'Lápiz'], ['arrow', 'Flecha', 'Flecha'], ['box', 'Recuadro', 'Recuadro'],
      ['text', 'Texto', 'Texto'], ['redact', 'Corrector', 'Corrector'], ['redact-brush', 'Corrector a mano', 'Corrector a mano'],
    ]);
  assert.deepEqual(controls(html).filter((item) => /^(undo|redo|clear) /.test(item)), [
    'undo aria-label=Deshacer title=Deshacer «»',
    'redo aria-label=Rehacer title=Rehacer «»',
    'clear aria-label=Quitar todo title=Quitar todo «»',
  ]);
  assert.match(html, /data-color="#e5484d"/);
  assert.match(html, /data-size/);
  assert.match(html, /data-redact-color/);
  assert.match(html, /<canvas class="ts-canvas"/);
});

// ------------------------------------------------ browser fakes


test('console saves full masked text including objects', async () => {
  fakeBrowser('https://site.test/pos/?q=Ana');
  const { createLogs } = await load('logs.js');
  const original = console.warn;
  console.warn = () => {};
  try {
    const logs = createLogs({ isOwnUrl: () => false, isCapturing: () => false,
                              maskText: (t) => maskText(t, ['email']) });
    console.warn('login inválido de ana@correo.mx', { password: 'secreto123', user: 'ana' }, [1, 2]);
    console.warn('x'.repeat(3000));
    const [entry, long] = logs.all();
    assert.equal(entry.message, 'login inválido de •••••••••••• {"password":"secreto123","user":"ana"} [1,2]');
    assert.equal(entry.page, '/pos/');
    assert.equal(long.message.length, 2000);
  } finally {
    console.warn = original;
  }
});

test('consoleText handles every argument without throwing', async () => {
  const { consoleText } = await load('util.js');
  const loop = { name: 'a' };
  loop.self = loop;
  assert.equal(consoleText(loop), '{"name":"a","self":"[referencia repetida]"}');
  assert.equal(consoleText({ n: 10n }), '{"n":"10"}');
  assert.equal(consoleText({ error: new TypeError('x') }), '{"error":"TypeError: x"}');
  assert.equal(consoleText(new Error('boom')), 'Error: boom');
  assert.equal(consoleText(undefined), 'undefined');
  assert.equal(consoleText('tal cual'), 'tal cual');
});

test('consoleText serializes JSON quotes dates empty and unsupported values', async () => {
  const { consoleText } = await load('util.js');
  const value = { 'di "hola"': 'línea\n"dos"', n: 1.5, no: NaN, ok: true, nada: null, sin: undefined,
                  fn() {}, lista: [undefined, () => 1, 2, [], {}], cuando: new Date(0) };
  assert.equal(consoleText(value), JSON.stringify(value));
  assert.equal(consoleText([]), '[]');
  assert.equal(consoleText({}), '{}');
  // Read each property once, like JSON.stringify; stateful getters do not repeat.
  let reads = 0;
  const counter = { get v() { reads += 1; return reads; } };
  assert.equal(consoleText(counter), '{"v":1}');
  assert.equal(reads, 1);
});

test('consoleText handles hostile objects', async () => {
  const { consoleText } = await load('util.js');
  const hostile = new Proxy({}, { getPrototypeOf() { throw new Error('x'); }, ownKeys() { throw new Error('x'); } });
  assert.equal(consoleText(hostile), '[no se pudo leer]');
  const error = new Error('boom');
  Object.defineProperty(error, 'message', { get() { throw new Error('x'); } });
  assert.equal(consoleText(error), '[no se pudo leer]');
  assert.equal(consoleText({ get boom() { throw new Error('x'); } }), '[no se pudo leer]');
  assert.equal(consoleText({ toJSON() { throw new Error('no'); } }), '[no se pudo leer]');
});

test('consoleText stops at the limit without traversing excess data', async () => {
  const { MAX_TEXT, consoleText } = await load('util.js');
  // Traversing the whole list would trigger the last element's failing getter.
  const huge = Array.from({ length: 200000 }, (_, i) => i);
  huge.push({ get boom() { throw new Error('leído'); } });
  const text = consoleText(huge);
  assert.equal(text.length, MAX_TEXT + 1);
  assert.ok(text.startsWith('[0,1,2,3,'));
  assert.ok(text.endsWith('…'));
  let deep = {};
  for (let i = 0; i < 100000; i++) deep = { a: deep };
  assert.equal(consoleText(deep).length, MAX_TEXT + 1);
  const exact = 'x'.repeat(MAX_TEXT - 4);
  assert.equal(consoleText([exact]), '["' + exact + '"]');
});

test('recorder stores URL names and console events without values', async () => {
  fakeBrowser('https://site.test/search/?q=Ana+Pérez');
  const { LS } = await load('util.js');
  const { createRecorder, eventFromLog } = await load('recorder.js');
  localStorage.setItem(LS.rec, JSON.stringify({ startedAt: Date.now(), count: 0 }));
  const recorder = createRecorder({ limits: { recordingMinutes: 30, recordingEvents: 10 },
                                    mask: { text: (t) => t, hidden: () => false }, tabId: 'tab1',
                                    isFromUi: () => false, isUiElement: () => false, logs: { onEntry() {} } });
  recorder.record('click', { label: 'Buscar' }, true);
  const [event] = recorder.mergedEvents();
  assert.equal(event.url, '/search/?q=…');
  assert.deepEqual(eventFromLog({ type: 'console', level: 'warn', message: 'Ana Pérez' }),
                   { status: undefined, label: 'warn' });
  assert.deepEqual(eventFromLog({ type: 'network', method: 'GET', url: '/api/?q=…', status: 500, message: 'x' }),
                   { status: 500, label: 'GET', target: '/api/?q=…' });
  recorder.end();
  assert.equal(localStorage.getItem(LS.rec), null);
});


test('logs observe resource errors rejected promises and network requests', async () => {
  fakeBrowser('https://site.test/pos/');
  window.fetch = async () => ({ status: 503 });
  const { createLogs } = await load('logs.js');
  const clock = [1000, 1250];
  const realNow = performance.now;
  performance.now = () => clock.shift();
  try {
    await withQuietConsole(async () => {
      const logs = createLogs({ isOwnUrl: () => false, isCapturing: () => false, maskText: (t) => t });
      window.dispatch('error', { target: { tagName: 'IMG', src: 'https://site.test/img/a.png?v=2' } });
      window.dispatch('unhandledrejection', { reason: { code: 7 } });
      await window.fetch('/api/x?token=abc');
      assert.deepEqual(logs.all().map(({ at, ...rest }) => rest), [
        { type: 'error', message: 'No cargó img: /img/a.png?v=…', url: '', page: '/pos/' },
        { type: 'error', message: 'Promesa rechazada: {"code":7}', url: '', page: '/pos/' },
        { type: 'network', method: 'GET', url: '/api/x?token=…', status: 503, ms: 250, page: '/pos/' },
      ]);
    });
  } finally {
    performance.now = realNow;
  }
});

test('JavaScript errors keep message and location while resource errors name the resource', async () => {
  fakeBrowser('https://site.test/pos/');
  const { createLogs } = await load('logs.js');
  await withQuietConsole(() => {
    const logs = createLogs({ isOwnUrl: () => false, isCapturing: () => false, maskText: (t) => t });
    window.dispatch('error', { target: window, message: 'x is not defined',
                               filename: 'https://site.test/static/app.js?v=3', lineno: 10, colno: 5 });
    window.dispatch('error', { target: window, filename: 'https://site.test/static/app.js' });
    window.dispatch('error', { target: { tagName: 'LINK', href: 'https://site.test/css/a.css' } });
    window.dispatch('error', { target: { tagName: 'VIDEO', currentSrc: '/v.mp4', src: '/otro.mp4' } });
    assert.deepEqual(logs.all().map((e) => [e.message, e.source]), [
      ['x is not defined', '/static/app.js:10:5'],
      ['', '/static/app.js::'],
      ['No cargó link: /css/a.css', undefined],
      ['No cargó video: /v.mp4', undefined],
    ]);
  });
});

test('network log includes method and URL but excludes bar requests', async () => {
  fakeBrowser('https://site.test/pos/');
  window.fetch = async () => ({ status: 200 });
  let capturing = false;
  const { createLogs } = await load('logs.js');
  await withQuietConsole(async () => {
    const logs = createLogs({ isOwnUrl: (url) => url.startsWith('/__ticketshot/'), isCapturing: () => capturing,
                              maskText: (t) => t });
    await window.fetch('/api/a', { method: 'post' });
    await window.fetch({ url: '/api/b?id=4', method: 'put' });
    await window.fetch('/__ticketshot/api/tickets/');
    capturing = true;
    await window.fetch('/fuente.woff2');
    assert.deepEqual(logs.all().map((e) => e.method + ' ' + e.url), ['POST /api/a', 'PUT /api/b?id=…']);
  });
});

test('failed requests retain status zero and error then propagate', async () => {
  fakeBrowser('https://site.test/pos/');
  window.fetch = async () => { throw new TypeError('Failed to fetch'); };
  const { createLogs } = await load('logs.js');
  await withQuietConsole(async () => {
    const logs = createLogs({ isOwnUrl: () => false, isCapturing: () => false, maskText: (t) => t });
    await assert.rejects(window.fetch('/api/caida'), /Failed to fetch/);
    const [entry] = logs.all();
    assert.deepEqual([entry.url, entry.status, entry.message], ['/api/caida', 0, 'TypeError: Failed to fetch']);
  });
});

test('XHR requests log on completion except bar requests', async () => {
  fakeBrowser('https://site.test/pos/');
  const { createLogs } = await load('logs.js');
  await withQuietConsole(() => {
    const logs = createLogs({ isOwnUrl: (url) => url.startsWith('/__ticketshot/'), isCapturing: () => false,
                              maskText: (t) => t });
    const xhr = new XMLHttpRequest();
    xhr.open('post', '/api/x?a=1');
    xhr.send();
    assert.equal(logs.all().length, 0);
    xhr.finish(201);
    const own = new XMLHttpRequest();
    own.open('GET', '/__ticketshot/api/');
    own.send();
    own.finish(200);
    const bare = new XMLHttpRequest();
    bare.send();
    assert.deepEqual(logs.all().map((e) => [e.method, e.url, e.status]), [['POST', '/api/x?a=…', 201]]);
  });
});

test('logs keep only the latest 120 entries', async () => {
  fakeBrowser('https://site.test/');
  const { createLogs } = await load('logs.js');
  await withQuietConsole(() => {
    const logs = createLogs({ isOwnUrl: () => false, isCapturing: () => false, maskText: (t) => t });
    for (let i = 0; i < 121; i++) console.warn('m' + i);
    const all = logs.all();
    assert.equal(all.length, 120);
    assert.equal(all[0].message, 'm1');
  });
});

test('IDs stay unique without randomUUID and tab ID survives reload', async () => {
  const { tabId, uid } = await load('util.js');
  assert.match(uid(), /^[0-9a-f-]{36}$/);
  const realCrypto = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
  Object.defineProperty(globalThis, 'crypto', { value: undefined, configurable: true });
  try {
    assert.match(uid(), /^x[0-9a-z]{12,}$/);
  } finally {
    Object.defineProperty(globalThis, 'crypto', realCrypto);
  }
  const session = new Map();
  globalThis.sessionStorage = { getItem: (k) => session.get(k) ?? null, setItem: (k, v) => session.set(k, v) };
  try {
    const first = tabId();
    assert.equal(first.length, 8);
    assert.equal(tabId(), first);
    globalThis.sessionStorage = { getItem() { throw new Error('bloqueado'); } };
    assert.equal(tabId().length, 8);
  } finally {
    delete globalThis.sessionStorage;
  }
});

test('server response returns data or an error message', async () => {
  const { jsonOrError } = await load('util.js');
  const reply = (ok, status, json) => ({ ok, status, json });
  assert.deepEqual(await jsonOrError(reply(true, 200, async () => ({ key: 'TS-1' }))), { key: 'TS-1' });
  await assert.rejects(jsonOrError(reply(false, 409, async () => ({ error: 'Ya existe.' }))), /^Error: Ya existe\.$/);
  await assert.rejects(jsonOrError(reply(false, 502, async () => { throw new SyntaxError('html'); })),
                       /^Error: El servidor respondió 502\.$/);
});

test('safe localStorage reports writes and lists by prefix', async () => {
  fakeBrowser('https://site.test/');
  const { lsGet, lsKeys, lsSet } = await load('util.js');
  assert.equal(lsSet('ticketshot:a', 1), true);
  lsSet('otro', 2);
  lsSet('ticketshot:b', 3);
  assert.deepEqual(lsKeys('ticketshot:'), ['ticketshot:a', 'ticketshot:b']);
  localStorage.setItem = () => { throw new Error('QuotaExceededError'); };
  assert.equal(lsSet('ticketshot:c', 4), false);
  assert.equal(lsGet('ticketshot:c', 'nada'), 'nada');
});


const ENDPOINTS = { open: '/__ticketshot/api/open/', action: '/__ticketshot/api/tickets/{key}/',
                    create: '/__ticketshot/api/tickets/' };

async function apiFor(cfg = {}, drafts = {}, mask = { text: (t) => t }) {
  const { createApi } = await load('api.js');
  return createApi({ csrf: 'tok', pageToken: 'pt', recordingCookie: 'ticketshot_rec',
                     limits: { recordingMinutes: 30 }, endpoints: ENDPOINTS, ...cfg },
                   { blob: async () => null, persistent: () => true, ...drafts }, mask);
}

test('bar requests open tickets for its URL and handles server failure', async () => {
  fakeBrowser('https://site.test/customers/4/?tab=payments');
  const api = await apiFor();
  assert.equal(api.tickets.loaded, false);
  await withFetch(reply({ tickets: [{ key: 'TS-1' }, { key: 'TS-2' }] }), async (calls) => {
    assert.deepEqual(await api.tickets.load(), [{ key: 'TS-1' }, { key: 'TS-2' }]);
    assert.equal(calls[0].url, '/__ticketshot/api/open/?path=%2Fcustomers%2F4%2F%3Ftab%3Dpayments');
    assert.deepEqual(calls[0].init, { credentials: 'same-origin', headers: { 'X-Requested-With': 'ticketshot' } });
  });
  assert.equal(api.tickets.loaded, true);
  assert.deepEqual(api.tickets.find('TS-2'), { key: 'TS-2' });
  assert.equal(api.tickets.find('TS-9'), null);
  await withFetch(reply({}), async () => assert.deepEqual(await api.tickets.load(), []));
  await withFetch(reply({ tickets: [{ key: 'TS-1' }] }, 500), async () => assert.deepEqual(await api.tickets.load(), []));
  const offline = await apiFor();
  await withFetch(async () => { throw new TypeError('offline'); }, async () => {
    assert.deepEqual(await offline.tickets.load(), []);
  });
  assert.equal(offline.tickets.loaded, true);
  const closed = await apiFor({ endpoints: { ...ENDPOINTS, open: '' } });
  await withFetch(reply({ tickets: [{ key: 'TS-1' }] }), async (calls) => {
    assert.deepEqual(await closed.tickets.load(), []);
    assert.equal(calls.length, 0);
  });
});

test('actions POST with CSRF token and chain survives navigation', async () => {
  fakeBrowser('https://site.test/');
  const api = await apiFor();
  await withFetch(reply({ message: 'Hecho.' }), async (calls) => {
    assert.deepEqual(await api.tickets.action('TS 1', 'reject', { note: 'sigue' }), { message: 'Hecho.' });
    const [{ url, init }] = calls;
    assert.equal(url, '/__ticketshot/api/tickets/TS%201/');
    assert.deepEqual([init.method, init.credentials, init.headers],
                     ['POST', 'same-origin', { 'X-CSRFToken': 'tok', 'X-Requested-With': 'ticketshot' }]);
    assert.equal(init.body.toString(), 'action=reject&note=sigue');
    await api.tickets.action('TS-1', 'approve');
    assert.equal(calls[1].init.body.toString(), 'action=approve');
  });
  assert.equal(api.tickets.chain(), null);
  api.tickets.setChain('TS-3', 1);
  assert.deepEqual(api.tickets.chain(), { key: 'TS-3', reject: true });
  api.tickets.setChain('TS-4');
  assert.deepEqual(api.tickets.chain(), { key: 'TS-4', reject: false });
  api.tickets.clearChain();
  assert.equal(api.tickets.chain(), null);
});

const BROWSER = {
  document: { title: 'Caja', referrer: 'https://site.test/start/?from=menu', cookie: '' },
  navigator: { userAgent: 'Prueba/1.0', language: 'es-MX', languages: ['es-MX', 'es', 'en', 'fr', 'de', 'it'],
               maxTouchPoints: 5, onLine: true },
  screen: { width: 1920, height: 1080 },
  matchMedia: (query) => ({ matches: query === '(prefers-color-scheme: dark)' }),
};

test('submission includes draft ID origin browser and selected logs', async () => {
  fakeBrowser('https://site.test/pos/?q=1');
  Object.assign(window, { innerWidth: 1280, innerHeight: 720, devicePixelRatio: 2, scrollX: 10.4, scrollY: 99.6 });
  await withGlobals(BROWSER, async () => {
    const api = await apiFor({}, { persistent: () => false });
    const draft = { id: 'd-1', kind: 'note', images: [], durationMs: 1500, recordingId: 'rec-9',
                    logs: [{ type: 'console' }], events: [] };
    await withFetch(reply({ key: 'TS-7' }, 201), async (calls) => {
      assert.deepEqual(await api.submit(draft, 'nota', { device: 'desktop', parent: 'TS-2', rejectParent: 1,
                                                         logs: true, events: true }), { key: 'TS-7' });
      const form = calls[0].init.body;
      assert.equal(calls[0].url, '/__ticketshot/api/tickets/');
      const { client, ...payload } = JSON.parse(form.get('payload'));
      assert.deepEqual(payload, { clientId: 'd-1', kind: 'note', note: 'nota', pageUrl: 'https://site.test/pos/?q=1',
                                  pageTitle: 'Caja', pageToken: 'pt', durationMs: 1500, device: 'desktop',
                                  parent: 'TS-2', rejectParent: true, recordingId: 'rec-9', images: [] });
      const { sentAt, timezone, ...rest } = client;
      assert.deepEqual(rest, {
        // Previous page query keeps names but not values, as in server logs.
        url: 'https://site.test/pos/?q=1', title: 'Caja', referrer: '/start/?from=…', userAgent: 'Prueba/1.0',
        language: 'es-MX', languages: ['es-MX', 'es', 'en', 'fr', 'de'], viewport: { width: 1280, height: 720 },
        screen: { width: 1920, height: 1080, dpr: 2 }, scroll: { x: 10, y: 100 }, touch: 5, colorScheme: 'oscuro',
        online: true, storage: 'memoria' });
      assert.ok(!Number.isNaN(Date.parse(sentAt)));
      assert.deepEqual(JSON.parse(await form.get('logs').text()), [{ type: 'console' }]);
      assert.deepEqual([form.get('logs').name, form.get('logs').type], ['logs.json', 'application/json']);
      assert.equal(form.get('events'), null);
      await api.submit({ ...draft, events: [{ type: 'click' }], recordingId: '' }, '', { device: 'mobile', logs: false, events: true });
      const second = calls[1].init.body;
      assert.equal(second.get('logs'), null);
      assert.deepEqual(JSON.parse(await second.get('events').text()), [{ type: 'click' }]);
      const again = JSON.parse(second.get('payload'));
      assert.deepEqual([again.parent, again.rejectParent, again.recordingId], ['', false, '']);
    });
  });
});

test('submission without captures uses current page and neutral optional values', async () => {
  fakeBrowser('https://site.test/end/');
  await withGlobals({ ...BROWSER, navigator: { userAgent: 'x' }, matchMedia: () => ({ matches: false }) }, async () => {
    const api = await apiFor();
    await withFetch(reply({ key: 'TS-8' }), async (calls) => {
      await api.submit({ id: 'd-2', kind: 'recording', images: [], logs: [], events: [] }, '', { device: 'both' });
      const { client, ...payload } = JSON.parse(calls[0].init.body.get('payload'));
      assert.deepEqual([payload.pageUrl, payload.pageTitle, payload.pageToken], ['https://site.test/end/', 'Caja', 'pt']);
      assert.deepEqual([client.languages, client.touch, client.colorScheme, client.storage, client.screen.dpr],
                       [[], 0, 'claro', 'indexeddb', 1]);
    });
  });
});

test('trigger URL title and context come from first capture', async () => {
  fakeBrowser('https://site.test/now/');
  await withGlobals(BROWSER, async () => {
    const { payloadOf } = await load('api.js');
    const images = [{ pageUrl: '/start/', pageTitle: 'Inicio', pageToken: 't1' },
                    { pageUrl: '/end/', pageTitle: 'Fin', pageToken: 't2' }];
    const payload = payloadOf({ pageToken: 'pt' }, { title: 'Ahora' }, { id: 'd', images }, '', {}, []);
    assert.deepEqual([payload.pageUrl, payload.pageTitle, payload.pageToken], ['/start/', 'Inicio', 't1']);
  });
});

test('submission never sends an unmasked page title', async () => {
  fakeBrowser('https://site.test/search/');
  await withGlobals({ ...BROWSER, document: { ...BROWSER.document, title: 'Resultados para ana@correo.mx', referrer: '' } }, async () => {
    const api = await apiFor({}, {}, { text: (t) => maskText(t, ['email']) });
    await withFetch(reply({ key: 'TS-9' }), async (calls) => {
      await api.submit({ id: 'd-3', kind: 'note', images: [], logs: [], events: [] }, '', { device: 'desktop' });
      const { client, pageTitle } = JSON.parse(calls[0].init.body.get('payload'));
      assert.equal(pageTitle, 'Resultados para ••••••••••••');
      assert.equal(client.title, 'Resultados para ••••••••••••');
      // Do not invent a previous page when none exists.
      assert.equal(client.referrer, '');
    });
  });
});

test('recording cookie lasts through recording plus ten minutes and uses Secure on https', async () => {
  fakeBrowser('https://site.test/');
  await withGlobals({ document: { cookie: '' } }, async () => {
    const api = await apiFor();
    api.recordingCookie.set('rec 1');
    assert.equal(document.cookie, 'ticketshot_rec=rec%201; path=/; max-age=2400; SameSite=Lax; Secure');
    api.recordingCookie.clear();
    assert.equal(document.cookie, 'ticketshot_rec=; path=/; max-age=0; SameSite=Lax; Secure');
    fakeBrowser('http://site.test/');
    api.recordingCookie.set('r');
    assert.equal(document.cookie, 'ticketshot_rec=r; path=/; max-age=2400; SameSite=Lax');
    api.recordingCookie.clear();
    assert.equal(document.cookie, 'ticketshot_rec=; path=/; max-age=0; SameSite=Lax');
    document.cookie = 'sin cambio';
    api.recordingCookie.set('');
    const off = await apiFor({ recordingCookie: '' });
    off.recordingCookie.set('r');
    off.recordingCookie.clear();
    assert.equal(document.cookie, 'sin cambio');
  });
});


async function draftsWith(store, logs = []) {
  const { createDrafts } = await load('drafts.js');
  return createDrafts(store, { all: () => logs });
}

test('current draft survives reload and clears when missing from storage', async () => {
  fakeBrowser('https://site.test/');
  const { LS } = await load('util.js');
  const store = fakeStore();
  const drafts = await draftsWith(store);
  assert.equal(await drafts.current(), null);
  const draft = await drafts.create('note');
  assert.deepEqual([draft.kind, draft.note, draft.images, draft.logs], ['note', '', [], []]);
  assert.ok(!Number.isNaN(Date.parse(draft.createdAt)));
  assert.equal(JSON.parse(localStorage.getItem(LS.draft)), draft.id);
  assert.equal(await drafts.current(), draft);
  assert.equal(JSON.parse(localStorage.getItem(LS.draft)), draft.id);
  store.tables.drafts.clear();
  assert.equal(await drafts.current(), null);
  assert.equal(localStorage.getItem(LS.draft), null);
  assert.equal(drafts.persistent(), false);
});

test('draft captures store images separately and retain current logs', async () => {
  fakeBrowser('https://site.test/');
  const store = fakeStore();
  const drafts = await draftsWith(store, [{ at: 1, type: 'console', message: 'x' }]);
  const draft = await drafts.create('note');
  const blob = new Blob(['png']);
  await drafts.addImage(draft, blob, { role: 'single', ops: [{ tool: 'pen' }] });
  const [img] = draft.images;
  assert.deepEqual({ ...img, id: undefined }, { id: undefined, ops: [{ tool: 'pen' }], caption: '', role: 'single' });
  assert.equal(await drafts.blob(img), blob);
  assert.deepEqual(draft.logs, [{ at: 1, type: 'console', message: 'x' }]);
  assert.equal(store.tables.drafts.get(draft.id), draft);
  await drafts.addImage(draft, new Blob(['b']), {});
  const second = draft.images[1];
  assert.deepEqual(second.ops, []);
  await drafts.removeImage(draft, img.id);
  assert.deepEqual(draft.images.map((i) => i.id), [second.id]);
  assert.equal(store.tables.blobs.has(img.id), false);
  // Draft stored by an older version without logs.
  const old = { id: 'viejo', images: [] };
  await drafts.addImage(old, new Blob(['c']), {});
  assert.deepEqual(old.logs, [{ at: 1, type: 'console', message: 'x' }]);
});

test('discard removes images and draft and clears only its current ID', async () => {
  fakeBrowser('https://site.test/');
  const { LS } = await load('util.js');
  const store = fakeStore();
  const drafts = await draftsWith(store);
  const old = await drafts.create('note');
  await drafts.addImage(old, new Blob(['a']), {});
  const current = await drafts.create('recording');
  await drafts.discard(old);
  assert.equal(store.tables.blobs.size, 0);
  assert.equal(store.tables.drafts.has(old.id), false);
  assert.equal(JSON.parse(localStorage.getItem(LS.draft)), current.id);
  await drafts.discard(current);
  assert.equal(localStorage.getItem(LS.draft), null);
  await drafts.discard(null);
});

test('recorder describes elements without their content', async () => {
  const { describe } = await load('recorder.js');
  const el = (tag, { id = '', attrs = {}, classes = [] } = {}) => ({
    nodeType: 1, tagName: tag.toUpperCase(), id, classList: classes, textContent: 'Ana Pérez',
    getAttribute: (name) => attrs[name] ?? null });
  assert.equal(describe(el('input', { id: 'correo', attrs: { name: 'email', type: 'email' },
                                      classes: ['campo', 'grande', 'extra'] })),
               'input#correo[name=email][type=email].campo.grande');
  assert.equal(describe(el('button', { attrs: { type: 'submit' } })), 'button');
  assert.equal(describe(el('div', { id: 'x'.repeat(200) })).length, 140);
  assert.equal(describe(null), '');
  assert.equal(describe({ nodeType: 3 }), '');
});

const NOW = 1_000_000;

async function recorderFor(tab, limits) {
  const { createRecorder } = await load('recorder.js');
  return createRecorder({
    limits: { recordingMinutes: 30, recordingEvents: 100, ...limits },
    mask: { text: (t) => t, hidden: () => false }, tabId: tab,
    isFromUi: () => false, isUiElement: () => false, logs: { onEntry() {} } });
}


test('recording expires after time limit then accepts only stop', async () => {
  fakeBrowser('https://site.test/a/');
  const { LS } = await load('util.js');
  const recorder = await recorderFor('t1', {});
  await withClock(NOW, () => {
    assert.equal(recorder.expired({ startedAt: NOW - 30 * 60000 }), false);
    assert.equal(recorder.expired({ startedAt: NOW - 30 * 60000 - 1 }), true);
    localStorage.setItem(LS.rec, JSON.stringify({ startedAt: NOW - 1000, expired: true }));
    recorder.record('click', { label: 'tarde' }, true);
    recorder.record('stop', { label: 'cierre' }, true);
  });
  assert.deepEqual(recorder.mergedEvents().map((e) => e.type), ['stop']);
});

test('recording counts events warns once at limit and stores relative time', async () => {
  fakeBrowser('https://site.test/a/');
  const { LS } = await load('util.js');
  const recorder = await recorderFor('t1', { recordingEvents: 1 });
  await withClock(NOW, () => {
    localStorage.setItem(LS.rec, JSON.stringify({ startedAt: NOW - 5000 }));
    recorder.record('click', { label: 'Buscar' }, true);
    recorder.record('click', { label: 'Otra' }, true);
    recorder.record('click', { label: 'Tercera' }, true);
  });
  assert.deepEqual(recorder.mergedEvents().map((e) => [e.t, e.type, e.label || e.message]), [
    [5000, 'click', 'Buscar'], [5000, 'limit', 'Se alcanzó el máximo de 1 eventos.']]);
  assert.equal(recorder.state().count, 1);
});

test('events from multiple tabs merge in time order', async () => {
  fakeBrowser('https://site.test/a/');
  const { LS } = await load('util.js');
  localStorage.setItem(LS.rec, JSON.stringify({ startedAt: 0 }));
  const first = await recorderFor('t1', {});
  const second = await recorderFor('t2', {});
  await withClock(3000, () => first.record('click', { label: 'c' }, true));
  await withClock(1000, () => second.record('click', { label: 'a' }, true));
  await withClock(2000, () => first.record('click', { label: 'b' }, true));
  assert.deepEqual(first.mergedEvents().map((e) => e.label), ['a', 'b', 'c']);
});

test('quota failure keeps recent events and a warning', async () => {
  const store = fakeBrowser('https://site.test/a/');
  const { LS } = await load('util.js');
  localStorage.setItem(LS.rec, JSON.stringify({ startedAt: 0 }));
  const recorder = await recorderFor('t1', {});
  let refused = false;
  localStorage.setItem = (k, v) => {
    if (k.startsWith(LS.events) && !refused) { refused = true; throw new Error('QuotaExceededError'); }
    store.set(k, String(v));
  };
  recorder.record('click', { label: 'x' }, true);
  assert.deepEqual(recorder.mergedEvents().map((e) => e.label || e.message),
                   ['x', 'El navegador se quedó sin espacio: se perdieron eventos.']);
});

test('recording timer starts only once', async () => {
  fakeBrowser('https://site.test/a/');
  const recorder = await recorderFor('t1', {});
  const original = globalThis.setInterval;
  let started = 0;
  globalThis.setInterval = () => { started += 1; return 1; };
  try {
    recorder.startTicker(() => {});
    recorder.startTicker(() => {});
  } finally {
    globalThis.setInterval = original;
    recorder.stopTicker();
  }
  assert.equal(started, 1);
});
