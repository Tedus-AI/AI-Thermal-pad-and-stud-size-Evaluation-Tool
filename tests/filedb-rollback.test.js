/*
 * fileDb（本機檔／離線資料庫）：寫入失敗時快取退回寫入前 —— 純 Node，不需瀏覽器。
 *   [A] 一般寫入：setDoc／updateDoc（函式 fields）／writeBatch／deleteDoc 都寫進檔案、version 遞增
 *   [B] 寫入失敗（沒有寫入權限）→ 例外丟出、快取沒有留下沒存成功的修改、之後的寫入不會把它帶進檔案
 *   [C] 版本衝突（別人寫過檔）→ ConflictError、快取換成磁碟上的最新內容
 *   [D] writeBatch 其中一筆的函式丟例外 → 整批不寫、快取不動
 * 執行：node tests/filedb-rollback.test.js
 */
'use strict';
const fs = require('fs'), path = require('path');
global.window = {}; global.indexedDB = { open() { const r = {}; setTimeout(() => r.onerror && r.onerror(new Error('no idb')), 0); return r; } };
const disk = { text: JSON.stringify({ version: 5, projects: { p1: { a: 1 } } }), failWrite: false, writes: 0 };
const handle = {
  name: 'thermal_db.json',
  async getFile() { return { async text() { return disk.text; } }; },
  async createWritable() {
    if (disk.failWrite) throw new Error('NotAllowedError');
    let buf = ''; return { async write(t) { buf = t; }, async close() { disk.text = buf; disk.writes++; } };
  },
};
window.showOpenFilePicker = async () => [handle];
eval(fs.readFileSync(path.join(__dirname, '..', 'fileDb.js'), 'utf8'));
const fileDb = window.fileDb;
let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; console.log('  ✅ ' + n); } else { fail++; console.log('  ❌ ' + n); } };
const db = () => JSON.parse(disk.text);
(async () => {
  await fileDb.pickFile();
  console.log('[A] 一般寫入');
  await fileDb.setDoc('projects', 'p2', { b: 2 });
  await fileDb.updateDoc('projects', 'p1', cur => ({ a: cur.a + 1 }));
  await fileDb.writeBatch([{ type: 'update', col: 'projects', id: 'p1', fields: { c: 3 } }, { type: 'set', col: 'tim_library', id: 't', data: { k: 5 } }]);
  ok('setDoc／updateDoc／writeBatch 都進檔案', db().projects.p2.b === 2 && db().projects.p1.a === 2 && db().projects.p1.c === 3 && db().tim_library.t.k === 5);
  ok('version 遞增', db().version > 5);
  await fileDb.deleteDoc('projects', 'p2');
  ok('deleteDoc 進檔案', db().projects.p2 === undefined);

  console.log('[B] 寫入失敗 → 快取退回');
  disk.failWrite = true;
  let err = null; try { await fileDb.updateDoc('projects', 'p1', { unsaved: 1 }); } catch (e) { err = e; }
  ok('例外丟出', !!err);
  ok('快取沒有留下沒存成功的修改', (await fileDb.getDoc('projects', 'p1')).unsaved === undefined);
  disk.failWrite = false;
  await fileDb.setDoc('projects', 'p3', { z: 1 });
  ok('之後的寫入不會把它帶進檔案', db().projects.p1.unsaved === undefined && db().projects.p3.z === 1);

  console.log('[C] 版本衝突');
  const ext = db(); ext.version += 100; ext.projects.pExt = { e: 1 }; disk.text = JSON.stringify(ext);
  err = null; try { await fileDb.setDoc('projects', 'p4', { q: 1 }); } catch (e) { err = e; }
  ok('ConflictError', err && err.name === 'ConflictError');
  ok('快取換成磁碟上的最新內容', (await fileDb.getDoc('projects', 'pExt')).e === 1 && (await fileDb.getDoc('projects', 'p4')) === null);

  console.log('[D] writeBatch 其中一筆丟例外');
  const w = disk.writes; err = null;
  try { await fileDb.writeBatch([{ type: 'update', col: 'projects', id: 'p1', fields: { ok: 1 } },
    { type: 'update', col: 'projects', id: 'p3', fields: () => { throw new Error('pending'); } }]); } catch (e) { err = e; }
  ok('例外丟出、沒有寫檔', err && err.message === 'pending' && disk.writes === w);
  ok('快取不動', (await fileDb.getDoc('projects', 'p1')).ok === undefined);

  console.log(`\n通過 ${pass} 項，失敗 ${fail} 項`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
