// Renders verify-audit.js findings as the markdown report posted on the PR.

const esc = (s) => String(s).replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
const ok = (b) => (b ? "✅" : "❌");
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

function evidenceText(c) {
  const parts = [];
  if ((c.checks || []).length) parts.push(plural(c.checks.length, "check"));
  if ((c.files || []).length) parts.push(`files: ${c.files.join(", ")}`);
  if (c.absent) parts.push(`no \`/${c.absent}/\` in the source`);
  return parts.join(" + ");
}

function mutationText(c) {
  if (c.structural && !(c.checks || []).length) return "n/a (structural ⚠)";
  if (!c.mutationRun) return "not run (fix the fresh run first)";
  return c.killed.length ? `✅ broke ${plural(c.killed.length, "check")}` : "❌ checks still passed";
}

function criteriaTable(criteria) {
  const lines = ["### Ticket asks → evidence", "", "| ID | Ask | Evidence | Fresh run | Feature broken on purpose |", "|---|---|---|---|---|"];
  for (const c of criteria) {
    const ask = c.quote ? `"${esc(c.quote)}"` : `clarified: ${esc(c.requirement)}`;
    lines.push(`| ${c.id} | ${ask} | ${esc(evidenceText(c))} | ${c.ok ? "✅" : `❌ ${esc(c.problems.join("; "))}`} | ${esc(mutationText(c))} |`);
  }
  lines.push("", "*Feature broken on purpose:* the audit reruns the checks with that feature disabled (`mutation`); " +
    "at least one of its checks must fail, which proves the checks really test it.", "");
  return lines;
}

function evidenceSection(f) {
  const lines = ["### Screenshots", "", ...(f.shots || []).map((s) =>
    `- \`${s.file}\`: ${s.info ? `${s.info.width}×${s.info.height}, ${Math.round(s.info.bytes / 1024)} KB` : "unreadable"} ${ok(!s.problems.length)}`), ""];
  if (f.pr) {
    lines.push(`### PR #${f.pr.number} evidence`, "", `- Closes #${f.issue}: ${ok(f.pr.closes)}`,
      `- Screenshots embedded and pinned to a commit: ${f.pr.pinned.length} ${ok(f.pr.pinned.length > 0)}`,
      `- Check count claimed: ${f.pr.claim ? `${f.pr.claim.passed}/${f.pr.claim.total}` : "none"}`, "");
  }
  return lines;
}

function report(f) {
  const verified = f.blockers.length === 0;
  const run = f.run || { pass: [], fail: [], consoleErrors: [] };
  const lines = [
    `## Verification audit: Ticket #${f.T} (issue #${f.issue})`, "",
    verified ? "**Verdict: ✅ VERIFIED.** Every ticket ask maps to checks that passed in a fresh run and fail when the feature is broken."
      : `**Verdict: ❌ NOT VERIFIED.** ${plural(f.blockers.length, "problem")} below. Don't merge until they're fixed.`, "",
    `Audited: ${f.ref} · fresh Chrome run: ${run.pass.length}/${run.pass.length + run.fail.length} checks passed, ` +
      `${plural(run.consoleErrors.length, "console error")} · criteria: \`${f.accFile}\``, "",
  ];
  if (f.criteria) lines.push(...criteriaTable(f.criteria));
  if ((f.context || []).length) {
    lines.push("**Treated as context, not tested. The reviewer must confirm none of these is an ask:**",
      ...f.context.map((c) => `- ⚠ "${c.quote}" (${c.reason})`), "");
  }
  lines.push(...evidenceSection(f));
  if (!verified) lines.push("### Problems", "", ...f.blockers.map((b) => `- ${b}`), "");
  if (f.notes.length) lines.push("### Notes", "", ...f.notes.map((n) => `- ${n}`), "");
  return lines.join("\n");
}

module.exports = { report };
