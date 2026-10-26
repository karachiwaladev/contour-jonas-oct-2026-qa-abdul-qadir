// Seeds demo tasks for screenshots. Run with:
//   node .claude/skills/factory-loop/scripts/browser-verify.js --dir todo --setup todo/tests/demo-setup.js --screenshot <out.png>
// Set window.DEMO_TAG / window.DEMO_STATUS / window.DEMO_EDIT (a task title) first to screenshot
// a filtered view or an open edit form.

const shift = (days) => {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

await ready;
for (const task of await taskStore.all(db)) await taskStore.remove(db, task.id);

const weekly = parseRepeat("week", 1, shift(-7));
const demo = [
  { title: "Team stand-up notes", dueDate: shift(-7), tags: ["work"], repeat: weekly, done: true, nextCreated: true },
  { title: "Submit expense report", dueDate: shift(-1), tags: ["work", "finance"] },
  { title: "Team stand-up notes", dueDate: shift(0), tags: ["work"], repeat: weekly },
  { title: "Water the plants", dueDate: shift(2), tags: ["home"], repeat: parseRepeat("day", 3, shift(2)) },
  { title: "Pay rent", dueDate: shift(5), tags: ["home", "finance"], repeat: parseRepeat("month", 1, shift(5)) },
  { title: "Renew car insurance", dueDate: shift(40), tags: ["finance"], repeat: parseRepeat("year", 1, shift(40)) },
  { title: "Buy groceries", dueDate: null, tags: ["home"] },
];
for (const [i, t] of demo.entries()) {
  await taskStore.update(db, { done: false, repeat: null, ...t, createdAt: Date.now() + i });
}

Object.assign(view, { status: window.DEMO_STATUS || "all", tag: window.DEMO_TAG || null, editingId: null });
if (window.DEMO_EDIT) {
  const target = (await taskStore.all(db)).find((t) => t.title === window.DEMO_EDIT && !t.done);
  if (target) view.editingId = target.id;
}
await render();
