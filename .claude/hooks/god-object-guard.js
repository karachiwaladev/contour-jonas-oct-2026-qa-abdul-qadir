#!/usr/bin/env node
// PostToolUse hook (Write|Edit): runs the god-object detector on the file Claude just wrote.
// OK → silent. WARN → adds context so Claude keeps the file in check. FAIL → blocks with the
// reasons and a split suggestion, so Claude refactors before moving on. Never throws: a broken
// analyzer must not get in the way of editing.

const fs = require("fs");
const path = require("path");

const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const ANALYZER = path.join(projectDir, ".claude/skills/factory-code-review/scripts/god-object.js");

function main() {
  let input = {};
  try {
    input = JSON.parse(fs.readFileSync(0, "utf8"));
  } catch {
    return;
  }
  const filePath = input.tool_input && (input.tool_input.file_path || input.tool_input.path);
  if (!filePath || !fs.existsSync(ANALYZER)) return;

  const rel = path.relative(projectDir, path.resolve(projectDir, filePath));
  if (rel.startsWith("..") || path.isAbsolute(rel)) return; // outside the repo
  process.chdir(projectDir);
  const { analyzeFile, format } = require(ANALYZER);
  const result = analyzeFile(rel);
  if (!result || result.status === "OK") return;

  const report = format(result);
  if (result.status === "FAIL") {
    process.stdout.write(JSON.stringify({
      decision: "block",
      reason: `God-object check failed for ${result.file}. Refactor before continuing: split it so each module/function has one responsibility, then re-check with node .claude/skills/factory-code-review/scripts/god-object.js ${result.file}. If the size is genuinely justified, add "quality: allow-large-file <reason>" in the first 5 lines and call it out in the code review.\n${report}`,
    }));
  } else {
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PostToolUse",
        additionalContext: `God-object warning for ${result.file} (approaching limits; don't grow it further without splitting):\n${report}`,
      },
    }));
  }
}

try {
  main();
} catch (err) {
  process.stderr.write(`god-object-guard: ${err.message}\n`);
}
