#!/usr/bin/env node
// Stop hook: appends every user prompt from the session transcript that hasn't
// been logged yet to .claude/logs/prompts.jsonl (one JSON object per line).
// Prompts are deduplicated by transcript entry uuid, so each stop adds only new ones.

const fs = require("fs");
const path = require("path");

// IDE/harness context that gets attached to a prompt but isn't something the user typed.
const CONTEXT_TAGS = ["ide_opened_file", "ide_selection", "system-reminder", "browser_instruction"];

function readStdin() {
  try {
    return JSON.parse(fs.readFileSync(0, "utf8"));
  } catch {
    return {};
  }
}

function promptText(content) {
  let text = typeof content === "string"
    ? content
    : content.filter((b) => b.type === "text").map((b) => b.text).join("\n");
  for (const tag of CONTEXT_TAGS) {
    text = text.replace(new RegExp(`<${tag}>[\\s\\S]*?</${tag}>`, "g"), "");
  }
  // Slash commands are stored as tagged XML; log them the way they were typed.
  const name = text.match(/<command-name>([\s\S]*?)<\/command-name>/);
  if (name) {
    const args = text.match(/<command-args>([\s\S]*?)<\/command-args>/);
    text = [name[1].trim(), args ? args[1].trim() : ""].filter(Boolean).join(" ");
  }
  return text.trim();
}

function main() {
  const input = readStdin();
  const transcript = input.transcript_path;
  if (!transcript || !fs.existsSync(transcript)) return;

  const projectDir = process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd();
  const logFile = path.join(projectDir, ".claude", "logs", "prompts.jsonl");
  fs.mkdirSync(path.dirname(logFile), { recursive: true });

  const logged = new Set();
  if (fs.existsSync(logFile)) {
    for (const line of fs.readFileSync(logFile, "utf8").split("\n")) {
      try {
        logged.add(JSON.parse(line).uuid);
      } catch {}
    }
  }

  const out = [];
  for (const line of fs.readFileSync(transcript, "utf8").split("\n")) {
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry.type !== "user" || entry.isMeta || entry.isSidechain || logged.has(entry.uuid)) continue;
    const content = entry.message && entry.message.content;
    if (!content) continue;
    if (Array.isArray(content) && content.some((b) => b.type === "tool_result")) continue;

    const prompt = promptText(content);
    if (!prompt) continue;
    out.push(JSON.stringify({
      timestamp: entry.timestamp,
      session_id: entry.sessionId || input.session_id,
      uuid: entry.uuid,
      origin: entry.turnOrigin || "human",
      prompt,
    }));
  }

  if (out.length) fs.appendFileSync(logFile, out.join("\n") + "\n");
}

try {
  main();
} catch (err) {
  // Never block Claude from stopping because logging failed.
  process.stderr.write(`log-prompts: ${err.message}\n`);
}
