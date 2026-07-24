/* db.js — 本地存储层
 * 聊天记录、persona 存 IndexedDB;轻量配置(key/model/主题/传感器开关)存 localStorage。
 * 所有数据只在本机,除 Anthropic API 请求外不发往任何地方。
 */
"use strict";

const DB = (() => {
  const DB_NAME = "companion";
  const DB_VER = 1;
  let _db = null;

  function open() {
    if (_db) return Promise.resolve(_db);
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VER);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains("messages")) {
          db.createObjectStore("messages", { keyPath: "id", autoIncrement: true });
        }
        if (!db.objectStoreNames.contains("kv")) {
          db.createObjectStore("kv"); // persona 等大文本
        }
      };
      req.onsuccess = () => { _db = req.result; resolve(_db); };
      req.onerror = () => reject(req.error);
    });
  }

  function tx(store, mode, fn) {
    return open().then(db => new Promise((resolve, reject) => {
      const t = db.transaction(store, mode);
      const s = t.objectStore(store);
      const out = fn(s);
      t.oncomplete = () => resolve(out && out.result !== undefined ? out.result : undefined);
      t.onerror = () => reject(t.error);
    }));
  }

  return {
    // ---- 消息 ----
    // msg: {role: "user"|"assistant", content, kind: "text"|"sensor"|"error", ts}
    addMessage(msg) { return tx("messages", "readwrite", s => s.add(msg)); },
    allMessages() {
      return open().then(db => new Promise((resolve, reject) => {
        const out = [];
        const cur = db.transaction("messages").objectStore("messages").openCursor();
        cur.onsuccess = () => {
          const c = cur.result;
          if (c) { out.push(c.value); c.continue(); } else resolve(out);
        };
        cur.onerror = () => reject(cur.error);
      }));
    },
    clearMessages() { return tx("messages", "readwrite", s => s.clear()); },

    // ---- persona ----
    setPersona(text) { return tx("kv", "readwrite", s => s.put(text, "persona")); },
    getPersona() { return tx("kv", "readonly", s => s.get("persona")); },
    clearPersona() { return tx("kv", "readwrite", s => s.delete("persona")); },
  };
})();

/* localStorage 配置 */
const CFG = {
  get(k, dflt) {
    const v = localStorage.getItem("cfg:" + k);
    return v === null ? dflt : JSON.parse(v);
  },
  set(k, v) { localStorage.setItem("cfg:" + k, JSON.stringify(v)); },
  del(k) { localStorage.removeItem("cfg:" + k); },
};
