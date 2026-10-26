// I/O for verify-audit.js: git/gh/tar processes, the PR export, browser runs and file scans.
// The audit rules themselves live in audit-lib.js.

const { spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const lib = require("./audit-lib");

class AuditError extends Error {} // the audit itself couldn't run → exit 2

const BROWSER_TIMEOUT_MS = 5 * 60 * 1000;
const exec = (cmd, args, opts = {}) => spawnSync(cmd, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, ...opts });

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

// JSON from disk, tolerating the UTF-8 BOM that PowerShell 5.1 writes.
const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""));

const loadTicket = (args) => args["ticket-file"]
  ? readJson(args["ticket-file"])
  : JSON.parse(gh(["api", `repos/{owner}/{repo}/issues/${args.issue}`]));

// Exports the project folder at the PR head into a temp dir with `git archive` (nothing is written
// to .git), and lists the files the PR changes. cleanup() removes only that temp dir.
function checkoutPr(pr, repoRoot, project) {
  const info = JSON.parse(gh(["pr", "view", String(pr), "--json", "number,body,headRefOid,baseRefName,state"]));
  git(["fetch", "--quiet", "origin", `pull/${info.number}/head`, info.baseRefName], repoRoot);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "va-"));
  const cleanup = () => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  try {
    git(["archive", "--format=tar", "-o", path.join(dir, "head.tar"), info.headRefOid, "--", project], repoRoot);
    // Relative names with cwd: Git Bash's GNU tar reads "C:\..." as a remote host.
    const x = exec("tar", ["-xf", "head.tar"], { cwd: dir });
    if (x.status !== 0) throw new AuditError(`couldn't unpack the PR head: ${(x.stderr || "").trim()}`);
    const base = git(["merge-base", `origin/${info.baseRefName}`, info.headRefOid], repoRoot).trim();
    const changed = git(["diff", "--name-only", "--no-renames", base, info.headRefOid], repoRoot).split(/\r?\n/).filter(Boolean);
    return { ...info, dir, changed, cleanup };
  } catch (err) {
    cleanup();
    throw err;
  }
}

const readJsonl = (file) => (fs.existsSync(file) ? fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l)) : []);

// The parts of an evidence pack the audit reads back: manifest, network and console logs.
function readEvidence(dir) {
  const manifestFile = path.join(dir, "manifest.json");
  if (!fs.existsSync(manifestFile)) throw new AuditError(`browser run left no evidence pack in ${dir}`);
  const manifestSha256 = require("crypto").createHash("sha256").update(fs.readFileSync(manifestFile)).digest("hex");
  return { dir, manifestSha256, manifest: readJson(manifestFile), network: readJsonl(path.join(dir, "network.jsonl")), console: readJsonl(path.join(dir, "console.jsonl")) };
}

// One fresh headless-Chrome run of checks.js that records an evidence pack in evidenceDir,
// optionally with a mutation injected first and a screencast.
function runBrowser(projectDir, { before, evidenceDir, video } = {}) {
  const args = [path.join(__dirname, "browser-verify.js"), "--dir", projectDir, "--test", path.join(projectDir, "tests", "checks.js"), "--evidence", evidenceDir];
  if (before) args.push("--before", before);
  if (video) args.push("--video", "1");
  const r = exec(process.execPath, args, { timeout: BROWSER_TIMEOUT_MS });
  if (r.error?.code === "ETIMEDOUT") throw new AuditError(`browser run timed out after ${BROWSER_TIMEOUT_MS / 60000} minutes`);
  const run = lib.parseRun(r.stdout);
  if (run.errors.length) throw new AuditError(`browser run couldn't happen: ${run.errors.join("; ")}`);
  if (![0, 1].includes(r.status) || !run.result) throw new AuditError(`browser-verify crashed: ${(r.stderr || r.stdout || "").trim().slice(-400)}`);
  return { ...run, exitCode: r.status, evidence: readEvidence(evidenceDir) };
}

// Runs checks.js once per mutation (code in a temp file), each with its own evidence pack under
// evidenceRoot/mutation-<id>; returns the parsed runs keyed by criterion id.
function runMutations(projectDir, criteria, evidenceRoot) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vm-"));
  try {
    return Object.fromEntries(criteria.map((c) => {
      const safe = c.id.replace(/[^\w-]/g, "_");
      const file = path.join(dir, `${safe}.js`);
      fs.writeFileSync(file, c.mutation);
      return [c.id, runBrowser(projectDir, { before: file, evidenceDir: path.join(evidenceRoot, `mutation-${safe}`) })];
    }));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
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

// A file criterion only counts if the path is a real file inside the project.
function fileExists(projectDir, rel) {
  const full = path.resolve(projectDir, rel);
  return full.startsWith(path.resolve(projectDir) + path.sep) && fs.existsSync(full) && fs.statSync(full).isFile();
}

function screenshots(projectDir, project, T) {
  const dir = path.join(projectDir, "screenshots");
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.startsWith(`ticket-${T}-`) && f.endsWith(".png")).map((f) => {
    const info = lib.pngInfo(fs.readFileSync(path.join(dir, f)));
    return { file: `${project}/screenshots/${f}`, info, problems: lib.screenshotProblems(info) };
  });
}

const inCommit = (repoRoot, sha, file) => exec("git", ["cat-file", "-e", `${sha}:${file}`], { cwd: repoRoot }).status === 0;

module.exports = {
  AuditError, git, readJson, loadTicket, checkoutPr, runBrowser, runMutations, absentHits, fileExists, screenshots, inCommit,
};
