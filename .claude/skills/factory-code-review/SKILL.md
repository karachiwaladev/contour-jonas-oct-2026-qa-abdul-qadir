---
name: factory-code-review
description: Code review of a ticket branch or pull request in this software factory, before it goes to a human reviewer. It checks that the change does what the ticket and the approved plan asked, looks for correctness bugs and edge cases, god objects (oversized files, classes and functions that mix responsibilities, via scripts/god-object.js), conventions, test coverage in the project's browser checks, docs and the CLAUDE.md index, and scope creep. It produces a severity-ranked report that gates the PR, with blockers and majors fixed first. Use this whenever factory-loop reaches its code-review step, or whenever the user asks to review a branch, PR or diff, "check my code", or "is this ready for review" in this repo, even if they don't name the skill.
---

# factory-code-review

The human reviewer should spend their time on judgment calls, not on bugs a careful read
would catch. This step is that careful read. It happens after the Chrome checks pass and
before the PR is opened, so the PR arrives with its known problems already fixed.

## 1. Gather context

- The ticket: the issue body and comments, plus the **approved plan** (W2). The review
  measures the change against the plan, not against what would be nice to have.
- The change: `git diff main...HEAD --stat`, then the full diff, then each changed file read
  **in full** around the changes. A diff alone hides how new code interacts with what's around it.
- Conventions: the root `CLAUDE.md` and the project's `CLAUDE.md`.

## 2. Get a second pair of eyes (recommended for any non-trivial change)

The author tends to see what they meant to write. Spawn a fresh subagent (the Agent tool,
type `general-purpose`) to review independently. Give it the ticket text, the approved
plan, the branch name and the checklist below. **Don't give it your own conclusions.** Ask
for findings with `file:line`, severity and a suggested fix. Merge its list with yours, and
confirm every item yourself before acting on it.

## 3. Checklist

**Does it do the job?**
- Every ask in the ticket and every item in the approved plan is implemented, with nothing
  silently dropped. Anything that changed from the plan is called out.
- No scope creep: no unrelated refactors, files or behaviour changes. If something extra was
  truly needed, it gets mentioned in the PR.

**Correctness**
- Logic errors, off-by-one errors, and boundary values (empty, 0, max, dates at month or year
  boundaries, time zones).
- Async ordering and races, such as stale closures, double submits and awaits that are never
  made. State changes go through the project's single write path (e.g. todo's `run()`).
- Error paths: failures are shown or handled, never swallowed silently, and the app never
  ends up half-updated.
- Older data and backwards compatibility: records saved by earlier versions still load.

**Design: no god objects**

Run `node .claude/skills/factory-code-review/scripts/god-object.js --changed --base main`. It
flags files, classes and functions that own too much:

| Signal | Warn | Fail |
|---|---|---|
| Code lines per file | > 300 | > 500 |
| Functions/methods per file | > 25 | > 40 |
| Longest function | > 50 lines | > 80 lines |
| Methods per class | > 15 | > 25 |
| Top-level `let`/`var` | > 8 | > 15 |
| Concerns mixed in one file (DOM/UI, storage, network, date/scheduling, server/fs) | > 3 | > 4 |

- **FAIL is a major finding.** Split the file before the PR. Separate it by responsibility
  (e.g. `storage.js`, `recurrence.js`, `ui.js` plus a small entry file), break long
  functions into named helpers with one job each, and move shared state into one owner.
  Keep behaviour identical, and rerun the browser checks to prove it.
- **WARN is a minor finding.** Don't grow the file further in this PR. If the ticket adds to
  a file that's already at WARN, propose the split as part of the plan or as a follow-up
  ticket.
- **Justified exceptions:** a file can carry `quality: allow-large-file <reason>` in its first
  5 lines, for example generated code or a fixture. That turns a FAIL into a WARN, so judge
  whether the reason holds up.

The `god-object-guard` PostToolUse hook runs the same check after every Write or Edit, so
problems are usually caught while writing. This review step catches anything that slipped
through.

**Quality and conventions**
- Follows the project `CLAUDE.md` (e.g. no build step, `textContent` never `innerHTML`).
- Names, structure and comment density match the surrounding code. No dead code, debug
  logging, commented-out blocks or TODOs without a ticket.
- No needless duplication. Reuses existing helpers instead of re-implementing them.
- Accessibility: form controls have labels, buttons have accessible names, and nothing
  depends on colour alone.

**Tests and verification**
- `tests/checks.js` gains checks for every new behaviour and edge case in the plan, and the
  existing checks still pass. Check also that the tests would actually fail if the feature
  broke; watch for tests that pass early or test nothing.
- Screenshots show the feature, nothing is cut off, and they match the final code.
- The acceptance file (`tests/acceptance/ticket-<T>.json`) must be faithful:
  - quotes are copied word for word from the ticket;
  - `clarified` is used only for real W1 decisions;
  - `context` holds only ticket text that isn't an ask;
  - each criterion maps to checks that actually exercise it.

  The verification audit (`verify-audit.js`) proves the mapped checks exist and pass in a fresh
  run, but only a reviewer can judge whether they test the right thing. A criterion backed by
  an unrelated check is a **major**.

**Docs**
- The project `CLAUDE.md` (features, data model, verify commands, check count) and the root
  index row are updated, and the root `CLAUDE.md` is under 100 lines.

## 4. Severity and gate

| Severity | Examples | Gate |
|---|---|---|
| **Blocker** | Wrong behaviour, data loss, a plan item missing, failing checks | Fix before the PR |
| **Major** | Unhandled edge case, race, missing tests for a feature, broken convention | Fix before the PR |
| **Minor** | Readability, small duplication, unclear naming, docs gaps | Fix if cheap, otherwise list in the PR |
| **Nit** | Style preference | Optional; don't let nits hold anything up |

After fixes, rerun the browser checks (and the scanner from `factory-security-review` if
the fixes touched code). Commit the fixes on the ticket branch with a message such as
`Ticket #N: address code review`.

## 5. Report

Write the report to the scratchpad as `review-<branch>-code.md`. If the PR already exists,
post it with `gh pr comment <PR> --body-file <file>`. If it doesn't yet (the normal case
inside factory-loop, where W6 runs before W8), hand the file back: factory-loop posts it when
it opens the PR, and puts its one-line result in the PR body. Format:

```markdown
## Code review: <branch>

**Result:** ✅ Ready for human review | ⚠️ Minor items listed | ❌ Blocked

**Plan coverage:** <each plan item → ✅ / ❌ (where it's implemented or tested)>

| Severity | Where | Finding | Status |
|---|---|---|---|
| Major | `todo/app.js:142` | Re-tick could duplicate next occurrence | Fixed in <sha>, check added |

**Reviewed by:** author pass + independent subagent pass
```

Report only confirmed findings, and say what was checked when there are none. If a finding
is debatable, say so and leave the decision to the human reviewer.
