/*
 * IndexedDB keeps drafts and images across navigation. When unavailable
 * (as in some private modes), memory storage loses the draft on
 * navigation and the bar warns the user.
 */

class Store {
  constructor() {
    this.memory = { drafts: {}, blobs: {} };
    this.dbPromise = null;
    this.available = !!window.indexedDB;
  }

  db() {
    if (!this.dbPromise) {
      this.dbPromise = new Promise(function (resolve, reject) {
        const request = indexedDB.open('ticketshot', 1);
        request.onupgradeneeded = function () {
          request.result.createObjectStore('drafts', { keyPath: 'id' });
          request.result.createObjectStore('blobs');
        };
        request.onsuccess = function () { resolve(request.result); };
        request.onerror = function () { reject(request.error); };
      }).catch(() => { this.available = false; return null; });
    }
    return this.dbPromise;
  }

  run(store, mode, action) {
    return this.db().then(function (database) {
      if (!database) return action(null);
      return new Promise(function (resolve, reject) {
        const tx = database.transaction(store, mode);
        const request = action(tx.objectStore(store));
        tx.oncomplete = function () { resolve(request ? request.result : undefined); };
        tx.onerror = function () { reject(tx.error); };
        tx.onabort = function () { reject(tx.error); };
      });
    });
  }

  persistent() { return this.available; }

  get(store, key) {
    return this.run(store, 'readonly', (s) => {
// In memory, run returns the action's value directly.
      if (!s) return this.memory[store][key];
      return s.get(key);
    });
  }

  put(store, value, key) {
    return this.run(store, 'readwrite', (s) => {
      const k = key === undefined ? value.id : key;
      if (!s) { this.memory[store][k] = value; return null; }
      return key === undefined ? s.put(value) : s.put(value, key);
    });
  }

  del(store, key) {
    return this.run(store, 'readwrite', (s) => {
      if (!s) { delete this.memory[store][key]; return null; }
      return s.delete(key);
    });
  }
}

export function createStore() { return new Store(); }
