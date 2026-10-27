// Storage for the todo app: tasks live client-side in IndexedDB, so they persist across reloads.
// Classic script (not a module), loaded after model.js (it uses DEFAULT_PRIORITY); its declarations
// are globals that app.js uses.

const DB_NAME = "todo-app";
const DB_VERSION = 1;
const STORE = "tasks";

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(STORE, { keyPath: "id", autoIncrement: true });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

// Runs fn against the tasks store in one transaction and resolves with the request's result.
function withStore(db, mode, fn) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const request = fn(tx.objectStore(STORE));
    tx.oncomplete = () => resolve(request.result);
    tx.onerror = () => reject(tx.error);
  });
}

const taskStore = {
  all: (db) => withStore(db, "readonly", (s) => s.getAll()),
  get: (db, id) => withStore(db, "readonly", (s) => s.get(id)),
  add: (db, { title, dueDate = null, tags = [], repeat = null, priority = DEFAULT_PRIORITY }) =>
    withStore(db, "readwrite", (s) => s.add({ title, done: false, dueDate, tags, repeat, priority, createdAt: Date.now() })),
  update: (db, task) => withStore(db, "readwrite", (s) => s.put(task)),
  remove: (db, id) => withStore(db, "readwrite", (s) => s.delete(id)),
};
