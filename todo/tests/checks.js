// Browser checks for the todo app. Run with:
//   node .claude/skills/factory-loop/scripts/browser-verify.js --dir todo --test todo/tests/checks.js
// Evaluated inside the page as an async function body; returns "PASS ..."/"FAIL ..." lines.

const out = [];
const check = (name, ok) => out.push(`${ok ? "PASS" : "FAIL"} ${name}`);
const items = () => [...document.querySelectorAll("#task-list .task")];
// Poll until the UI reaches the expected state (IndexedDB work is asynchronous).
const waitFor = async (cond) => {
  for (let i = 0; i < 250 && !cond(); i++) await new Promise((r) => setTimeout(r, 20));
  return cond();
};
const add = (title) => {
  input.value = title;
  form.requestSubmit();
};

await ready;
for (const task of await taskStore.all(db)) await taskStore.remove(db, task.id); // start clean
await render();

check("empty state shown when there are no tasks", !emptyState.hidden && items().length === 0);
add("Buy milk");
check("create a task", await waitFor(() => items().length === 1));
add("<b>Write report</b>");
check("create a second task", await waitFor(() => items().length === 2));
check("empty state hidden once tasks exist", emptyState.hidden);
const title = items()[1].querySelector(".task-title");
check("task titles render as text, not HTML", title.textContent === "<b>Write report</b>" && !title.querySelector("b"));
add("   ");
await new Promise((r) => setTimeout(r, 200));
check("blank titles are ignored", items().length === 2);
items()[0].querySelector("input[type=checkbox]").click();
check("mark a task done", await waitFor(() => items()[0].classList.contains("done")));
check("summary counts remaining tasks", summary.textContent === "1 of 2 remaining");
items()[1].querySelector(".delete").click();
check("delete a task", (await waitFor(() => items().length === 1)) && items()[0].textContent.includes("Buy milk"));
const stored = await taskStore.all(await openDb());
check("changes are persisted in IndexedDB", stored.length === 1 && stored[0].title === "Buy milk" && stored[0].done === true);
items()[0].querySelector("input[type=checkbox]").click();
check("mark a task not done again", await waitFor(() => !items()[0].classList.contains("done")));
items()[0].querySelector(".delete").click();
check("empty state returns after deleting the last task", await waitFor(() => items().length === 0 && !emptyState.hidden));
check("no error message shown", errorBox.hidden);
return out;
