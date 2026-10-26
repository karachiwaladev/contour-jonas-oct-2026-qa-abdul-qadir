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
  add: (db, { title, dueDate = null, tags = [] }) =>
    withStore(db, "readwrite", (s) => s.add({ title, done: false, dueDate, tags, createdAt: Date.now() })),
  update: (db, task) => withStore(db, "readwrite", (s) => s.put(task)),
  remove: (db, id) => withStore(db, "readwrite", (s) => s.delete(id)),
};

// ---- Task helpers ----

// Comma-separated input → trimmed, lowercased, de-duplicated tags.
function parseTags(text) {
  const tags = (text || "").split(",").map((t) => t.trim().toLowerCase().slice(0, 30)).filter(Boolean);
  return [...new Set(tags)];
}

// Today's date as YYYY-MM-DD in local time, matching <input type="date"> values.
function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// "overdue" | "due-today" | null. Completed tasks are never flagged.
function dueStatus(task, today = todayISO()) {
  if (task.done || !task.dueDate) return null;
  if (task.dueDate < today) return "overdue";
  if (task.dueDate === today) return "due-today";
  return null;
}

function formatDate(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

// Tasks saved before due dates and tags existed lack those fields.
function normalize(task) {
  return { ...task, dueDate: task.dueDate || null, tags: Array.isArray(task.tags) ? task.tags : [] };
}

// Earliest due date first, undated tasks last, ties in creation order.
function compareTasks(a, b) {
  if (a.dueDate !== b.dueDate) {
    if (!a.dueDate) return 1;
    if (!b.dueDate) return -1;
    return a.dueDate < b.dueDate ? -1 : 1;
  }
  return a.createdAt - b.createdAt;
}

// ---- UI ----

const form = document.getElementById("new-task-form");
const input = document.getElementById("new-task-title");
const dueInput = document.getElementById("new-task-due");
const tagsInput = document.getElementById("new-task-tags");
const statusFilter = document.getElementById("status-filter");
const tagFilter = document.getElementById("tag-filter");
const list = document.getElementById("task-list");
const emptyState = document.getElementById("empty-state");
const summary = document.getElementById("summary");
const errorBox = document.getElementById("error");

// View state. Filters are not persisted; they reset on reload.
const view = { status: "all", tag: null, editingId: null };

let db;

function showError(err) {
  errorBox.textContent = `Something went wrong: ${err && err.message ? err.message : err}`;
  errorBox.hidden = false;
}

function el(tag, props = {}, children = []) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
}

function renderMeta(task) {
  const meta = el("div", { className: "task-meta" });
  if (task.dueDate) {
    meta.append(el("span", { className: "due", textContent: `Due ${formatDate(task.dueDate)}` }));
    const status = dueStatus(task);
    if (status) meta.append(el("span", { className: `badge ${status}`, textContent: status === "overdue" ? "Overdue" : "Due today" }));
  }
  for (const tag of task.tags) meta.append(el("span", { className: "chip tag", textContent: tag }));
  return meta;
}

function renderEditForm(task) {
  const due = el("input", { type: "date", value: task.dueDate || "", className: "edit-due" });
  due.setAttribute("aria-label", "Due date");
  const tags = el("input", { type: "text", value: task.tags.join(", "), placeholder: "work, urgent", className: "edit-tags" });
  tags.setAttribute("aria-label", "Tags");
  const save = el("button", { type: "submit", textContent: "Save", className: "save" });
  const cancel = el("button", { type: "button", textContent: "Cancel", className: "secondary cancel" });

  const editForm = el("form", { className: "edit-form" }, [due, tags, save, cancel]);
  editForm.addEventListener("submit", (event) => {
    event.preventDefault();
    view.editingId = null;
    run(() => taskStore.update(db, { ...task, dueDate: due.value || null, tags: parseTags(tags.value) }));
  });
  cancel.addEventListener("click", () => {
    view.editingId = null;
    run();
  });
  return editForm;
}

function renderTask(task) {
  const status = dueStatus(task);
  const item = el("li", { className: ["task", task.done && "done", status].filter(Boolean).join(" ") });
  item.dataset.id = task.id;

  const checkbox = el("input", { type: "checkbox", checked: task.done });
  checkbox.setAttribute("aria-label", `Mark "${task.title}" as ${task.done ? "not done" : "done"}`);
  checkbox.addEventListener("change", () => run(() => taskStore.update(db, { ...task, done: checkbox.checked })));

  // textContent, never innerHTML: titles and tags are user input
  const body = el("div", { className: "task-body" }, [el("div", { className: "task-title", textContent: task.title })]);
  body.append(view.editingId === task.id ? renderEditForm(task) : renderMeta(task));

  const edit = el("button", { type: "button", className: "edit", textContent: "Edit" });
  edit.setAttribute("aria-label", `Edit "${task.title}"`);
  edit.addEventListener("click", () => {
    view.editingId = view.editingId === task.id ? null : task.id;
    run();
  });
  const del = el("button", { type: "button", className: "delete", textContent: "Delete" });
  del.setAttribute("aria-label", `Delete "${task.title}"`);
  del.addEventListener("click", () => run(() => taskStore.remove(db, task.id)));

  item.append(checkbox, body, el("div", { className: "task-actions" }, [edit, del]));
  return item;
}

function renderTagFilter(allTags) {
  if (!allTags.length) return tagFilter.replaceChildren();
  const chip = (label, tag) => {
    const button = el("button", { type: "button", className: tag ? "chip" : "chip all", textContent: label });
    button.setAttribute("aria-pressed", String(view.tag === tag));
    if (tag) button.dataset.tag = tag;
    button.addEventListener("click", () => {
      view.tag = view.tag === tag ? null : tag;
      run();
    });
    return button;
  };
  tagFilter.replaceChildren(chip("All tags", null), ...allTags.map((tag) => chip(tag, tag)));
}

async function render() {
  const tasks = (await taskStore.all(db)).map(normalize).sort(compareTasks);
  const allTags = [...new Set(tasks.flatMap((t) => t.tags))].sort();
  if (view.tag && !allTags.includes(view.tag)) view.tag = null; // the tag's last task is gone

  const visible = tasks.filter((t) =>
    (view.status === "all" || (view.status === "done") === t.done) && (!view.tag || t.tags.includes(view.tag)));

  for (const button of statusFilter.querySelectorAll("button")) {
    button.setAttribute("aria-pressed", String(button.dataset.status === view.status));
  }
  renderTagFilter(allTags);
  list.replaceChildren(...visible.map(renderTask));

  emptyState.hidden = visible.length > 0;
  emptyState.textContent = tasks.length ? "No tasks match these filters." : "No tasks yet. Add one above.";
  const remaining = tasks.filter((t) => !t.done).length;
  const filtered = view.status !== "all" || view.tag;
  summary.textContent = tasks.length
    ? `${remaining} of ${tasks.length} remaining${filtered ? ` · showing ${visible.length}` : ""}`
    : "";
}

// Applies an optional change to the database, then re-renders from the stored state.
// Waits for the database to open first, so an early click or submit isn't lost.
async function run(change) {
  try {
    await ready;
    if (change) await change();
    await render();
  } catch (err) {
    showError(err);
  }
}

form.addEventListener("submit", (event) => {
  event.preventDefault();
  const title = input.value.trim();
  if (!title) return;
  const task = { title, dueDate: dueInput.value || null, tags: parseTags(tagsInput.value) };
  form.reset();
  run(() => taskStore.add(db, task));
});

statusFilter.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-status]");
  if (!button) return;
  view.status = button.dataset.status;
  run();
});

const ready = openDb()
  .then((opened) => {
    db = opened;
    return render();
  })
  .catch(showError);
