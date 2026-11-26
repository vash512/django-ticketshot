import test from 'node:test';
import assert from 'node:assert/strict';
import { load, fakeBrowser, fakeStore, withClock, withGlobals } from './helpers.mjs';

test('pure capture decisions cover full document and limits', async () => {
  const { captureFrame, backgroundColor, captureFilter } = await load('capture.js');
  const small = { vw: 800, vh: 600, rootWidth: 2000, bodyWidth: 2200,
    rootHeight: 1000, bodyHeight: 1100, pixelRatio: 3 };
  assert.deepEqual(captureFrame(false, small), { width: 800, height: 600, scale: 2 });
  assert.deepEqual(captureFrame(true, small), { width: 2200, height: 1100, scale: 2 });
  const tall = { ...small, rootHeight: 20000, bodyHeight: 18000, pixelRatio: 1 };
  assert.equal(captureFrame(true, tall).scale, Math.sqrt(16e6 / (2200 * 20000)));
  assert.equal(captureFrame(false, { ...small, pixelRatio: 0 }).scale, 1);
  assert.equal(backgroundColor('transparent', 'rgb(1, 2, 3)'), 'rgb(1, 2, 3)');
  assert.equal(backgroundColor('rgba(0, 0, 0, 0)', 'transparent'), '#ffffff');
  assert.equal(backgroundColor('red', 'blue'), 'red');
  assert.equal(captureFilter({ nodeType: 3 }), true);
  assert.equal(captureFilter({ nodeType: 1, hasAttribute: () => false }), true);
  assert.equal(captureFilter({ nodeType: 1, hasAttribute: () => true }), false);
});

test('recorder decisions describe actions without private values', async () => {
  fakeBrowser('https://site.test/a/?password=secreto');
  const { clickData, inputData, fieldChangeData, navigationData, openedWindowData,
    nativeDialogData, nativeResult, pageDialogData, controlLabel, visibleDialog, dialogLabel } = await load('recorder.js');
  const element = { nodeType: 1, tagName: 'INPUT', id: 'correo', classList: [],
    value: 'secreto', getAttribute: (name) => name === 'type' ? 'text' : null };
  assert.deepEqual(clickData(element, 'Correo', 3.6, 4.2),
    { target: 'input#correo[type=text]', label: 'Correo', x: 4, y: 4 });
  assert.deepEqual(inputData(element, 'Correo'),
    { target: 'input#correo[type=text]', label: 'Correo', size: '7 caracteres' });
  assert.deepEqual(fieldChangeData(element, 'Correo', 'text', false, '', false, (x) => x),
    { target: 'input#correo[type=text]', label: 'Correo' });
  assert.equal(fieldChangeData(element, '', 'checkbox', true, '', false, (x) => x).value, 'marcado');
  assert.equal(fieldChangeData(element, '', 'radio', false, '', false, (x) => x).value, 'desmarcado');
  assert.equal(fieldChangeData(element, '', 'select', false, '  visible  ', false, (x) => x).value, 'visible');
  assert.equal(fieldChangeData(element, '', 'select', false, 'secreto', true, (x) => x).value, undefined);
  assert.deepEqual(navigationData('pushState'), { label: 'pushState' });
  assert.deepEqual(openedWindowData('/b/?password=secreto'), { url: '/b/?password=…', label: 'window.open' });
  assert.deepEqual(nativeDialogData('prompt', 'Pregunta', 'secreto', (x) => x),
    { label: 'prompt', message: 'Pregunta', result: '(oculto)' });
  assert.equal(nativeResult('prompt', null), 'cancelado');
  assert.equal(nativeResult('confirm', true), 'aceptar');
  assert.equal(nativeResult('confirm', false), 'cancelar');
  assert.equal(nativeResult('alert', undefined), '');
  assert.deepEqual(pageDialogData('Ayuda', false), { label: 'Ayuda', value: 'cerrada' });
  assert.deepEqual(pageDialogData('Ayuda', true), { label: 'Ayuda', value: 'abierta' });
  assert.equal(controlLabel({ aria: 'A', title: 'B' }), 'A');
  assert.equal(controlLabel({ title: 'B' }), 'B');
  assert.equal(controlLabel({ field: true, associated: 'Campo' }), 'Campo');
  assert.equal(controlLabel({ field: true, placeholder: 'Pista' }), 'Pista');
  assert.equal(controlLabel({ field: true, name: 'nombre' }), 'nombre');
  assert.equal(controlLabel({ innerText: 'Botón' }), 'Botón');
  assert.equal(controlLabel({ textContent: 'Texto' }), 'Texto');
  assert.equal(dialogLabel('', '', 'Título', 'div'), 'Título');
  assert.equal(dialogLabel('A', 'B', 'C', 'div'), 'A');
  assert.equal(dialogLabel('', '', '', 'div'), 'div');
  const visible = { hidden: false, ariaHidden: null, tag: 'DIV', open: false,
    display: 'block', visibility: 'visible', rectCount: 1 };
  assert.equal(visibleDialog(visible), true);
  assert.equal(visibleDialog({ ...visible, hidden: true }), false);
  assert.equal(visibleDialog({ ...visible, ariaHidden: 'true' }), false);
  assert.equal(visibleDialog({ ...visible, tag: 'DIALOG' }), false);
  assert.equal(visibleDialog({ ...visible, display: 'none' }), false);
  assert.equal(visibleDialog({ ...visible, visibility: 'hidden' }), false);
  assert.equal(visibleDialog({ ...visible, rectCount: 0 }), false);
});

test('path and drawing size are decided without canvas', async () => {
  const { strokeRoute, flattenedSize } = await load('draw.js');
  assert.deepEqual(strokeRoute([]), []);
  assert.deepEqual(strokeRoute([[4, 5]]), [[4, 5], [4.1, 5.1]]);
  assert.deepEqual(strokeRoute([[1, 2], [3, 4]]), [[1, 2], [3, 4]]);
  assert.deepEqual(flattenedSize(1000, 600, 400), { width: 400, height: 240, ratio: 0.4 });
  assert.deepEqual(flattenedSize(1000, 600, 2000), { width: 1000, height: 600, ratio: 1 });
  assert.deepEqual(flattenedSize(1000, 600), { width: 1000, height: 600, ratio: 1 });
});

test('recorder listens to browser events without private answers', async () => {
  fakeBrowser('https://site.test/a/?q=privado');
  const { LS } = await load('util.js');
  const { createRecorder } = await load('recorder.js');
  const handlers = new Map();
  const captureHandlers = [];
  const windowListeners = [];
  const originalWindowListener = window.addEventListener;
  window.addEventListener = function (type, fn, options) {
    windowListeners.push([type, options]);
    originalWindowListener.call(this, type, fn, options);
  };
  const dialog = {
    nodeType: 1, tagName: 'DIALOG', open: true, hidden: false, id: 'ayuda', classList: [],
    getAttribute: (name) => name === 'aria-label' ? 'Ayuda' : null,
    getClientRects: () => [1], querySelector: () => null
  };
  const uiDialog = { ...dialog, id: 'barra', ui: true };
  const hiddenDialog = { ...dialog, id: 'cerrado', hidden: true };
  let dialogs = [dialog, uiDialog, hiddenDialog];
  let observer;
  let observedOptions;
  class Observer {
    constructor(fn) { observer = fn; }
    observe(_root, options) { observedOptions = options; }
  }
  const document = {
    title: 'Página de prueba', documentElement: {},
    visibilityState: 'visible',
    addEventListener(type, fn, capture) { handlers.set(type, fn); captureHandlers.push([type, capture]); },
    dispatch(type, event = {}) { handlers.get(type)(event); },
    querySelector: (selector) => selector.includes('nombre') ? { textContent: 'Nombre asociado' } : null,
    querySelectorAll: () => dialogs,
    getElementById: () => null
  };
  const history = { pushState: () => 1, replaceState: () => 2 };
  const element = {
    nodeType: 1, tagName: 'INPUT', id: 'correo', type: 'text', value: 'privado',
    textContent: 'No guardar', classList: [], closest() { return this; },
    getAttribute: (name) => ({ name: 'correo', placeholder: 'Correo' })[name] ?? null
  };
  window.MutationObserver = Observer;
  window.open = () => 'ventana';
  window.alert = () => undefined;
  window.confirm = () => true;
  window.prompt = () => 'respuesta secreta';
  await withGlobals({ document, history, CSS: { escape: (x) => x }, MutationObserver: Observer,
    performance: { getEntriesByType: () => [{ type: 'reload' }] },
    getComputedStyle: () => ({ display: 'block', visibility: 'visible' }) }, async () => {
    let entry;
    const recorder = createRecorder({
      limits: { recordingMinutes: 30, recordingEvents: 100 },
      mask: { text: (x) => x, hidden: (el) => Boolean(el.private) }, tabId: 't1',
      isFromUi: () => false, isUiElement: (el) => Boolean(el.ui), dialogSelectors: ['dialog'],
      logs: { onEntry(fn) { entry = fn; } }
    });
    localStorage.setItem(LS.rec, JSON.stringify({ startedAt: Date.now(), count: 0 }));
    // Only the first call starts listening so another tab knows it joined.
    assert.equal(recorder.listen(), true);
    assert.equal(recorder.listen(), false);
    assert.deepEqual(captureHandlers.filter(([, capture]) => capture === true).map(([type]) => type),
      ['click', 'input', 'change', 'submit', 'keydown', 'transitionend', 'animationend']);
    assert.deepEqual(windowListeners.find(([type]) => type === 'scroll')[1], { passive: true });
    assert.deepEqual(observedOptions, { subtree: true, childList: true, attributes: true,
      attributeFilter: ['open', 'hidden', 'class', 'style', 'aria-hidden'] });
    assert.equal(recorder.openDialogs.size, 1);
    assert.equal(recorder.labelOf(null), '');
    assert.equal(recorder.labelOf({ private: true, nodeType: 1 }), '(oculto)');
    assert.equal(recorder.labelOf({ ...element, id: 'nombre', getAttribute: () => null }), 'Nombre asociado');
    assert.equal(recorder.labelOf({ ...element, id: '', getAttribute: (name) => name === 'aria-label' ? 'Correo accesible' : null }), 'Correo accesible');
    assert.equal(recorder.labelOf({ nodeType: 1, tagName: 'BUTTON', innerText: ' Guardar   ahora ',
      getAttribute: () => null }), 'Guardar ahora');
    assert.equal(recorder.labelOf({ nodeType: 1, tagName: 'TEXTAREA', textContent: 'secreto',
      getAttribute: (name) => name === 'placeholder' ? 'Comentario' : null }), 'Comentario');
    const labelledDialog = { ...dialog, getAttribute: (name) => name === 'aria-labelledby' ? 'titulo' : null };
    document.getElementById = () => ({ textContent: 'Título referenciado' });
    assert.equal(recorder.dialogTitle(labelledDialog), 'Título referenciado');
    document.getElementById = () => null;
    assert.equal(recorder.dialogTitle({ ...labelledDialog, querySelector: () => ({ textContent: 'Encabezado' }) }), 'Encabezado');
    assert.equal(recorder.dialogTitle({ ...labelledDialog, querySelector: () => null }), 'dialog#ayuda');
    document.dispatch('click', { target: element, clientX: 4.7, clientY: 6.2 });
    const nested = { ...element, tagName: 'SPAN', id: 'interior',
      closest: () => ({ ...element, tagName: 'BUTTON', id: 'exterior', innerText: 'Abrir' }) };
    document.dispatch('click', { target: nested, clientX: 9, clientY: 10 });
    document.dispatch('input', { target: element });
    document.dispatch('change', { target: { ...element, type: 'checkbox', checked: true } });
    document.dispatch('change', { target: { ...element, tagName: 'SELECT', options: [{ text: 'Primera' }],
      selectedIndex: 0, type: 'select-one' } });
    document.dispatch('submit', { target: { ...element, tagName: 'FORM',
      querySelector: () => null,
      getAttribute: (name) => ({ action: '/enviar/?clave=privado', method: 'post' })[name] ?? null } });
    assert.equal(recorder.buffer.length, 0);
    document.dispatch('keydown', { target: element, key: 'Enter' });
    document.dispatch('keydown', { target: element, key: 'Escape' });
    document.dispatch('keydown', { target: element, key: 'a' });
    document.dispatch('visibilitychange');
    assert.equal(recorder.buffer.length, 0);
    history.pushState();
    history.replaceState();
    recorder.flush();
    window.open('/other/?dato=privado');
    assert.equal(recorder.buffer.length, 0);
    window.alert('Atención');
    assert.equal(recorder.buffer.length, 0);
    window.confirm('¿Seguir?');
    window.prompt('Nombre');
    assert.equal(recorder.buffer.length, 0);
    window.dispatch('hashchange', {});
    window.dispatch('popstate', {});
    window.dispatch('beforeprint', {});
    assert.equal(recorder.buffer.length, 0);
    window.scrollY = 42.4;
    window.innerWidth = 800;
    window.innerHeight = 600;
    window.dispatch('scroll', {});
    window.dispatch('resize', {});
    entry({ type: 'console', level: 'warn', message: 'texto privado' });
    recorder.recordPage('token');
    assert.equal(recorder.buffer.length, 0);
    await new Promise((resolve) => setTimeout(resolve, 720));
    dialogs = [];
    observer();
    await new Promise((resolve) => setTimeout(resolve, 90));
    window.dispatch('pagehide', {});
    const events = recorder.mergedEvents();
    assert.ok(events.some((e) => e.type === 'click' && e.label === 'Correo'));
    assert.ok(events.some((e) => e.type === 'click' && e.target.startsWith('button#exterior')));
    assert.ok(events.some((e) => e.type === 'input' && e.size === '7 caracteres'));
    assert.ok(events.some((e) => e.type === 'change' && e.value === 'marcado'));
    assert.ok(events.some((e) => e.type === 'change' && e.value === 'Primera'));
    assert.ok(events.some((e) => e.type === 'submit' && e.url === '/enviar/?clave=…' && e.value === 'POST'));
    assert.deepEqual(events.filter((e) => e.type === 'key').map((e) => e.label), ['Enter', 'Escape']);
    assert.deepEqual(events.filter((e) => e.type === 'visibility').map((e) => e.label), ['visible']);
    assert.ok(events.some((e) => e.type === 'scroll' && e.y === 42));
    assert.ok(events.some((e) => e.type === 'resize' && e.size === '800×600'));
    assert.ok(events.some((e) => e.type === 'page' && e.value === 'reload' && e.token === 'token'));
    assert.equal(events.find((e) => e.type === 'page').label, 'Página de prueba');
    assert.deepEqual(events.filter((e) => e.type === 'dialog').map((e) => e.value), ['abierta', 'cerrada']);
    assert.deepEqual(events.filter((e) => e.type === 'nav').map((e) => e.label),
      ['pushState', 'replaceState', 'hash', 'atrás/adelante']);
    assert.ok(events.some((e) => e.type === 'open' && e.url === '/other/?dato=…'));
    assert.ok(events.some((e) => e.type === 'native' && e.label === 'prompt' && e.result === '(oculto)'));
    assert.ok(!JSON.stringify(events).includes('respuesta secreta'));
    assert.ok(!JSON.stringify(events).includes('texto privado'));
    recorder.end();
    assert.equal(recorder.active(), false);
    recorder.record('click', {}, true);
  });
});

test('masking removes sensitive fields and preserves dates', async () => {
  const { createMask, maskText } = await load('mask.js');
  assert.equal(maskText('2026-11-07 10:30', ['phone']), '2026-11-07 10:30');
  assert.ok(!maskText('ana@example.com +52 555 123 4567', ['email', 'phone']).includes('ana@'));
  const secret = field('password', 'clave');
  const selected = field('text', 'Ana');
  selected.closest = (selector) => selector === '.privado';
  const email = field('text', 'ana@example.com');
  const root = {
    querySelectorAll(selector) {
      if (selector === '.privado') return [selected];
      if (selector === 'input,textarea') return [secret, selected, email];
      return [];
    }
  };
  const mask = createMask({ selectors: ['.privado'], patterns: ['email'] });
  assert.equal(mask.hidden({ closest: (selector) => selector === '.privado' }), true);
  await withGlobals({ document: { createTreeWalker: () => ({ nextNode: () => null }) }, NodeFilter: { SHOW_TEXT: 4 } }, () => {
    assert.equal(mask.apply(root), 2);
  });
  assert.equal(secret.value, '');
  assert.equal(selected.value, '');
  assert.ok(!email.value.includes('ana@'));
});

test('masking visits visible text and skips script and style', async () => {
  const { createMask, fieldMask } = await load('mask.js');
  assert.deepEqual(fieldMask('password', false, 'clave', []), { value: '', clear: true, count: 0 });
  assert.deepEqual(fieldMask('text', false, 'normal', []), { value: 'normal', clear: false, count: 0 });
  const nodes = [
    { parentNode: { nodeName: 'P' }, nodeValue: 'ana@example.com' },
    { parentNode: { nodeName: 'SCRIPT' }, nodeValue: 'ana@example.com' },
    { parentNode: { nodeName: 'STYLE' }, nodeValue: 'ana@example.com' },
    { parentNode: { nodeName: 'P' }, nodeValue: 'normal' }
  ];
  const root = { querySelectorAll: () => [], ownerDocument: {
    createTreeWalker: () => { let i = 0; return { nextNode: () => nodes[i++] || null }; }
  } };
  await withGlobals({ NodeFilter: { SHOW_TEXT: 4 } }, () => {
    assert.equal(createMask({ patterns: ['email'] }).apply(root), 1);
  });
  assert.ok(!nodes[0].nodeValue.includes('ana@'));
  assert.equal(nodes[1].nodeValue, 'ana@example.com');
  assert.equal(nodes[2].nodeValue, 'ana@example.com');
});

function field(type, value) {
  const attrs = { type };
  return {
    value, textContent: 'original',
    style: { setProperty() {} },
    getAttribute: (name) => attrs[name] || null,
    setAttribute: (name, val) => { attrs[name] = val; },
    closest: () => false,
    querySelectorAll: () => []
  };
}

test('visible capture limits canvas and uses the html background', async () => {
  const calls = [];
  const style = { removed: false, setAttribute() {}, remove() { this.removed = true; } };
  const root = { clientWidth: 1000, scrollWidth: 20000, scrollHeight: 4000 };
  const body = { scrollWidth: 21000, scrollHeight: 4500 };
  const document = {
    documentElement: root, body,
    styleSheets: [{ href: 'https://fonts.googleapis.com/css?family=X', get cssRules() { throw Error('cors'); } }],
    createElement: () => style,
    head: { appendChild(node) { calls.push(node); } }
  };
  const window = {
    innerWidth: 900, innerHeight: 800, devicePixelRatio: 3, scrollX: 15, scrollY: 25,
    modernScreenshot: { domToCanvas: async (_node, options) => {
      calls.push(options);
      const cloneBody = { style: { setProperty(name, value) { calls.push([name, value]); } } };
      options.onCloneNode({ querySelector: () => cloneBody });
      return { toBlob(cb) { cb({ image: true }); } };
    } }
  };
  await withGlobals({ document, window, getComputedStyle: (node) => ({ backgroundColor: node === body ? 'transparent' : 'rgb(1, 2, 3)' }) }, async () => {
    const { createCapture } = await load('capture.js');
    const capture = createCapture({ libUrl: '/capture.js', mask: { apply() { calls.push('mask'); } } });
    assert.equal(capture.isCapturing(), false);
    assert.deepEqual(await capture.dom(false), { image: true });
    const shifts = () => calls.filter((item) => Array.isArray(item)).length;
    assert.equal(shifts(), 3);
    assert.deepEqual(await capture.dom(true), { image: true });
    assert.equal(shifts(), 3);
    window.scrollY = 0;
    await capture.dom(false);
    assert.equal(shifts(), 6);
    assert.ok(calls.some((item) => Array.isArray(item) && item[0] === 'left' && item[1] === '-15px'));
    window.scrollX = undefined;
    window.scrollY = undefined;
    await capture.dom(false);
    assert.equal(shifts(), 6);
    assert.equal(capture.isCapturing(), false);
  });
  const options = calls.find((item) => item && item.width);
  assert.deepEqual([options.width, options.height, options.scale, options.backgroundColor], [1000, 800, 2, 'rgb(1, 2, 3)']);
  assert.deepEqual(options.features, { restoreScrollPosition: true });
  assert.ok(calls.some((item) => item && item.width === 21000));
  assert.ok(calls.some((item) => Array.isArray(item) && item[0] === 'top' && item[1] === '-25px'));
  assert.equal(style.removed, true);
});

test('store falls back to memory without IndexedDB', async () => {
  await withGlobals({ window: { indexedDB: undefined } }, async () => {
    const { createStore } = await load('store.js');
    const store = createStore();
    assert.equal(store.persistent(), false);
    await store.put('drafts', { id: 'a', title: 'Uno' });
    await store.put('blobs', 'imagen', 'b');
    assert.deepEqual(await store.get('drafts', 'a'), { id: 'a', title: 'Uno' });
    assert.equal(await store.get('blobs', 'b'), 'imagen');
    await store.del('drafts', 'a');
    assert.equal(await store.get('drafts', 'a'), undefined);
  });
});

test('IndexedDB schema separates explicit keys from draft IDs', async () => {
  const { createStore } = await load('store.js');
  const records = { drafts: new Map(), blobs: new Map() };
  const opened = [];
  const schema = [];
  const database = { createObjectStore: (name, options) => schema.push([name, options]),
    transaction(name, mode) {
      opened.push([name, mode]);
      const transaction = { objectStore() { return {
        get(key) { const request = { result: records[name].get(key) }; queueMicrotask(() => transaction.oncomplete()); return request; },
        put(value, key) { records[name].set(key === undefined ? value.id : key, value);
          const request = { result: key }; queueMicrotask(() => transaction.oncomplete()); return request; },
        delete(key) { records[name].delete(key); const request = { result: undefined };
          queueMicrotask(() => transaction.oncomplete()); return request; }
      }; } };
      return transaction;
    } };
  const indexedDB = { open(name, version) {
    opened.push([name, version]);
    const request = { result: database };
    queueMicrotask(() => { request.onupgradeneeded(); request.onsuccess(); });
    return request;
  } };
  await withGlobals({ window: { indexedDB }, indexedDB }, async () => {
    const store = createStore();
    assert.equal(store.persistent(), true);
    await store.put('drafts', { id: 'd1', title: 'Uno' });
    await store.put('blobs', { id: 'distinto' }, 'b1');
    assert.deepEqual(await store.get('drafts', 'd1'), { id: 'd1', title: 'Uno' });
    assert.deepEqual(await store.get('blobs', 'b1'), { id: 'distinto' });
    assert.equal(await store.get('blobs', 'distinto'), undefined);
    await store.del('blobs', 'b1');
    assert.equal(await store.get('blobs', 'b1'), undefined);
  });
  assert.deepEqual(opened[0], ['ticketshot', 1]);
  assert.deepEqual(schema, [['drafts', { keyPath: 'id' }], ['blobs', undefined]]);
});

test('failed IndexedDB open keeps drafts in memory and stops claiming persistence', async () => {
  const { createStore } = await load('store.js');
  const indexedDB = { open() {
    const request = { error: new Error('no disponible') };
    queueMicrotask(() => request.onerror());
    return request;
  } };
  await withGlobals({ window: { indexedDB }, indexedDB }, async () => {
    const store = createStore();
    assert.equal(store.persistent(), true);
    await store.put('drafts', { id: 'd1', title: 'temporal' });
    assert.equal(store.persistent(), false);
    assert.deepEqual(await store.get('drafts', 'd1'), { id: 'd1', title: 'temporal' });
  });
});

test('a one-point stroke draws a visible mark', async () => {
  const { drawOp } = await load('draw.js');
  const calls = [];
  const ctx = new Proxy({}, { get(target, name) {
    if (name in target) return target[name];
    return (...args) => calls.push([name, ...args]);
  }, set(target, name, value) { target[name] = value; return true; } });
  drawOp(ctx, { t: 'pen', color: '#000', w: 3, pts: [[4, 5]] });
  assert.deepEqual(calls, [['save'], ['beginPath'], ['moveTo', 4, 5], ['lineTo', 4.1, 5.1], ['stroke'], ['restore']]);
});

test('capture limits preserve scale and distinguish borders', async () => {
  const { captureFrame, backgroundColor } = await load('capture.js');
  const base = { vw: 1000, vh: 500, rootWidth: 900, bodyWidth: 800,
    rootHeight: 450, bodyHeight: 400, pixelRatio: 1.5 };
  assert.deepEqual(captureFrame(true, base), { width: 1000, height: 500, scale: 1.5 });
  assert.deepEqual(captureFrame(false, { ...base, pixelRatio: 4 }),
    { width: 1000, height: 500, scale: 2 });
  assert.equal(captureFrame(true, { ...base, vw: 100, vh: 16000, pixelRatio: 1 }).scale, 1);
  assert.equal(captureFrame(true, { ...base, vw: 100, vh: 16001, pixelRatio: 1 }).scale,
    16000 / 16001);
  assert.equal(backgroundColor('', ''), '#ffffff');
  assert.equal(backgroundColor('rgba(0, 0, 0, 0)', 'blue'), 'blue');
  assert.equal(backgroundColor('transparent', 'transparent'), '#ffffff');
  assert.equal(captureFrame(false, { ...base, vw: 100, vh: 17000, pixelRatio: 1 }).scale,
    16000 / 17000);
  assert.equal(captureFrame(false, { ...base, vw: 5000, vh: 4000, pixelRatio: 1 }).scale,
    Math.sqrt(16e6 / 20e6));
  assert.equal(captureFrame(false, { ...base, vw: 4000, vh: 4000, pixelRatio: 1 }).scale, 1);
  assert.equal(captureFrame(false, { ...base, vw: 100, vh: 9000, pixelRatio: 2 }).scale,
    16000 / 9000);
  assert.equal(captureFrame(false, { ...base, vw: 4000, vh: 4000, pixelRatio: 2 }).scale, 1);
});

test('outside fonts missing body and horizontal scroll preserve capture', async () => {
  const { createCapture } = await load('capture.js');
  const styles = [];
  const document = { documentElement: { clientWidth: 600, scrollWidth: 600, scrollHeight: 500 },
    body: null, styleSheets: [
      { href: null, get cssRules() { throw new Error('cors'); } },
      { href: 'https://fonts.googleapis.com/css?family=A', get cssRules() { throw new Error('cors'); } },
      { href: 'https://fonts.bunny.net/css?family=B', get cssRules() { throw new Error('cors'); } },
      { href: 'https://evil.example/css', get cssRules() { throw new Error('cors'); } }
    ], createElement: () => ({ setAttribute() {}, remove() {} }),
    head: { appendChild: (style) => styles.push(style) } };
  const window = { innerWidth: 600, innerHeight: 500, devicePixelRatio: 1,
    scrollX: 12, scrollY: 34, modernScreenshot: { domToCanvas: async (_node, options) => {
      const properties = [];
      options.onCloneNode({ querySelector: () => ({ style: { setProperty: (...args) => properties.push(args) } }) });
      assert.ok(properties.some(([name, value]) => name === 'top' && value === '-34px'));
      assert.ok(properties.some(([name, value]) => name === 'left' && value === '-12px'));
      return { toBlob: (callback) => callback({ type: 'image/webp' }) };
    } } };
  await withGlobals({ document, window, getComputedStyle: (node) => {
    assert.equal(node, document.documentElement);
    return { backgroundColor: 'transparent' };
  } },
    async () => { await createCapture({ mask: { apply() {} } }).dom(false); });
  assert.equal(styles.length, 1);
  assert.equal(styles[0].textContent,
    '@import url("https://fonts.googleapis.com/css?family=A");\n' +
    '@import url("https://fonts.bunny.net/css?family=B");');
});

test('capture loader adds the script and reports download failures', async () => {
  const { createCapture } = await load('capture.js');
  let script;
  const document = { createElement: () => ({ setAttribute() {} }),
    head: { appendChild(node) { script = node; } } };
  const window = { modernScreenshot: null };
  await withGlobals({ document, window }, async () => {
    const capture = createCapture({ libUrl: '/vendor/captura.js' });
    const success = capture.load();
    assert.equal(script.src, '/vendor/captura.js');
    assert.equal(script.async, true);
    window.modernScreenshot = { ready: true };
    script.onload();
    assert.deepEqual(await success, { ready: true });
    window.modernScreenshot = null;
    const failure = capture.load();
    script.onerror();
    await assert.rejects(failure, /No se pudo cargar la herramienta/);
  });
});

test('failed DOM capture releases busy state', async () => {
  const { createCapture } = await load('capture.js');
  const root = { clientWidth: 100, scrollWidth: 100, scrollHeight: 100 };
  let rejectCapture;
  const window = { innerWidth: 100, innerHeight: 100, devicePixelRatio: 1, scrollX: 0, scrollY: 0,
    modernScreenshot: { domToCanvas: () => new Promise((_resolve, reject) => { rejectCapture = reject; }) } };
  const document = { body: root, documentElement: root, styleSheets: [] };
  await withGlobals({ document, window, getComputedStyle: () => ({ backgroundColor: '#fff' }) }, async () => {
    const capture = createCapture({ mask: { apply() {} } });
    const promise = capture.dom(false);
    assert.equal(capture.isCapturing(), true);
    await Promise.resolve();
    rejectCapture(new Error('falló el lienzo'));
    await assert.rejects(promise, /falló el lienzo/);
    assert.equal(capture.isCapturing(), false);
  });
});

test('exact capture depends on device and always stops the stream', async () => {
  const { createCapture } = await load('capture.js');
  let stopped = 0;
  const stream = { getTracks: () => [{ stop: () => stopped++ }] };
  const video = { play: async () => {}, videoWidth: 320, videoHeight: 200 };
  const draws = [];
  const canvas = { toBlob: (callback) => callback({ type: 'image/webp' }),
    getContext: () => ({ drawImage: (...args) => draws.push(args) }) };
  const document = { createElement: (tag) => tag === 'video' ? video : canvas };
  const requests = [];
  const navigator = { maxTouchPoints: 0, mediaDevices: { getDisplayMedia: async (options) => {
    requests.push(options); return stream;
  } } };
  await withGlobals({ document, navigator, matchMedia: () => ({ matches: false }) }, async () => {
    const capture = createCapture({});
    assert.equal(capture.isTouch(), false);
    assert.equal(capture.canExact(), true);
    assert.deepEqual(await capture.exact(), { type: 'image/webp' });
    assert.deepEqual([canvas.width, canvas.height, stopped], [320, 200, 1]);
    assert.deepEqual(requests, [{ video: { displaySurface: 'browser' }, audio: false,
      preferCurrentTab: true, selfBrowserSurface: 'include' }]);
    assert.equal(video.muted, true);
    assert.equal(video.playsInline, true);
    assert.equal(video.srcObject, stream);
    assert.deepEqual(draws, [[video, 0, 0]]);
    navigator.maxTouchPoints = 1;
    assert.equal(capture.canExact(), true);
  });
  await withGlobals({ navigator: { maxTouchPoints: 2, mediaDevices: { getDisplayMedia() {} } },
    matchMedia: () => ({ matches: true }) }, async () => {
    assert.equal(createCapture({}).canExact(), false);
  });
  await withGlobals({ navigator: { maxTouchPoints: 0 }, matchMedia: () => ({ matches: false }) },
    async () => { assert.equal(createCapture({}).canExact(), false); });
  await withGlobals({ navigator: {}, matchMedia: () => ({ matches: true }) },
    async () => { assert.equal(createCapture({}).isTouch(), false); });
  await withGlobals({ navigator: { maxTouchPoints: 0 }, matchMedia: () => ({ matches: true }) },
    async () => { assert.equal(createCapture({}).isTouch(), false); });
  await withGlobals({ navigator: { maxTouchPoints: 1 }, matchMedia: () => ({ matches: true }) },
    async () => { assert.equal(createCapture({}).isTouch(), true); });
});

test('recorder respects expiry limits and privacy on changes', async () => {
  fakeBrowser('https://site.test/route/?clave=secreto');
  const { LS } = await load('util.js');
  const { createRecorder, eventFromLog, describe, fieldChangeData } = await load('recorder.js');
  const element = { nodeType: 1, tagName: 'INPUT', id: 'campo', classList: ['uno', 'dos', 'tres'],
    value: 'escrito', getAttribute: (name) => ({ name: 'dato', type: 'password' })[name] || null };
  assert.equal(describe(element), 'input#campo[name=dato][type=password].uno.dos');
  assert.equal(describe(null), '');
  assert.deepEqual(eventFromLog({ type: 'console', level: 'warn', message: 'secreto' }),
    { status: undefined, label: 'warn' });
  assert.deepEqual(eventFromLog({ type: 'network', method: 'GET', url: '/ruta?clave=…', body: 'secreto' }),
    { status: undefined, label: 'GET', target: '/ruta?clave=…' });
  assert.deepEqual(fieldChangeData(element, '', 'select', false, '', false, (x) => x),
    { target: describe(element), label: '', value: '' });
  const recorder = createRecorder({ tabId: 't', limits: { recordingMinutes: 1, recordingEvents: 1 } });
  await withGlobals({ location: new URL('https://site.test/route/?clave=secreto') }, async () => {
    localStorage.setItem(LS.rec, JSON.stringify({ startedAt: Date.now() - 61000, count: 0 }));
    assert.equal(recorder.active(), true);
    assert.equal(recorder.state().expired, true);
    recorder.record('click', { label: 'ignorado' }, true);
    recorder.record('stop', { label: 'fin' }, true);
    assert.equal(recorder.mergedEvents().length, 1);
    assert.equal(recorder.mergedEvents()[0].url, '/route/?clave=…');
    localStorage.setItem(LS.rec, JSON.stringify({ startedAt: Date.now(), count: 1 }));
    recorder.record('click', {}, true);
    assert.equal(recorder.mergedEvents().filter((event) => event.type === 'limit').length, 1);
    assert.equal(recorder.state().limitHit, true);
    recorder.end();
  });
});

test('page title is masked before recording', async () => {
  fakeBrowser('https://site.test/profile/');
  const { createRecorder } = await load('recorder.js');
  const recorder = createRecorder({ tabId: 'titulo', limits: { recordingEvents: 100, recordingMinutes: 30 },
    isFromUi: () => false, dialogSelectors: [],
    mask: { hidden: () => false, text: (value) => value.replace(/\S+@\S+/g, '•••') } });
  const long = 'x'.repeat(200);
  await withGlobals({ document: { title: 'Perfil de ana@site.test ' + long } }, () => {
    assert.equal(recorder.pageTitle(), ('Perfil de ••• ' + long).slice(0, 120));
  });
  await withGlobals({ document: { title: '' } }, () => {
    assert.equal(recorder.pageTitle(), '');
  });
});

test('recorder filters bar events and recognizes fields and dialogs without values', async () => {
  fakeBrowser('https://site.test/form/?clave=secreto');
  const { LS } = await load('util.js');
  const { createRecorder } = await load('recorder.js');
  let isUi = false;
  let handler;
  let handled = 0;
  let labelLookups = 0;
  const document = { title: 'Formulario',
    querySelector: () => { labelLookups++; return { textContent: 'Asociado' }; },
    getElementById: (id) => id === 'primero' ? { textContent: 'Título' } : null };
  const recorder = createRecorder({ tabId: 'f', limits: { recordingEvents: 100, recordingMinutes: 30 },
    isFromUi: () => isUi, dialogSelectors: [],
    mask: { hidden: (el) => Boolean(el.private), text: (value) => value } });
  assert.equal(recorder.listening, false);
  assert.equal(recorder.dialogPending, false);
  recorder.on({ addEventListener: (_type, fn) => { handler = fn; } }, 'click', () => handled++);
  handler({});
  assert.equal(handled, 0);
  localStorage.setItem(LS.rec, JSON.stringify({ startedAt: Date.now(), count: 0 }));
  handler({});
  assert.equal(handled, 1);
  isUi = true;
  handler({});
  assert.equal(handled, 1);
  await withGlobals({ document, CSS: { escape: (value) => value },
    performance: { getEntriesByType: () => [{ type: 'navigate' }, { type: 'reload' }] } }, async () => {
    const input = { nodeType: 1, tagName: 'INPUT', id: 'correo', private: true,
      value: 'secreto', type: 'text',
      getAttribute: (name) => ({ 'aria-label': 'Correo', title: 'Ayuda' })[name] || null };
    assert.equal(recorder.labelOf(input), '(oculto)');
    assert.equal(recorder.labelData(input).associated, '');
    assert.equal(labelLookups, 0);
    assert.equal(recorder.labelData({ ...input, private: false, getAttribute: (name) =>
      name === 'aria-label' ? 'Correo' : null }).associated, '');
    assert.equal(recorder.labelData({ ...input, private: false, getAttribute: (name) =>
      name === 'title' ? 'Ayuda' : null }).associated, '');
    assert.equal(labelLookups, 0);
    const select = { ...input, tagName: 'SELECT', options: [{ text: 'secreto' }], selectedIndex: 0,
      getAttribute: () => null };
    assert.deepEqual(recorder.changeData(select), { target: 'select#correo', label: '(oculto)' });
    assert.equal(recorder.headingDialogTitle({ querySelector: () => ({ textContent: 'Otro' }) }, 'Accesible', ''), '');
    assert.equal(recorder.headingDialogTitle({ querySelector: () => ({ textContent: 'Otro' }) }, '', 'Referido'), '');
    assert.equal(recorder.referencedDialogTitle({ getAttribute: () => 'primero' }, 'Accesible'), '');
    assert.equal(recorder.referencedDialogTitle({ getAttribute: () => null }, ''), '');
    const dialog = { nodeType: 1, tagName: 'DIALOG', id: 'dialogo', classList: [],
      getAttribute: (name) => ({ 'aria-labelledby': 'primero segundo' })[name] || null,
      querySelector: () => ({ textContent: 'Alternativo' }) };
    assert.equal(recorder.dialogTitle(dialog), 'Título');
    const submitButton = { nodeType: 1, tagName: 'BUTTON', id: 'enviar', innerText: 'Enviar',
      getAttribute: () => null };
    recorder.onSubmit({ target: { nodeType: 1, tagName: 'FORM', id: 'f', classList: [],
      querySelector: () => submitButton,
      getAttribute: (name) => name === 'action' ? '/guardar/?clave=secreto' : null } });
    assert.ok(recorder.mergedEvents().some((event) => event.type === 'submit' &&
      event.label === 'Enviar' && event.url === '/guardar/?clave=…' && event.value === 'GET'));
    recorder.record('click', { label: 'primero' });
    const firstTimer = recorder.flushTimer;
    recorder.record('click', { label: 'segundo' });
    assert.equal(recorder.flushTimer, firstTimer);
    clearTimeout(firstTimer);
    recorder.flush();
    window.MutationObserver = class {};
    recorder.watchDialogs();
    recorder.active = () => false;
    recorder.scheduleDialogScan();
    assert.equal(recorder.dialogPending, true);
    await new Promise((resolve) => setTimeout(resolve, 70));
    assert.equal(recorder.dialogPending, false);
    recorder.active = () => true;
    recorder.recordPage('página');
    assert.equal(recorder.mergedEvents().find((event) => event.type === 'page').value, 'navigate');
  });
});

test('drafts reuse thumbnails and revoke old URLs', async () => {
  const { createDrafts, thumbKey, cachedThumbUrl } = await load('drafts.js');
  assert.equal(thumbKey({ id: 'uno' }), 'uno:0');
  assert.equal(thumbKey({ id: 'uno', ops: [{}, {}] }), 'uno:2');
  assert.equal(cachedThumbUrl({ key: 'uno:2', url: 'blob:ok' }, 'uno:2'), 'blob:ok');
  assert.equal(cachedThumbUrl({ key: 'uno:1', url: 'blob:vieja' }, 'uno:2'), null);
  assert.equal(cachedThumbUrl(undefined, 'uno:2'), null);
  const store = fakeStore();
  const draft = createDrafts(store, { all: () => [] });
  const image = { id: 'uno', ops: [] };
  let created = 0;
  const revoked = [];
  const blob = { naturalWidth: 640, naturalHeight: 320 };
  await store.put('blobs', blob, 'uno');
  await withGlobals({ URL: { createObjectURL: () => `blob:${++created}`,
    revokeObjectURL: (url) => revoked.push(url) },
  Image: class { set src(value) { this.naturalWidth = 640; this.naturalHeight = 320; this.onload(); } },
  document: { createElement: () => ({ getContext: () => ({ scale() {}, drawImage() {}, save() {}, restore() {} }),
    toBlob: (callback) => callback({ type: 'image/webp' }) }) } }, async () => {
    assert.equal(await draft.thumbUrl(image), 'blob:2');
    assert.equal(await draft.thumbUrl(image), 'blob:2');
    const thumb = { src: '' };
    draft.fillThumbs({ querySelector: (selector) => selector === '[data-thumb="uno"]' ? thumb : null },
      [image, { id: 'sin-imagen', ops: [] }]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(thumb.src, 'blob:2');
    const missingThumb = { src: 'sin cambiar' };
    draft.fillThumbs({ querySelector: () => missingThumb }, [{ id: 'sin-imagen', ops: [] }]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(missingThumb.src, 'sin cambiar');
    image.ops = [{ t: 'unknown' }];
    assert.equal(await draft.thumbUrl(image), 'blob:4');
    assert.ok(revoked.includes('blob:2'));
    await store.del('blobs', 'uno');
    assert.equal(await draft.thumbUrl({ ...image, ops: [{}, {}] }), '');
    draft.forgetThumb('uno');
    assert.ok(revoked.includes('blob:4'));
  });
});

test('attachment preserves name metadata and missing image errors', async () => {
  const { imageAttachment, imageMeta, appendImage } = await load('api.js');
  assert.deepEqual(imageAttachment(3, 'image/webp'), { field: 'image_3', filename: 'image_3.webp' });
  assert.deepEqual(imageAttachment(0, 'image/png'), { field: 'image_0', filename: 'image_0.png' });
  assert.deepEqual(imageAttachment(1, ''), { field: 'image_1', filename: 'image_1.png' });
  assert.equal(imageMeta({ ops: [] }, 'image_0').edited, false);
  assert.equal(imageMeta({ ops: [{}] }, 'image_0').edited, true);
  const form = { parts: [], append(...part) { this.parts.push(part); } };
  await assert.rejects(appendImage(form, { blob: async () => null }, { id: 'ausente' }, 2),
    /Falta la imagen 3/);
  assert.deepEqual(form.parts, []);
  let nextType = 'image/webp';
  const revoked = [];
  await withGlobals({ URL: { createObjectURL: () => 'blob:source', revokeObjectURL: (url) => revoked.push(url) },
    Image: class { set src(value) { this.naturalWidth = 20; this.naturalHeight = 10; this.onload(); } },
    document: { createElement: () => ({ getContext: () => ({ scale() {}, drawImage() {} }),
      toBlob: (callback) => callback({ type: nextType }) }) } }, async () => {
    const img = { id: 'presente', ops: [{ t: 'unknown' }], caption: 'Detalle' };
    const drafts = { blob: async () => ({ type: 'image/png' }) };
    assert.deepEqual(await appendImage(form, drafts, img, 0), imageMeta(img, 'image_0'));
    nextType = 'image/png';
    await appendImage(form, drafts, { id: 'segunda', ops: [] }, 1);
  });
  assert.deepEqual(form.parts.map(([name, , filename]) => [name, filename]),
    [['image_0', 'image_0.webp'], ['image_1', 'image_1.png']]);
  assert.deepEqual(revoked, ['blob:source', 'blob:source']);
});

test('masking ignores invalid roots without touching the DOM', async () => {
  const { createMask } = await load('mask.js');
  const mask = createMask({ selectors: ['.privado'], patterns: ['email'] });
  assert.equal(mask.apply(null), 0);
  assert.equal(mask.apply({}), 0);
});

test('arrow rectangle redaction and text draw visible geometry', async () => {
  const { drawOp } = await load('draw.js');
  const calls = [];
  const ctx = new Proxy({}, { get(target, name) {
    if (name in target) return target[name];
    return (...args) => calls.push([name, ...args]);
  }, set(target, name, value) { target[name] = value; return true; } });
  drawOp(ctx, { t: 'arrow', x1: 0, y1: 0, x2: 100, y2: 0, w: 2, color: '#f00' });
  assert.ok(calls.some((call) => call[0] === 'lineTo' && call[1] === 91.6 && call[2] === 0));
  assert.ok(calls.some((call) => call[0] === 'moveTo' && call[1] === 100 && call[2] === 0));
  calls.length = 0;
  drawOp(ctx, { t: 'box', x1: 20, y1: 30, x2: 5, y2: 7, w: 2, color: '#0f0' });
  assert.ok(calls.some((call) => call[0] === 'strokeRect' &&
    JSON.stringify(call.slice(1)) === JSON.stringify([5, 7, 15, 23])));
  calls.length = 0;
  drawOp(ctx, { t: 'redact', x1: 10, y1: 20, x2: 30, y2: 40, k: 2, color: '#000' });
  assert.ok(calls.some((call) => call[0] === 'fillRect' &&
    JSON.stringify(call.slice(1)) === JSON.stringify([10, 20, 20, 20])));
  assert.ok(calls.some((call) => call[0] === 'strokeRect' &&
    JSON.stringify(call.slice(1)) === JSON.stringify([11, 21, 18, 18])));
  calls.length = 0;
  drawOp(ctx, { t: 'text', text: 'uno\ndos', x: 4, y: 5, size: 20, color: '#ffffff' });
  assert.deepEqual(calls.filter((call) => call[0] === 'fillText'),
    [['fillText', 'uno', 4, 5], ['fillText', 'dos', 4, 30]]);
  calls.length = 0;
  drawOp(ctx, { t: 'desconocido' });
  assert.deepEqual(calls, []);
});

test('pure geometry preserves tips border and line spacing', async () => {
  const { arrowGeometry, redactionBorder, textLines } = await load('draw.js');
  const arrow = arrowGeometry({ x1: 0, y1: 0, x2: 100, y2: 0, w: 2 });
  assert.deepEqual(arrow.shaft, [91.6, 0]);
  assert.ok(arrow.left[1] > 0);
  assert.ok(arrow.right[1] < 0);
  assert.deepEqual(redactionBorder({ x1: 10, y1: 20, x2: 30, y2: 40, k: 2 }),
    { x: 11, y: 21, w: 18, h: 18, width: 2 });
  assert.deepEqual(redactionBorder({ x1: 2, y1: 3, x2: 2, y2: 3, k: 0 }),
    { x: 2.5, y: 3.5, w: 0, h: 0, width: 1 });
  assert.deepEqual(textLines({ text: 'uno\ndos', x: 4, y: 5, size: 20 }),
    [{ text: 'uno', x: 4, y: 5 }, { text: 'dos', x: 4, y: 30 }]);
  const vertical = arrowGeometry({ x1: 0, y1: 0, x2: 0, y2: 100, w: 2 });
  assert.ok(Math.abs(vertical.shaft[0]) < 1e-12);
  assert.equal(vertical.shaft[1], 91.6);
  assert.ok(Math.abs(vertical.left[0] + 5.206604869) < 1e-8);
  assert.ok(Math.abs(vertical.right[0] - 5.206604869) < 1e-8);
  assert.ok(Math.abs(vertical.left[1] - 89.188373585) < 1e-8);
  const thick = arrowGeometry({ x1: 0, y1: 0, x2: 100, y2: 0, w: 10 });
  assert.equal(thick.shaft[0], 68.5);
  assert.ok(Math.abs(thick.left[0] - 59.456400945) < 1e-8);
  assert.ok(Math.abs(thick.right[1] + 19.524768259) < 1e-8);
  assert.ok(Math.abs(arrow.left[0] - 89.188373585) < 1e-8);
  assert.ok(Math.abs(arrow.right[0] - 89.188373585) < 1e-8);
  assert.ok(Math.abs(arrow.left[1] - 5.206604869) < 1e-8);
  assert.ok(Math.abs(arrow.right[1] + 5.206604869) < 1e-8);
  const offset = arrowGeometry({ x1: 10, y1: 20, x2: 110, y2: 20, w: 2 });
  assert.deepEqual(offset.shaft, [101.6, 20]);
  assert.ok(Math.abs(offset.left[0] - 99.188373585) < 1e-8);
  assert.ok(Math.abs(offset.right[1] - 14.793395131) < 1e-8);
  const diagonal = arrowGeometry({ x1: 10, y1: 20, x2: 110, y2: 120, w: 2 });
  assert.ok(Math.abs(diagonal.shaft[0] - 104.060303039) < 1e-8);
  assert.ok(Math.abs(diagonal.shaft[1] - 114.060303039) < 1e-8);
});

test('canvas shows dotted border contrast and thumbnail scale', async () => {
  const { drawOp, flatten } = await load('draw.js');
  const calls = [];
  const ctx = new Proxy({}, { get(target, name) {
    if (name in target) return target[name];
    return (...args) => calls.push([name, ...args]);
  }, set(target, name, value) { calls.push(['set', name, value]); target[name] = value; return true; } });
  drawOp(ctx, { t: 'redact', x1: 0, y1: 0, x2: 30, y2: 30, k: 3, color: '#222' });
  assert.ok(calls.some((call) => call[0] === 'setLineDash' &&
    JSON.stringify(call[1]) === JSON.stringify([12, 9])));
  drawOp(ctx, { t: 'text', text: 'A', x: 2, y: 3, size: 5, color: '#ffffff' });
  assert.ok(calls.some((call) => call[0] === 'set' && call[1] === 'strokeStyle' && call[2] === '#111111'));
  assert.ok(calls.some((call) => call[0] === 'set' && call[1] === 'lineWidth' && call[2] === 2));
  drawOp(ctx, { t: 'text', text: 'B', x: 2, y: 3, size: 20, color: '#222222' });
  assert.ok(calls.some((call) => call[0] === 'set' && call[1] === 'strokeStyle' && call[2] === '#ffffff'));
  assert.ok(calls.some((call) => call[0] === 'set' && call[1] === 'lineWidth' && call[2] === 4));
  assert.ok(calls.some((call) => call[0] === 'set' && call[1] === 'font' &&
    call[2] === '600 20px system-ui, -apple-system, "Segoe UI", sans-serif'));
  const canvas = { getContext: () => ctx, toBlob: (callback) => callback({ type: 'image/webp' }) };
  await withGlobals({ URL: { createObjectURL: () => 'blob:source',
    revokeObjectURL: (url) => calls.push(['revoke', url]) },
    Image: class { set src(value) { this.naturalWidth = 1000; this.naturalHeight = 600; this.onload(); } },
    document: { createElement: () => canvas } }, async () => {
    assert.deepEqual(await flatten({ type: 'image/png' }, [{ t: 'box', x1: 1, y1: 2,
      x2: 4, y2: 6, w: 1, color: '#000' }], 400), { type: 'image/webp' });
  });
  assert.deepEqual([canvas.width, canvas.height], [400, 240]);
  assert.ok(calls.some((call) => call[0] === 'scale' && call[1] === 0.4 && call[2] === 0.4));
  assert.ok(calls.some((call) => call[0] === 'drawImage' && call[2] === 0 && call[3] === 0));
  assert.ok(calls.some((call) => call[0] === 'strokeRect' &&
    JSON.stringify(call.slice(1)) === JSON.stringify([1, 2, 3, 4])));
  assert.ok(calls.some((call) => call[0] === 'revoke' && call[1] === 'blob:source'));
});

function quietRecorder(createRecorder, tabId, extra = {}) {
  return createRecorder({ tabId, limits: { recordingMinutes: 30, recordingEvents: 100 },
    mask: { text: (t) => t, hidden: () => false }, isFromUi: () => false, isUiElement: () => false,
    logs: { onEntry() {} }, ...extra });
}

test('idle events flush together once after 400 ms', async () => {
  fakeBrowser('https://site.test/a/');
  const { LS } = await load('util.js');
  const { createRecorder } = await load('recorder.js');
  localStorage.setItem(LS.rec, JSON.stringify({ startedAt: Date.now(), count: 0 }));
  const timers = [];
  await withGlobals({ setTimeout: (fn, ms) => { timers.push([fn, ms]); return timers.length; } }, async () => {
    const recorder = quietRecorder(createRecorder, 'tz');
    recorder.record('scroll', { y: 1 });
    recorder.record('scroll', { y: 2 });
    assert.deepEqual(timers.map((t) => t[1]), [400]);
    assert.equal(localStorage.getItem(LS.events + 'tz'), null);
    timers[0][0]();
    assert.deepEqual(JSON.parse(localStorage.getItem(LS.events + 'tz')).map((e) => e.y), [1, 2]);
  });
});

test('site dialogs appear in recordings while bar dialogs do not', async () => {
  fakeBrowser('https://site.test/a/');
  const { LS } = await load('util.js');
  const { createRecorder } = await load('recorder.js');
  localStorage.setItem(LS.rec, JSON.stringify({ startedAt: Date.now(), count: 0 }));
  const site = { name: 'Confirmar pago' };
  const own = { name: 'Barra', ui: true };
  const hidden = { name: 'Oculta' };
  let present = [site, own, hidden];
  await withGlobals({ document: { querySelectorAll: () => present } }, async () => {
    const recorder = quietRecorder(createRecorder, 'td', { isUiElement: (el) => Boolean(el.ui) });
    recorder.dialogSelectors = 'dialog';
    recorder.dialogVisible = (el) => el !== hidden;
    recorder.dialogTitle = (el) => el.name;
    const dialogs = () => recorder.mergedEvents().filter((e) => e.type === 'dialog').map((e) => [e.label, e.value]);
    recorder.scanDialogs();
    assert.deepEqual(dialogs(), [['Confirmar pago', 'abierta']]);
    recorder.scanDialogs();
    assert.deepEqual(dialogs(), [['Confirmar pago', 'abierta']]);
    present = [];
    recorder.scanDialogs();
    assert.deepEqual(dialogs(), [['Confirmar pago', 'abierta'], ['Confirmar pago', 'cerrada']]);
  });
});
