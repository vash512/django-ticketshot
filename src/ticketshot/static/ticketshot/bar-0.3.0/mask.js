/*
 * Automatically hide content that must stay out of captures and logs.
 * Apply masking to the capture library's copy, never the live page.
 */

// Bound the email local part to 64 characters to prevent quadratic
// matching on long text without @. Keep the pattern in sync with
// anonymize.py through the shared mask cases.
const EMAIL = /[\w.+-]{1,64}@[\w-]+(\.[\w-]+)+/g;
// Require at least 10 phone digits so prices remain visible.
// ni fechas.
const PHONE = /\+?\d[\d\s().-]{6,}\d/g;
const DATE = /\d{4}-\d{2}-\d{2}/;

/**
 * Mask a page title supplied by the site before storing it in captures,
 * submissions, or recordings; it may echo search text.
 */
export function maskedTitle(mask) { return mask.text(document.title || ''); }

/** Mask email and phone text using active patterns. */
export function maskText(value, patterns) {
  let out = String(value || '');
  if (patterns.indexOf('email') >= 0) {
    out = out.replace(EMAIL, function (m) { return '•'.repeat(Math.min(m.length, 12)); });
  }
  if (patterns.indexOf('phone') >= 0) {
    out = out.replace(PHONE, function (m) {
// A timestamp also contains 10 digits; leave it intact.
      if (DATE.test(m)) return m;
      return m.replace(/\D/g, '').length >= 10 ? '•'.repeat(Math.min(m.length, 14)) : m;
    });
  }
  return out;
}

function block(el) {
  el.style.setProperty('color', 'transparent', 'important');
// The library copies computed -webkit-text-fill-color, which paints
// text even when the color property says otherwise.
  el.style.setProperty('-webkit-text-fill-color', 'transparent', 'important');
  el.style.setProperty('background', '#8b8f98', 'important');
  el.style.setProperty('border-radius', '3px', 'important');
  el.style.setProperty('text-shadow', 'none', 'important');
  el.querySelectorAll('img,svg,video,canvas,picture').forEach(function (m) {
    m.style.setProperty('visibility', 'hidden', 'important');
  });
}

/** Choose the value a field leaves in the capture copy. */
export function fieldMask(type, selected, value, patterns) {
  if (type === 'password' || selected) return { value: '', clear: true, count: 0 };
  const masked = maskText(value, patterns);
  return { value: masked, clear: false, count: masked !== value ? 1 : 0 };
}

class Mask {
  constructor(options) {
    this.selectors = (options.selectors || []).join(',');
    this.patterns = options.patterns || [];
    this.text = this.text.bind(this);
  }

  text(value) { return maskText(value, this.patterns); }

  hidden(el) {
    return !!(this.selectors && el && el.closest && el.closest(this.selectors));
  }

  maskFields(root) {
    let count = 0;
    root.querySelectorAll('input,textarea').forEach((el) => {
      const type = (el.getAttribute('type') || '').toLowerCase();
      const decision = fieldMask(type, this.hidden(el), el.value, this.patterns);
      if (decision.clear) {
        el.value = ''; el.setAttribute('value', ''); el.textContent = '';
        return;
      }
      if (decision.count) {
        el.value = decision.value; el.setAttribute('value', decision.value); count++;
      }
    });
    return count;
  }

  maskTextNodes(root) {
    let count = 0;
    const walker = (root.ownerDocument || document).createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
    let node;
    while ((node = walker.nextNode())) {
      const parent = node.parentNode && node.parentNode.nodeName;
      if (parent === 'SCRIPT' || parent === 'STYLE') continue;
      const masked = this.text(node.nodeValue);
      if (masked !== node.nodeValue) { node.nodeValue = masked; count++; }
    }
    return count;
  }

/** Mask the page copy and return the number of masked items. */
  apply(root) {
    if (!root || !root.querySelectorAll) return 0;
    let count = 0;
    if (this.selectors) root.querySelectorAll(this.selectors).forEach(function (el) { block(el); count++; });
    count += this.maskFields(root);
    if (this.patterns.length) count += this.maskTextNodes(root);
    return count;
  }
}

export function createMask(options) { return new Mask(options); }
