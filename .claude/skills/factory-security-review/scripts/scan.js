#!/usr/bin/env node
// Pattern-based security scan of what a branch adds, for the factory-security-review skill.
//
//   node scan.js [--base main] [--all]
//
// Scans lines added since the merge-base with <base> (committed, uncommitted and untracked
// files). With --all, scans every tracked and untracked file instead. Prints one line per finding:
//   [SEVERITY] rule-id  path:line  message
//     > offending line
// Exit codes: 0 = no blocking findings, 1 = critical/high findings, 2 = the scan could not run
// (never treat 2 as clean). Findings are leads, not verdicts: the skill says to confirm each
// one by reading the code. Silence a confirmed false positive by adding
// "security-scan: ignore" to the line, and explain why in the review.

const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const args = process.argv.slice(2);
const scanAll = args.includes("--all");
const baseIndex = args.indexOf("--base");
const base = baseIndex === -1 ? "main" : args[baseIndex + 1];

const SELF = path.relative(process.cwd(), __filename).split(path.sep).join("/");
const CODE = /\.(m?js|cjs|ts|tsx|jsx|html?|vue|svelte|py|rb|php|go|java|cs|sh|ps1)$/i;
const ENV_LIKE = /(^|\/)(\.env[^/]*|[^/]+\.(sh|ps1|ya?ml|properties|ini|cfg|conf|toml))$/i;
const EXAMPLE = /\.(example|sample|template|dist)$/i;
const MAX_LINE = 2000; // longer lines (minified code) are truncated before matching: bounds regex cost

// { id, severity, re, msg, files? (path filter), skip? (path exclusion) }
const LINE_RULES = [
  // Secrets: specific formats are flagged everywhere, including comments and example files.
  { id: "secret-aws-key", severity: "critical", re: /AKIA[0-9A-Z]{16}/, msg: "AWS access key ID" },
  { id: "secret-github-token", severity: "critical", re: /\bgh[pousr]_[A-Za-z0-9]{36,}/, msg: "GitHub token" },
  { id: "secret-anthropic-key", severity: "critical", re: /\bsk-ant-[A-Za-z0-9_-]{20,}/, msg: "Anthropic API key" },
  { id: "secret-openai-key", severity: "critical", re: /\bsk-(proj-)?[A-Za-z0-9]{32,}/, msg: "OpenAI-style API key" },
  { id: "secret-slack-token", severity: "critical", re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/, msg: "Slack token" },
  { id: "secret-private-key", severity: "critical", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/, msg: "Private key material" },
  // Generic credential assignments: quoted values in code/JSON, unquoted KEY=value in env-like files.
  { id: "secret-assignment", severity: "high", re: /\w*(api[_-]?key|secret|token|passw(or)?d|credential)\w*["']?\s*[:=]\s*["'`][^"'`\s$<{]{8,}["'`]/i, msg: "Hard-coded credential-like value", skip: EXAMPLE },
  { id: "secret-env-assignment", severity: "high", re: /^\s*(export\s+)?[A-Z0-9_]*(KEY|SECRET|TOKEN|PASSWORD|PASSWD)[A-Z0-9_]*\s*=\s*["']?[^\s"'#$<{]{8,}/, msg: "Credential-like value in env/config file", files: ENV_LIKE, skip: EXAMPLE },
  // XSS / code injection (client side)
  { id: "xss-innerhtml", severity: "high", re: /\.(inner|outer)HTML\s*\+?=(?!=)/, msg: "innerHTML/outerHTML assignment (use textContent or DOM APIs)", files: CODE },
  { id: "xss-insert-adjacent", severity: "high", re: /\binsertAdjacentHTML\s*\(/, msg: "insertAdjacentHTML with possibly untrusted data", files: CODE },
  { id: "xss-document-write", severity: "high", re: /\bdocument\.write(ln)?\s*\(/, msg: "document.write", files: CODE },
  { id: "xss-react-dangerous", severity: "high", re: /dangerouslySetInnerHTML/, msg: "dangerouslySetInnerHTML", files: CODE },
  { id: "code-eval", severity: "high", re: /(^|[^.\w])eval\s*\(/, msg: "eval()", files: CODE },
  { id: "code-new-function", severity: "high", re: /\bnew\s+Function\s*\(/, msg: "new Function()", files: CODE },
  { id: "code-string-timer", severity: "high", re: /\bset(Timeout|Interval)\s*\(\s*["'`]/, msg: "setTimeout/setInterval with a string (implicit eval)", files: CODE },
  { id: "xss-javascript-url", severity: "high", re: /["'`]\s*javascript:/i, msg: "javascript: URL", files: CODE },
  // Command / process injection (server side, scripts, hooks)
  { id: "cmd-exec-template", severity: "high", re: /\bexec(Sync)?\s*\(\s*`[^`]*\$\{/, msg: "Shell command built from a template string", files: CODE },
  { id: "cmd-shell-true", severity: "medium", re: /\bshell\s*:\s*true\b/, msg: "spawn with shell: true", files: CODE },
  // Transport / TLS
  { id: "tls-disabled", severity: "high", re: /rejectUnauthorized\s*:\s*false|NODE_TLS_REJECT_UNAUTHORIZED\s*=\s*["']?0/, msg: "TLS certificate verification disabled" },
  { id: "insecure-http", severity: "medium", re: /["'`]http:\/\/(?!(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)[:/"'`])/, msg: "Plain http:// URL (use https)", files: CODE },
  { id: "script-no-sri", severity: "medium", re: /<script\b(?![^>]*\bintegrity=)[^>]*\bsrc=["']https?:\/\//i, msg: "External <script> without integrity (SRI)", files: /\.html?$/i },
  { id: "link-noopener", severity: "low", re: /target=["']_blank["'](?![^>]*\brel=["'][^"']*noopener)/i, msg: 'target="_blank" without rel="noopener"', files: CODE },
  // Sensitive client-side storage
  { id: "storage-sensitive", severity: "medium", re: /(localStorage|sessionStorage)\.setItem\(\s*["'`][^"'`]*(token|password|secret|session|auth)/i, msg: "Credential-like data in web storage", files: CODE },
  // Dangerous operations in scripts
  { id: "git-force", severity: "medium", re: /\bgit\s+(push\b[^\n]*\s(--force|-f)\b|reset\s+--hard|clean\s+-[a-z]*f)/, msg: "Destructive git command", files: CODE },
  { id: "rm-rf", severity: "medium", re: /\brm\s+-[a-z]*r[a-z]*f|\brm\s+-[a-z]*f[a-z]*r|Remove-Item\b[^\n]*-Recurse[^\n]*-Force/i, msg: "Recursive forced delete", files: CODE },
  { id: "no-verify", severity: "medium", re: /--no-verify\b/, msg: "Skips git hooks (--no-verify)", files: CODE },
];

// Rules on the file path itself (checked for every added/changed file, including binaries and renames).
const PATH_RULES = [
  { id: "file-secret", severity: "critical", re: /(^|\/)(\.env(\.[^/]*)?|id_(rsa|ed25519|ecdsa)|[^/]+\.(pem|key|p12|pfx))$/i, skip: EXAMPLE, msg: "Secret-bearing file added to the repo" },
  { id: "file-runs-locally", severity: "medium", re: /^(\.claude\/(settings[^/]*\.json|hooks\/|commands\/|agents\/|skills\/[^/]+\/scripts\/)|\.github\/workflows\/|\.husky\/|(.*\/)?package\.json$|\.mcp\.json$)/, msg: "Code/config that runs on contributors' machines or CI: review by hand" },
];

// Comments can't execute, so only secret rules look at them (a key in a comment is still leaked).
// A leading /* ... */ block is stripped first, so code after it on the same line is still scanned.
const COMMENT = /^\s*(\/\/|\/\*|\*|#(?!!)|<!--|--\s)/;
const LEADING_BLOCK_COMMENT = /^\s*\/\*.*?\*\//;

function git(...a) {
  const r = spawnSync("git", ["-c", "core.quotePath=false", ...a], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`git ${a.join(" ")}: ${r.stderr.trim()}`);
  return r.stdout;
}

const nulList = (out) => out.split("\0").filter(Boolean);

function isBinary(file) {
  try {
    return fs.readFileSync(file).subarray(0, 8000).includes(0);
  } catch {
    return true;
  }
}

function readLines(file) {
  if (isBinary(file)) return [];
  return fs.readFileSync(file, "utf8").split("\n").map((text, i) => ({ n: i + 1, text }));
}

// → { files: [path], added: Map<path, [{ n, text }]> }
function collect() {
  const untracked = nulList(git("ls-files", "--others", "--exclude-standard", "-z"));
  if (scanAll) {
    const files = [...nulList(git("ls-files", "-z")), ...untracked].filter((f) => fs.existsSync(f));
    return { files, added: new Map(files.map((f) => [f, readLines(f)])) };
  }

  if (!base || base.startsWith("-")) throw new Error("--base needs a ref, e.g. --base main");
  const verify = spawnSync("git", ["rev-parse", "--verify", "--quiet", "--end-of-options", `${base}^{commit}`], { encoding: "utf8" });
  if (verify.status !== 0) throw new Error(`base ref not found: ${base}`);
  // Merge-base, so commits that landed on base after branching don't show up as "added".
  const mergeBase = git("merge-base", "--end-of-options", base, "HEAD").trim();
  const diffArgs = ["--no-renames", "--no-ext-diff", "--no-color", "--src-prefix=a/", "--dst-prefix=b/", mergeBase, "--"];

  // Every added/modified file, binary or renamed included (path rules need them all).
  const files = [...nulList(git("diff", "--name-only", "--diff-filter=d", "-z", ...diffArgs)), ...untracked];

  const added = new Map();
  let current = null;
  let inHeader = false; // between "diff --git" and the first "@@"; only there is "+++ " a file header
  let n = 0;
  for (const line of git("diff", "-U0", ...diffArgs).split("\n")) {
    if (line.startsWith("diff --git ")) {
      inHeader = true;
      current = null;
    } else if (inHeader && line.startsWith("+++ ")) {
      const file = line.slice(4).replace(/^b\//, "");
      current = file === "/dev/null" ? null : file;
      if (current) added.set(current, []);
    } else if (line.startsWith("@@")) {
      inHeader = false;
      n = Number(/\+(\d+)/.exec(line)[1]);
    } else if (!inHeader && current && line.startsWith("+")) {
      added.get(current).push({ n: n++, text: line.slice(1) });
    } else if (!inHeader && current && !line.startsWith("-") && !line.startsWith("\\")) {
      n++;
    }
  }
  for (const f of untracked) added.set(f, readLines(f));
  return { files, added };
}

function main() {
  const { files, added } = collect();
  const findings = [];

  for (const file of files) {
    for (const rule of PATH_RULES) {
      if (rule.re.test(file) && !(rule.skip && rule.skip.test(file))) findings.push({ ...rule, file, n: 0, text: "" });
    }
  }
  for (const [file, lines] of added) {
    if (file === SELF) continue; // the rules themselves would match
    for (const { n, text: raw } of lines) {
      const text = raw.length > MAX_LINE ? raw.slice(0, MAX_LINE) : raw;
      if (/security-scan:\s*ignore/.test(text)) continue;
      const comment = COMMENT.test(text.replace(LEADING_BLOCK_COMMENT, (m) => (m.trim() === text.trim() ? m : "")));
      for (const rule of LINE_RULES) {
        if (rule.files && !rule.files.test(file)) continue;
        if (rule.skip && rule.skip.test(file)) continue;
        if (comment && !rule.id.startsWith("secret")) continue;
        if (rule.re.test(text)) findings.push({ ...rule, file, n, text: text.trim().slice(0, 160) });
      }
    }
  }

  const order = { critical: 0, high: 1, medium: 2, low: 3 };
  findings.sort((a, b) => order[a.severity] - order[b.severity] || a.file.localeCompare(b.file) || a.n - b.n);
  const scope = scanAll ? "all files" : `changes since merge-base with ${base}`;
  console.log(`Security scan of ${scope}: ${files.length} file(s), ${findings.length} finding(s)`);
  for (const f of findings) {
    console.log(`[${f.severity.toUpperCase()}] ${f.id}  ${f.file}${f.n ? `:${f.n}` : ""}  ${f.msg}`);
    if (f.text) console.log(`    > ${f.text}`);
  }
  const blocking = findings.filter((f) => f.severity === "critical" || f.severity === "high").length;
  console.log(blocking ? `RESULT: ${blocking} blocking finding(s)` : "RESULT: no blocking findings");
  process.exit(blocking ? 1 : 0);
}

try {
  main();
} catch (err) {
  console.error(`scan failed: ${err.message}`);
  console.log("RESULT: scan did not run (exit 2): do not treat as clean");
  process.exit(2);
}
