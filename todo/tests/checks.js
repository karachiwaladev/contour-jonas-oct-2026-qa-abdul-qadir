// Browser checks for the todo app. Run with:
//   node .claude/skills/factory-loop/scripts/browser-verify.js --dir todo --test todo/tests/checks.js
// Evaluated inside the page as an async function body; returns "PASS ..."/"FAIL ..." lines.

const out = [];
const check = (name, ok) => out.push(`${ok ? "PASS" : "FAIL"} ${name}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Poll until the UI reaches the expected state (IndexedDB work is asynchronous).
const waitFor = async (cond) => {
  for (let i = 0; i < 250 && !cond(); i++) await sleep(20);
  return cond();
};
const items = () => [...document.querySelectorAll("#task-list .task")];
const titles = () => items().map((li) => li.querySelector(".task-title").textContent);
const find = (title) => items().find((li) => li.querySelector(".task-title").textContent === title);
const chipTags = (li) => [...li.querySelectorAll(".task-meta .tag")].map((c) => c.textContent);
const filterTags = () => [...tagFilter.querySelectorAll("button[data-tag]")].map((b) => b.dataset.tag);
const add = async (title, due = "", tags = "") => {
  const count = items().length;
  input.value = title;
  dueInput.value = due;
  tagsInput.value = tags;
  form.requestSubmit();
  await waitFor(() => items().length === count + 1);
};
const clickStatus = async (status) => {
  statusFilter.querySelector(`[data-status="${status}"]`).click();
  await waitFor(() => statusFilter.querySelector(`[data-status="${status}"]`).getAttribute("aria-pressed") === "true");
  await sleep(50);
};
const shift = (days) => {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
const clear = async () => {
  for (const task of await taskStore.all(db)) await taskStore.remove(db, task.id);
  Object.assign(view, { status: "all", tag: null, editingId: null });
  await render();
};

await ready;
await clear();

// ---- Core: create, complete, delete, persist ----
check("empty state shown when there are no tasks", !emptyState.hidden && items().length === 0 && emptyState.textContent.startsWith("No tasks yet"));
await add("Buy milk");
check("create a task", items().length === 1);
await add("<b>Write report</b>");
check("create a second task", items().length === 2);
check("empty state hidden once tasks exist", emptyState.hidden);
const htmlTitle = find("<b>Write report</b>").querySelector(".task-title");
check("task titles render as text, not HTML", !!htmlTitle && !htmlTitle.querySelector("b"));
input.value = "   ";
form.requestSubmit();
await sleep(200);
check("blank titles are ignored", items().length === 2);
find("Buy milk").querySelector("input[type=checkbox]").click();
check("mark a task done", await waitFor(() => find("Buy milk").classList.contains("done")));
check("summary counts remaining tasks", summary.textContent === "1 of 2 remaining");
find("<b>Write report</b>").querySelector(".delete").click();
check("delete a task", (await waitFor(() => items().length === 1)) && titles()[0] === "Buy milk");
let stored = await taskStore.all(await openDb());
check("changes are persisted in IndexedDB", stored.length === 1 && stored[0].done === true);
find("Buy milk").querySelector("input[type=checkbox]").click();
check("mark a task not done again", await waitFor(() => !find("Buy milk").classList.contains("done")));
await clear();

// ---- Due dates ----
const today = todayISO();
await add("Pay rent", shift(-2), "home");
await add("Call bank", today, "home, Finance");
await add("Plan trip", shift(5), "travel");
await add("Read book");
const rent = find("Pay rent");
check("due date is stored with the task", (await taskStore.all(db)).find((t) => t.title === "Pay rent").dueDate === shift(-2));
check("due date is shown on the task", rent.querySelector(".due").textContent.startsWith("Due "));
check("past-due incomplete task is marked Overdue", rent.classList.contains("overdue") && rent.querySelector(".badge.overdue")?.textContent === "Overdue");
check("task due today is marked Due today", find("Call bank").querySelector(".badge.due-today")?.textContent === "Due today");
check("future and undated tasks have no badge", !find("Plan trip").querySelector(".badge") && !find("Read book").querySelector(".badge"));
check("tasks sort by due date, undated last", titles().join("|") === "Pay rent|Call bank|Plan trip|Read book");
rent.querySelector("input[type=checkbox]").click();
check("completed tasks are never flagged overdue", await waitFor(() => find("Pay rent").classList.contains("done") && !find("Pay rent").querySelector(".badge")));

// ---- Tags ----
await add("Fix bug", "", " Work, URGENT, work ,, ");
check("tags are trimmed, lowercased and de-duplicated", chipTags(find("Fix bug")).join(",") === "work,urgent");
check("tag filter lists every tag in use, sorted", filterTags().join(",") === "finance,home,travel,urgent,work");
const tagInTitle = await (async () => { await add("Tag test", "", "<i>x</i>"); return find("Tag test").querySelector(".tag"); })();
check("tags render as text, not HTML", tagInTitle.textContent === "<i>x</i>" && !tagInTitle.querySelector("i"));
find("Tag test").querySelector(".delete").click();
await waitFor(() => !find("Tag test"));

// ---- Status filter ----
await clickStatus("done");
check("Completed filter shows only completed tasks", titles().join("|") === "Pay rent");
await clickStatus("active");
check("Incomplete filter shows only incomplete tasks", titles().join("|") === "Call bank|Plan trip|Read book|Fix bug");
check("summary notes how many are shown when filtered", summary.textContent === "4 of 5 remaining · showing 4");
await clickStatus("all");
check("All filter shows every task", items().length === 5 && summary.textContent === "4 of 5 remaining");

// ---- Tag filter ----
tagFilter.querySelector('[data-tag="home"]').click();
check("clicking a tag shows only tasks with that tag", await waitFor(() => titles().join("|") === "Pay rent|Call bank"));
check("selected tag chip is marked pressed", tagFilter.querySelector('[data-tag="home"]').getAttribute("aria-pressed") === "true");
await clickStatus("active");
check("tag filter combines with the status filter", titles().join("|") === "Call bank");
await clickStatus("done");
tagFilter.querySelector('[data-tag="home"]').click();
await waitFor(() => view.tag === null);
tagFilter.querySelector('[data-tag="travel"]').click();
check("no-match message when filters hide everything", await waitFor(() => items().length === 0 && !emptyState.hidden && emptyState.textContent === "No tasks match these filters."));
await clickStatus("all");
tagFilter.querySelector('[data-tag="travel"]').click();
check("clicking the selected tag again clears the tag filter", await waitFor(() => view.tag === null && items().length === 5));
tagFilter.querySelector('[data-tag="work"]').click();
await waitFor(() => view.tag === "work");
tagFilter.querySelector("button.all").click();
check("All tags chip clears the tag filter", await waitFor(() => view.tag === null && items().length === 5));

// ---- Edit ----
find("Read book").querySelector(".edit").click();
await waitFor(() => !!find("Read book").querySelector(".edit-form"));
let editForm = find("Read book").querySelector(".edit-form");
check("Edit opens an inline form with the task's values", editForm.querySelector(".edit-due").value === "" && editForm.querySelector(".edit-tags").value === "");
editForm.querySelector(".edit-due").value = shift(1);
editForm.querySelector(".edit-tags").value = "Leisure, books";
editForm.requestSubmit();
check("Save updates the due date and tags", await waitFor(() => !find("Read book").querySelector(".edit-form") && chipTags(find("Read book")).join(",") === "leisure,books"));
stored = (await taskStore.all(await openDb())).find((t) => t.title === "Read book");
check("edits are persisted", stored.dueDate === shift(1) && stored.tags.join(",") === "leisure,books");
check("edited task moves to its due-date position", titles().indexOf("Read book") === titles().indexOf("Plan trip") - 1);
find("Read book").querySelector(".edit").click();
await waitFor(() => !!find("Read book").querySelector(".edit-form"));
editForm = find("Read book").querySelector(".edit-form");
editForm.querySelector(".edit-tags").value = "changed";
editForm.querySelector(".cancel").click();
check("Cancel discards edits", await waitFor(() => !find("Read book").querySelector(".edit-form") && chipTags(find("Read book")).join(",") === "leisure,books"));

// ---- Tag filter resets when its last task is deleted ----
tagFilter.querySelector('[data-tag="travel"]').click();
await waitFor(() => view.tag === "travel");
find("Plan trip").querySelector(".delete").click();
check("deleting a tag's last task clears that tag filter", await waitFor(() => view.tag === null && !filterTags().includes("travel") && items().length === 4));

// ---- Tasks saved before due dates and tags existed ----
await taskStore.update(db, { title: "Legacy task", done: false, createdAt: Date.now() }); // old record shape
await render();
check("tasks without dueDate/tags still render", !!find("Legacy task") && !find("Legacy task").querySelector(".badge") && chipTags(find("Legacy task")).length === 0);

await clear();
check("empty state returns after clearing all tasks", !emptyState.hidden && emptyState.textContent.startsWith("No tasks yet"));
check("no error message shown", errorBox.hidden);
return out;
