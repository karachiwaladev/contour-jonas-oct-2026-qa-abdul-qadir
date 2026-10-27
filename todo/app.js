// Todo app UI: rendering, forms, filters and actions. Storage is in store.js and the task rules
// in model.js; all three are classic scripts (not modules) so index.html also works from disk.

// Marks a task done or not done. Completing a repeating task also creates its next
// occurrence, once: nextCreated stops un-tick/re-tick from making duplicates.
// Re-reads the stored task first, so a quick click on a not-yet-re-rendered row can't
// write stale fields (e.g. a repeat that was just removed) back to the database.
async function setDone(staleTask, done) {
  const stored = await taskStore.get(db, staleTask.id);
  if (!stored) return; // deleted in the meantime
  const task = normalize(stored);
  const updated = { ...task, done };
  if (done && task.repeat && !task.nextCreated) {
    updated.nextCreated = true;
    const dueDate = nextDueDate(task.dueDate || todayISO(), task.repeat);
    await taskStore.add(db, { title: task.title, dueDate, tags: task.tags, repeat: task.repeat, priority: task.priority });
  }
  await taskStore.update(db, updated);
}

const form = document.getElementById("new-task-form");
const input = document.getElementById("new-task-title");
const dueInput = document.getElementById("new-task-due");
const tagsInput = document.getElementById("new-task-tags");
const repeatUnitInput = document.getElementById("new-task-repeat");
const repeatEveryInput = document.getElementById("new-task-every");
const priorityInput = document.getElementById("new-task-priority");
const statusFilter = document.getElementById("status-filter");
const priorityFilter = document.getElementById("priority-filter");
const tagFilter = document.getElementById("tag-filter");
const list = document.getElementById("task-list");
const emptyState = document.getElementById("empty-state");
const summary = document.getElementById("summary");
const errorBox = document.getElementById("error");

// View state. Filters are not persisted; they reset on reload.
const view = { status: "all", priority: null, tag: null, editingId: null };

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
  meta.append(el("span", { className: `chip priority priority-${task.priority}`, textContent: priorityLabel(task.priority) }));
  if (task.dueDate) {
    meta.append(el("span", { className: "due", textContent: `Due ${formatDate(task.dueDate)}` }));
    const status = dueStatus(task);
    if (status) meta.append(el("span", { className: `badge ${status}`, textContent: status === "overdue" ? "Overdue" : "Due today" }));
  }
  if (task.repeat) meta.append(el("span", { className: "chip repeat", textContent: `↻ ${repeatLabel(task.repeat)}` }));
  for (const tag of task.tags) meta.append(el("span", { className: "chip tag", textContent: tag }));
  return meta;
}

// The interval only matters when a unit is chosen.
function syncRepeatEvery(unitSelect, everyInput) {
  everyInput.disabled = !REPEAT_UNITS.includes(unitSelect.value);
}

// Builds the "Repeat every [N] [unit]" controls used by the edit form (the add form is in index.html).
function renderRepeatControls(repeat) {
  const every = el("input", { type: "number", min: 1, max: 99, value: repeat ? repeat.every : 1, className: "edit-every" });
  every.setAttribute("aria-label", "Repeat interval");
  const unit = el("select", { className: "edit-repeat" }, [
    el("option", { value: "", textContent: "Does not repeat" }),
    ...REPEAT_UNITS.map((u) => el("option", { value: u, textContent: `${u}(s)` })),
  ]);
  unit.setAttribute("aria-label", "Repeat");
  unit.value = repeat ? repeat.unit : "";
  syncRepeatEvery(unit, every);
  unit.addEventListener("change", () => syncRepeatEvery(unit, every));
  return { every, unit, wrapper: el("span", { className: "repeat-field" }, [el("span", { textContent: "Repeat every" }), every, unit]) };
}

// The priority select used by the edit form (the add form's is in index.html).
function renderPrioritySelect(priority) {
  const select = el("select", { className: "edit-priority" }, PRIORITIES.map((p) => el("option", { value: p, textContent: priorityLabel(p) })));
  select.setAttribute("aria-label", "Priority");
  select.value = priority;
  return select;
}

function renderEditForm(task) {
  const due = el("input", { type: "date", value: task.dueDate || "", className: "edit-due" });
  due.setAttribute("aria-label", "Due date");
  const tags = el("input", { type: "text", value: task.tags.join(", "), placeholder: "work, urgent", className: "edit-tags" });
  tags.setAttribute("aria-label", "Tags");
  const priority = renderPrioritySelect(task.priority);
  const repeatControls = renderRepeatControls(task.repeat);
  const save = el("button", { type: "submit", textContent: "Save", className: "save" });
  const cancel = el("button", { type: "button", textContent: "Cancel", className: "secondary cancel" });

  const editForm = el("form", { className: "edit-form" }, [due, tags, priority, repeatControls.wrapper, save, cancel]);
  editForm.addEventListener("submit", (event) => {
    event.preventDefault();
    view.editingId = null;
    // A repeating task needs a due date to schedule from; default to today.
    let dueDate = due.value || null;
    const unit = repeatControls.unit.value;
    if (REPEAT_UNITS.includes(unit) && !dueDate) dueDate = todayISO();
    const repeat = parseRepeat(unit, repeatControls.every.value, dueDate);
    run(() => taskStore.update(db, { ...task, dueDate, tags: parseTags(tags.value), repeat, priority: parsePriority(priority.value) }));
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
  checkbox.addEventListener("change", () => run(() => setDone(task, checkbox.checked)));

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

  const visible = tasks.filter((t) => (view.status === "all" || (view.status === "done") === t.done) &&
    (!view.priority || t.priority === view.priority) && (!view.tag || t.tags.includes(view.tag)));

  for (const button of statusFilter.querySelectorAll("button")) {
    button.setAttribute("aria-pressed", String(button.dataset.status === view.status));
  }
  for (const button of priorityFilter.querySelectorAll("button")) {
    button.setAttribute("aria-pressed", String((button.dataset.priority || null) === view.priority));
  }
  renderTagFilter(allTags);
  list.replaceChildren(...visible.map(renderTask));

  emptyState.hidden = visible.length > 0;
  emptyState.textContent = tasks.length ? "No tasks match these filters." : "No tasks yet. Add one above.";
  const remaining = tasks.filter((t) => !t.done).length;
  const filtered = view.status !== "all" || view.priority || view.tag;
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
  const unit = repeatUnitInput.value;
  // A repeating task needs a due date to schedule from; default to today.
  const dueDate = dueInput.value || (REPEAT_UNITS.includes(unit) ? todayISO() : null);
  const task = {
    title, dueDate, tags: parseTags(tagsInput.value), repeat: parseRepeat(unit, repeatEveryInput.value, dueDate),
    priority: parsePriority(priorityInput.value),
  };
  form.reset();
  syncRepeatEvery(repeatUnitInput, repeatEveryInput);
  run(() => taskStore.add(db, task));
});

repeatUnitInput.addEventListener("change", () => syncRepeatEvery(repeatUnitInput, repeatEveryInput));
syncRepeatEvery(repeatUnitInput, repeatEveryInput);

statusFilter.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-status]");
  if (!button) return;
  view.status = button.dataset.status;
  run();
});

priorityFilter.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-priority]");
  if (!button) return;
  view.priority = button.dataset.priority || null;
  run();
});

const ready = openDb()
  .then((opened) => {
    db = opened;
    return render();
  })
  .catch(showError);
