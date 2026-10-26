// Pure rules behind verify-audit.js: acceptance-file validation, ticket coverage, checks.js lint,
// browser-run parsing, criterion and mutation grading, PNG decoding and PR evidence.
// No file, process or network I/O here (callers inject it), so every rule is unit-tested in audit-lib.test.js.

const zlib = require("zlib");

const MAX_QUOTE_WORDS = 12; // one ask per criterion: a whole-ticket quote can't cover everything at once
const MAX_CONTEXT_WORDS = 6; // context is a short lead-in ("Enhance my todo app"), never an ask

// Function words only. Negations and qualifiers ("no", "not", "only", "all", "every") stay required.
const STOPWORDS = new Set((
  "a an the and or but of to in on at by for with from into onto as is are was were be been being am it its " +
  "this that these those there here i me my we us our you your he she they them their do does did so then than " +
  "also just very really please want wants would like should could will can may might must able let lets have " +
  "has had make makes made build enhance need needs add adding allow allows use using get got some any each " +
  "everything something thing things"
).split(/\s+/));

const normalize = (text) => String(text || "").normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
const tokens = (text) => (normalize(text) ? normalize(text).split(" ") : []);

// Light plural stemming so "tags"/"tag" and "dates"/"date" match; applied to both sides.
function stem(w) {
  if (w.length > 4 && w.endsWith("ies")) return `${w.slice(0, -3)}y`;
  if (w.length > 4 && /(s|x|ch|sh)es$/.test(w)) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith("s") && !w.endsWith("ss")) return w.slice(0, -1);
  return w;
}
const words = (text) => tokens(text).filter((w) => (w.length >= 2 || /\d/.test(w)) && !STOPWORDS.has(w)).map(stem);
const contains = (haystack, needle) => normalize(needle) !== "" && ` ${normalize(haystack)} `.includes(` ${normalize(needle)} `);
const sentences = (text) => String(text || "").split(/[.!?\n]+/).map(normalize).filter(Boolean);
const isStringArray = (v) => Array.isArray(v) && v.every((s) => typeof s === "string" && s.trim() !== "");
const SAFE_PATH = /^(?![\\/])(?!.*(^|[\\/])\.\.?([\\/]|$))[^:*?"<>|]+$/; // relative, no "." or ".." segments

function validRegex(source) {
  try {
    new RegExp(source);
    return true;
  } catch {
    return false;
  }
}

// Problems in one criterion's shape and evidence.
function criterionProblems(c) {
  const id = c.id || "(no id)";
  const problems = [];
  if (!c.quote && !(c.source === "clarified" && c.requirement)) problems.push(`${id}: needs a "quote" from the ticket, or "source": "clarified" with a "requirement"`);
  for (const key of ["checks", "files"]) if (c[key] !== undefined && !isStringArray(c[key])) problems.push(`${id}: "${key}" must be an array of names`);
  for (const f of isStringArray(c.files) ? c.files : []) if (!SAFE_PATH.test(f)) problems.push(`${id}: file "${f}" must be a relative path inside the project`);
  if (c.absent !== undefined && (typeof c.absent !== "string" || !validRegex(c.absent))) problems.push(`${id}: "absent" is not a valid regular expression`);
  const hasChecks = isStringArray(c.checks) && c.checks.length > 0;
  if (hasChecks && !(typeof c.mutation === "string" && c.mutation.trim())) problems.push(`${id}: needs a "mutation" that breaks the feature, to prove its checks can fail`);
  if (!hasChecks && !(c.structural === true && isStringArray(c.files) && c.files.length && c.quote)) {
    problems.push(`${id}: needs browser "checks" (only a quoted, "structural": true criterion may rely on files alone)`);
  }
  return problems;
}

// Structural problems in an acceptance file; an empty array means it is usable.
function validateAcceptance(acc, expected = {}) {
  if (!acc || !Array.isArray(acc.criteria) || acc.criteria.length === 0) return ["acceptance file has no criteria"];
  const problems = [];
  if (acc.ticket !== undefined && expected.ticket !== undefined && String(acc.ticket) !== String(expected.ticket)) problems.push(`"ticket" is ${acc.ticket}, but this is Ticket #${expected.ticket}`);
  if (acc.issue !== undefined && expected.issue !== undefined && String(acc.issue) !== String(expected.issue)) problems.push(`"issue" is ${acc.issue}, but this is issue #${expected.issue}`);
  const ids = acc.criteria.map((c) => c.id);
  ids.filter((id, i) => ids.indexOf(id) !== i).forEach((id) => problems.push(`${id}: duplicate id`));
  acc.criteria.forEach((c) => problems.push(...criterionProblems(c)));
  for (const ctx of acc.context || []) if (!ctx.quote || !ctx.reason) problems.push("context entries need a quote and a reason");
  return problems;
}

// Quotes must come from the ticket, be one short ask each, and together cover every meaningful
// ticket word, so an ask can't be invented, dropped, or hidden under one giant quote or "context".
function ticketCoverage(title, body, acc) {
  const ticketText = `${title}\n${body}`;
  const quoted = acc.criteria.filter((c) => c.quote).map((c) => c.quote);
  const context = (acc.context || []).map((c) => c.quote);
  const found = (q) => contains(title, q) || contains(body, q);
  const badQuotes = [...quoted, ...context].filter((q) => !found(q));
  const longQuotes = quoted.filter((q) => tokens(q).length > MAX_QUOTE_WORDS || /[.!?](\s|$)/.test(q.trim().slice(0, -1)));
  const badContext = context.filter((q) => tokens(q).length > MAX_CONTEXT_WORDS ||
    !sentences(ticketText).some((s) => ` ${s} `.startsWith(` ${normalize(q)} `)));
  const covered = new Set([...quoted, ...context].filter(found).flatMap(words));
  const uncoveredWords = [...new Set(words(ticketText))].filter((w) => !covered.has(w));
  return { badQuotes, longQuotes, badContext, uncoveredWords };
}

// checks.js must assert, not print: hard-coded passes and silenced errors fake a verification.
function lintChecks(source) {
  // Comments don't run, so they can't fake anything (and describe the "PASS ..." format).
  const code = String(source || "").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:\\])\/\/.*$/gm, "$1");
  const rules = [
    [/(["'`])PASS\s/, 'hard-coded "PASS ..." result string'],
    [/\bcheck\s*\(\s*(["'`])(?:(?!\1)[^\\]|\\.)*\1\s*,\s*(true|!0|!!1|1)\s*\)/, "check(...) with a constant true"],
    [/console\s*(\.\s*error|\[\s*["'`]error["'`]\s*\])\s*=|\bonerror\s*=|onunhandledrejection\s*=|addEventListener\(\s*["'`](error|unhandledrejection)["'`]/, "silences console errors"],
  ];
  return rules.filter(([re]) => re.test(code)).map(([, why]) => why);
}

// Reads browser-verify.js output: PASS/FAIL check lines, ERROR (run couldn't happen) and RESULT.
function parseRun(stdout) {
  const run = { pass: [], fail: [], consoleErrors: [], errors: [], result: null };
  for (const line of String(stdout).split(/\r?\n/)) {
    if (line.startsWith("FAIL console error: ")) run.consoleErrors.push(line.slice(20));
    else if (line.startsWith("PASS ")) run.pass.push(line.slice(5));
    else if (line.startsWith("FAIL ")) run.fail.push(line.slice(5));
    else if (line.startsWith("ERROR ")) run.errors.push(line.slice(6));
    else if (line.startsWith("RESULT: ")) run.result = line.slice(8).trim();
  }
  return run;
}

// Grades each criterion. io = { fileExists(relPath) -> isFile, absentHits(regexSource) -> ["file:line", ...] }.
function gradeCriteria(acc, run, io) {
  return acc.criteria.map((c) => {
    const problems = [];
    for (const name of c.checks || []) {
      if (run.fail.includes(name)) problems.push(`check failed: "${name}"`);
      else if (!run.pass.includes(name)) problems.push(`check not found in the run: "${name}"`);
    }
    for (const file of c.files || []) if (!io.fileExists(file)) problems.push(`file missing: ${file}`);
    if (c.absent) for (const hit of io.absentHits(c.absent)) problems.push(`forbidden pattern /${c.absent}/ at ${hit}`);
    return { ...c, problems, ok: problems.length === 0 };
  });
}

// A mutation is "killed" when breaking the feature makes at least one of its mapped checks fail.
const killedBy = (c, run) => (c.checks || []).filter((name) => run.fail.includes(name));

// Decodes enough of a PNG to tell a real screenshot from a forged header or a blank image.
function pngInfo(buf) {
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (!buf || buf.length < 24 || sig.some((b, i) => buf[i] !== b)) return null;
  const idat = [];
  for (let off = 8; off + 8 <= buf.length;) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString("ascii", off + 4, off + 8);
    if (type === "IDAT") idat.push(buf.subarray(off + 8, off + 8 + len));
    if (type === "IEND") break;
    off += 12 + len;
  }
  let pixels = null;
  try {
    pixels = zlib.inflateSync(Buffer.concat(idat));
  } catch {
    pixels = null;
  }
  const distinct = pixels ? new Set(pixels.subarray(0, 2_000_000)).size : 0;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20), bytes: buf.length, decoded: !!pixels, distinct };
}

function screenshotProblems(info) {
  if (!info) return ["not a PNG"];
  const problems = [];
  if (info.width < 300 || info.height < 200) problems.push(`too small (${info.width}×${info.height})`);
  if (!info.decoded) problems.push("image data doesn't decode (forged or truncated PNG)");
  else if (info.distinct < 16) problems.push(`looks blank (only ${info.distinct} distinct byte values)`);
  return problems;
}

// What the PR body claims: a closing keyword for #N, embedded screenshots pinned to a commit, "x/y checks".
function prEvidence(body, issue) {
  const text = String(body || "").replace(/<!--[\s\S]*?-->/g, ""); // hidden text doesn't count
  const urls = [...text.matchAll(/!\[[^\]]*\]\(\s*<?(https?:\/\/[^)\s>]+)/gi), ...text.matchAll(/<img\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi)].map((m) => m[1]);
  const images = urls.map((u) => u.match(/github\.com\/[^/]+\/[^/]+\/(?:blob|raw)\/([0-9a-f]{7,40})\/([^?#]+\.png)/i) ||
    u.match(/raw\.githubusercontent\.com\/[^/]+\/[^/]+\/([0-9a-f]{7,40})\/([^?#]+\.png)/i)).filter(Boolean)
    .map((m) => ({ sha: m[1], path: decodeURIComponent(m[2]) }));
  const claim = text.match(/(\d+)\s*\/\s*(\d+)\s+checks/i);
  return {
    closes: new RegExp(`\\b(close[sd]?|fix(e[sd])?|resolve[sd]?)\\s*:?\\s+#${issue}\\b`, "i").test(text),
    images,
    claim: claim ? { passed: Number(claim[1]), total: Number(claim[2]) } : null,
  };
}

module.exports = {
  normalize, words, validateAcceptance, ticketCoverage, lintChecks, parseRun, gradeCriteria, killedBy,
  pngInfo, screenshotProblems, prEvidence, MAX_QUOTE_WORDS, MAX_CONTEXT_WORDS,
};
