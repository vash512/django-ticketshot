/*
 * Short question inside the bar. Avoid prompt(): the recorder watches
 * native dialogs, which also block the page.
 */
import { t } from './i18n.js';
import { esc } from './util.js';

export function askHtml(options, maxLength) {
  return '<div class="ts-sheet ts-sheet-sm" role="dialog" aria-modal="true" aria-labelledby="ts-ask-title">' +
      '<header class="ts-sheet-head"><h2 id="ts-ask-title">' + esc(options.title) + '</h2>' +
        t('<button type="button" class="ts-icon-btn" data-act="cancel" aria-label="Close">×</button></header>') +
      '<div class="ts-sheet-body">' +
        (options.text ? '<p class="ts-note">' + esc(options.text) + '</p>' : '') +
        '<label class="ts-field"><span>' + esc(options.label) + '</span>' +
          '<textarea rows="3" maxlength="' + maxLength + '" data-answer></textarea></label>' +
        '<p class="ts-error" data-error hidden></p>' +
      '</div>' +
      '<footer class="ts-sheet-foot"><span class="ts-grow"></span>' +
        t('<button type="button" class="ts-btn" data-act="cancel">Cancel</button>') +
        '<button type="button" class="ts-btn ts-primary" data-act="ok">' + esc(options.ok) + '</button>' +
      '</footer></div>';
}

/** Return an answer, or an error if a required answer is empty. */
export function checkAnswer(raw, options) {
  const answer = String(raw || '').trim();
  if (options.required && !answer) return { error: options.requiredText || t('Write something before continuing.') };
  return { answer: answer };
}

/** Question dialog; resolve receives text or null. */
class Question {
  constructor(root, maxLength, options, resolve) {
    const self = this;
    this.options = options;
    this.resolve = resolve;
    this.el = document.createElement('div');
    this.el.className = 'ts-modal';
    this.el.innerHTML = askHtml(options, maxLength);
    this.input = this.el.querySelector('[data-answer]');
    this.el.addEventListener('click', function (event) { self.onClick(event); });
    this.el.addEventListener('keydown', function (event) { self.onKey(event); });
    root.appendChild(this.el);
    this.input.focus();
  }

  done(value) {
    this.el.remove();
    this.resolve(value);
  }

  confirm() {
    const result = checkAnswer(this.input.value, this.options);
    if (result.error === undefined) { this.done(result.answer); return; }
    const error = this.el.querySelector('[data-error]');
    error.textContent = result.error;
    error.hidden = false;
    this.input.focus();
  }

  onClick(event) {
    const button = event.target.closest('button');
    const act = button ? button.dataset.act : '';
    if (act === 'cancel') this.done(null);
    else if (act === 'ok') this.confirm();
  }

  onKey(event) {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    this.done(null);
  }
}

/** Resolve with entered text, or null on cancellation. */
export function ask(root, maxLength, options) {
  return new Promise(function (resolve) { return new Question(root, maxLength, options, resolve); });
}
