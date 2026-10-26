// Seeds demo tasks for screenshots. Run with:
//   node .claude/skills/factory-loop/scripts/browser-verify.js --dir todo --setup todo/tests/demo-setup.js --screenshot <out.png>
// Set window.DEMO_TAG / window.DEMO_STATUS before running (or edit below) to screenshot a filtered view.

const shift = (days) => {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

await ready;
for (const task of await taskStore.all(db)) await taskStore.remove(db, task.id);

const demo = [
  { title: "Submit expense report", dueDate: shift(-1), tags: ["work", "finance"] },
  { title: "Prepare sprint demo", dueDate: shift(0), tags: ["work"] },
  { title: "Book dentist appointment", dueDate: shift(3), tags: ["health"] },
  { title: "Review pull request #42", dueDate: shift(1), tags: ["work", "code"], done: true },
  { title: "Buy groceries", dueDate: null, tags: ["home"] },
];
for (const [i, t] of demo.entries()) {
  await taskStore.update(db, { title: t.title, done: !!t.done, dueDate: t.dueDate, tags: t.tags, createdAt: Date.now() + i });
}

Object.assign(view, { status: window.DEMO_STATUS || "all", tag: window.DEMO_TAG || null, editingId: null });
await render();
