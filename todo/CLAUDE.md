# todo

A todo app with a simple interface. Tasks are stored in the browser with IndexedDB.
Source ticket: Ticket #3 (GitHub issue #4).

## Features

- Create a task
- Mark a task done (or undo it)
- Delete a task

Tasks persist across page reloads. Each browser and profile has its own copy of the data.

## Stack

Plain HTML, CSS and JavaScript. No build step and no dependencies.

| File | Purpose |
|------|---------|
| `index.html` | Page markup |
| `styles.css` | Styling, with light and dark themes |
| `app.js` | IndexedDB storage (`taskStore`) and UI rendering |
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
node .claude/skills/factory-loop/scripts/browser-verify.js --dir todo --setup todo/tests/demo-setup.js --screenshot todo/screenshots/ticket-3-todo-app.png --width 700 --height 640
```

`tests/checks.js` covers creating, completing, un-completing and deleting tasks. It also checks that tasks persist, that HTML in a title is shown as text, that blank titles are ignored, and that the empty state appears when there are no tasks.

## Data model

IndexedDB database `todo-app` (v1), object store `tasks`, with an auto-incrementing `id` key:

```
{ id: number, title: string, done: boolean, createdAt: number /* epoch ms */ }
```

## Conventions

- Render user text with `textContent`, never `innerHTML`.
- Every change goes through `run()`. It writes to the database and then re-renders from it, so the stored data is the only source of truth.
