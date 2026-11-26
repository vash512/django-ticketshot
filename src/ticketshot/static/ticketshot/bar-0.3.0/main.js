/*
 * Ticketshot review bar entry point.
 *
 * TicketShotMiddleware injects this ES module before </body>.
 * This module reads page configuration and starts the bar; app.js
 * connects the components. Other modules receive their dependencies
 * and do not touch the page on import.
 *
 * Privacy: edit and flatten the image in the browser. Only the marked
 * and redacted version reaches the server. Originals and strokes stay
 * in this browser's IndexedDB until submission or discard.
 */
import { start } from './app.js';
import { embeddedInPanel } from './util.js';

function readConfig() {
  const node = document.getElementById('ticketshot-config');
  return node ? JSON.parse(node.textContent) : null;
}

const cfg = readConfig();
if (cfg && !embeddedInPanel(window, cfg.endpoints.panel) && !window.__ticketshot) {
  window.__ticketshot = { version: cfg.version };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', function () { start(cfg); });
  else start(cfg);
}
