// Browser checks for the todo app. Run with:
//   node .claude/skills/factory-loop/scripts/browser-verify.js --dir todo --test todo/tests/checks.js
// Evaluated inside the page as an async function body; returns "PASS ..."/"FAIL ..." lines.

const out = (window.__checkResults = []); // published so a crash still reports what ran (see browser-verify.js)
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
// UI actions go through `trusted` (installed by browser-verify.js): real mouse clicks and typing that
// Chrome dispatches over CDP (event.isTrusted === true), not synthetic .click() calls from page code.
// Values a user would pick in a native date or select widget are still set directly.
const addButton = form.querySelector('button[type="submit"]');
const add = async (title, due = "", tags = "") => {
  const count = items().length;
  await trusted.type(input, title);
  dueInput.value = due;
  await trusted.type(tagsInput, tags);
  await trusted.click(addButton);
  await waitFor(() => items().length === count + 1);
};
const clickStatus = async (status) => {
  await trusted.click(statusFilter.querySelector(`[data-status="${status}"]`));
  await waitFor(() => statusFilter.querySelector(`[data-status="${status}"]`).getAttribute("aria-pressed") === "true");
  await sleep(50);
};
// The tag filter has settled once the re-render marks the chosen chip as pressed (view.tag changes
// before the re-render, and real clicks need the chips where they'll actually be).
const tagSettled = (tag) => waitFor(() => tagFilter.querySelector(tag ? `[data-tag="${tag}"]` : "button.all")?.getAttribute("aria-pressed") === "true");
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
await trusted.type(input, "   ");
await trusted.click(addButton);
await sleep(200);
check("blank titles are ignored", items().length === 2);
await trusted.click(find("Buy milk").querySelector("input[type=checkbox]"));
check("mark a task done", await waitFor(() => find("Buy milk").classList.contains("done")));
check("summary counts remaining tasks", summary.textContent === "1 of 2 remaining");
await trusted.click(find("<b>Write report</b>").querySelector(".delete"));
check("delete a task", (await waitFor(() => items().length === 1)) && titles()[0] === "Buy milk");
let stored = await taskStore.all(await openDb());
check("changes are persisted in IndexedDB", stored.length === 1 && stored[0].done === true);
await trusted.snapshot("after-create-done-delete"); // Chrome dumps IndexedDB into the evidence pack
await trusted.click(find("Buy milk").querySelector("input[type=checkbox]"));
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
await trusted.click(rent.querySelector("input[type=checkbox]"));
check("completed tasks are never flagged overdue", await waitFor(() => find("Pay rent").classList.contains("done") && !find("Pay rent").querySelector(".badge")));

// ---- Tags ----
await add("Fix bug", "", " Work, URGENT, work ,, ");
check("tags are trimmed, lowercased and de-duplicated", chipTags(find("Fix bug")).join(",") === "work,urgent");
check("tag filter lists every tag in use, sorted", filterTags().join(",") === "finance,home,travel,urgent,work");
const tagInTitle = await (async () => { await add("Tag test", "", "<i>x</i>"); return find("Tag test").querySelector(".tag"); })();
check("tags render as text, not HTML", tagInTitle.textContent === "<i>x</i>" && !tagInTitle.querySelector("i"));
await trusted.click(find("Tag test").querySelector(".delete"));
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
await trusted.click(tagFilter.querySelector('[data-tag="home"]'));
check("clicking a tag shows only tasks with that tag", await waitFor(() => titles().join("|") === "Pay rent|Call bank"));
check("selected tag chip is marked pressed", tagFilter.querySelector('[data-tag="home"]').getAttribute("aria-pressed") === "true");
await clickStatus("active");
check("tag filter combines with the status filter", titles().join("|") === "Call bank");
await clickStatus("done");
await trusted.click(tagFilter.querySelector('[data-tag="home"]'));
await tagSettled(null);
await trusted.click(tagFilter.querySelector('[data-tag="travel"]'));
check("no-match message when filters hide everything", await waitFor(() => items().length === 0 && !emptyState.hidden && emptyState.textContent === "No tasks match these filters."));
await clickStatus("all");
await trusted.click(tagFilter.querySelector('[data-tag="travel"]'));
check("clicking the selected tag again clears the tag filter", await waitFor(() => view.tag === null && items().length === 5));
await trusted.click(tagFilter.querySelector('[data-tag="work"]'));
await tagSettled("work");
await trusted.click(tagFilter.querySelector("button.all"));
check("All tags chip clears the tag filter", await waitFor(() => view.tag === null && items().length === 5));

// ---- Edit ----
await trusted.click(find("Read book").querySelector(".edit"));
await waitFor(() => !!find("Read book").querySelector(".edit-form"));
let editForm = find("Read book").querySelector(".edit-form");
check("Edit opens an inline form with the task's values", editForm.querySelector(".edit-due").value === "" && editForm.querySelector(".edit-tags").value === "");
editForm.querySelector(".edit-due").value = shift(1);
await trusted.type(editForm.querySelector(".edit-tags"), "Leisure, books");
await trusted.click(editForm.querySelector(".save"));
check("Save updates the due date and tags", await waitFor(() => !find("Read book").querySelector(".edit-form") && chipTags(find("Read book")).join(",") === "leisure,books"));
stored = (await taskStore.all(await openDb())).find((t) => t.title === "Read book");
check("edits are persisted", stored.dueDate === shift(1) && stored.tags.join(",") === "leisure,books");
check("edited task moves to its due-date position", titles().indexOf("Read book") === titles().indexOf("Plan trip") - 1);
await trusted.click(find("Read book").querySelector(".edit"));
await waitFor(() => !!find("Read book").querySelector(".edit-form"));
editForm = find("Read book").querySelector(".edit-form");
await trusted.type(editForm.querySelector(".edit-tags"), "changed");
await trusted.click(editForm.querySelector(".cancel"));
check("Cancel discards edits", await waitFor(() => !find("Read book").querySelector(".edit-form") && chipTags(find("Read book")).join(",") === "leisure,books"));

// ---- Tag filter resets when its last task is deleted ----
await trusted.click(tagFilter.querySelector('[data-tag="travel"]'));
await tagSettled("travel");
await trusted.click(find("Plan trip").querySelector(".delete"));
check("deleting a tag's last task clears that tag filter", await waitFor(() => view.tag === null && !filterTags().includes("travel") && items().length === 4));

// ---- Tasks saved before due dates and tags existed ----
await taskStore.update(db, { title: "Legacy task", done: false, createdAt: Date.now() }); // old record shape
await render();
check("tasks without dueDate/tags still render", !!find("Legacy task") && !find("Legacy task").querySelector(".badge") && chipTags(find("Legacy task")).length === 0);

await clear();

// ---- Recurring tasks: schedule math (Ticket #5) ----
const R = (unit, every, due) => parseRepeat(unit, every, due);
const past = "2000-01-01"; // "today" far in the past so no catch-up kicks in
check("daily: next day", nextDueDate("2026-03-10", R("day", 1, "2026-03-10"), past) === "2026-03-11");
check("every 3 days crosses a month boundary", nextDueDate("2026-01-30", R("day", 3, "2026-01-30"), past) === "2026-02-02");
check("weekly: +7 days", nextDueDate("2026-12-28", R("week", 1, "2026-12-28"), past) === "2027-01-04");
check("every 2 weeks: +14 days", nextDueDate("2026-03-10", R("week", 2, "2026-03-10"), past) === "2026-03-24");
check("monthly keeps the day of month", nextDueDate("2026-03-15", R("month", 1, "2026-03-15"), past) === "2026-04-15");
const endOfMonth = R("month", 1, "2026-01-31");
check("monthly on the 31st clamps to the last day of February", nextDueDate("2026-01-31", endOfMonth, past) === "2026-02-28");
check("monthly returns to the 31st after a short month", nextDueDate("2026-02-28", endOfMonth, past) === "2026-03-31");
check("every 3 months rolls over the year", nextDueDate("2026-11-30", R("month", 3, "2026-11-30"), past) === "2027-02-28");
check("yearly: same date next year", nextDueDate("2026-07-04", R("year", 1, "2026-07-04"), past) === "2027-07-04");
check("yearly on Feb 29 falls on Feb 28 in non-leap years", nextDueDate("2028-02-29", R("year", 1, "2028-02-29"), past) === "2029-02-28");
check("overdue schedule skips ahead to today or later", nextDueDate(shift(-10), R("week", 1, shift(-10)), today) === shift(4));
check("next date is today when the schedule lands on today", nextDueDate(shift(-14), R("week", 1, shift(-14)), today) === today);
check("interval is clamped to 1..99", R("day", 0).every === 1 && R("day", 500).every === 99 && R("day", "abc").every === 1);
check("'Does not repeat' gives no rule", R("", 3, today) === null);

// ---- Recurring tasks: UI ----
const addRepeating = async (title, due, unit, every, tags = "") => {
  repeatUnitInput.value = unit;
  repeatUnitInput.dispatchEvent(new Event("change"));
  repeatEveryInput.value = String(every);
  await add(title, due, tags);
};
check("interval field is disabled until a repeat is chosen", repeatEveryInput.disabled);
await addRepeating("Water plants", shift(-3), "week", 2, "home");
const plants = find("Water plants");
check("repeating task shows its schedule", plants.querySelector(".chip.repeat")?.textContent === "↻ Every 2 weeks");
check("form resets to 'Does not repeat' after adding", repeatUnitInput.value === "" && repeatEveryInput.disabled);
await addRepeating("Stand-up notes", "", "day", 1);
check("repeating task without a date defaults to due today", (await taskStore.all(db)).find((t) => t.title === "Stand-up notes").dueDate === today);
check("singular label for an interval of 1", find("Stand-up notes").querySelector(".chip.repeat").textContent === "↻ Every day");
await trusted.click(find("Water plants").querySelector("input[type=checkbox]"));
check("completing a repeating task creates the next occurrence",
  await waitFor(() => items().filter((li) => li.querySelector(".task-title").textContent === "Water plants").length === 2));
let waterings = (await taskStore.all(db)).filter((t) => t.title === "Water plants").sort((a, b) => a.createdAt - b.createdAt);
check("completed occurrence stays as done history", waterings[0].done === true && waterings[0].dueDate === shift(-3));
check("next occurrence is open, on schedule, with the same tags and repeat",
  waterings[1].done === false && waterings[1].dueDate === shift(11) && waterings[1].tags.join() === "home" && waterings[1].repeat.every === 2 && waterings[1].repeat.unit === "week");
const doneItem = () => items().find((li) => li.querySelector(".task-title").textContent === "Water plants" && li.classList.contains("done"));
await trusted.click(doneItem().querySelector("input[type=checkbox]"));
await waitFor(() => !doneItem());
await trusted.click(items().filter((li) => li.querySelector(".task-title").textContent === "Water plants")
  .find((li) => li.dataset.id === String(waterings[0].id)).querySelector("input[type=checkbox]"));
await waitFor(() => !!doneItem());
await sleep(150);
check("un-ticking and re-ticking does not create a duplicate", (await taskStore.all(db)).filter((t) => t.title === "Water plants").length === 2);

await trusted.click(find("Stand-up notes").querySelector(".edit"));
await waitFor(() => !!find("Stand-up notes").querySelector(".edit-form"));
editForm = find("Stand-up notes").querySelector(".edit-form");
check("edit form shows the current repeat", editForm.querySelector(".edit-repeat").value === "day" && editForm.querySelector(".edit-every").value === "1");
editForm.querySelector(".edit-repeat").value = "month";
editForm.querySelector(".edit-repeat").dispatchEvent(new Event("change"));
editForm.querySelector(".edit-every").value = "3";
await trusted.click(editForm.querySelector(".save"));
check("editing changes the repeat", await waitFor(() => find("Stand-up notes")?.querySelector(".chip.repeat")?.textContent === "↻ Every 3 months"));
await trusted.click(find("Stand-up notes").querySelector(".edit"));
await waitFor(() => !!find("Stand-up notes").querySelector(".edit-form"));
editForm = find("Stand-up notes").querySelector(".edit-form");
editForm.querySelector(".edit-repeat").value = "";
editForm.querySelector(".edit-repeat").dispatchEvent(new Event("change"));
await trusted.click(editForm.querySelector(".save"));
check("'Does not repeat' stops repeating", await waitFor(() =>
  !!find("Stand-up notes") && !find("Stand-up notes").querySelector(".edit-form") && !find("Stand-up notes").querySelector(".chip.repeat")));
await trusted.click(find("Stand-up notes").querySelector("input[type=checkbox]"));
await waitFor(() => find("Stand-up notes")?.classList.contains("done"));
await sleep(150);
check("completing a non-repeating task creates nothing new", (await taskStore.all(db)).filter((t) => t.title === "Stand-up notes").length === 1);
stored = await taskStore.all(await openDb());
check("repeat rules are persisted", stored.find((t) => t.title === "Water plants" && !t.done).repeat.unit === "week" && stored.find((t) => t.title === "Stand-up notes").repeat === null);

await clear();
check("empty state returns after clearing all tasks", !emptyState.hidden && emptyState.textContent.startsWith("No tasks yet"));
check("no error message shown", errorBox.hidden);
return out;
