#!/usr/bin/env node
// Stop hook: commits any uncommitted changes in the repo and pushes the current branch.
// Deliberately non-destructive: no force push, no reset, no --no-verify, and it does nothing
// while a merge/rebase/cherry-pick is in progress or HEAD is detached. Files that look like
// secrets are never committed, and nothing is pushed until the factory-security-review scanner
// passes (blocking findings or a scan that can't run hold the push; the commit stays local).
// Failures are reported on stderr and never block stopping.

const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const SECRET_PATTERNS = [/(^|\/)\.env(\..*)?$/, /\.(pem|key|p12|pfx)$/, /(^|\/)id_(rsa|ed25519|ecdsa)$/];
// Only committed on the default branch, so ticket-branch PRs stay focused and never conflict on it.
const PROMPT_LOG = ".claude/logs/prompts.jsonl";
const SCANNER = ".claude/skills/factory-security-review/scripts/scan.js";

const cwd = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const git = (...args) => spawnSync("git", args, { cwd, encoding: "utf8" });
const fail = (msg) => {
  process.stderr.write(`auto-commit-push: ${msg}\n`);
  process.exit(0);
};

function main() {
  const gitDir = git("rev-parse", "--git-dir");
  if (gitDir.status !== 0) return; // not a git repo
  const dir = path.resolve(cwd, gitDir.stdout.trim());
  if (["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "rebase-merge", "rebase-apply"].some((f) => fs.existsSync(path.join(dir, f)))) {
    return fail("merge/rebase in progress; skipping");
  }
  const branch = git("symbolic-ref", "--quiet", "--short", "HEAD").stdout.trim();
  if (!branch) return fail("detached HEAD; skipping");
  const defaultBranch = git("symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD").stdout.trim().replace(/^origin\//, "") || "main";

  git("add", "-A");
  const staged = git("diff", "--cached", "--name-only").stdout.split("\n").filter(Boolean);
  const secrets = staged.filter((f) => SECRET_PATTERNS.some((re) => re.test(f)));
  if (secrets.length) process.stderr.write(`auto-commit-push: not committing possible secrets: ${secrets.join(", ")}\n`);
  const held = branch === defaultBranch ? secrets : [...secrets, ...staged.filter((f) => f === PROMPT_LOG)];
  if (held.length) git("reset", "-q", "--", ...held); // unstage only; the files stay on disk untouched
  const files = staged.filter((f) => !held.includes(f));

  if (files.length) {
    const summary = files.length <= 3 ? files.join(", ") : `${files.slice(0, 3).join(", ")} and ${files.length - 3} more`;
    const message = `Auto-commit on stop: ${summary}\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`;
    const commit = git("commit", "-q", "-m", message);
    if (commit.status !== 0) return fail(`commit failed: ${(commit.stderr || commit.stdout).trim()}`);
  }

  // Push whenever the branch has commits the remote doesn't, including ones made earlier.
  const upstream = git("rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}");
  const ahead = upstream.status === 0 ? Number(git("rev-list", "--count", "@{u}..HEAD").stdout.trim()) : 1;
  if (!ahead) return;

  // Security gate: scan what this push would publish (everything since the remote default
  // branch) before it leaves the machine.
  if (fs.existsSync(path.join(cwd, SCANNER))) {
    const remoteDefault = git("rev-parse", "--verify", "--quiet", `origin/${defaultBranch}`).status === 0;
    const scan = spawnSync(process.execPath, [SCANNER, "--base", remoteDefault ? `origin/${defaultBranch}` : defaultBranch], { cwd, encoding: "utf8" });
    if (scan.status !== 0) {
      const lines = `${scan.stdout}${scan.stderr}`.trim().split("\n");
      const summary = lines.filter((l) => /^\[(CRITICAL|HIGH)\]|^RESULT:|^scan failed/.test(l)).slice(0, 6).join("; ");
      return fail(`push held by security scan (exit ${scan.status}); commit is local only. ${summary}`);
    }
  }

  const push = upstream.status === 0 ? git("push", "origin", branch) : git("push", "-u", "origin", branch);
  if (push.status !== 0) return fail(`push failed: ${push.stderr.trim().split("\n").pop()}`);
}

try {
  main();
} catch (err) {
  fail(err.message);
}
