/*
 * Tvarin vault crypto — device-bound encryption for saved logins.
 *
 * A single AES-GCM 256 key lives in the extension's own IndexedDB as a
 * NON-EXTRACTABLE CryptoKey: the browser encrypts/decrypts with it but never
 * hands back its raw bytes — not to our code, not to anything reading the
 * profile files off disk. So saved passwords are never written in plaintext
 * and can't be lifted from disk, yet there's no master password to unlock.
 *
 * Runs in the EXTENSION context only (service worker / options page), where
 * IndexedDB is scoped to the extension's origin. Never load this into a
 * content script — there IndexedDB belongs to the visited page, which would
 * make the key both wrong (per-site) and reachable by the page.
 *
 * Exposes: globalThis.TvarinVault = { encrypt, decrypt }
 *   encrypt(text)        -> { iv, ct }   (both base64)
 *   decrypt({ iv, ct })  -> text
 */
(() => {
  "use strict";

  const DB_NAME = "tvarin-vault";
  const STORE = "keys";
  const KEY_ID = "deviceKey";

  function openDb() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(STORE)) {
          req.result.createObjectStore(STORE);
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  function idbGet(db, id) {
    return new Promise((resolve, reject) => {
      const req = db.transaction(STORE, "readonly").objectStore(STORE).get(id);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  function idbPut(db, id, value) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put(value, id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  // Cache the key promise so concurrent calls share one generate/lookup.
  let keyPromise = null;
  function getKey() {
    if (keyPromise) return keyPromise;
    keyPromise = (async () => {
      const db = await openDb();
      let key = await idbGet(db, KEY_ID);
      if (!key) {
        key = await crypto.subtle.generateKey(
          { name: "AES-GCM", length: 256 },
          false, // non-extractable: raw bytes never leave the browser
          ["encrypt", "decrypt"]
        );
        await idbPut(db, KEY_ID, key);
      }
      return key;
    })().catch((e) => {
      keyPromise = null; // let a later call retry
      throw e;
    });
    return keyPromise;
  }

  function toB64(buf) {
    const bytes = new Uint8Array(buf);
    let s = "";
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s);
  }

  function fromB64(s) {
    const bin = atob(s);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  }

  async function encrypt(plaintext) {
    const key = await getKey();
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      key,
      new TextEncoder().encode(String(plaintext == null ? "" : plaintext))
    );
    return { iv: toB64(iv), ct: toB64(ct.buffer || ct) };
  }

  async function decrypt(rec) {
    if (!rec || !rec.iv || !rec.ct) return "";
    const key = await getKey();
    const pt = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: fromB64(rec.iv) },
      key,
      fromB64(rec.ct)
    );
    return new TextDecoder().decode(pt);
  }

  globalThis.TvarinVault = { encrypt, decrypt };
})();
