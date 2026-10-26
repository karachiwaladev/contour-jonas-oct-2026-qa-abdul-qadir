// Unit tests for audit-lib.js. Run: node --test .claude/skills/factory-loop/scripts/audit-lib.test.js
// Each "bypass:" test is a way an agent could fake verification; the audit must reject it.
const test = require("node:test");
const assert = require("node:assert");
const zlib = require("zlib");
const lib = require("./audit-lib");

const TITLE = "Filters, due dates and tags";
const BODY = "Enhance my todo app. I would like to add a due date. I would like to add tags to my ticket and filter the tasks by available tags.";
const crit = (id, quote, extra = {}) => ({ id, quote, checks: [`${id} check`], mutation: "x = 1;", ...extra });
const acc = (criteria, context = []) => ({ criteria, context });
const FULL = acc([
  crit("AC1", "add a due date"),
  crit("AC2", "add tags to my ticket"),
  crit("AC3", "filter the tasks by available tags"),
], [{ quote: "Enhance my todo app", reason: "context" }]);
const coverage = (a, title = TITLE, body = BODY) => lib.ticketCoverage(title, body, a);

test("full coverage: quotes come from the ticket and map every word, title included", () => {
  assert.deepStrictEqual(coverage(FULL), { badQuotes: [], longQuotes: [], badContext: [], uncoveredWords: [] });
});

test("a dropped ask is caught", () => {
  assert.deepStrictEqual(coverage(acc(FULL.criteria.slice(0, 2), FULL.context)).uncoveredWords, ["filter", "task", "available"]);
});

test("an invented ask is caught", () => {
  assert.deepStrictEqual(coverage(acc([...FULL.criteria, crit("AC9", "export to CSV")], FULL.context)).badQuotes, ["export to CSV"]);
});

test("an ask that is only in the title is caught", () => {
  assert.deepStrictEqual(coverage(FULL, "Recurring tasks").uncoveredWords, ["recurring"]);
});

test("bypass: one giant quote covering the whole ticket", () => {
  const giant = acc([crit("AC1", "I would like to add tags to my ticket and filter the tasks by available tags")]);
  assert.strictEqual(coverage(giant).longQuotes.length, 1);
  const twoSentences = acc([crit("AC1", "add a due date. I would like")]);
  assert.strictEqual(coverage(twoSentences).longQuotes.length, 1);
});

test("bypass: an ask hidden in context (mid-sentence or too long)", () => {
  const hidden = acc(FULL.criteria.slice(0, 2), [...FULL.context, { quote: "filter the tasks by available tags", reason: "x" }]);
  assert.deepStrictEqual(coverage(hidden).badContext, ["filter the tasks by available tags"]);
});

test("words: negations, short words, numbers and non-ASCII text all count", () => {
  assert.deepStrictEqual(lib.words("Do not show UI for 10 échéances"), ["not", "show", "ui", "10", "échéance"]);
  assert.deepStrictEqual(lib.words("添加导出功能"), ["添加导出功能"]);
});

test("acceptance validation: shape, evidence and mutations", () => {
  const problems = lib.validateAcceptance(acc([
    { id: "AC1", checks: ["x"], mutation: "m" }, // no quote or clarified requirement
    { id: "AC2", quote: "q", checks: "ab", mutation: "m" }, // checks not an array
    { id: "AC3", quote: "q", checks: ["x"] }, // no mutation
    { id: "AC4", quote: "q", absent: "qqq" }, // absent alone proves nothing
    { id: "AC5", quote: "q", structural: true, files: ["."] }, // "." isn't a file
    { id: "AC6", quote: "q", checks: ["x"], mutation: "m", absent: "(" }, // invalid regex
  ]), { ticket: 4, issue: 5 });
  assert.strictEqual(problems.length, 7, problems.join("\n")); // AC2 also has no usable checks
  assert.deepStrictEqual(lib.validateAcceptance({ ticket: 3, ...FULL }, { ticket: 4 }), ['"ticket" is 3, but this is Ticket #4']);
  assert.deepStrictEqual(lib.validateAcceptance(acc([{ id: "S", quote: "q", structural: true, files: ["index.html"] }])), []);
});

test("bypass: checks.js that prints passes instead of asserting", () => {
  assert.deepStrictEqual(lib.lintChecks('return ["PASS recurring works"];'), ['hard-coded "PASS ..." result string']);
  assert.deepStrictEqual(lib.lintChecks('check("delete a task", true);'), ["check(...) with a constant true"]);
  assert.deepStrictEqual(lib.lintChecks("console.error = () => {};"), ["silences console errors"]);
  assert.deepStrictEqual(lib.lintChecks('out.push(`${ok ? "PASS" : "FAIL"} ${name}`); check("x", a === b);'), []);
  assert.deepStrictEqual(lib.lintChecks('// returns "PASS ..." lines\n/* "PASS x" */\ncheck("x", a);'), [], "comments are ignored");
});

test("parseRun separates checks, console errors, run errors and the result", () => {
  const run = lib.parseRun("Loaded x\nPASS a\nFAIL b\nFAIL console error: boom\nERROR no chrome\nRESULT: FAIL\n");
  assert.deepStrictEqual(run, { pass: ["a"], fail: ["b"], consoleErrors: ["boom"], errors: ["no chrome"], result: "FAIL" });
});

test("Chrome's network log decides local-only, and console messages are attributed by source", () => {
  const rows = [
    { method: "GET", url: "http://127.0.0.1:5000/app.js", local: true },
    { method: "POST", url: "https://api.example.com/sync", local: false },
  ];
  assert.deepStrictEqual(lib.externalRequests(rows), ["POST https://api.example.com/sync"]);
  const [c] = lib.gradeCriteria(acc([crit("N", "q", { checks: ["ok"], network: "local-only" })]), { pass: ["ok"], fail: [] },
    { fileExists: () => true, absentHits: () => [], externalRequests: () => lib.externalRequests(rows) });
  assert.deepStrictEqual(c.problems, ["Chrome saw an external request: POST https://api.example.com/sync"]);
  assert.deepStrictEqual(lib.validateAcceptance(acc([crit("N", "q", { network: "anywhere" })])), ['N: "network" can only be "local-only"']);
  assert.deepStrictEqual(lib.consoleBySource([{ source: "app:app.js" }, { source: "test-script" }, { source: "app:app.js" }]), { "app:app.js": 2, "test-script": 1 });
});

test("grading and mutation kills", () => {
  const run = { pass: ["ok"], fail: ["broken"] };
  const io = { fileExists: (f) => f === "index.html", absentHits: () => ["app.js:3"], externalRequests: () => [] };
  const [good, bad] = lib.gradeCriteria(acc([
    crit("G", "q", { checks: ["ok"], files: ["index.html"] }),
    crit("B", "q", { checks: ["broken", "never-ran"], files: ["gone.js"], absent: "fetch\\(" }),
  ]), run, io);
  assert.ok(good.ok);
  assert.strictEqual(bad.problems.length, 4);
  assert.deepStrictEqual(lib.killedBy({ checks: ["ok", "broken"] }, run), ["broken"]);
  assert.deepStrictEqual(lib.killedBy({ checks: ["ok"] }, run), []);
});

// Builds a real RGB PNG (CRCs are not checked by pngInfo).
function png(w, h, pixel) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    return Buffer.concat([len, Buffer.from(type, "ascii"), data, Buffer.alloc(4)]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const rows = [];
  for (let y = 0; y < h; y++) {
    rows.push(0);
    for (let x = 0; x < w; x++) rows.push(...pixel(x, y));
  }
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.concat([sig, chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(Buffer.from(rows))), chunk("IEND", Buffer.alloc(0))]);
}

test("screenshots: a real image passes; forged, blank or tiny ones don't", () => {
  const real = lib.pngInfo(png(400, 300, (x, y) => [x % 256, y % 256, (x * y) % 256]));
  assert.deepStrictEqual(lib.screenshotProblems(real), []);
  const blank = lib.pngInfo(png(400, 300, () => [255, 255, 255]));
  assert.match(lib.screenshotProblems(blank)[0], /looks blank/);
  const forged = Buffer.concat([png(800, 600, () => [0, 0, 0]).subarray(0, 33), Buffer.alloc(6000, 7)]); // header only
  assert.match(lib.screenshotProblems(lib.pngInfo(forged))[0], /doesn't decode/);
  assert.match(lib.screenshotProblems(lib.pngInfo(png(100, 80, (x) => [x, x, x])))[0], /too small/);
  assert.strictEqual(lib.pngInfo(Buffer.from("not a png at all, nope")), null);
});

test("PR evidence: closing keywords, embedded pinned images, hidden text ignored", () => {
  const body = "Fixes #7\n**Verification:** 68/68 checks passed\n" +
    "![s](https://github.com/o/r/blob/abc1234def/todo/screenshots/ticket-5-recurring.png?raw=true)\n" +
    '<img src="https://raw.githubusercontent.com/o/r/abc1234def/todo/screenshots/ticket-5-edit.png">';
  assert.deepStrictEqual(lib.prEvidence(body, 7), {
    closes: true,
    images: [
      { sha: "abc1234def", path: "todo/screenshots/ticket-5-recurring.png" },
      { sha: "abc1234def", path: "todo/screenshots/ticket-5-edit.png" },
    ],
    claim: { passed: 68, total: 68 },
  });
  assert.strictEqual(lib.prEvidence("<!-- Closes #7 -->", 7).closes, false, "hidden comment");
  assert.strictEqual(lib.prEvidence("Closes #70", 7).closes, false, "different issue");
  assert.deepStrictEqual(lib.prEvidence("see https://github.com/o/r/blob/abc1234/todo/screenshots/ticket-5-a.png", 7).images, [], "plain link isn't embedded");
});
