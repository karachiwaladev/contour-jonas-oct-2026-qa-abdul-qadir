// Todo app: tasks are stored client-side in IndexedDB, so they persist across reloads.
// Loaded as a classic script (not a module) so index.html also works when opened from disk.

const DB_NAME = "todo-app";
const DB_VERSION = 1;
const STORE = "tasks";

// ---- Storage (IndexedDB) ----

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
  add: (db, title) => withStore(db, "readwrite", (s) => s.add({ title, done: false, createdAt: Date.now() })),
  update: (db, task) => withStore(db, "readwrite", (s) => s.put(task)),
  remove: (db, id) => withStore(db, "readwrite", (s) => s.delete(id)),
};

// ---- UI ----

const form = document.getElementById("new-task-form");
const input = document.getElementById("new-task-title");
const list = document.getElementById("task-list");
const emptyState = document.getElementById("empty-state");
const summary = document.getElementById("summary");
const errorBox = document.getElementById("error");

let db;

function showError(err) {
  errorBox.textContent = `Something went wrong: ${err && err.message ? err.message : err}`;
  errorBox.hidden = false;
}

function renderTask(task) {
  const item = document.createElement("li");
  item.className = task.done ? "task done" : "task";

  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";
  checkbox.checked = task.done;
  checkbox.setAttribute("aria-label", `Mark "${task.title}" as ${task.done ? "not done" : "done"}`);
  checkbox.addEventListener("change", () => run(() => taskStore.update(db, { ...task, done: checkbox.checked })));

  const title = document.createElement("span");
  title.className = "task-title";
  title.textContent = task.title; // textContent, never innerHTML: task titles are user input

  const del = document.createElement("button");
  del.type = "button";
  del.className = "delete";
  del.textContent = "Delete";
  del.setAttribute("aria-label", `Delete "${task.title}"`);
  del.addEventListener("click", () => run(() => taskStore.remove(db, task.id)));

  item.append(checkbox, title, del);
  return item;
}

async function render() {
  const tasks = await taskStore.all(db);
  tasks.sort((a, b) => a.createdAt - b.createdAt);
  list.replaceChildren(...tasks.map(renderTask));
  emptyState.hidden = tasks.length > 0;
  const remaining = tasks.filter((t) => !t.done).length;
  summary.textContent = tasks.length ? `${remaining} of ${tasks.length} remaining` : "";
}

// Applies a change to the database, then re-renders from the stored state.
// Waits for the database to open first, so an early click or submit isn't lost.
async function run(change) {
  try {
    await ready;
    await change();
    await render();
  } catch (err) {
    showError(err);
  }
}

form.addEventListener("submit", (event) => {
  event.preventDefault();
  const title = input.value.trim();
  if (!title) return;
  input.value = "";
  run(() => taskStore.add(db, title));
});

const ready = openDb()
  .then((opened) => {
    db = opened;
    return render();
  })
  .catch(showError);
