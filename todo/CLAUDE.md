# todo

A todo app with a simple interface. Tasks are stored in the browser with IndexedDB.
Source tickets: Ticket #3 (issue #4, the app) and Ticket #4 (issue #5, filters, due dates and tags).

## Features

- Create, complete (or un-complete) and delete tasks. Tasks persist across reloads.
- **Due date** (optional, date only). Incomplete tasks past their date are flagged **Overdue**
  and tasks due today are flagged **Due today**. Completed tasks are never flagged.
- **Tags** (optional, comma-separated). Tags are trimmed, lowercased, de-duplicated and shown as chips.
- **Edit** a task's due date and tags inline, with Save or Cancel.
- **Filters:** a status filter (All / Incomplete / Completed) and a one-at-a-time tag filter
  built from the tags in use. The two filters combine. They aren't saved, so they reset on reload.
- **Sort order:** earliest due date first, undated tasks last, ties in creation order.

## Stack

Plain HTML, CSS and JavaScript. No build step and no dependencies.

| File | Purpose |
|------|---------|
| `index.html` | Page markup (new-task form, filters, list) |
| `styles.css` | Styling, with light and dark themes |
| `app.js` | IndexedDB storage (`taskStore`), task helpers, UI rendering |
| `tests/checks.js` | Browser checks (see Verify) |
| `tests/demo-setup.js` | Seeds demo tasks for screenshots |
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

`tests/checks.js` has 40 checks covering every feature above. It also tests edge cases:
HTML in titles and tags, blank input, the empty and no-match states, persistence of
creates and edits, and old records saved without `dueDate` or `tags`.

## Data model

IndexedDB database `todo-app` (v1), object store `tasks`, with an auto-incrementing `id` key:

```
{ id: number, title: string, done: boolean, createdAt: number /* epoch ms */,
  dueDate: "YYYY-MM-DD" | null, tags: string[] }
```

Records saved before Ticket #4 lack `dueDate` and `tags`. `normalize()` fills in the
defaults, so no migration is needed.

## Conventions

- Render user text with `textContent`, never `innerHTML`.
- Every change goes through `run()`. It writes to the database and then re-renders from it, so the stored data is the only source of truth.
- View-only state (`view.status`, `view.tag`, `view.editingId`) lives in memory.
