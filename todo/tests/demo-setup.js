// Seeds demo tasks for screenshots. Run with:
//   node .claude/skills/factory-loop/scripts/browser-verify.js --dir todo --setup todo/tests/demo-setup.js --screenshot <out.png>

const items = () => [...document.querySelectorAll("#task-list .task")];
const waitFor = async (cond) => {
  for (let i = 0; i < 250 && !cond(); i++) await new Promise((r) => setTimeout(r, 20));
};

await ready;
for (const task of await taskStore.all(db)) await taskStore.remove(db, task.id);
await render();

for (const title of ["Read Ticket #3", "Build the todo app", "Verify it in Chrome", "Push to GitHub"]) {
  const count = items().length;
  input.value = title;
  form.requestSubmit();
  await waitFor(() => items().length === count + 1);
}
for (const i of [0, 1, 2]) {
  items()[i].querySelector("input[type=checkbox]").click();
  await waitFor(() => items()[i].classList.contains("done"));
}
