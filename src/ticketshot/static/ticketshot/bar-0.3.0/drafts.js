/*
 * Current draft: captures in IndexedDB, marks, and thumbnails.
 * Originals and strokes remain in this browser and are deleted on
 * submission or discard.
 */
import { flatten } from './draw.js';
import { mergeLogs } from './logs.js';
import { LS, lsDel, lsGet, lsSet, uid } from './util.js';

/** Identify a thumbnail version by its marks. */
export function thumbKey(img) { return img.id + ':' + (img.ops || []).length; }

/** Return a stored URL only for the current version. */
export function cachedThumbUrl(thumb, key) { return thumb && thumb.key === key ? thumb.url : null; }

class Drafts {
  constructor(store, logs) {
    this.store = store;
    this.logs = logs;
// Cache thumbnails by image and mark version.
    this.thumbs = {};
  }

  current() {
    const id = lsGet(LS.draft, null);
    if (!id) return Promise.resolve(null);
    return this.store.get('drafts', id).then(function (draft) {
      if (!draft) lsDel(LS.draft);
      return draft || null;
    });
  }

  create(kind) {
    const draft = { id: uid(), kind: kind, createdAt: new Date().toISOString(),
                    note: '', images: [], logs: [] };
    return this.store.put('drafts', draft).then(function () {
      lsSet(LS.draft, draft.id);
      return draft;
    });
  }

  save(draft) { return this.store.put('drafts', draft).then(function () { return draft; }); }

  addImage(draft, blob, meta) {
    const self = this;
    const key = uid();
    return this.store.put('blobs', blob, key).then(function () {
      draft.images.push(Object.assign({ id: key, ops: [], caption: '' }, meta));
      draft.logs = mergeLogs(draft.logs || [], self.logs.all());
      return self.save(draft);
    });
  }

  removeImage(draft, id) {
    const self = this;
    draft.images = draft.images.filter(function (img) { return img.id !== id; });
    this.forgetThumb(id);
    return this.store.del('blobs', id).then(function () { return self.save(draft); });
  }

  discard(draft) {
    const self = this;
    if (!draft) return Promise.resolve();
    const jobs = draft.images.map(function (img) { self.forgetThumb(img.id); return self.store.del('blobs', img.id); });
    return Promise.all(jobs).then(function () { return self.store.del('drafts', draft.id); }).then(function () {
      if (lsGet(LS.draft, null) === draft.id) lsDel(LS.draft);
    });
  }

  blob(img) { return this.store.get('blobs', img.id); }

  persistent() { return this.store.persistent(); }

  forgetThumb(id) {
    if (this.thumbs[id]) { URL.revokeObjectURL(this.thumbs[id].url); delete this.thumbs[id]; }
  }

/** URL of an image thumbnail with its marks. */
  async thumbUrl(img) {
    const key = thumbKey(img);
    const cached = cachedThumbUrl(this.thumbs[img.id], key);
    if (cached) return cached;
    const blob = await this.blob(img);
    if (!blob) return '';
    const small = await flatten(blob, img.ops, 480);
    this.forgetThumb(img.id);
    const url = URL.createObjectURL(small);
    this.thumbs[img.id] = { key, url };
    return url;
  }

/** Fill thumbnail images in the container. */
  fillThumbs(container, images) {
    const self = this;
    images.forEach(function (img) {
      self.thumbUrl(img).then(function (url) {
        const el = container.querySelector('[data-thumb="' + img.id + '"]');
        if (el && url) el.src = url;
      });
    });
  }
}

export function createDrafts(store, logs) { return new Drafts(store, logs); }
