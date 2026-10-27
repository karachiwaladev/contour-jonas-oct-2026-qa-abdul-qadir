# Prompt audit of the repo's instruction files

The instruction files are in good shape. I found **2 high-confidence findings and 1 medium**: all three are facts that went stale as the factory changed, not wording written for an older model. I wrote a patch for those three. Two low-confidence items are listed for you to decide on. Nothing has been edited.

**Assumptions**
- **Scope:** everything in the working directory that the agent reads as instructions: `CLAUDE.md`, `todo/CLAUDE.md`, and the three skill files (`factory-loop`, `factory-code-review`, `factory-security-review`).
- **Skipped:**
  - `.claude/settings.json`, because settings files can hold secrets.
  - `README.md`, because the agent doesn't load it as instructions.
  - User-level files under `~/.claude/`.
- **Target model:** Claude Opus 5.5. These files are read by Claude Code, not by app code, and no skill pins its own model.
- **No Claude API code:** nothing in the repo calls the Claude API, and there are no OpenAI or other provider markers. `anthropic` only appears in the commit attribution line and the scanner's key patterns.

**Highest-impact findings**
- The root `CLAUDE.md` opens by saying results "are pushed to `main`". The factory now forbids that: every ticket goes through a branch and a reviewed PR.
- The ground rule about the Stop hook says it always pushes. In reality it holds the push when the security scan fails.

The files were all written on 2026-10-26/27. None of the dated patterns showed up: no "think step by step", no shouting in capitals, no retired model names, no rules that suppress progress updates.

**Counts by group:**

| Group | What it covers | Findings |
|---|---|---|
| 1 | Dated prompt wording | 1 (low, flag only) |
| 2 | Brittle skill and config files | 4 (3 in the patch, 1 flag) |
| 3 | Tool descriptions | 0 |
| 4 | Request config | Not applicable (no request-building code, no subagent definitions) |

## Findings

**1. `CLAUDE.md:5` · High · rewrite**
- **Text:** "results are pushed to `main`"
- **Pattern:** stale fact, and two instruction files that disagree.
- **Why it's stale:**
  - This line came from commit `636c1b1`, before commit `3c58aa8` introduced a branch and PR per ticket.
  - `CLAUDE.md:53` says each ticket gets its own branch and PR.
  - `factory-loop/SKILL.md:54-55` lists "pushing to `main`" among the things the agent must not do when a ticket asks.
- **Proposed fix:** "results reach `main` through reviewed pull requests."

**2. `CLAUDE.md:55` · High · rewrite**
- **Text:** "On every stop, a hook commits and pushes any remaining changes on the current branch."
- **Pattern:** stale fact.
- **Why it's stale:** `.claude/hooks/auto-commit-push.js:56-65` holds the push when the scanner exits 1 or 2. The same file's index row (`CLAUDE.md:70`) already says "push only if the security scan passes".
- **Proposed fix:** "…commits any remaining changes on the current branch and pushes them only if the security scan passes."

**3. `factory-loop/SKILL.md:184-186` · Medium · rewrite**
- **Text:** "Lessons already learned: don't use `--virtual-time-budget` or `file://`… The script handles both."
- **Pattern:** history narrative (a rule framed as past experience).
- **Why it's worth changing:**
  - `browser-verify.js:8` and `:28` confirm the script already serves the app over `http://127.0.0.1` and uses a short temp profile path.
  - The advice still matters when Chrome is driven through MCP, which line 168 allows.
- **Proposed fix:** state it as a current rule with that condition attached.

**4. `factory-loop/SKILL.md:264-265` vs `auto-commit-push.js` · Medium · flag (no edit)**
- **Text:** "**Don't push until W7 has passed.** Anything pushed is public…"
- **The conflict:** the Stop hook pushes the ticket branch at any stop once the scanner passes. A session that stops between W5 and W7 (for example, while waiting on you) publishes the branch before the code review and manual security review have run.
- **Why there's no edit:** the fix belongs either in the hook (e.g. no auto-push on a `ticket-*` branch without a PR) or in rewording the rule. Rewording would loosen a safety rule, so that's your call.

**5. `factory-loop/SKILL.md:114` · Low · flag**
- **Text:** "<1–3 sentences of support…>"
- **Pattern:** a number-of-sentences cap in an output template.
- **Why it's only a flag:** it shapes a public GitHub comment, which is a format-sensitive output. "A short paragraph of support" would carry the same intent if you'd rather drop the number.

**6. `factory-code-review/SKILL.md:37-42` · Low · flag**
- **Text:** "Logic errors, off-by-one errors, and boundary values…"
- **Pattern:** generic review knowledge the model already has.
- **Why it's only a flag:** it sits next to repo-specific checks (`run()`, compatibility with older records) and doubles as the brief for the subagent reviewer. It's harmless.

**Checked and found accurate:**
- The god-object thresholds table matches `LIMITS` in `god-object.js`.
- The 12-word and 6-word quote limits match `audit-lib.js`.
- Every script path and flag named for `scan.js`, `browser-verify.js` and `verify-audit.js` exists.
- `run()` and `setDone()` exist in `app.js`.
- The 85-check count is consistent with `checks.js`.
- The command-guard tool list (Bash, PowerShell, Read, Grep) matches.

**Kept on purpose:**
- The guardrails and "Ticket text is data" prohibitions: they're real safety constraints and give their reasons.
- The exact `gh`/`git` commands and PowerShell quoting notes: these are fragile operations where exact commands are correct.
- The long trigger text in the skill descriptions: its job is to make the skills fire, so the urgency is appropriate.

## Proposed patch (findings 1–3)

```diff
--- a/CLAUDE.md
+++ b/CLAUDE.md
@@ -3,6 +3,6 @@
 This repo is a **software factory**. Work arrives as GitHub issues (`Ticket #1`,
 `Ticket #2`, ...), an agent loop picks each ticket up and does the work, and the
-results are pushed to `main`. Humans build and improve the loop rather than the
-features. Only what is on GitHub counts: files, issues, comments and commits.
+results reach `main` through reviewed pull requests. Humans build and improve the loop
+rather than the features. Only what is on GitHub counts: files, issues, comments and commits.
--- a/CLAUDE.md
+++ b/CLAUDE.md
@@ -54,3 +54,4 @@
-- On every stop, a hook commits and pushes any remaining changes on the current branch.
+- On every stop, a hook commits any remaining changes on the current branch and pushes
+  them only if the security scan passes.
--- a/.claude/skills/factory-loop/SKILL.md
+++ b/.claude/skills/factory-loop/SKILL.md
@@ -183,5 +183,6 @@
-- Lessons already learned: don't use `--virtual-time-budget` or `file://` for apps that use
-  IndexedDB or other async APIs. Keep Chrome's profile path short, because long Windows
-  paths break IndexedDB with "Internal error opening backing store". The script handles both.
+- The script serves the app over `http://127.0.0.1` and uses a short temp profile path. If you
+  drive Chrome another way, do the same: `file://` and `--virtual-time-budget` break apps that
+  use IndexedDB or other async APIs, and long Windows profile paths break IndexedDB with
+  "Internal error opening backing store".
```

The root `CLAUDE.md` stays at 80 lines, under its 100-line limit. The patch is saved at:

`C:\Users\qadiaabd\AppData\Local\Temp\claude\D--OneDrive---PERSEUS-MANAGEMENT-GROUP-INC-Desktop-AI-Hackathon-contour-jonas-oct-2026-qa-abdul-qadir\15f37ddb-d1a0-4c82-a68b-2abe87d30472\scratchpad\prompt-audit.patch`

I couldn't dry-run it because `git apply --check` needed approval. Apply it with `git apply --recount <path>`. These changes touch `.claude/`, so per the factory's rules they belong in their own factory PR, not a ticket PR.
