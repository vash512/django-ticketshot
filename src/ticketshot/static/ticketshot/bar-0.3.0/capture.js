/*
 * Capture the page from the DOM with modern-screenshot (MIT, loaded only
 * when needed), or capture the tab exactly with getDisplayMedia.
 */
import { toBlob } from './draw.js';
import { t } from './i18n.js';
import { wait } from './util.js';

// Approximate canvas limit on mobile browsers (16 megapixels).
const MAX_SIDE = 16000;
const MAX_AREA = 16e6;
// Cross-origin font stylesheets cannot be read, causing fallback fonts.
// A temporary @import in a local stylesheet lets the capture library
// fetch and embed those fonts when CORS allows it.
// Apply this only to font services.
const FONT_HOSTS = /^https:\/\/(fonts\.googleapis\.com|fonts\.bunny\.net|use\.typekit\.net)\//;
const UI_ATTR = 'data-ticketshot-ui';

function fontHelper() {
  const hrefs = [];
  Array.prototype.forEach.call(document.styleSheets, function (sheet) {
    try { void sheet.cssRules; } catch (e) {
      if (sheet.href && FONT_HOSTS.test(sheet.href)) hrefs.push(sheet.href);
    }
  });
  if (!hrefs.length) return null;
  const style = document.createElement('style');
  style.setAttribute(UI_ATTR, '');
  style.textContent = hrefs.map(function (href) { return '@import url("' + href + '");'; }).join('\n');
  document.head.appendChild(style);
  return style;
}

/** Choose the visible background from computed colors. */
export function backgroundColor(bodyColor, rootColor) {
  const transparent = function (c) { return !c || c === 'rgba(0, 0, 0, 0)' || c === 'transparent'; };
  const background = transparent(bodyColor) ? rootColor : bodyColor;
  return transparent(background) ? '#ffffff' : background;
}

function pageBackground() {
  return backgroundColor(getComputedStyle(document.body || document.documentElement).backgroundColor,
    getComputedStyle(document.documentElement).backgroundColor);
}

/** Canvas dimensions and scale for the viewport or full document. */
export function captureFrame(full, dimensions) {
  const { vw, vh, rootWidth, bodyWidth, rootHeight, bodyHeight, pixelRatio } = dimensions;
  const width = full ? Math.max(rootWidth, bodyWidth, vw) : vw;
  const height = full ? Math.max(rootHeight, bodyHeight, vh) : vh;
  let scale = Math.min(pixelRatio || 1, 2);
  if (height * scale > MAX_SIDE) scale = MAX_SIDE / height;
  if (width * height * scale * scale > MAX_AREA) scale = Math.sqrt(MAX_AREA / (width * height));
  return { width: width, height: height, scale: scale };
}

function frameFor(full) {
  const root = document.documentElement;
  const body = document.body || root;
  return captureFrame(full, { vw: root.clientWidth || window.innerWidth, vh: window.innerHeight,
    rootWidth: root.scrollWidth, bodyWidth: body.scrollWidth,
    rootHeight: root.scrollHeight, bodyHeight: body.scrollHeight,
    pixelRatio: window.devicePixelRatio });
}

/** Offset normal content in the copy; fixed content stays in place. */
function shiftClone(clone, sx, sy) {
  const cloneBody = clone.querySelector ? clone.querySelector('body') : null;
  if (!cloneBody) return;
  cloneBody.style.setProperty('position', 'relative', 'important');
  cloneBody.style.setProperty('top', (-sy) + 'px', 'important');
  cloneBody.style.setProperty('left', (-sx) + 'px', 'important');
}

class Capture {
  constructor(options) {
    this.options = options;
    this.capturing = 0;
    this.isCapturing = this.isCapturing.bind(this);
  }

  load() {
    if (window.modernScreenshot) return Promise.resolve(window.modernScreenshot);
    const libUrl = this.options.libUrl;
    return new Promise(function (resolve, reject) {
      const script = document.createElement('script');
      script.src = libUrl;
      script.async = true;
      script.setAttribute(UI_ATTR, '');
      script.onload = function () { resolve(window.modernScreenshot); };
      script.onerror = function () { reject(new Error(t('Could not load the capture tool.'))); };
      document.head.appendChild(script);
    });
  }

/** Reconstruct the viewport or full document from the DOM. */
  dom(full) {
    const size = frameFor(full);
    const sx = window.scrollX || 0;
    const sy = window.scrollY || 0;
    const fonts = fontHelper();
    this.capturing++;
    return this.load().then((lib) => {
      return lib.domToCanvas(document.documentElement, {
        width: size.width,
        height: size.height,
        scale: size.scale,
        backgroundColor: pageBackground(),
        timeout: 15000,
        features: { restoreScrollPosition: true },
        filter: captureFilter,
        onCloneNode: (clone) => {
          this.options.mask.apply(clone);
          if (!full && (sx || sy)) shiftClone(clone, sx, sy);
        }
      });
    }).then(toBlob).finally(() => {
      this.capturing = Math.max(0, this.capturing - 1);
      if (fonts) fonts.remove();
    });
  }

  isTouch() {
    return (navigator.maxTouchPoints || 0) > 0 && matchMedia('(pointer: coarse)').matches;
  }

  canExact() {
    return !!(navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia) && !this.isTouch();
  }

// Exact tab capture requests permission every time and matches the screen.
// Automatic masking does not apply; use manual redaction.
  exact() {
    let stream = null;
    return navigator.mediaDevices.getDisplayMedia({
      video: { displaySurface: 'browser' }, audio: false,
      preferCurrentTab: true, selfBrowserSurface: 'include'
    }).then(function (s) {
      stream = s;
      const video = document.createElement('video');
      video.muted = true;
      video.playsInline = true;
      video.srcObject = stream;
      return video.play().then(function () { return wait(350); }).then(function () {
        const canvas = document.createElement('canvas');
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        canvas.getContext('2d').drawImage(video, 0, 0);
        return toBlob(canvas);
      });
    }).finally(function () {
      if (stream) stream.getTracks().forEach(function (t) { t.stop(); });
    });
  }

// The library fetches outside fonts and images during capture.
  isCapturing() { return this.capturing > 0; }
}

/** Exclude the ticketshot interface from capture. */
export function captureFilter(node) {
  return !(node.nodeType === 1 && node.hasAttribute && node.hasAttribute(UI_ATTR));
}

export function createCapture(options) { return new Capture(options); }
