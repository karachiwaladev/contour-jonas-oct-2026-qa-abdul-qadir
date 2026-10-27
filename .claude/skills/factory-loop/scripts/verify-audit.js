#!/usr/bin/env node
// Verification audit: did the factory really verify the feature the ticket asked for?
//
//   node verify-audit.js --issue <N> --project <dir> [--pr <PR>] [--out report.md]
//                        [--evidence <dir>] [--acceptance <file>] [--ticket-file ticket.json]
//                        [--mode ticket|regression]
//
// --evidence    keep the evidence packs recorded from Chrome (base run with video, one per mutation)
//               in this folder; CI uploads it as an artifact. Without it they go to a temp folder.
// --mode regression  with --pr, for a PR that isn't this ticket's own (a factory change or another
//               ticket touching the project): re-proves the ticket on the PR head, without the rules
//               about that PR's body, screenshots and factory files.
// --acceptance  criteria file from the current checkout instead of the audited tree (for old PRs)
// --ticket-file {title, body} JSON instead of fetching the issue with gh (offline runs)
//
// 1. Ticket coverage: each criterion in <project>/tests/acceptance/ticket-<T>.json quotes one ask
//    from the ticket (or is a decision clarified with the user), and every meaningful ticket word,
//    title included, is quoted. "context" may only be a short sentence lead-in.
// 2. Fresh Chrome run of <project>/tests/checks.js (linted first for hard-coded passes): every
//    mapped check passes, with no console errors. Earlier runs and the PR's claims are never trusted.
// 3. Mutation: each criterion's "mutation" (JS that breaks that feature) is injected and the checks
//    rerun; at least one of its checks must now FAIL, which proves the checks really test it.
// 4. Evidence: ticket-<T>-*.png screenshots decode as real, non-blank images. With --pr: the PR
//    closes #N, embeds them pinned to a commit, added them itself, and doesn't touch .claude/.
// With --pr the audit runs on the PR's head commit, exported to a temp folder; the working tree is
// never touched. Run it from main, so a branch can't weaken the audit that judges it.
// Exit 0 = VERIFIED, 1 = NOT VERIFIED, 2 = the audit couldn't run.

const fs = require("fs");
const path = require("path");
const lib = require("./audit-lib");
const io = require("./audit-io");
const { report } = require("./audit-report");

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 2) args[argv[i].replace(/^--/, "")] = argv[i + 1];
  if (!args.issue || !args.project) {
    throw new io.AuditError("usage: verify-audit.js --issue <N> --project <dir> [--pr <PR>] [--out report.md] [--evidence dir] [--acceptance f] [--ticket-file f] [--mode ticket|regression]");
  }
  args.mode = args.mode || "ticket";
  if (!["ticket", "regression"].includes(args.mode)) throw new io.AuditError(`--mode must be ticket or regression, not "${args.mode}"`);
  args.project = args.project.replace(/\\/g, "/").replace(/\/+$/, "");
  return args;
}

function checkTicket(f, ticket, acc) {
  for (const p of lib.validateAcceptance(acc, { ticket: f.T, issue: f.issue })) f.blockers.push(`acceptance file: ${p}`);
  if (f.blockers.length) return;
  const title = String(ticket.title || "").replace(/^\s*Ticket\s*#\d+:?/i, "");
  const cov = lib.ticketCoverage(title, ticket.body || "", acc);
  for (const q of cov.badQuotes) f.blockers.push(`quote not found in the ticket: "${q}"`);
  for (const q of cov.longQuotes) f.blockers.push(`quote covers more than one ask (max ${lib.MAX_QUOTE_WORDS} words, one sentence): "${q}"`);
  for (const q of cov.badContext) f.blockers.push(`context must be a short lead-in that starts a sentence (max ${lib.MAX_CONTEXT_WORDS} words): "${q}"`);
  if (cov.uncoveredWords.length) f.blockers.push(`ticket text not mapped to any criterion: ${cov.uncoveredWords.join(", ")}`);
}

function checkRun(f, projectDir, acc) {
  const checksFile = path.join(projectDir, "tests", "checks.js");
  if (!fs.existsSync(checksFile)) return f.blockers.push(`no browser checks at ${f.project}/tests/checks.js`);
  for (const why of lib.lintChecks(fs.readFileSync(checksFile, "utf8"))) f.blockers.push(`checks.js: ${why}`);
  f.run = io.runBrowser(projectDir, { evidenceDir: path.join(f.evidenceRoot, "base"), video: true });
  // Synthetic .click() calls bypass the real event path (focus, disabled controls, overlays), so a run
  // that never used trusted input doesn't count as having driven the UI.
  if (!f.run.evidence.manifest.counts.trustedInputs) f.blockers.push("checks.js never used trusted.click / trusted.type: drive the UI with real input dispatched by Chrome");
  if (f.run.fail.length) f.blockers.push(`${f.run.fail.length} browser check(s) failed: ${f.run.fail.join("; ")}`);
  if (f.run.consoleErrors.length) f.blockers.push(`console errors: ${f.run.consoleErrors.join("; ")}`);
  if ((f.run.result !== "PASS" || f.run.exitCode !== 0) && !f.run.fail.length && !f.run.consoleErrors.length) {
    f.blockers.push('browser-verify reported FAIL: every result must be a one-line "PASS ..."');
  }
  if (!Array.isArray(acc.criteria)) return;
  f.criteria = lib.gradeCriteria(acc, f.run, {
    fileExists: (rel) => io.fileExists(projectDir, rel),
    absentHits: (pattern) => io.absentHits(projectDir, pattern),
    externalRequests: () => lib.externalRequests(f.run.evidence.network, f.run.evidence.egress),
  });
  for (const c of f.criteria.filter((x) => !x.ok)) f.blockers.push(`${c.id} not verified: ${c.problems.join("; ")}`);
}

// Breaks each feature on purpose; its checks must notice. Only worth it once the fresh run is clean.
function checkMutations(f, projectDir) {
  if (!f.criteria || f.run?.result !== "PASS") return;
  const targets = f.criteria.filter((c) => c.ok && (c.checks || []).length && c.mutation);
  const runs = io.runMutations(projectDir, targets, f.evidenceRoot);
  for (const c of targets) {
    c.mutationRun = runs[c.id];
    c.killed = lib.killedBy(c, runs[c.id]);
    if (c.killed.length) continue;
    const threw = runs[c.id].fail.find((l) => /^(before|test) threw/.test(l));
    f.blockers.push(threw ? `${c.id}: its mutation crashed instead of breaking the feature (${threw})`
      : `${c.id}: all its checks still pass with the feature broken (\`${c.mutation.trim()}\`), so they don't prove it`);
  }
}

function checkPr(f, pr, repoRoot) {
  const factory = pr.changed.filter((p) => (p.startsWith(".claude/") && !p.startsWith(".claude/logs/")) || p.startsWith(".github/"));
  if (factory.length) f.blockers.push(`a ticket PR must not change factory files (${factory.join(", ")}); ship them in a separate PR`);
  const ev = lib.prEvidence(pr.body, f.issue);
  const pinned = ev.images.filter((i) => i.path.startsWith(`${f.project}/screenshots/ticket-${f.T}-`));
  f.pr = { number: pr.number, closes: ev.closes, pinned, claim: ev.claim };
  if (!ev.closes) f.blockers.push(`PR body doesn't close #${f.issue} (e.g. "Closes #${f.issue}")`);
  if (!pinned.length) f.blockers.push(`PR body embeds no ticket-${f.T} screenshot pinned to a commit`);
  for (const s of pinned) {
    if (!io.inCommit(repoRoot, s.sha, s.path)) f.blockers.push(`PR screenshot ${s.path} isn't in commit ${s.sha}`);
    else if (!pr.changed.includes(s.path)) f.blockers.push(`PR screenshot ${s.path} wasn't added or updated by this PR`);
  }
  const fresh = { passed: f.run?.pass.length || 0, total: (f.run?.pass.length || 0) + (f.run?.fail.length || 0) };
  if (!ev.claim) f.notes.push("the PR body states no check count");
  else if (ev.claim.passed !== fresh.passed || ev.claim.total !== fresh.total) {
    f.notes.push(`the PR claims ${ev.claim.passed}/${ev.claim.total} checks; the fresh run gives ${fresh.passed}/${fresh.total}`);
  }
}

function checkEvidence(f, projectDir, pr, repoRoot) {
  f.shots = io.screenshots(projectDir, f.project, f.T);
  if (!f.shots.length) f.blockers.push(`no screenshots named ${f.project}/screenshots/ticket-${f.T}-*.png`);
  for (const s of f.shots) for (const p of s.problems) f.blockers.push(`screenshot ${s.file}: ${p}`);
  if (pr && f.mode !== "regression") checkPr(f, pr, repoRoot);
}

function loadAcceptance(f, args, root, projectDir) {
  // --acceptance reads the current checkout (for PRs made before acceptance files existed); by
  // default the criteria come from the audited tree, so they are part of what gets reviewed.
  const accPath = args.acceptance ? path.resolve(args.acceptance) : path.join(projectDir, "tests", "acceptance", `ticket-${f.T}.json`);
  f.accFile = args.acceptance ? `${args.acceptance} (current checkout)` : path.relative(root, accPath).replace(/\\/g, "/");
  if (!fs.existsSync(accPath)) {
    f.blockers.push(`no acceptance criteria at ${f.accFile}`);
    return {};
  }
  try {
    return io.readJson(accPath);
  } catch (err) {
    f.blockers.push(`acceptance file isn't valid JSON: ${err.message}`);
    return {};
  }
}

function audit(args) {
  const ticket = io.loadTicket(args);
  const T = (String(ticket.title).match(/Ticket\s*#(\d+)/i) || [])[1];
  if (!T) throw new io.AuditError(`issue #${args.issue} has no "Ticket #<T>" in its title`);
  const repoRoot = io.git(["rev-parse", "--show-toplevel"]).trim();
  const pr = args.pr ? io.checkoutPr(args.pr, repoRoot, args.project) : null;
  const root = pr ? pr.dir : repoRoot;
  const ref = pr ? `PR #${pr.number} @ ${pr.headRefOid.slice(0, 7)}${args.mode === "regression" ? " (regression: re-proving this ticket on another PR)" : ""}` : "working tree";
  const f = { T, issue: args.issue, project: args.project, mode: args.mode, ref, blockers: [], notes: [] };
  f.evidenceRoot = args.evidence ? path.resolve(args.evidence) : fs.mkdtempSync(path.join(require("os").tmpdir(), "ve-"));
  f.evidenceKept = !!args.evidence;
  try {
    const projectDir = path.join(root, args.project);
    const acc = loadAcceptance(f, args, root, projectDir);
    f.context = acc.context || [];
    if (acc.criteria) checkTicket(f, ticket, acc);
    checkRun(f, projectDir, acc);
    checkMutations(f, projectDir);
    checkEvidence(f, projectDir, pr, repoRoot);
    return f;
  } finally {
    if (pr) pr.cleanup();
    if (!f.evidenceKept) fs.rmSync(f.evidenceRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}

function main() {
  try {
    const args = parseArgs(process.argv.slice(2));
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
