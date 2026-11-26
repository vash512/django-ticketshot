/*
 * Draw marks (pen, arrow, rectangle, text, and redaction) and flatten
 * the image in the browser. The server never receives pixels hidden
 * by redaction.
 */
import { t } from './i18n.js';

export function rectOf(op) {
  return { x: Math.min(op.x1, op.x2), y: Math.min(op.y1, op.y2),
           w: Math.abs(op.x2 - op.x1), h: Math.abs(op.y2 - op.y1) };
}

export function isRedaction(op) { return op.t === 'redact' || op.t === 'redact-brush'; }

export function redactionCount(ops) { return (ops || []).filter(isRedaction).length; }

/** Path points, including the minimum segment for a single point. */
export function strokeRoute(pts) {
  if (!pts.length) return [];
  return pts.length === 1 ? [pts[0], [pts[0][0] + 0.1, pts[0][1] + 0.1]] : pts;
}

function strokePath(ctx, pts) {
  const route = strokeRoute(pts);
  if (!route.length) return;
  ctx.beginPath();
  ctx.moveTo(route[0][0], route[0][1]);
  for (let i = 1; i < route.length; i++) ctx.lineTo(route[i][0], route[i][1]);
  ctx.stroke();
}

function drawStroke(ctx, op) {
  ctx.strokeStyle = op.color;
  ctx.lineWidth = op.w;
  strokePath(ctx, op.pts);
}

/** Arrow points before drawing. */
export function arrowGeometry(op) {
  const angle = Math.atan2(op.y2 - op.y1, op.x2 - op.x1);
  const head = Math.max(12, op.w * 4.5);
  return {
    shaft: [op.x2 - Math.cos(angle) * head * 0.7, op.y2 - Math.sin(angle) * head * 0.7],
    left: [op.x2 - head * Math.cos(angle - Math.PI / 7),
      op.y2 - head * Math.sin(angle - Math.PI / 7)],
    right: [op.x2 - head * Math.cos(angle + Math.PI / 7),
      op.y2 - head * Math.sin(angle + Math.PI / 7)]
  };
}

function drawArrow(ctx, op) {
  const points = arrowGeometry(op);
  ctx.strokeStyle = op.color;
  ctx.fillStyle = op.color;
  ctx.lineWidth = op.w;
  ctx.beginPath();
  ctx.moveTo(op.x1, op.y1);
  ctx.lineTo(...points.shaft);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(op.x2, op.y2);
  ctx.lineTo(...points.left);
  ctx.lineTo(...points.right);
  ctx.closePath();
  ctx.fill();
}

function drawBox(ctx, op) {
  const b = rectOf(op);
  ctx.strokeStyle = op.color;
  ctx.lineWidth = op.w;
  ctx.strokeRect(b.x, b.y, b.w, b.h);
}

/** Inner rectangle of the redaction border. */
export function redactionBorder(op) {
  const rect = rectOf(op);
  const width = Math.max(1, op.k);
  return { x: rect.x + width / 2, y: rect.y + width / 2,
    w: Math.max(0, rect.w - width), h: Math.max(0, rect.h - width), width };
}

function drawRedaction(ctx, op) {
  const r = rectOf(op);
  const border = redactionBorder(op);
  ctx.fillStyle = op.color;
  ctx.fillRect(r.x, r.y, r.w, r.h);
// A subtle dotted border shows the reviewer where content was hidden,
// without looking like a gap in the design.
  ctx.setLineDash([op.k * 4, op.k * 3]);
  ctx.lineWidth = border.width;
  ctx.strokeStyle = 'rgba(80, 80, 80, 0.55)';
  ctx.strokeRect(border.x, border.y, border.w, border.h);
}

/** Position of each marked text line. */
export function textLines(op) {
  return String(op.text).split('\n').map((text, index) =>
    ({ text, x: op.x, y: op.y + index * op.size * 1.25 }));
}

function drawText(ctx, op) {
  ctx.font = '600 ' + op.size + 'px system-ui, -apple-system, "Segoe UI", sans-serif';
  ctx.textBaseline = 'top';
  ctx.lineWidth = Math.max(2, op.size / 5);
  ctx.strokeStyle = op.color === '#ffffff' ? '#111111' : '#ffffff';
  textLines(op).forEach(function (line) {
    ctx.strokeText(line.text, line.x, line.y);
    ctx.fillStyle = op.color;
    ctx.fillText(line.text, line.x, line.y);
  });
}

const PAINTERS = {
  pen: drawStroke,
  'redact-brush': drawStroke,
  arrow: drawArrow,
  box: drawBox,
  redact: drawRedaction,
  text: drawText
};

export function drawOp(ctx, op) {
  const paint = PAINTERS[op.t];
  if (!paint) return;
  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  paint(ctx, op);
  ctx.restore();
}

export function toBlob(canvas) {
  return new Promise(function (resolve, reject) {
    canvas.toBlob(function (blob) {
      if (blob) return resolve(blob);
      canvas.toBlob(function (png) {
        return png ? resolve(png) : reject(new Error(t('Could not generate the image.')));
      }, 'image/png');
    }, 'image/webp', 0.92);
  });
}

export function loadImage(blob) {
  return new Promise(function (resolve, reject) {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = function () { resolve({ img: img, url: url }); };
    img.onerror = function () { URL.revokeObjectURL(url); reject(new Error(t('Could not open the image.'))); };
    img.src = url;
  });
}

/** Flatten the image and marks into one bitmap, optionally resized. */
export function flatten(blob, ops, maxWidth) {
  return loadImage(blob).then((loaded) => flattenLoaded(loaded, ops, maxWidth));
}

/** Target dimensions for flattening. */
export function flattenedSize(width, height, maxWidth) {
  const ratio = maxWidth ? Math.min(1, maxWidth / width) : 1;
  return { width: Math.round(width * ratio), height: Math.round(height * ratio), ratio: ratio };
}

function flattenLoaded(loaded, ops, maxWidth) {
  const img = loaded.img;
  const size = flattenedSize(img.naturalWidth, img.naturalHeight, maxWidth);
  const canvas = document.createElement('canvas');
  canvas.width = size.width;
  canvas.height = size.height;
  const ctx = canvas.getContext('2d');
  ctx.scale(size.ratio, size.ratio);
  ctx.drawImage(img, 0, 0);
  (ops || []).forEach(function (op) { drawOp(ctx, op); });
  URL.revokeObjectURL(loaded.url);
  return toBlob(canvas);
}
