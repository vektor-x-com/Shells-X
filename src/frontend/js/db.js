// ==================== INDEXEDDB STORAGE ====================
const DB_NAME = 'shelldb', DB_VER = 3;
let _db = null;
let _dbOpenPromise = null;

function dbOpen() {
  if (_db) return Promise.resolve(_db);
  if (_dbOpenPromise) return _dbOpenPromise;
  _dbOpenPromise = new Promise((res, rej) => {
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = e => {
      const db = e.target.result;
      if (db.objectStoreNames.length > 0) {
        console.warn(
          'Shells-X: IndexedDB schema upgraded (v' + DB_VER + ') — ' +
          'local command history and scan cache were cleared for this origin.'
        );
      }
      // Clean slate — drop any prior stores and recreate the current schema
      Array.from(db.objectStoreNames).forEach(name => db.deleteObjectStore(name));
      db.createObjectStore('history', { keyPath: 'ts' });
      db.createObjectStore('scans', { keyPath: 'id' });
      // Composite key [scan_id, seq] — server-assigned seq is monotonic per scan,
      // so re-fetching the same byte range from the events file is idempotent.
      const results = db.createObjectStore('scan_results', { keyPath: ['scan_id', 'seq'] });
      results.createIndex('by_scan', 'scan_id', { unique: false });
    };
    req.onblocked = () => {
      // Another open tab is holding the DB at an older version. Surface it so
      // the user knows why nothing is rendering instead of staring at a spinner.
      console.warn('IndexedDB upgrade blocked — close other shell tabs and refresh');
      rej(new Error('DB upgrade blocked — close other shell tabs and refresh'));
    };
    req.onsuccess = e => {
      _db = e.target.result;
      _db.onversionchange = () => { _db.close(); _db = null; _dbOpenPromise = null; };
      res(_db);
    };
    req.onerror = e => {
      _dbOpenPromise = null;
      rej(e.target.error);
    };
  });
  return _dbOpenPromise;
}

function dbGetAll(store) {
  return dbOpen().then(db => new Promise((res, rej) => {
    const req = db.transaction(store, 'readonly').objectStore(store).getAll();
    req.onsuccess = e => {
      const rows = e.target.result;
      // history is keyed by ts (ISO string) — sort newest first
      if (store === 'history') rows.sort((a, b) => (b.ts || '').localeCompare(a.ts || ''));
      res(rows);
    };
    req.onerror   = e => rej(e.target.error);
  }));
}

function dbPut(store, obj) {
  return dbOpen().then(db => new Promise((res, rej) => {
    const req = db.transaction(store, 'readwrite').objectStore(store).put(obj);
    req.onsuccess = e => res(e.target.result);
    req.onerror   = e => rej(e.target.error);
  }));
}

function dbPutMany(store, objs) {
  if (!objs || !objs.length) return Promise.resolve();
  return dbOpen().then(db => new Promise((res, rej) => {
    const tx = db.transaction(store, 'readwrite');
    const os = tx.objectStore(store);
    objs.forEach(o => os.put(o));
    tx.oncomplete = () => res();
    tx.onerror    = e => rej(e.target.error);
  }));
}

function dbDelete(store, key) {
  return dbOpen().then(db => new Promise((res, rej) => {
    const req = db.transaction(store, 'readwrite').objectStore(store).delete(key);
    req.onsuccess = () => res();
    req.onerror   = e => rej(e.target.error);
  }));
}

function dbClear(store) {
  return dbOpen().then(db => new Promise((res, rej) => {
    const req = db.transaction(store, 'readwrite').objectStore(store).clear();
    req.onsuccess = () => res();
    req.onerror   = e => rej(e.target.error);
  }));
}

function dbGetByIndex(store, indexName, value) {
  return dbOpen().then(db => new Promise((res, rej) => {
    const req = db.transaction(store, 'readonly').objectStore(store).index(indexName).getAll(value);
    req.onsuccess = e => res(e.target.result);
    req.onerror   = e => rej(e.target.error);
  }));
}

function dbDeleteByIndex(store, indexName, value) {
  return dbOpen().then(db => new Promise((res, rej) => {
    const tx = db.transaction(store, 'readwrite');
    const os = tx.objectStore(store);
    const idx = os.index(indexName);
    const req = idx.openCursor(IDBKeyRange.only(value));
    req.onsuccess = e => {
      const cur = e.target.result;
      if (cur) { os.delete(cur.primaryKey); cur.continue(); }
    };
    tx.oncomplete = () => res();
    tx.onerror    = e => rej(e.target.error);
  }));
}

// ==================== DB EXPORT / IMPORT ====================
function exportDB() {
  Promise.all([dbGetAll('history'), dbGetAll('scans'), dbGetAll('scan_results')]).then(([history, scans, results]) => {
    const data = {
      version: 3,
      exported: new Date().toISOString(),
      history: history,
      scans: scans,
      scan_results: results,
    };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'shelldb_' + Date.now() + '.json';
    a.click();
  });
}

function importDB(input) {
  const file = input.files[0];
  if (!file) return;
  input.value = '';
  const reader = new FileReader();
  reader.onload = function(e) {
    let data;
    try { data = JSON.parse(e.target.result); } catch(_) { alert('Invalid JSON file.'); return; }
    if (!data || typeof data !== 'object') { alert('Invalid DB file format.'); return; }
    const history = Array.isArray(data.history) ? data.history : [];
    const scans = Array.isArray(data.scans) ? data.scans : [];
    const results = Array.isArray(data.scan_results) ? data.scan_results : [];
    if (history.length + scans.length + results.length === 0) { alert('No data found in file.'); return; }
    const mode = confirm(
      'Import ' + history.length + ' history, ' + scans.length + ' scans, ' + results.length + ' scan results.\n\n' +
      'OK = Merge with existing data\nCancel = Replace all existing data'
    );
    const work = mode
      ? Promise.resolve()
      : Promise.all([dbClear('history'), dbClear('scans'), dbClear('scan_results')]);
    work.then(() => Promise.all([
      dbPutMany('history', history.filter(h => h && h.ts)),
      dbPutMany('scans', scans.filter(s => s && s.id)),
      // strip legacy rowid from v2 exports; composite [scan_id,seq] is the key now
      dbPutMany('scan_results', results.filter(r => r && r.scan_id && typeof r.seq === 'number').map(r => { const { rowid, ...rest } = r; return rest; })),
    ])).then(() => {
      alert('Import complete (' + history.length + ' history, ' + scans.length + ' scans, ' + results.length + ' results).');
      if (typeof renderHistory === 'function') renderHistory();
      if (typeof renderScans === 'function') renderScans();
    }).catch(err => alert('Import error: ' + err));
  };
  reader.readAsText(file);
}
