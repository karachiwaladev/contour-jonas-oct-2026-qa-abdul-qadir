#!/usr/bin/env node
// Failure traces for a whole project, grouped by cause across all its tickets.
//
//   node project-failures.js --project <dir> --out <dir> [--evidence <dir>] [--reuse 1]
//
// Runs the verification audit for every <project>/tests/acceptance/ticket-<T>.json in parallel,
// keeping each ticket's evidence pack (with a failure trace per FAIL, see cdp-trace.js), then writes
// <out>/README.md and the screenshots it shows (<out>/img/). Causes are grouped across tickets:
//   - real failures in a fresh run (problems), by kind and the action just before them;
//   - failures caused on purpose, one group per way of breaking the app (the mutation code), so
//     tickets that break the same thing the same way share a group.
// --reuse 1 skips the audits and reads an existing --evidence folder.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const lib = require("./audit-lib");
const { readJson } = require("./audit-io");

const args = {};
for (let i = 2; i < process.argv.length; i += 2) args[process.argv[i].replace(/^--/, "")] = process.argv[i + 1];
if (!args.project || !args.out) {
  console.error("usage: project-failures.js --project <dir> --out <dir> [--evidence <dir>] [--reuse 1]");
  process.exit(2);
}

const readJsonl = (file) => (fs.existsSync(file) ? fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l)) : []);
const md = (s) => String(s ?? "").replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
const safe = (id) => id.replace(/[^\w-]/g, "_");

function tickets(project) {
  const dir = path.join(project, "tests", "acceptance");
  return fs.readdirSync(dir).filter((f) => /^ticket-\d+\.json$/.test(f)).map((f) => readJson(path.join(dir, f)))
    .sort((a, b) => a.ticket - b.ticket);
}

function audit(acc, evidence) {
  const dir = path.join(evidence, `ticket-${acc.ticket}`);
  fs.mkdirSync(dir, { recursive: true });
  const script = path.join(__dirname, "verify-audit.js");
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script, "--issue", String(acc.issue), "--project", args.project, "--evidence", dir, "--out", path.join(dir, "report.md")], { stdio: "ignore" });
    child.on("close", (code) => resolve({ ticket: acc.ticket, code }));
  });
}

// What a criterion asks, for naming a cause.
const ask = (c) => (c.quote ? `"${c.quote}"` : c.requirement);

// Groups every ticket's traces: real failures by kind/action, deliberate ones by mutation code.
function collect(accs, evidence) {
  const real = new Map();
  const deliberate = new Map();
  for (const acc of accs) {
    const root = `ticket-${acc.ticket}`;
    const base = readJsonl(path.join(evidence, root, "base", "traces.jsonl"));
    for (const g of lib.groupFailures([{ dir: `${root}/base`, traces: base }])) {
      if (!real.has(g.cause)) real.set(g.cause, { cause: g.cause, kind: g.kind, runs: [] });
      real.get(g.cause).runs.push({ ticket: acc.ticket, failures: g.failures });
    }
    for (const c of acc.criteria || []) {
      if (!c.mutation) continue;
      const dir = `${root}/mutation-${safe(c.id)}`;
      const traces = readJsonl(path.join(evidence, dir, "traces.jsonl"));
      if (!traces.length) continue;
      const [g] = lib.groupFailures([{ dir, mutation: { id: c.id, code: c.mutation }, traces }]);
      const key = c.mutation.replace(/\s+/g, " ").trim();
      if (!deliberate.has(key)) deliberate.set(key, { code: key, runs: [] });
      deliberate.get(key).runs.push({ ticket: acc.ticket, id: c.id, ask: ask(c), failures: g.failures });
    }
  }
  return { real: [...real.values()], deliberate: [...deliberate.values()] };
}

function copyShot(evidence, out, rel, name) {
  if (!rel || !fs.existsSync(path.join(evidence, rel))) return null;
  fs.mkdirSync(path.join(out, "img"), { recursive: true });
  fs.copyFileSync(path.join(evidence, rel), path.join(out, "img", name));
  return `img/${name}`;
}

function failureLine(fl) {
  const d = fl.details && typeof fl.details === "object" && "expected" in fl.details
    ? ` (expected \`${md(fl.details.expected)}\`, got \`${md(fl.details.actual)}\`)` : "";
  return `${fl.check ? `"${md(fl.check)}"` : md(String(fl.message).split("\n")[0])}${d}`;
}

function render(accs, results, groups, evidence, out) {
  const date = new Date().toISOString().slice(0, 10);
  const verdicts = results.map((r) => `Ticket #${r.ticket} ${r.code === 0 ? "✅ VERIFIED" : r.code === 1 ? "❌ NOT VERIFIED" : "⚠ couldn't run"}`).join(", ");
  const lines = [`# Failure traces: \`${args.project}\``, "",
    `Generated ${date} from fresh verification audits of every ${args.project} ticket: ${verdicts}.`,
    "Every failed check has a trace: a screenshot, the DOM at that moment, the inputs and console output just before it.",
    "They are grouped **by cause**, across tickets. Each group's first failure is the direct hit; the rest are knock-on failures.", "",
    "| # | Cause | Kind | Tickets | Failures | Direct hit |", "|---|---|---|---|---|---|"];
  const all = [...groups.real.map((g) => ({ ...g, kindLabel: `real: ${g.kind}`, name: g.cause })),
    ...groups.deliberate.map((g) => ({ ...g, kindLabel: "broken on purpose", name: g.runs.map((r) => r.ask).join(" / ") }))];
  all.forEach((g, i) => {
    const count = g.runs.reduce((n, r) => n + r.failures.length, 0);
    lines.push(`| C${i + 1} | ${md(g.name)} | ${g.kindLabel} | ${g.runs.map((r) => `#${r.ticket}${r.id ? ` ${r.id}` : ""}`).join(", ")} | ${count} | ${failureLine(g.runs[0].failures[0])} |`);
  });
  lines.push("", "## Real failures (fresh runs)", "", groups.real.length ? "" : "None: every ticket's fresh run passed, so every failure below was caused on purpose by the audit.", "");
  all.forEach((g, i) => {
    if (i === groups.real.length) lines.push("## Failures caused on purpose (one group per way of breaking the app)", "");
    lines.push(`### C${i + 1} · ${md(g.name)}`, "");
    if (g.code) lines.push(`Broken by \`${md(g.code)}\`, in ${g.runs.map((r) => `Ticket #${r.ticket} ${r.id}`).join(" and ")}.`, "");
    for (const r of g.runs) {
      const [first, ...rest] = r.failures;
      const shot = copyShot(evidence, out, first.screenshot, `t${r.ticket}-${r.id || "base"}-${i + 1}.png`);
      lines.push(`**Ticket #${r.ticket}${r.id ? ` ${r.id}` : ""}:** ${r.failures.length} failure${r.failures.length === 1 ? "" : "s"}.`, "",
        `- Direct hit: ${failureLine(first)}`);
      if (rest.length) lines.push(`- Knock-on (${rest.length}): ${rest.map(failureLine).join("; ")}`);
      if (shot) lines.push("", `![Ticket #${r.ticket} ${r.id || ""}: ${md(first.check || "failure")}](${shot})`);
      lines.push("");
    }
  });
  lines.push("---", `Full traces (every screenshot, DOM snapshot and \`failures.html\` per ticket): \`${evidence}\`.`,
    `Regenerate: \`node .claude/skills/factory-loop/scripts/project-failures.js --project ${args.project} --out ${args.out}\`.`, "");
  return lines.join("\n");
}

async function main() {
  const accs = tickets(args.project);
  const evidence = path.resolve(args.evidence || fs.mkdtempSync(path.join(os.tmpdir(), "pf-")));
  const verdict = (a) => {
    const file = path.join(evidence, `ticket-${a.ticket}`, "report.md");
    const text = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
    return { ticket: a.ticket, code: /NOT VERIFIED/.test(text) ? 1 : /VERIFIED/.test(text) ? 0 : 2 };
  };
  const results = args.reuse ? accs.map(verdict) : await Promise.all(accs.map((a) => audit(a, evidence)));
  const out = path.resolve(args.out);
  fs.mkdirSync(out, { recursive: true });
  const groups = collect(accs, evidence);
  fs.writeFileSync(path.join(out, "README.md"), render(accs, results, groups, evidence, out));
  console.log(`${path.join(out, "README.md")}: ${groups.real.length} real and ${groups.deliberate.length} deliberate causes; ` +
    results.map((r) => `#${r.ticket} exit ${r.code}`).join(", "));
}

main().catch((err) => {
  console.error(`project-failures: ${err.message}`);
  process.exit(2);
});
