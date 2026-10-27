#!/usr/bin/env node
// PreToolUse hook (Bash|PowerShell|Read|Grep): blocks what the factory must never do, whatever a
// ticket says: recursive forced deletes, force-pushes, piping a download into a shell, and reading
// .env files. The same list is in permissions.deny in .claude/settings.json; this hook also catches
// what a prefix rule can't: pipes and subshells, flags in any order or grouped, quoting tricks,
// PowerShell and cmd spellings.
//
// Blocked → permissionDecision "deny" with the reason, which Claude sees. Anything else → silent,
// and the normal permission rules apply. If a command can't be analysed, it is denied: this hook is
// a security boundary, so it fails closed. It is deliberately strict: a command that only mentions
// one of these (in an echo or a commit -m) is blocked too; write such text to a file instead.

const fs = require("fs");
const path = require("path");

const SHELLS = "sh|bash|zsh|dash|ksh|fish|pwsh|powershell|cmd|iex|invoke-expression|python3?|node|perl|ruby";
const DOWNLOADERS = "curl|wget|iwr|irm|invoke-webrequest|invoke-restmethod|downloadstring|downloadfile|start-bitstransfer";
const PIPE_TO_SHELL = [
  new RegExp(`\\b(${DOWNLOADERS})\\b[^\\n]*\\|\\s*(sudo\\s+)?(${SHELLS})\\b`), // curl … | sh, iwr … | iex
  new RegExp(`(\\b(${SHELLS}|source)|(^|\\s)\\.)\\s+<\\(\\s*(${DOWNLOADERS})\\b`), // bash <(curl …), . <(curl …)
  new RegExp(`\\b(${SHELLS})\\b[^\\n|;]*\\$\\(\\s*(${DOWNLOADERS})\\b`), // sh -c "$(curl …)"
  new RegExp(`\\b(iex|invoke-expression)\\b[^\\n|;]*\\b(${DOWNLOADERS})\\b`), // iex (iwr …)
];
const DELETE_COMMANDS = new Set(["rm", "remove-item", "ri", "del", "erase", "rd", "rmdir"]);
const ENV_FILE = /^\.env(\.[\w.*-]+)?\*?$|^\*\.env$/; // .env, .env.local, .env*, *.env
const ENV_EXAMPLE = /\.(example|sample|template|dist)$/;

// Lowercased, with quotes and cmd's ^ escapes removed, so `"r"m` and ^r^m read as rm. A backslash
// is either a bash escape (r\m is rm) or a Windows path separator (C:\repo\.env), so each command
// is checked both ways.
const readings = (cmd) => {
  const s = String(cmd).toLowerCase().replace(/["'`^]/g, "");
  return [s.replace(/\\/g, "/"), s.replace(/\\/g, "")].map((r) => r.replace(/[ \t]+/g, " "));
};
// Simple commands, split on ; & | newlines and subshell brackets.
const segments = (flat) => flat.split(/[;&|\n(){}]|\$\(/).map((s) => s.trim().split(" ").filter(Boolean)).filter((t) => t.length);
const base = (token) => token.split(/[\\/]/).pop().replace(/\.exe$/, "");

// Flags of a delete command: bash clusters (-rf, -fR), long options, PowerShell parameters and their
// abbreviations (-r, -rec, -fo), and cmd switches (/s /q).
function deleteFlags(args) {
  let recursive = false;
  let force = false;
  for (const a of args) {
    if (/^-(r|re|rec|recu|recur|recurs|recurse)$/.test(a) || a === "--recursive" || a === "/s") recursive = true;
    else if (/^-(fo|for|forc|force)$/.test(a) || a === "--force" || a === "/q") force = true;
    else if (/^-[a-z]+$/.test(a)) {
      if (a.includes("r")) recursive = true;
      if (a.includes("f")) force = true;
    }
  }
  return recursive && force;
}

function forcePush(args) {
  return args.some((a) => /^--force(-with-lease|-if-includes)?(=|$)/.test(a) || (/^-[a-z]+$/.test(a) && a.includes("f")) || /^\+/.test(a));
}

// Returns why a shell command is blocked, or null.
function checkCommand(cmd) {
  for (const flat of readings(cmd)) {
    const reason = checkReading(flat);
    if (reason) return reason;
  }
  return null;
}

function checkReading(flat) {
  if (PIPE_TO_SHELL.some((re) => re.test(flat))) return "a download piped into a shell (curl | sh and the like): download it, read it, and ask the user before running it";
  for (const tokens of segments(flat)) {
    for (let i = 0; i < tokens.length; i++) {
      const word = base(tokens[i]);
      if (DELETE_COMMANDS.has(word) && deleteFlags(tokens.slice(i + 1))) return `a recursive forced delete (${tokens.slice(i).join(" ")}): delete specific files, and ask the user first`;
      if (word === "git") {
        const push = tokens.indexOf("push", i + 1);
        if (push > i && forcePush(tokens.slice(push + 1))) return "a force-push, which rewrites history on the remote: push normally, or ask the user";
      }
    }
    const env = tokens.flatMap((t) => t.split(/[\\/=<>]/)).find((t) => ENV_FILE.test(t) && !ENV_EXAMPLE.test(t));
    if (env) return `a .env file (${env}), which holds secrets: never read it`;
  }
  return null;
}

// Returns why a tool call is blocked, or null.
function check(toolName, input = {}) {
  if (toolName === "Bash" || toolName === "PowerShell") return checkCommand(input.command || "");
  if (toolName === "Read" || toolName === "Grep") {
    for (const p of [input.file_path, input.path, input.glob].filter(Boolean)) {
      const name = path.basename(String(p)).toLowerCase();
      if (ENV_FILE.test(name) && !ENV_EXAMPLE.test(name)) return `a .env file (${name}), which holds secrets: never read it`;
    }
  }
  return null;
}

function main() {
  let event;
  try {
    event = JSON.parse(fs.readFileSync(0, "utf8"));
  } catch {
    return; // nothing to judge
  }
  let reason;
  try {
    reason = check(event.tool_name, event.tool_input || {});
  } catch (err) {
    reason = `a call it couldn't check (${err.message}), so it fails closed`;
  }
  if (!reason) return;
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: `command-guard blocked ${reason}.` },
  }));
}

if (require.main === module) main();

module.exports = { check, checkCommand };
