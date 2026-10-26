---
name: factory-security-review
description: Security review of a ticket branch or pull request in this software factory. It runs a deterministic scan of the added lines for secrets and risky patterns, then a manual threat review (XSS and injection, untrusted input, client-side storage, dependencies and CDNs, hooks and settings that run on contributors' machines), and produces a severity-ranked report that gates the PR. Critical and high findings block it. Use this whenever factory-loop reaches its security step, or whenever the user asks for a security review, security check, vulnerability scan, secret scan or "is this safe to merge" on a branch, PR or diff in this repo, even if they don't name the skill.
---

# factory-security-review

Find security problems in what a branch *adds*, before it reaches a reviewer. The factory
merges work that was produced quickly, often by an agent. That makes this step the safety
net for the classic mistakes: a leaked key, an `innerHTML`, a hook that runs arbitrary
code. It also catches anything an issue's text slipped in.

Scope: the diff between the ticket branch and `main`, read in the context of the files it
touches. Don't audit the whole repo unless asked; use `--all` for that.

## 1. Run the scanner

From the repo root, on the ticket branch:

```
node .claude/skills/factory-security-review/scripts/scan.js --base main
```

It checks the lines added since `main`, including uncommitted and untracked files, for:
- **secrets:** cloud, GitHub and LLM API keys, private keys, `password = "..."`, `.env`, `.pem` and similar files
- **XSS and code injection:** `innerHTML`, `insertAdjacentHTML`, `document.write`, `eval`, `new Function`, string timers, `javascript:` URLs
- **shell injection:** template strings passed to `exec`, `shell: true`
- **transport:** disabled TLS checks, plain `http://`, CDN scripts without SRI, `target=_blank` without `noopener`
- **web storage:** credential-like data in `localStorage`
- **destructive commands** inside scripts
- **changes to `.claude/settings*.json` or `.claude/hooks/`**

The exit code is 1 when anything is critical or high. Treat every hit as a **lead**. Open the
code and confirm it is a real issue before reporting it. A confirmed false positive gets
`// security-scan: ignore` on that line, plus one sentence in the report saying why.

## 2. Manual review (the scanner can't do this part)

Read the full diff (`git diff main...HEAD`) and each touched file around the changes. Then
ask these questions, keeping only the ones that apply to this change:

- **Untrusted input → sinks.** Where does user or external data enter, such as form fields,
  URL params, `postMessage`, imported files, API responses or issue text? Follow it to every
  place it is written. In the DOM it must go through `textContent` or attributes, never HTML.
  The same goes for URLs (`href`/`src`; block `javascript:`), file paths, shell commands,
  SQL and regexes (watch for ReDoS from nested quantifiers on user input).
- **Data at rest.** What is stored client-side (IndexedDB or localStorage)? It's readable by
  any script on the origin, so it should never hold secrets or tokens. Is stored data
  validated or normalized when it's read back, so a corrupted or old record can't break the app?
- **Dependencies and third-party code.** New packages, CDN scripts or fonts: are they pinned
  to an exact version, from a trusted source, with SRI where possible? Is each one actually needed?
- **Agent and dev tooling.** Any change under `.claude/` (hooks, settings, skills, scripts)
  runs on teammates' machines. Check what it executes, which network calls it makes, which
  files it writes, and whether it could be steered by issue or PR text (prompt injection).
  Check also that it can't push secrets or delete work.
- **Secrets hygiene.** Nothing real in code, tests, fixtures, screenshots or commit messages,
  and `.gitignore` covers local env files if the project uses them.
- **Authorization and privacy**, if the project has users or a server: access checks on every
  endpoint, no sensitive data in URLs or logs, CORS not set to `*` together with credentials.
- **Error handling.** Errors shown to users don't leak stack traces or internals, and
  failures don't leave the app in an insecure state.

For a large or high-risk change, Claude Code's built-in `/security-review` can be run as
a second opinion. Its findings still need confirming like any other.

## 3. Severity and gate

| Severity | Meaning | Gate |
|---|---|---|
| **Critical** | Exploitable now or secret exposed (live key committed, RCE, stored XSS) | **Block.** Fix before the PR; rotate any leaked secret. History rewrites need the user's OK. |
| **High** | Likely exploitable with modest effort (reflected XSS, injection, TLS off) | **Block.** Fix before the PR. |
| **Medium** | Weakens defenses or needs unusual conditions (no SRI, http URL, token in storage) | Fix, or justify in the report. |
| **Low** | Hardening and hygiene | Note it. |

After fixing anything, rerun the scanner and the project's browser checks. A secret that was
already pushed stays leaked even if a later commit removes it. Tell the user to rotate it.
Never force-push or rewrite history without their explicit OK.

## 4. Report

Write the report to a file and post it as a PR comment (`gh pr comment <PR> --body-file <file>`):

```markdown
## Security review: <branch>

**Result:** ✅ No blocking issues | ⚠️ N medium/low | ❌ Blocked: N critical/high

**Scanner** (`scan.js --base main`): <N findings → N confirmed, N false positives (why)>

**Manual review covered:** <the checks from section 2 that applied, one line each>

| Severity | Where | Issue | Status |
|---|---|---|---|
| High | `todo/app.js:120` | innerHTML with task title | Fixed in <sha> |

<"No findings" is a valid result. Say what was checked so the reviewer can trust it.>
```

Only report what you confirmed. Don't pad the report with generic advice.
