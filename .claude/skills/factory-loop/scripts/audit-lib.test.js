// Unit tests for audit-lib.js. Run: node --test .claude/skills/factory-loop/scripts/audit-lib.test.js
const test = require("node:test");
const assert = require("node:assert");
const lib = require("./audit-lib");

const TICKET = "Enhance my todo app. I would like to add a due date. I would like to add tags to my ticket and filter the tasks by available tags.";
const acc = (criteria, context = []) => ({ criteria, context });
const full = acc([
  { id: "AC1", quote: "add a due date", checks: ["due shown"] },
  { id: "AC2", quote: "add tags to my ticket", checks: ["tags shown"] },
  { id: "AC3", quote: "filter the tasks by available tags", checks: ["tag filter"] },
], [{ quote: "Enhance my todo app", reason: "context" }]);

test("full coverage: every quote is in the ticket and every word is mapped", () => {
  assert.deepStrictEqual(lib.ticketCoverage(TICKET, full), { badQuotes: [], uncoveredWords: [] });
});

test("a dropped ask is caught (filter by tags never mapped)", () => {
  const partial = acc(full.criteria.slice(0, 2), full.context);
  assert.deepStrictEqual(lib.ticketCoverage(TICKET, partial).uncoveredWords, ["filter", "tasks", "available"]);
});

test("an invented ask is caught (quote not in the ticket)", () => {
  const invented = acc([...full.criteria, { id: "AC4", quote: "export to CSV", checks: ["x"] }], full.context);
  assert.deepStrictEqual(lib.ticketCoverage(TICKET, invented).badQuotes, ["export to CSV"]);
});

test("quotes match whole words, ignoring case and punctuation", () => {
  const t = "Filters: only see completed, incomplete and all tasks.";
  assert.deepStrictEqual(lib.ticketCoverage(t, acc([{ id: "A", quote: "only see COMPLETED incomplete", checks: ["c"] }])).badQuotes, []);
  assert.deepStrictEqual(lib.ticketCoverage("a due date", acc([{ id: "A", quote: "due dat", checks: ["c"] }])).badQuotes, ["due dat"]);
});

test("acceptance validation rejects criteria without a source or evidence", () => {
  const problems = lib.validateAcceptance(acc([
    { id: "AC1", checks: ["x"] },
    { id: "AC1", quote: "q" },
    { id: "AC3", source: "clarified", requirement: "r", files: ["a.html"] },
  ]));
  assert.strictEqual(problems.length, 3);
  assert.deepStrictEqual(lib.validateAcceptance({}), ["acceptance file has no criteria"]);
});

test("parseRun separates checks, console errors and the result", () => {
  const run = lib.parseRun("Loaded x\nPASS a\nFAIL b\nFAIL console error: boom\nRESULT: FAIL\n");
  assert.deepStrictEqual(run, { pass: ["a"], fail: ["b"], consoleErrors: ["boom"], result: "FAIL" });
});

test("grading: failed, missing and absent-pattern evidence all fail the criterion", () => {
  const run = { pass: ["ok"], fail: ["broken"] };
  const io = { fileExists: (f) => f === "index.html", absentHits: () => ["app.js:3"] };
  const [good, bad] = lib.gradeCriteria(acc([
    { id: "G", quote: "q", checks: ["ok"], files: ["index.html"] },
    { id: "B", quote: "q", checks: ["broken", "never-ran"], files: ["gone.js"], absent: "fetch\\(" },
  ]), run, io);
  assert.ok(good.ok);
  assert.strictEqual(bad.ok, false);
  assert.strictEqual(bad.problems.length, 4);
});

test("pngInfo reads the size from the IHDR chunk and rejects non-PNGs", () => {
  const png = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png);
  png.writeUInt32BE(700, 16);
  png.writeUInt32BE(640, 20);
  assert.deepStrictEqual(lib.pngInfo(png), { width: 700, height: 640, bytes: 24 });
  assert.strictEqual(lib.pngInfo(Buffer.from("not a png at all, nope")), null);
  assert.deepStrictEqual(lib.screenshotProblems({ width: 700, height: 640, bytes: 40000 }), []);
  assert.strictEqual(lib.screenshotProblems({ width: 100, height: 640, bytes: 900 }).length, 2);
});

test("prEvidence finds Closes, pinned screenshots and the claimed check count", () => {
  const body = "Closes #7\n**Verification:** 68/68 checks passed\n" +
    "![s](https://github.com/o/r/blob/abc1234def/todo/screenshots/ticket-5-recurring.png?raw=true)";
  assert.deepStrictEqual(lib.prEvidence(body, 7), {
    closes: true,
    images: [{ sha: "abc1234def", path: "todo/screenshots/ticket-5-recurring.png" }],
    claim: { passed: 68, total: 68 },
  });
  assert.strictEqual(lib.prEvidence("Closes #70", 7).closes, false);
});
