#!/usr/bin/env node
// God-object detector for the factory-code-review skill and the god-object-guard hook.
//
//   node god-object.js <file>...            check specific files
//   node god-object.js --changed [--base main]   check code files changed since the merge-base
//
// A "god object" is a file, class or function that has grown to own too many responsibilities:
// it's long, has many functions/methods, long functions, lots of shared mutable state, and mixes
// concerns (DOM + storage + network + domain logic). This measures those signals with
// language-light heuristics (JS/TS get full analysis; other code files get size checks only).
//
// Each file gets OK / WARN / FAIL with reasons and a split suggestion. Exit 1 if any FAIL.
// A file can opt out with a comment in its first 5 lines:  quality: allow-large-file <reason>
// (the reason must be stated; reviewers judge it).

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const LIMITS = {
  fileLines: { warn: 300, fail: 500 }, // non-blank, non-comment lines
  functions: { warn: 25, fail: 40 }, // functions + methods in the file
  functionLines: { warn: 50, fail: 80 }, // longest single function
  classMethods: { warn: 15, fail: 25 },
  mutableGlobals: { warn: 8, fail: 15 }, // top-level let/var
  concerns: { warn: 3, fail: 4 }, // distinct concerns mixed in one file
};

const JS = /\.(m?js|cjs|ts|tsx|jsx)$/i;
const CODE = /\.(m?js|cjs|ts|tsx|jsx|py|rb|php|go|java|cs|kt|swift)$/i;
const SKIP = /(^|\/)(node_modules|dist|build|vendor|tests?|__tests__|screenshots)\/|\.min\.|\.(test|spec)\.|(^|\/)\.claude\/logs\//i;

// Concerns that, mixed together in one file, signal several responsibilities.
const CONCERNS = {
  "DOM/UI": /\bdocument\.|\.addEventListener\(|\bquerySelector|\bcreateElement\(/,
  storage: /\bindexedDB\b|\blocalStorage\b|\bsessionStorage\b|\.transaction\(|\bobjectStore\(/,
  network: /\bfetch\(|\bXMLHttpRequest\b|\bWebSocket\b|\baxios\b/,
  "date/scheduling": /\bnew Date\(|\bgetFullYear\(|\bsetTimeout\(|\bsetInterval\(/,
  "server/fs/process": /\brequire\(["'](fs|http|child_process|net)["']\)|\bprocess\.(argv|exit)\b/,
};

// Blank out comments and string/template contents (keeping newlines) so braces and keywords
// inside them don't count. Regex literals aren't handled; they rarely contain braces.
function stripCode(src) {
  let out = "";
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    const next = src[i + 1];
    if (c === "/" && next === "/") {
      while (i < src.length && src[i] !== "\n") i++;
    } else if (c === "/" && next === "*") {
      i += 2;
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) out += src[i++] === "\n" ? "\n" : "";
      i += 2;
    } else if (c === '"' || c === "'" || c === "`") {
      out += c;
      i++;
      while (i < src.length && src[i] !== c) {
        if (src[i] === "\\") i++;
        else if (src[i] === "\n") out += "\n";
        i++;
      }
      out += c;
      i++;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

const FUNCTION_START = [
  /\bfunction\b\s*\*?\s*([A-Za-z_$][\w$]*)?\s*\(/, // function foo( / function (
  /([A-Za-z_$][\w$]*)\s*[:=]\s*(async\s+)?(\([^()]*\)|[A-Za-z_$][\w$]*)\s*=>\s*\{/, // foo = (...) => {
  /^\s*(async\s+|static\s+|get\s+|set\s+)*([A-Za-z_$][\w$]*)\s*\([^()]*\)\s*\{/, // method(...) {
];
const NOT_A_METHOD = /^\s*(if|for|while|switch|catch|with|return|else|do|try)\b/;

function analyzeJs(src) {
  const code = stripCode(src);
  const lines = code.split("\n");
  const functions = []; // { name, start, end }
  const classes = []; // { name, start, end, methods }
  const stack = []; // open blocks: { kind, name, start, depth }
  let depth = 0;
  let mutableGlobals = 0;

  lines.forEach((line, idx) => {
    const n = idx + 1;
    if (depth === 0 && /^\s*(let|var)\s/.test(line)) mutableGlobals += (line.match(/,/g) || []).length + 1;
    let pending = null;
    const cls = /\bclass\s+([A-Za-z_$][\w$]*)/.exec(line);
    if (cls) pending = { kind: "class", name: cls[1] };
    else if (!NOT_A_METHOD.test(line)) {
      for (const re of FUNCTION_START) {
        const m = re.exec(line);
        if (m) {
          pending = { kind: "function", name: m[1] || m[2] || "(anonymous)" };
          break;
        }
      }
    }
    for (const ch of line) {
      if (ch === "{") {
        depth++;
        stack.push(pending ? { ...pending, start: n, depth } : { kind: "block", depth });
        pending = null;
      } else if (ch === "}") {
        const open = stack.pop();
        depth = Math.max(0, depth - 1);
        if (!open || open.kind === "block") continue;
        const entry = { name: open.name, start: open.start, end: n, lines: n - open.start + 1 };
        if (open.kind === "class") classes.push({ ...entry, methods: 0 });
        else functions.push(entry);
      }
    }
  });
  for (const c of classes) c.methods = functions.filter((f) => f.start > c.start && f.end < c.end).length;
  return { functions, classes, mutableGlobals };
}

function codeLineCount(src, isJs) {
  const body = isJs ? stripCode(src) : src;
  return body.split("\n").filter((l) => l.trim() && !/^\s*(#|\/\/|\*|\/\*|--)/.test(l)).length;
}

function level(value, limit) {
  if (value > limit.fail) return "FAIL";
  if (value > limit.warn) return "WARN";
  return "OK";
}

// → { file, status, reasons: [{ level, text }], suggestion, metrics } or null if skipped.
function analyzeFile(file) {
  const rel = file.split(path.sep).join("/");
  if (!CODE.test(rel) || SKIP.test(rel) || !fs.existsSync(file)) return null;
  const src = fs.readFileSync(file, "utf8");
  const allow = /quality:\s*allow-large-file\s+\S/.exec(src.split("\n").slice(0, 5).join("\n"));
  const isJs = JS.test(rel);
  const reasons = [];
  const add = (lvl, text) => lvl !== "OK" && reasons.push({ level: lvl, text });

  const loc = codeLineCount(src, isJs);
  add(level(loc, LIMITS.fileLines), `${loc} code lines (warn > ${LIMITS.fileLines.warn}, fail > ${LIMITS.fileLines.fail})`);
  const metrics = { loc };

  if (isJs) {
    const { functions, classes, mutableGlobals } = analyzeJs(src);
    const longest = functions.reduce((a, f) => (f.lines > (a ? a.lines : 0) ? f : a), null);
    const concerns = Object.entries(CONCERNS).filter(([, re]) => re.test(src)).map(([k]) => k);
    Object.assign(metrics, { functions: functions.length, longest: longest && `${longest.name} (${longest.lines} lines, line ${longest.start})`, mutableGlobals, concerns });
    add(level(functions.length, LIMITS.functions), `${functions.length} functions/methods (warn > ${LIMITS.functions.warn}, fail > ${LIMITS.functions.fail})`);
    if (longest) add(level(longest.lines, LIMITS.functionLines), `longest function ${longest.name}() is ${longest.lines} lines at line ${longest.start} (warn > ${LIMITS.functionLines.warn}, fail > ${LIMITS.functionLines.fail})`);
    for (const c of classes) add(level(c.methods, LIMITS.classMethods), `class ${c.name} has ${c.methods} methods (warn > ${LIMITS.classMethods.warn}, fail > ${LIMITS.classMethods.fail})`);
    add(level(mutableGlobals, LIMITS.mutableGlobals), `${mutableGlobals} top-level let/var (shared mutable state)`);
    add(level(concerns.length, LIMITS.concerns), `mixes ${concerns.length} concerns: ${concerns.join(", ")}`);
  }

  let status = reasons.some((r) => r.level === "FAIL") ? "FAIL" : reasons.length ? "WARN" : "OK";
  if (status === "FAIL" && allow) status = "WARN"; // explicit, justified opt-out downgrades to a warning
  const suggestion = status === "OK" ? "" : suggestSplit(metrics);
  return { file: rel, status, reasons, suggestion, allowed: !!allow, metrics };
}

function suggestSplit(m) {
  const parts = [];
  if (m.concerns && m.concerns.length > 1) parts.push(`split by concern into separate modules (${m.concerns.join(" / ")}), with one small entry file wiring them together`);
  if (m.longest) parts.push(`break ${m.longest.split(" ")[0]} into named helpers, one job each`);
  if (m.mutableGlobals > LIMITS.mutableGlobals.warn) parts.push("group shared state into one state object owned by a single module");
  if (!parts.length) parts.push("extract cohesive groups of functions into their own files");
  return parts.join("; ");
}

function format(r) {
  const lines = [`[${r.status}] ${r.file}${r.allowed ? " (allow-large-file)" : ""}`];
  for (const reason of r.reasons) lines.push(`    ${reason.level}: ${reason.text}`);
  if (r.suggestion) lines.push(`    suggestion: ${r.suggestion}`);
  return lines.join("\n");
}

function changedFiles(base) {
  if (!base || base.startsWith("-")) throw new Error("--base needs a ref");
  const run = (...a) => spawnSync("git", ["-c", "core.quotePath=false", ...a], { encoding: "utf8" });
  const mb = run("merge-base", "--end-of-options", base, "HEAD");
  if (mb.status !== 0) throw new Error(`base ref not found: ${base}`);
  const diff = run("diff", "--name-only", "--diff-filter=d", "--no-renames", "-z", mb.stdout.trim(), "--");
  const untracked = run("ls-files", "--others", "--exclude-standard", "-z");
  return [...diff.stdout.split("\0"), ...untracked.stdout.split("\0")].filter(Boolean);
}

function main() {
  const args = process.argv.slice(2);
  let files = args.filter((a) => !a.startsWith("--"));
  if (args.includes("--changed")) {
    const i = args.indexOf("--base");
    files = changedFiles(i === -1 ? "main" : args[i + 1]);
  }
  const results = files.map(analyzeFile).filter(Boolean);
  for (const r of results) console.log(format(r));
  const fails = results.filter((r) => r.status === "FAIL").length;
  const warns = results.filter((r) => r.status === "WARN").length;
  console.log(`RESULT: ${results.length} file(s) checked, ${fails} FAIL, ${warns} WARN`);
  process.exit(fails ? 1 : 0);
}

module.exports = { analyzeFile, format, LIMITS };

if (require.main === module) {
  try {
    main();
  } catch (err) {
    console.error(`god-object check failed: ${err.message}`);
    process.exit(2);
  }
}
