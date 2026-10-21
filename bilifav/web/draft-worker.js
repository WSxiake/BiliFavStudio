'use strict';
importScripts('draft-codec.js');
const snapshots = new Map();
self.onmessage = ({data}) => {
  if (data.type === 'snapshots') { for (const [id,snapshot] of data.fresh) snapshots.set(id,snapshot); return; }
  try {
    const job = data.job;
    for (const [id, snapshot] of job.fresh) snapshots.set(id,snapshot);
    const undo = job.undoIds.map(id => snapshots.get(id)), redo = job.redoIds.map(id => snapshots.get(id));
    if (undo.some(s => !s) || redo.some(s => !s)) throw new Error('草稿历史需要重新同步');
    const body = BiliFavDraftCodec.serialize({...job,undo,redo});
    const keep = new Set([...job.undoIds,...job.redoIds]);
    for (const id of snapshots.keys()) if (!keep.has(id)) snapshots.delete(id);
    self.postMessage({id: data.id, ok: true, body, keepIds:[...keep]});
  }
  catch (error) { self.postMessage({id: data.id, ok: false, error: String(error.message || error)}); }
};
