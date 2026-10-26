// Pure rules behind verify-audit.js: acceptance-file validation, ticket coverage,
// browser-run parsing, criterion grading, PNG sanity and PR evidence.
// No file or network I/O here (callers inject it), so every rule is unit-tested in audit-lib.test.js.

// Words that carry no requirement on their own ("I would like to add ...").
const STOPWORDS = new Set((
  "the and for with you your my me it its this that these those want would like should could will can must " +
  "please also then them they their there here have has had are was were been being into onto from only just " +
  "very really some any each every everything something make makes made build allow allows enhance able need " +
  "needs our out not but get got let lets add adding use using"
).split(/\s+/));

const normalize = (text) => String(text || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const words = (text) => normalize(text).split(" ").filter((w) => w.length >= 3 && !STOPWORDS.has(w));
const contains = (haystack, needle) => ` ${normalize(haystack)} `.includes(` ${normalize(needle)} `);

// Structural problems in an acceptance file; an empty array means it is usable.
function validateAcceptance(acc) {
  const problems = [];
  if (!acc || !Array.isArray(acc.criteria) || acc.criteria.length === 0) return ["acceptance file has no criteria"];
  const seen = new Set();
  for (const c of acc.criteria) {
    const id = c.id || "(no id)";
    if (seen.has(id)) problems.push(`${id}: duplicate id`);
    seen.add(id);
    if (!c.quote && !(c.source === "clarified" && c.requirement)) {
      problems.push(`${id}: needs a "quote" from the ticket, or "source": "clarified" with a "requirement"`);
    }
    const evidence = (c.checks || []).length + (c.files || []).length + (c.absent ? 1 : 0);
    if (evidence === 0) problems.push(`${id}: has no evidence (checks, files or absent)`);
  }
  for (const ctx of acc.context || []) if (!ctx.quote || !ctx.reason) problems.push(`context entries need a quote and a reason`);
  return problems;
}

// Quotes must come from the ticket, and every meaningful ticket word must be quoted somewhere,
// so an ask can't be silently dropped or invented.
function ticketCoverage(ticketText, acc) {
  const quotes = [...acc.criteria.filter((c) => c.quote), ...(acc.context || [])].map((c) => c.quote);
  const badQuotes = quotes.filter((q) => !contains(ticketText, q));
  const quoted = new Set(quotes.filter((q) => contains(ticketText, q)).flatMap(words));
  const uncoveredWords = [...new Set(words(ticketText))].filter((w) => !quoted.has(w));
  return { badQuotes, uncoveredWords };
}

// Reads browser-verify.js output: "PASS name" / "FAIL name" lines plus "RESULT: PASS|FAIL".
function parseRun(stdout) {
  const run = { pass: [], fail: [], consoleErrors: [], result: null };
  for (const line of String(stdout).split(/\r?\n/)) {
    if (line.startsWith("FAIL console error: ")) run.consoleErrors.push(line.slice(20));
    else if (line.startsWith("PASS ")) run.pass.push(line.slice(5));
    else if (line.startsWith("FAIL ")) run.fail.push(line.slice(5));
    else if (line.startsWith("RESULT: ")) run.result = line.slice(8).trim();
  }
  return run;
}

// Grades each criterion. io = { fileExists(relPath), absentHits(regexSource) -> ["file:line", ...] }.
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

// Width/height of a PNG buffer, or null if it isn't one.
function pngInfo(buf) {
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (!buf || buf.length < 24 || sig.some((b, i) => buf[i] !== b)) return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20), bytes: buf.length };
}

// Screenshot is real evidence only if it's a PNG of a plausible page size, not a blank stub.
function screenshotProblems(info) {
  if (!info) return ["not a PNG"];
  const problems = [];
  if (info.width < 300 || info.height < 200) problems.push(`too small (${info.width}×${info.height})`);
  if (info.bytes < 5000) problems.push(`suspiciously small file (${info.bytes} bytes), likely blank`);
  return problems;
}

// What the PR body claims: Closes #N, screenshots pinned to a commit, and "x/y checks".
function prEvidence(body, issue) {
  const text = String(body || "");
  const images = [...text.matchAll(/\/blob\/([0-9a-f]{7,40})\/([^)\s?#]+\.png)/gi)].map((m) => ({ sha: m[1], path: m[2] }));
  const claim = text.match(/(\d+)\s*\/\s*(\d+)\s+checks/i);
  return {
    closes: new RegExp(`\\b(closes|fixes|resolves)\\s+#${issue}\\b`, "i").test(text),
    images,
    claim: claim ? { passed: Number(claim[1]), total: Number(claim[2]) } : null,
  };
}

module.exports = { normalize, words, validateAcceptance, ticketCoverage, parseRun, gradeCriteria, pngInfo, screenshotProblems, prEvidence };
