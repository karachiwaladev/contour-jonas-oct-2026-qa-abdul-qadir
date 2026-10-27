# todo

A todo app with a simple interface. Tasks are stored in the browser with IndexedDB.
Source tickets: Ticket #3 (issue #4, the app), Ticket #4 (issue #5, filters, due dates and tags),
Ticket #5 (issue #7, recurring tasks) and Ticket #6 (issue #11, task priority).

## Features

- Create, complete (or un-complete) and delete tasks. Tasks persist across reloads.
- **Due date** (optional, date only). Incomplete tasks past their date are flagged **Overdue**
  and tasks due today are flagged **Due today**. Completed tasks are never flagged.
- **Tags** (optional, comma-separated). Tags are trimmed, lowercased, de-duplicated and shown as chips.
- **Priority:** High, Medium or Low, chosen when adding a task (default Medium) and shown as a
  coloured chip. Tasks saved before priorities existed count as Medium.
- **Edit** a task's due date, tags, priority and repeat inline, with Save or Cancel.
- **Filters:** a status filter (All / Incomplete / Completed), a priority filter (Any / High /
  Medium / Low) and a one-at-a-time tag filter built from the tags in use. All three combine.
  They aren't saved, so they reset on reload.
- **Sort order:** earliest due date first, undated tasks last. On the same date, higher priority
  comes first, then creation order.
- **Recurring tasks:** "Repeat every N day(s), week(s), month(s) or year(s)", set when adding a task or in Edit.
  - A repeating task with no due date defaults to today.
  - Completing it keeps the done task as history and creates the next occurrence once, with the same title, tags and repeat. Un-ticking and re-ticking doesn't create a duplicate.
  - The next date follows the schedule: previous due date plus the interval. If that's still in the past, it moves forward until it's today or later. Monthly and yearly repeats keep their day of the month (`anchorDay`), clamping to the end of shorter months and to Feb 28 in non-leap years.
  - Choosing "Does not repeat" stops it.

## Stack

Plain HTML, CSS and JavaScript. No build step and no dependencies.

| File | Purpose |
|------|---------|
| `index.html` | Page markup (new-task form, filters, list) |
| `styles.css` | Styling, with light and dark themes |
| `store.js` | IndexedDB storage (`openDb`, `taskStore`) |
| `model.js` | Task rules, no DOM: tags, dates, recurrence, priority, due flags, `normalize`, sort order |
| `app.js` | UI: rendering, forms, filters and actions (`setDone`, `run`) |
| `tests/checks.js` | Browser checks (see Verify) |
| `tests/demo-setup.js` | Seeds demo tasks for screenshots |
| `tests/acceptance/ticket-<T>.json` | Each ticket ask (quoted) → the checks that prove it, for the verification audit |
| `screenshots/` | Verification screenshots attached to tickets |

## Run

Open `todo/index.html` in a browser. Alternatively, serve the folder with
`npx serve todo` and open the URL it prints.

## Verify

Run these from the repo root. They use headless Chrome through the DevTools Protocol:

```
node .claude/skills/factory-loop/scripts/browser-verify.js --dir todo --test todo/tests/checks.js
node .claude/skills/factory-loop/scripts/browser-verify.js --dir todo --setup todo/tests/demo-setup.js --screenshot todo/screenshots/<name>.png --width 760 --height 900
```

To prove each ticket's asks are covered, run the verification audit. Use issue #4, #5, #7 or #11:

```
node .claude/skills/factory-loop/scripts/verify-audit.js --issue 7 --project todo
```

It maps each ticket's words to checks through `tests/acceptance/ticket-<T>.json`, reruns the
checks fresh, and checks the screenshots. Add `--pr <PR>` to audit a pull request's head commit,
and `--evidence <dir>` to keep the evidence packs Chrome records. Each pack holds the console
attributed to its source, the network log, an IndexedDB dump, a video (`base/video.html`), the
Chrome binary hash and a manifest; the egress log (`egress.jsonl`) lists every connection that
left the machine, from pages, workers or WebSockets. On GitHub, the same audit runs on every PR and its evidence
is attached to the run.

The checks drive the UI with `trusted.click` and `trusted.type`, which is real input dispatched
by Chrome, not synthetic `.click()` calls.

`tests/checks.js` has 85 checks covering every feature above. It also tests edge cases:
HTML in titles and tags, blank input, the empty and no-match states, persistence of
creates and edits, and old records saved without `dueDate`, `tags`, `repeat` or `priority`.
The recurrence checks cover the date math for every unit and for every N, month-end and
leap-year handling, catching up past overdue dates, and no duplicate on re-tick. The priority
checks cover the default, add, edit, the filter combined with the others, the sort tie-break,
and a repeating task's next occurrence keeping its priority.

## Data model

IndexedDB database `todo-app` (v1), object store `tasks`, with an auto-incrementing `id` key:

```
{ id: number, title: string, done: boolean, createdAt: number /* epoch ms */,
  dueDate: "YYYY-MM-DD" | null, tags: string[],
  repeat: { every: 1..99, unit: "day"|"week"|"month"|"year", anchorDay?: 1..31 } | null,
  priority: "high"|"medium"|"low",
  nextCreated?: true /* set once a completed repeating task has spawned its next occurrence */ }
```

Records saved before Tickets #4–#6 lack `dueDate`, `tags`, `repeat` and `priority`. `normalize()` fills
in the defaults, so no migration is needed. `setDone()` re-reads the stored task before
completing it, so a click on a row that hasn't re-rendered yet can't write stale fields back.

## Conventions

- Render user text with `textContent`, never `innerHTML`.
- Every change goes through `run()`. It writes to the database and then re-renders from it, so the stored data is the only source of truth.
- View-only state (`view.status`, `view.priority`, `view.tag`, `view.editingId`) lives in memory.
- `store.js`, `model.js` and `app.js` are classic scripts loaded in that order, so their
  declarations are shared globals. The checks and the audit's mutations rely on that.
