// ==================== INDEXEDDB STORAGE ====================
const DB_NAME = 'shelldb', DB_VER = 1;
let _db = null;

function dbOpen() {
  if (_db) return Promise.resolve(_db);
  return new Promise((res, rej) => {
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = e => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains('history')) db.createObjectStore('history', { keyPath: 'ts' });
      if (!db.objectStoreNames.contains('scans'))   db.createObjectStore('scans',   { keyPath: 'ts' });
    };
    req.onsuccess = e => { _db = e.target.result; res(_db); };
    req.onerror   = e => rej(e.target.error);
  });
}

function dbGetAll(store) {
  return dbOpen().then(db => new Promise((res, rej) => {
    const req = db.transaction(store, 'readonly').objectStore(store).getAll();
    req.onsuccess = e => res(e.target.result.sort((a, b) => b.ts.localeCompare(a.ts)));
    req.onerror   = e => rej(e.target.error);
  }));
}

function dbPut(store, obj) {
  return dbOpen().then(db => new Promise((res, rej) => {
    const req = db.transaction(store, 'readwrite').objectStore(store).put(obj);
    req.onsuccess = () => res();
    req.onerror   = e => rej(e.target.error);
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

// Migrate any existing localStorage data once
dbOpen().then(() => {
  const oldScans = localStorage.getItem('shell_scans');
  const oldHist  = localStorage.getItem('shell_history');
  if (oldScans) {
    try { JSON.parse(oldScans).forEach(s => dbPut('scans', s)); } catch(_) {}
    localStorage.removeItem('shell_scans');
  }
  if (oldHist) {
    try { JSON.parse(oldHist).forEach(h => dbPut('history', h)); } catch(_) {}
    localStorage.removeItem('shell_history');
  }
});

// ==================== DB EXPORT / IMPORT ====================
function exportDB() {
  Promise.all([dbGetAll('history'), dbGetAll('scans')]).then(([history, scans]) => {
    const data = { version: 1, exported: new Date().toISOString(), history: history, scans: scans };
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
    if (history.length === 0 && scans.length === 0) { alert('No data found in file.'); return; }
    const mode = confirm(
      'Import ' + history.length + ' history + ' + scans.length + ' scan record(s).\n\n' +
      'OK = Merge with existing data\nCancel = Replace all existing data'
    );
    const work = mode
      ? Promise.resolve()
      : Promise.all([dbClear('history'), dbClear('scans')]);
    work.then(() => {
      const puts = [];
      history.forEach(h => { if (h && h.ts) puts.push(dbPut('history', h)); });
      scans.forEach(s => { if (s && s.ts) puts.push(dbPut('scans', s)); });
      return Promise.all(puts);
    }).then(() => {
      alert('Import complete (' + history.length + ' history, ' + scans.length + ' scans).');
      if (typeof renderHistory === 'function') renderHistory();
    }).catch(err => alert('Import error: ' + err));
  };
  reader.readAsText(file);
}
