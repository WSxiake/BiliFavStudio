/* Shared by the UI fallback and draft worker. History snapshots are immutable. */
(() => {
  'use strict';
  const encoded = new WeakMap();
  function textOf(value) {
    if (!value || typeof value !== 'object') return JSON.stringify(value);
    if (!encoded.has(value)) encoded.set(value, JSON.stringify(value));
    return encoded.get(value);
  }
  function encode(stack, redoStack, base) {
    const pool = [], ids = new Map(), encoder = new TextEncoder();
    const fields = ['order','deleted','extra','locked','pageSize','page','tags','itemTags','picked','anchor','lastBoxSize'];
    let bytes = 0;
    function pack(snapshot) {
      if (Array.isArray(snapshot)) snapshot = {...base, order: snapshot};
      const values = fields.map(key => snapshot[key]);
      const texts = values.map(textOf);
      const fresh = new Set(texts.filter(text => !ids.has(text)));
      const added = [...fresh].reduce((n,text) => n + encoder.encode(text).byteLength, 0);
      if (bytes + added > 4 * 1024 * 1024) return null;
      bytes += added;
      return texts.map((text,i) => {
        if (!ids.has(text)) { ids.set(text, pool.length); pool.push(values[i]); }
        return ids.get(text);
      });
    }
    const undo = [], redo = [];
    let stopUndo = false, stopRedo = false;
    for (let i = 1; i <= 60; i++) {
      for (const [source,output,stopped] of [[stack,undo,stopUndo],[redoStack,redo,stopRedo]]) {
        if (stopped || i > source.length) continue;
        const row = pack(source[source.length-i]);
        if (row) output.unshift(row);
        else if (output === undo) stopUndo = true; else stopRedo = true;
      }
    }
    return {version: 1, pool, undo, redo};
  }
  function serialize(job) {
    return JSON.stringify({media_id: job.media_id, title: job.title,
      draft: {...job.snapshot, original: job.original, history: encode(job.undo, job.redo, job.snapshot)}});
  }
  globalThis.BiliFavDraftCodec = {encode, serialize};
})();
