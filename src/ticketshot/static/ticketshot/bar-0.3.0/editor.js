/*
 * Edit a capture with pen, arrow, rectangle, text, and redaction.
 * Marks are stored as operations with the draft and flattened on send.
 * al enviar.
 */
import { t, t as translate } from './i18n.js';
import { drawOp, loadImage, rectOf } from './draw.js';
import { esc } from './util.js';

// Same caption stored for each capture by the server.
const MAX_CAPTION = 500;

const COLORS = [
  { value: '#e5484d', label: 'Red' },
  { value: '#ffc53d', label: 'Yellow' },
  { value: '#3e63dd', label: 'Blue' },
  { value: '#111111', label: 'Black' },
  { value: '#ffffff', label: 'White' }
];
const SIZES = { fino: 2, medio: 4, grueso: 8 };
const TOOLS = [
  ['pen', 'Pen'], ['arrow', 'Arrow'], ['box', 'Rectangle'], ['text', 'Text'],
  ['redact', 'Redaction tool'], ['redact-brush', 'Freehand redaction tool']
];
const TOOL_ICONS = {
  pen: '<path d="m4 20 4-.8L20 7l-3-3L5 16zM14.5 6.5l3 3"/>',
  arrow: '<path d="M4 20 20 4M11 4h9v9"/>',
  box: '<rect x="4" y="4" width="16" height="16" rx="1"/>',
  text: '<path d="M4 6V4h16v2M12 4v16m-4 0h8"/>',
  redact: '<rect x="4" y="6" width="16" height="12" rx="1"/><path d="M7 10h10m-10 4h10"/>',
  'redact-brush': '<path d="m4 17 13-13 3 3L7 20H4zM4 20h4"/>',
  undo: '<path d="M9 7 4 12l5 5M4 12h9a6 6 0 0 1 6 6"/>',
  redo: '<path d="m15 7 5 5-5 5m5-5h-9a6 6 0 0 0-6 6"/>',
  clear: '<path d="M4 7h16M9 7V4h6v3M7 7l1 13h8l1-13M10 11v6m4-6v6"/>'
};

function toolIcon(name) {
  return '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + TOOL_ICONS[name] + '</svg>';
}
const HINTS = {
  pen: 'Draw freehand.',
  arrow: 'Drag from the origin to what you want to point at.',
  box: 'Drag to enclose an area.',
  text: 'Tap where the text goes, type it, and press Enter.',
  redact: 'Drag over what must be hidden: it is covered with a solid color.',
  'redact-brush': 'Paint over what must be hidden.'
};

function isRedactTool(tool) { return tool.indexOf('redact') === 0; }

export function markFromPointer(tool, point, color, width, scale, redactColor) {
  if (tool === 'pen' || tool === 'redact-brush') {
    return { t: tool, color: tool === 'pen' ? color : redactColor, w: width, pts: [point] };
  }
  return { t: tool, color: color, w: width, k: scale,
           x1: point[0], y1: point[1], x2: point[0], y2: point[1] };
}

export function markIsValid(op) {
  if (op.pts) return true;
  const r = rectOf(op);
  return r.w >= 3 || r.h >= 3;
}

export function marksAfterAction(ops, redo, action) {
  if (action === 'undo' && ops.length) return { ops: ops.slice(0, -1), redo: redo.concat(ops[ops.length - 1]) };
  if (action === 'redo' && redo.length) return { ops: ops.concat(redo[redo.length - 1]), redo: redo.slice(0, -1) };
  if (action === 'clear' && ops.length) return { ops: [], redo: ops.slice().reverse() };
  return { ops: ops, redo: redo };
}

export function dominantColor(colors) {
  const counts = {};
  let best = '#ffffff';
  let bestCount = 0;
  for (const d of colors) {
    const key = `rgb(${d[0] & 0xf8},${d[1] & 0xf8},${d[2] & 0xf8})`;
    counts[key] = (counts[key] || 0) + 1;
    if (counts[key] > bestCount) { bestCount = counts[key]; best = 'rgb(' + d[0] + ',' + d[1] + ',' + d[2] + ')'; }
  }
  return best;
}

export function previewMark(mark, redactColor) {
  return mark.t === 'redact' && redactColor === 'auto'
    ? Object.assign({}, mark, { color: 'rgba(120,120,120,0.55)' }) : mark;
}

export function pointFromRect(event, rect, canvasWidth) {
  const scale = canvasWidth / rect.width;
  return [Math.round((event.clientX - rect.left) * scale),
          Math.round((event.clientY - rect.top) * scale)];
}

export function perimeterPoints(rect, pad) {
  const points = [];
  for (let i = 0; i <= 8; i++) {
    const x = rect.x + (rect.w * i) / 8;
    const y = rect.y + (rect.h * i) / 8;
    points.push([x, rect.y - pad], [x, rect.y + rect.h + pad],
                [rect.x - pad, y], [rect.x + rect.w + pad, y]);
  }
  return points;
}

export function markWidth(tool, size, scale) {
  if (tool === 'redact-brush') return Math.round(26 * scale);
  return Math.max(1, Math.round(SIZES[size] * scale));
}

export function textMark(value, point, size, scale, color) {
  const text = value.trim();
  return text ? { t: 'text', text, x: point[0], y: point[1],
                  size: Math.round(size * scale), color } : null;
}

/** Capture note can be entered before marking; ticket note comes at send. */
function captionHtml(caption) {
  return t('<div class="ts-editor-note"><label><span>Note for this capture</span>') +
    '<input type="text" data-caption maxlength="' + MAX_CAPTION + '" value="' + esc(caption || '') + '"' +
    t(' placeholder="What should change here (optional)"></label>') +
    t('<p class="ts-editor-note-hint">You can add a general note when sending the ticket.</p></div>');
}

export function editorHtml(index, total, caption) {
  return '<header class="ts-editor-bar">' +
      t('<p class="ts-editor-title">Capture ') + (index + 1) + t(' of ') + total + '</p>' +
      '<div class="ts-editor-actions">' +
        t('<button type="button" class="ts-btn" data-act="cancel">Cancel</button>') +
        t('<button type="button" class="ts-btn ts-primary" data-act="done">Save</button>') +
      '</div></header>' + captionHtml(caption) +
      t('<div class="ts-tools" role="toolbar" aria-label="Tools">') +
        TOOLS.map(function (t) {
          return '<button type="button" class="ts-tool' + (isRedactTool(t[0]) ? ' ts-tool-redact' : '') +
                 '" data-tool="' + t[0] + '" aria-label="' + translate(t[1]) + '" title="' + translate(t[1]) +
                 '" aria-pressed="false">' + toolIcon(t[0]) + '</button>';
        }).join('') +
        '<span class="ts-tool-divider" aria-hidden="true"></span>' +
        [['undo', t('Undo')], ['redo', t('Redo')], ['clear', t('Remove all')]].map(function (item) {
          return '<button type="button" class="ts-tool" data-act="' + item[0] + '" aria-label="' + t(item[1]) +
            '" title="' + t(item[1]) + '">' + toolIcon(item[0]) + '</button>';
        }).join('') +
      '</div>' +
      '<div class="ts-editor-options"><div class="ts-row ts-draw-opts">' +
        '<div class="ts-swatches" role="group" aria-label="Color">' +
          COLORS.map(function (c) {
            return '<button type="button" class="ts-swatch" data-color="' + c.value + '" style="--c:' + c.value +
                   '" aria-label="' + t(c.label) + '" title="' + t(c.label) + '" aria-pressed="false"></button>';
          }).join('') +
        '</div>' +
        t('<label class="ts-select">Thickness <select data-size>') +
          t('<option value="fino">Thin</option><option value="medio" selected>Medium</option>') +
          t('<option value="grueso">Thick</option></select></label>') +
      '</div><div class="ts-row ts-redact-opts" hidden>' +
        t('<label class="ts-select">Redaction color <select data-redact-color>') +
          t('<option value="auto" selected>Background color</option><option value="#ffffff">White</option>') +
          t('<option value="#111111">Black</option></select></label>') +
      '</div></div>' +
    '<div class="ts-stage"><div class="ts-canvas-wrap">' +
      t('<canvas class="ts-canvas" aria-label="Capture to edit"></canvas>') +
      t('<textarea class="ts-text-input" rows="1" hidden aria-label="Annotation text"></textarea>') +
    '</div></div>' +
    '<p class="ts-editor-hint" aria-live="polite"></p>';
}

function isEditable(el) {
  return !!el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName || ''));
}

/**
 * Map editor keys to cancel, undo, redo, or null. In an input field,
 * Ctrl+Z belongs to the field, not the marks.
 */
export function editorKeyAction(event, textOpen, inEditable) {
  if (event.key === 'Escape') return textOpen ? null : 'cancel';
  const undo = (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z';
  if (!undo || inEditable) return null;
  return event.shiftKey ? 'redo' : 'undo';
}

export class Editor {
/** Open the editor in the bar's Shadow DOM; return marks or null. */
  constructor(root, img, blob, index, total) {
    this.root = root;
    this.img = img;
    this.blob = blob;
    this.index = index;
    this.total = total;
    this.caption = img.caption || '';
    this.ops = (img.ops || []).slice();
    this.redo = [];
    this.tool = 'pen';
    this.color = COLORS[0].value;
    this.size = 'medio';
    this.redactColor = 'auto';
    this.current = null;
  }

  open() {
    const self = this;
    return loadImage(this.blob).then(function (loaded) {
      self.base = loaded.img;
      self.baseUrl = loaded.url;
      self.sampler = document.createElement('canvas');
      self.sampler.width = self.base.naturalWidth;
      self.sampler.height = self.base.naturalHeight;
      self.samplerCtx = self.sampler.getContext('2d', { willReadFrequently: true });
      self.samplerCtx.drawImage(self.base, 0, 0);
      return new Promise(function (resolve) {
        self.resolve = resolve;
        self.mount();
      });
    });
  }

  mount() {
    const el = document.createElement('div');
    el.className = 'ts-editor';
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-modal', 'true');
    el.setAttribute('aria-label', t('Edit capture'));
    el.innerHTML = editorHtml(this.index, this.total, this.caption);
    this.el = el;
    this.canvas = el.querySelector('canvas');
    this.ctx = this.canvas.getContext('2d');
    this.canvas.width = this.base.naturalWidth;
    this.canvas.height = this.base.naturalHeight;
    this.textInput = el.querySelector('.ts-text-input');
    this.hint = el.querySelector('.ts-editor-hint');
    this.listen();
    this.root.appendChild(el);
    this.setTool('pen');
    this.setColor(this.color);
    this.render();
    el.querySelector('[data-tool="pen"]').focus();
  }

  listen() {
    const el = this.el;
    el.addEventListener('click', this.handleClick.bind(this));
    el.querySelector('[data-size]').addEventListener('change', this.handleSize.bind(this));
    el.querySelector('[data-redact-color]').addEventListener('change', this.handleRedactColor.bind(this));
    this.canvas.addEventListener('pointerdown', this.down.bind(this));
    this.canvas.addEventListener('pointermove', this.move.bind(this));
    this.canvas.addEventListener('pointerup', this.up.bind(this));
    this.canvas.addEventListener('pointercancel', this.up.bind(this));
    this.textInput.addEventListener('keydown', this.handleTextKey.bind(this));
    this.textInput.addEventListener('blur', this.commitText.bind(this));
    this.onKey = this.handleKey.bind(this);
    this.root.addEventListener('keydown', this.onKey);
  }

  handleClick(event) {
    const button = event.target.closest('button');
    if (!button) return;
    if (button.dataset.tool) this.setTool(button.dataset.tool);
    if (button.dataset.color) this.setColor(button.dataset.color);
    if (button.dataset.act) this.action(button.dataset.act);
  }

  handleSize(event) { this.size = event.target.value; }
  handleRedactColor(event) { this.redactColor = event.target.value; }

  handleTextKey(event) {
    if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); this.commitText(); }
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); this.cancelText(); }
  }

  handleKey(event) {
    const act = editorKeyAction(event, !this.textInput.hidden, isEditable(event.target));
    if (!act) return;
    event.preventDefault();
    this.action(act);
  }

  scale() { return this.canvas.width / (this.canvas.clientWidth || this.canvas.width); }

  point(event) {
    return pointFromRect(event, this.canvas.getBoundingClientRect(), this.canvas.width);
  }

  setTool(tool) {
    this.tool = tool;
    this.el.querySelectorAll('[data-tool]').forEach(function (b) {
      b.setAttribute('aria-pressed', String(b.dataset.tool === tool));
    });
    this.el.querySelector('.ts-draw-opts').hidden = isRedactTool(tool);
    this.el.querySelector('.ts-redact-opts').hidden = !isRedactTool(tool);
    this.hint.textContent = t(HINTS[tool]);
    this.canvas.style.cursor = tool === 'text' ? 'text' : 'crosshair';
  }

  setColor(color) {
    this.color = color;
    this.el.querySelectorAll('[data-color]').forEach(function (b) {
      b.setAttribute('aria-pressed', String(b.dataset.color === color));
    });
  }

// Match the surrounding color so redaction blends into backgrounds
// such as beige, white, or a card rather than leaving a patch.
  sample(points) {
    const ctx = this.samplerCtx;
    const w = this.sampler.width;
    const h = this.sampler.height;
    const colors = points.map(function (p) {
      const x = Math.max(0, Math.min(w - 1, p[0]));
      const y = Math.max(0, Math.min(h - 1, p[1]));
      return ctx.getImageData(x, y, 1, 1).data;
    });
    return dominantColor(colors);
  }

  perimeter(r) {
    return perimeterPoints(r, Math.round(3 * this.scale()));
  }

  width() {
    return markWidth(this.tool, this.size, this.scale());
  }

  brushColor(p) {
    if (this.tool === 'pen') return this.color;
    if (this.redactColor !== 'auto') return this.redactColor;
    return this.sample([p, [p[0] + 6, p[1]], [p[0], p[1] + 6], [p[0] - 6, p[1]]]);
  }

  down(event) {
    if (event.button !== undefined && event.button > 0) return;
    const p = this.point(event);
// Otherwise the canvas retains focus and typed text is lost.
    event.preventDefault();
    if (this.tool === 'text') { this.startText(p, event); return; }
    this.canvas.setPointerCapture(event.pointerId);
    const brushColor = this.tool === 'pen' || this.tool === 'redact-brush' ? this.brushColor(p) : null;
    this.current = markFromPointer(this.tool, p, this.color, this.width(), this.scale(), brushColor);
    this.render();
  }

  move(event) {
    if (!this.current) return;
    const p = this.point(event);
    if (this.current.pts) this.current.pts.push(p);
    else { this.current.x2 = p[0]; this.current.y2 = p[1]; }
    this.render();
  }

  up() {
    const op = this.current;
    if (!op) return;
    this.current = null;
    if (!op.pts) {
      const r = rectOf(op);
      if (!markIsValid(op)) { this.render(); return; }
      if (op.t === 'redact') {
        op.color = this.redactColor === 'auto' ? this.sample(this.perimeter(r)) : this.redactColor;
      }
    }
    this.push(op);
  }

  push(op) {
    this.ops.push(op);
    this.redo = [];
    this.render();
  }

  textSize() { return Math.max(14, SIZES[this.size] * 4); }

  startText(p, event) {
    const wrap = this.el.querySelector('.ts-canvas-wrap').getBoundingClientRect();
    const input = this.textInput;
    this.textPoint = p;
    input.hidden = false;
    input.value = '';
    input.style.left = (event.clientX - wrap.left) + 'px';
    input.style.top = (event.clientY - wrap.top) + 'px';
    input.style.color = this.color;
    input.style.fontSize = this.textSize() + 'px';
    input.focus();
    setTimeout(function () { input.focus(); }, 0);
  }

  commitText() {
    if (this.textInput.hidden) return;
    const text = this.textInput.value.trim();
    this.textInput.hidden = true;
    if (!text) return;
    this.push(textMark(text, this.textPoint, this.textSize(), this.scale(), this.color));
  }

  cancelText() { this.textInput.hidden = true; }

  render() {
    const ctx = this.ctx;
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.drawImage(this.base, 0, 0);
    for (const op of this.ops) drawOp(ctx, op);
    if (this.current) drawOp(ctx, previewMark(this.current, this.redactColor));
  }

  action(act) {
    if (act === 'undo' || act === 'redo' || act === 'clear') {
      const next = marksAfterAction(this.ops, this.redo, act);
      this.ops = next.ops;
      this.redo = next.redo;
      this.render();
      return;
    }
    if (act === 'cancel') this.close(null);
    if (act === 'done') this.close(this.ops);
  }

/** Null operations mean cancellation; save neither marks nor note. */
  close(ops) {
    const caption = this.el.querySelector('[data-caption]').value.trim().slice(0, MAX_CAPTION);
    this.root.removeEventListener('keydown', this.onKey);
    this.el.remove();
    URL.revokeObjectURL(this.baseUrl);
    this.resolve(ops === null ? null : { ops: ops, caption: caption });
  }
}
