#!/usr/bin/env node
// Pattern-based security scan of what a branch adds, for the factory-security-review skill.
//
//   node scan.js [--base main] [--all]
//
// Scans lines added since <base> (committed, uncommitted and untracked files). With --all,
// scans every tracked file instead. Prints one line per finding:
//   [SEVERITY] rule-id  path:line  message
//     > offending line
// and exits 1 if anything is critical or high. Findings are leads, not verdicts: the skill
// says to confirm each one by reading the code. Silence a confirmed false positive by adding
// "security-scan: ignore" to the line, and explain why in the review.

const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const args = process.argv.slice(2);
const base = args.includes("--base") ? args[args.indexOf("--base") + 1] : "main";
const scanAll = args.includes("--all");

const SELF = path.relative(process.cwd(), __filename).split(path.sep).join("/");
const CODE = /\.(m?js|cjs|ts|tsx|jsx|html?|vue|svelte|py|rb|php|go|java|cs|sh|ps1)$/i;

// { id, severity, re, msg, files? (regex on path; defaults to every text file) }
const LINE_RULES = [
  // Secrets
  { id: "secret-aws-key", severity: "critical", re: /AKIA[0-9A-Z]{16}/, msg: "AWS access key ID" },
  { id: "secret-github-token", severity: "critical", re: /\bgh[pousr]_[A-Za-z0-9]{36,}/, msg: "GitHub token" },
  { id: "secret-anthropic-key", severity: "critical", re: /\bsk-ant-[A-Za-z0-9_-]{20,}/, msg: "Anthropic API key" },
  { id: "secret-openai-key", severity: "critical", re: /\bsk-(proj-)?[A-Za-z0-9]{32,}/, msg: "OpenAI-style API key" },
  { id: "secret-slack-token", severity: "critical", re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/, msg: "Slack token" },
  { id: "secret-private-key", severity: "critical", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/, msg: "Private key material" },
  { id: "secret-assignment", severity: "high", re: /\b(api[_-]?key|secret|token|passw(or)?d|client[_-]?secret)\b\s*[:=]\s*["'][^"'\s]{8,}["']/i, msg: "Hard-coded credential-like value" },
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
  { id: "git-force", severity: "medium", re: /\bgit\b[^\n]*\s(push\s+[^\n]*(--force|-f\b)|reset\s+--hard|clean\s+-[a-z]*f)/, msg: "Destructive git command", files: CODE },
  { id: "rm-rf", severity: "medium", re: /\brm\s+-[a-z]*r[a-z]*f|\brm\s+-[a-z]*f[a-z]*r|Remove-Item\b[^\n]*-Recurse[^\n]*-Force/i, msg: "Recursive forced delete", files: CODE },
  { id: "no-verify", severity: "medium", re: /--no-verify\b/, msg: "Skips git hooks (--no-verify)", files: CODE },
];

// Comments can't execute, so only secret rules look at them (a key in a comment is still leaked).
const COMMENT = /^\s*(\/\/|\/\*|\*|#(?!!)|<!--|--\s)/;

// Rules on the file path itself.
const PATH_RULES = [
  { id: "file-secret", severity: "critical", re: /(^|\/)(\.env(\.[^/]*)?|id_(rsa|ed25519|ecdsa)|[^/]+\.(pem|key|p12|pfx))$/i, msg: "Secret-bearing file added to the repo" },
  { id: "file-agent-config", severity: "medium", re: /^\.claude\/(settings[^/]*\.json|hooks\/)/, msg: "Changes code/config that runs on contributors' machines (hooks/settings): review by hand" },
];

const git = (...a) => {
  const r = spawnSync("git", a, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`git ${a.join(" ")}: ${r.stderr.trim()}`);
  return r.stdout;
};

function isBinary(file) {
  try {
    return fs.readFileSync(file).subarray(0, 8000).includes(0);
  } catch {
    return true;
  }
}

// → [{ file, lines: [{ n, text }] }] for added lines.
function collectAdded() {
  if (scanAll) {
    return git("ls-files").split("\n").filter(Boolean).filter((f) => !isBinary(f)).map((file) => ({
      file,
      lines: fs.readFileSync(file, "utf8").split("\n").map((text, i) => ({ n: i + 1, text })),
    }));
  }
  const out = [];
  let current = null;
  let n = 0;
  for (const line of git("diff", "-U0", "--no-color", "--no-ext-diff", base).split("\n")) {
    if (line.startsWith("+++ ")) {
      const file = line.slice(4).replace(/^b\//, "");
      current = file === "/dev/null" ? null : { file, lines: [] };
      if (current) out.push(current);
    } else if (line.startsWith("@@")) {
      n = Number(/\+(\d+)/.exec(line)[1]);
    } else if (current && line.startsWith("+")) {
      current.lines.push({ n: n++, text: line.slice(1) });
    } else if (current && !line.startsWith("-") && !line.startsWith("\\")) {
      n++;
    }
  }
  for (const file of git("ls-files", "--others", "--exclude-standard").split("\n").filter(Boolean)) {
    if (isBinary(file)) {
      out.push({ file, lines: [] });
      continue;
    }
    out.push({ file, lines: fs.readFileSync(file, "utf8").split("\n").map((text, i) => ({ n: i + 1, text })) });
  }
  return out;
}

function main() {
  const findings = [];
  const files = collectAdded().filter((f) => f.file !== SELF);
  for (const { file, lines } of files) {
    for (const rule of PATH_RULES) {
      if (rule.re.test(file)) findings.push({ ...rule, file, n: 0, text: "" });
    }
    for (const { n, text } of lines) {
      if (/security-scan:\s*ignore/.test(text)) continue;
      const comment = COMMENT.test(text);
      for (const rule of LINE_RULES) {
        if (rule.files && !rule.files.test(file)) continue;
        if (comment && !rule.id.startsWith("secret")) continue;
        if (rule.re.test(text)) findings.push({ ...rule, file, n, text: text.trim().slice(0, 160) });
      }
    }
  }

  const order = { critical: 0, high: 1, medium: 2, low: 3 };
  findings.sort((a, b) => order[a.severity] - order[b.severity] || a.file.localeCompare(b.file) || a.n - b.n);
  const scope = scanAll ? "all tracked files" : `changes since ${base}`;
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
  process.exit(2);
}
