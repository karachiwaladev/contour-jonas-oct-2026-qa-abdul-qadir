#!/usr/bin/env node
// Verification audit: did the factory really verify the feature the ticket asked for?
//
//   node verify-audit.js --issue <N> --project <dir> [--pr <PR>] [--out report.md]
//                        [--acceptance <file>] [--ticket-file ticket.json]
//
// --acceptance  criteria file from the current checkout instead of the audited tree (for old PRs)
// --ticket-file {title, body} JSON instead of fetching the issue with gh (offline runs)
//
// 1. Ticket coverage: each criterion in <project>/tests/acceptance/ticket-<T>.json quotes the
//    ticket (or is a decision clarified with the user), and every meaningful ticket word is quoted.
// 2. Fresh Chrome run of <project>/tests/checks.js: every check mapped to a criterion passes and
//    nothing logs a console error. Earlier runs and the PR's own claims are never trusted.
// 3. Evidence: ticket-<T>-*.png screenshots are real PNGs. With --pr, the PR says Closes #N, embeds
//    those screenshots pinned to a commit that contains them, and its check count is compared.
// With --pr the audit runs on the PR's head commit in a temporary git worktree, so the working tree
// is never touched. Exit 0 = VERIFIED, 1 = NOT VERIFIED, 2 = the audit couldn't run.

const { spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const lib = require("./audit-lib");

class AuditError extends Error {} // the audit itself couldn't run → exit 2

const exec = (cmd, args, opts = {}) => spawnSync(cmd, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, ...opts });

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 2) args[argv[i].replace(/^--/, "")] = argv[i + 1];
  if (!args.issue || !args.project) {
    throw new AuditError("usage: verify-audit.js --issue <N> --project <dir> [--pr <PR>] [--out report.md] [--acceptance f] [--ticket-file f]");
  }
  args.project = args.project.replace(/\\/g, "/").replace(/\/+$/, "");
  return args;
}

function git(args, cwd) {
  const r = exec("git", args, { cwd });
  if (r.status !== 0) throw new AuditError(`git ${args.join(" ")} failed: ${(r.stderr || "").trim()}`);
  return r.stdout;
}

function gh(args) {
  const exe = exec("gh", ["--version"]).status === 0 ? "gh" : "C:/Program Files/GitHub CLI/gh.exe";
  const r = exec(exe, args);
  if (r.error || r.status !== 0) throw new AuditError(`gh ${args.join(" ")} failed: ${(r.stderr || r.error?.message || "").trim()}`);
  return r.stdout;
}

const loadTicket = (args) => args["ticket-file"]
  ? JSON.parse(fs.readFileSync(args["ticket-file"], "utf8"))
  : JSON.parse(gh(["api", `repos/{owner}/{repo}/issues/${args.issue}`]));

// Checks out the PR head in a throwaway worktree; cleanup removes only that worktree.
function checkoutPr(pr, repoRoot) {
  const info = JSON.parse(gh(["pr", "view", String(pr), "--json", "number,body,headRefOid,state"]));
  git(["fetch", "--quiet", "origin", `pull/${info.number}/head`], repoRoot);
  const dir = path.join(os.tmpdir(), `va-${process.pid}-${Date.now()}`);
  git(["worktree", "add", "--detach", "--quiet", dir, info.headRefOid], repoRoot);
  return { ...info, dir, cleanup: () => exec("git", ["worktree", "remove", "--force", dir], { cwd: repoRoot }) };
}

function runBrowser(projectDir) {
  const checks = path.join(projectDir, "tests", "checks.js");
  if (!fs.existsSync(checks)) return { ...lib.parseRun(""), missing: true };
  const r = exec(process.execPath, [path.join(__dirname, "browser-verify.js"), "--dir", projectDir, "--test", checks]);
  const run = lib.parseRun(r.stdout);
  // Browser infrastructure trouble means the audit couldn't run; it says nothing about the feature.
  const crash = run.fail.find((l) => /Chrome\/Edge not found|Chrome did not start|CDP connection failed|\b(EBUSY|EPERM|EACCES)\b/.test(l));
  if (crash) throw new AuditError(`browser run couldn't start: ${crash}`);
  return run;
}

function sourceFiles(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".") || ["tests", "screenshots", "node_modules"].includes(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) sourceFiles(full, out);
    else if (/\.(m?js|html)$/.test(entry.name)) out.push(full);
  }
  return out;
}

function absentHits(projectDir, pattern) {
  const re = new RegExp(pattern);
  return sourceFiles(projectDir).flatMap((file) => fs.readFileSync(file, "utf8").split(/\r?\n/)
    .map((line, i) => (re.test(line) ? `${path.relative(projectDir, file)}:${i + 1}` : null)).filter(Boolean));
}

function screenshots(projectDir, project, T) {
  const dir = path.join(projectDir, "screenshots");
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.startsWith(`ticket-${T}-`) && f.endsWith(".png")).map((f) => {
    const info = lib.pngInfo(fs.readFileSync(path.join(dir, f)));
    return { file: `${project}/screenshots/${f}`, info, problems: lib.screenshotProblems(info) };
  });
}

function checkTicket(f, ticket, acc) {
  for (const p of lib.validateAcceptance(acc)) f.blockers.push(`acceptance file: ${p}`);
  if (f.blockers.length) return;
  // The body holds the asks; the title is only a summary of them (fallback when the body is empty).
  const asks = String(ticket.body || "").trim() || String(ticket.title).replace(/Ticket\s*#\d+:?/i, "");
  const cov = lib.ticketCoverage(asks, acc);
  for (const q of cov.badQuotes) f.blockers.push(`quote not found in the ticket: "${q}"`);
  if (cov.uncoveredWords.length) f.blockers.push(`ticket text not mapped to any criterion: ${cov.uncoveredWords.join(", ")}`);
}

function checkRun(f, projectDir, acc) {
  f.run = runBrowser(projectDir);
  if (f.run.missing) return f.blockers.push(`no browser checks at ${f.project}/tests/checks.js`);
  if (f.run.fail.length) f.blockers.push(`${f.run.fail.length} browser check(s) failed: ${f.run.fail.join("; ")}`);
  if (f.run.consoleErrors.length) f.blockers.push(`console errors: ${f.run.consoleErrors.join("; ")}`);
  if (!acc.criteria) return;
  f.criteria = lib.gradeCriteria(acc, f.run, {
    fileExists: (rel) => fs.existsSync(path.join(projectDir, rel)),
    absentHits: (pattern) => absentHits(projectDir, pattern),
  });
  for (const c of f.criteria.filter((x) => !x.ok)) f.blockers.push(`${c.id} not verified: ${c.problems.join("; ")}`);
}

function checkEvidence(f, projectDir, pr, repoRoot) {
  f.shots = screenshots(projectDir, f.project, f.T);
  if (!f.shots.length) f.blockers.push(`no screenshots named ${f.project}/screenshots/ticket-${f.T}-*.png`);
  for (const s of f.shots) for (const p of s.problems) f.blockers.push(`screenshot ${s.file}: ${p}`);
  if (!pr) return;
  const ev = lib.prEvidence(pr.body, f.issue);
  const pinned = ev.images.filter((i) => i.path.startsWith(`${f.project}/screenshots/ticket-${f.T}-`));
  f.pr = { number: pr.number, closes: ev.closes, pinned, claim: ev.claim };
  if (!ev.closes) f.blockers.push(`PR body doesn't say "Closes #${f.issue}"`);
  if (!pinned.length) f.blockers.push(`PR body embeds no ticket-${f.T} screenshot pinned to a commit`);
  for (const s of pinned) {
    if (exec("git", ["cat-file", "-e", `${s.sha}:${s.path}`], { cwd: repoRoot }).status !== 0) {
      f.blockers.push(`PR screenshot ${s.path} isn't in commit ${s.sha}`);
    }
  }
  const fresh = { passed: f.run.pass.length, total: f.run.pass.length + f.run.fail.length };
  if (!ev.claim) f.notes.push("the PR body states no check count");
  else if (ev.claim.passed !== fresh.passed || ev.claim.total !== fresh.total) {
    f.notes.push(`the PR claims ${ev.claim.passed}/${ev.claim.total} checks; the fresh run gives ${fresh.passed}/${fresh.total}`);
  }
}

function audit(args) {
  const ticket = loadTicket(args);
  const T = (String(ticket.title).match(/Ticket\s*#(\d+)/i) || [])[1];
  if (!T) throw new AuditError(`issue #${args.issue} has no "Ticket #<T>" in its title`);
  const repoRoot = git(["rev-parse", "--show-toplevel"]).trim();
  const pr = args.pr ? checkoutPr(args.pr, repoRoot) : null;
  const root = pr ? pr.dir : repoRoot;
  const f = { T, issue: args.issue, project: args.project, ref: pr ? `PR #${pr.number} @ ${pr.headRefOid.slice(0, 7)}` : "working tree", blockers: [], notes: [] };
  try {
    const projectDir = path.join(root, args.project);
    // --acceptance is read from the current checkout (for auditing PRs made before acceptance files existed);
    // by default the criteria come from the audited tree itself, so they are part of what gets reviewed.
    const accPath = args.acceptance ? path.resolve(args.acceptance) : path.join(projectDir, "tests", "acceptance", `ticket-${T}.json`);
    f.accFile = args.acceptance ? `${args.acceptance} (current checkout)` : path.relative(root, accPath).replace(/\\/g, "/");
    if (!fs.existsSync(accPath)) f.blockers.push(`no acceptance criteria at ${f.accFile}`);
    const acc = fs.existsSync(accPath) ? JSON.parse(fs.readFileSync(accPath, "utf8")) : {};
    f.context = acc.context || [];
    if (acc.criteria) checkTicket(f, ticket, acc);
    checkRun(f, projectDir, acc);
    checkEvidence(f, projectDir, pr, repoRoot);
    return f;
  } finally {
    if (pr) pr.cleanup();
  }
}

const esc = (s) => String(s).replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
const ok = (b) => (b ? "✅" : "❌");

function evidenceText(c) {
  const parts = [];
  if ((c.checks || []).length) parts.push(`${c.checks.length} check${c.checks.length === 1 ? "" : "s"}`);
  if ((c.files || []).length) parts.push(`files: ${c.files.join(", ")}`);
  if (c.absent) parts.push(`no \`/${c.absent}/\` in the source`);
  return parts.join(" + ");
}

function report(f) {
  const verified = f.blockers.length === 0;
  const run = f.run || { pass: [], fail: [], consoleErrors: [] };
  const lines = [
    `## Verification audit: Ticket #${f.T} (issue #${f.issue})`, "",
    verified ? "**Verdict: ✅ VERIFIED.** Every ticket ask maps to evidence that passed in a fresh run."
      : `**Verdict: ❌ NOT VERIFIED.** ${f.blockers.length} problem(s) below. Don't merge until they're fixed.`, "",
    `Audited: ${f.ref} · fresh Chrome run: ${run.pass.length}/${run.pass.length + run.fail.length} checks passed, ` +
      `${run.consoleErrors.length} console error(s) · criteria: \`${f.accFile}\``, "",
  ];
  if (f.criteria) {
    lines.push("### Ticket asks → evidence", "", "| ID | Ask | Evidence | Result |", "|---|---|---|---|");
    for (const c of f.criteria) {
      const ask = c.quote ? `"${esc(c.quote)}"` : `clarified: ${esc(c.requirement)}`;
      lines.push(`| ${c.id} | ${ask} | ${esc(evidenceText(c))} | ${c.ok ? "✅" : `❌ ${esc(c.problems.join("; "))}`} |`);
    }
    lines.push("");
  }
  for (const c of f.context || []) lines.push(`- Context, not a separate ask: "${c.quote}" (${c.reason})`);
  if ((f.context || []).length) lines.push("");
  lines.push("### Screenshots", "", ...(f.shots || []).map((s) =>
    `- \`${s.file}\`: ${s.info ? `${s.info.width}×${s.info.height}, ${Math.round(s.info.bytes / 1024)} KB` : "unreadable"} ${ok(!s.problems.length)}`), "");
  if (f.pr) {
    lines.push(`### PR #${f.pr.number} evidence`, "", `- Closes #${f.issue}: ${ok(f.pr.closes)}`,
      `- Screenshots pinned to a commit: ${f.pr.pinned.length} ${ok(f.pr.pinned.length > 0)}`,
      `- Check count claimed: ${f.pr.claim ? `${f.pr.claim.passed}/${f.pr.claim.total}` : "none"}`, "");
  }
  if (!verified) lines.push("### Problems", "", ...f.blockers.map((b) => `- ${b}`), "");
  if (f.notes.length) lines.push("### Notes", "", ...f.notes.map((n) => `- ${n}`), "");
  return lines.join("\n");
}

function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
    const findings = audit(args);
    const text = report(findings);
    if (args.out) fs.writeFileSync(args.out, text);
    console.log(text);
    process.exit(findings.blockers.length ? 1 : 0);
  } catch (err) {
    console.error(`verify-audit: couldn't run: ${err.message}`);
    process.exit(2);
  }
}

if (require.main === module) main();
module.exports = { report };
