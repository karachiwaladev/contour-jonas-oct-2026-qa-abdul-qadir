# Software Factory

This repo is a **software factory**. Work arrives as GitHub issues (`Ticket #1`,
`Ticket #2`, ...), an agent loop picks each ticket up and does the work, and the
results are pushed to `main`. Humans build and improve the loop rather than the
features. Only what is on GitHub counts: files, issues, comments and commits.

> **Keep this file under 100 lines at all times.** It is the entry point and the
> index, not the manual. Detail belongs in the files it links to.

## Progressive disclosure

Load context in layers, and only as deep as the task needs:

1. **This file**: what the factory is, the rules, and the index of everything.
2. **A project's `CLAUDE.md`**: that project's purpose, stack, commands and
   conventions. Read it only when working on that project.
3. **Files inside the project**: code, docs and tests, opened on demand.

So when this file gets long, move the detail into the project or skill it
concerns and leave a one-line pointer here.

## Repo layout

```
CLAUDE.md                  ← you are here: rules + index
README.md                  ← workshop info (scoring, schedule)
.claude/skills/<skill>/    ← factory skills (the loop's tools)
.claude/hooks/             ← Stop hooks (prompt log, auto commit + push)
<project>/                 ← one top-level folder per project
  CLAUDE.md                ← project-level context (layer 2)
```

## Adding a project

1. Create `<project-name>/` at the repo root (lowercase, hyphenated), or use the
   folder name the ticket asks for.
2. Add `<project-name>/CLAUDE.md` with the project's purpose, stack, how to run
   and verify it, and which ticket(s) it came from.
3. Add one row to the **Project index** below.

## Working a ticket

Use the `factory-loop` skill (`/factory-loop`, or `/loop 1m /factory-loop`). It:
claims the issue with 👀 → for build work, asks clarifying questions → plans and
gets approval → builds on a `ticket-<T>-<slug>` branch → verifies in Chrome (DevTools
Protocol) with screenshots → opens a PR (`Closes #N`) and comments on the issue.
Never destructive. Details are in the skill.

## Ground rules

- This is a training repo: no Jonas or Contour code, and no real keys or secrets.
- Each work ticket gets its own branch and PR into `main`; small, focused commits that name
  the ticket (e.g. `Ticket #3: ...`). Scoring counts `main`, so PRs need merging to count.
- On every stop, a hook commits and pushes any remaining changes on the current branch.

## Index

### Skills & hooks

| Item | Path | Purpose |
|------|------|---------|
| factory-loop | [.claude/skills/factory-loop/SKILL.md](.claude/skills/factory-loop/SKILL.md) | Claim, clarify, plan, build, verify and answer GitHub issues |
| browser-verify | [.claude/skills/factory-loop/scripts/browser-verify.js](.claude/skills/factory-loop/scripts/browser-verify.js) | Headless Chrome checks + screenshots |
| Stop hooks | [.claude/settings.json](.claude/settings.json) | Log prompts to `.claude/logs/prompts.jsonl`; auto commit + push |

### Project index

| Project | Path | Ticket | Summary |
|---------|------|--------|---------|
| todo | [todo/](todo/CLAUDE.md) | #3, #4 (issues #4, #5) | Todo app with due dates, tags and filters; IndexedDB storage |
