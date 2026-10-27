// Renders failure traces grouped by cause (audit-lib groupFailures): a section of the audit report,
// and failures.html in the evidence folder, which shows each group's screenshots side by side.

const md = (s) => String(s).replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
const label = (fl) => (fl.check ? `"${md(fl.check)}"` : md(fl.message || "(no message)"));

function detailText(fl) {
  const d = fl.details;
  if (!d || typeof d !== "object" || !("expected" in d)) return "";
  return ` (expected \`${md(d.expected)}\`, got \`${md(d.actual)}\`)`;
}

function traceLinks(fl) {
  return [fl.screenshot && `[screenshot](${fl.screenshot})`, fl.dom && `[DOM](${fl.dom})`,
    fl.video && `video ${fl.video.seconds}s`].filter(Boolean).join(" · ");
}

function groupLines(g) {
  const head = `- **${md(g.cause)}**: ${plural(g.failures.length, "failure")}${g.expected ? " (expected: the audit broke this feature on purpose)" : ""}`;
  const [first, ...rest] = g.failures;
  if (!g.expected) return [head, ...g.failures.map((fl) => `  - ${label(fl)}${detailText(fl)}: ${traceLinks(fl)}`)];
  const lines = [head, `  - first: ${label(first)}${detailText(first)}: ${traceLinks(first)}`];
  if (rest.length) {
    const names = rest.slice(0, 8).map(label).join(", ");
    lines.push(`  - knock-on: ${names}${rest.length > 8 ? `, and ${rest.length - 8} more` : ""}`);
  }
  return lines;
}

// The audit report's section. Paths are relative to the evidence folder.
function failureSection(f) {
  const groups = f.failureGroups || [];
  if (!f.run) return [];
  const unexpected = groups.filter((g) => !g.expected);
  const lines = ["### Failure traces, grouped by cause", ""];
  if (!unexpected.length) lines.push("- Fresh run: no failures.");
  for (const g of groups) lines.push(...groupLines(g));
  lines.push("", `Each failure has a screenshot, the DOM at that moment, the inputs and console output just before it, and, ` +
    `for the fresh run, its time in \`base/video.html\`. ${f.evidenceKept ? "Open `failures.html` in the evidence folder to see them all." : "Run with `--evidence <dir>` to keep them (CI keeps them as an artifact)."}`, "");
  return lines;
}

const html = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

function failureCard(fl) {
  const d = fl.details && typeof fl.details === "object" && "expected" in fl.details
    ? `<p><b>Expected</b> <code>${html(fl.details.expected)}</code><br><b>Got</b> <code>${html(fl.details.actual)}</code></p>` : "";
  const img = fl.screenshot ? `<a href="${html(fl.screenshot)}"><img src="${html(fl.screenshot)}" alt="screenshot" loading="lazy"></a>` : "<p>(no screenshot)</p>";
  const links = [fl.dom && `<a href="${html(fl.dom)}">DOM</a>`, fl.video && `video ${fl.video.seconds}s`].filter(Boolean).join(" · ");
  return `<figure>${img}<figcaption><b>${html(fl.check || fl.message)}</b>${d}<p>${links}</p></figcaption></figure>`;
}

// A standalone page for the evidence folder: every group with its failures' screenshots.
function failuresPage(f) {
  const groups = f.failureGroups || [];
  const body = groups.length ? groups.map((g) => `<section class="${g.expected ? "expected" : "unexpected"}"><h2>${html(g.cause)}</h2>
<p>${plural(g.failures.length, "failure")} in <code>${html(g.run)}</code>${g.expected ? ": expected, because the audit broke this feature on purpose" : ""}</p>
<div class="grid">${g.failures.map(failureCard).join("\n")}</div></section>`).join("\n") : "<p>No failures in any run.</p>";
  return `<!doctype html><meta charset="utf-8"><title>Failure traces: Ticket #${html(f.T)}</title>
<style>body{font:14px system-ui,sans-serif;margin:24px;background:#f6f7f9;color:#1f2328}section{margin-bottom:32px;padding:12px 16px;background:#fff;border-radius:8px;border-left:6px solid #2563eb}
section.unexpected{border-left-color:#dc2626}.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:12px}figure{margin:0}img{width:100%;border:1px solid #d0d7de;border-radius:4px}
code{background:#eef1f4;padding:1px 4px;border-radius:4px;word-break:break-all}h2{font-size:16px;margin:4px 0}</style>
<h1>Failure traces, Ticket #${html(f.T)} (issue #${html(f.issue)})</h1>
<p>Red: failures in the fresh run (real problems). Blue: failures the audit caused on purpose, one group per broken feature.</p>
${body}`;
}

module.exports = { failureSection, failuresPage };
