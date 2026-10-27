// Failure traces for browser-verify: every FAIL gets a trace in the evidence pack, so you can see what
// the page looked like when a check failed, not just its name.
//   traces/fail-<n>.png    screenshot taken by Chrome right after the failure
//   traces/fail-<n>.html   the DOM at the moment the check failed (captured in the page, synchronously)
//   traces.jsonl           one row per failure: kind, check, message, expected/actual when the check
//                          gave them, the trusted inputs and console messages just before, and where
//                          it is in the screencast (video.html)
// Kinds: "assertion" (a check returned FAIL), "input-refused" (trusted.click/type refused the target),
// "script-threw" (the test or a mutation crashed), "console-error" (an error the app logged).
// Traces are diagnostics, not proof: page code could tamper with a DOM snapshot, but it can't make a
// failing check pass.

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const MAX_DOM_CHARS = 400000;

// Hooks window.__checkResults (which checks.js assigns) so each "FAIL ..." pushed onto it is reported
// at once, with the DOM and any details the check gave (window.__checkDetails[name]).
const pageHook = (binding) => `(() => {
  const send = window.${binding};
  delete window.${binding};
  let results;
  const hook = (arr) => {
    if (!Array.isArray(arr)) return arr;
    const push = arr.push;
    arr.push = function (...items) {
      const n = push.apply(this, items);
      for (const item of items) {
        const line = String(item);
        if (!line.startsWith("FAIL ")) continue;
        const check = line.slice(5);
        const details = window.__checkDetails && window.__checkDetails[check];
        send(JSON.stringify({ check, details: details === undefined ? null : details,
          dom: document.documentElement.outerHTML.slice(0, ${MAX_DOM_CHARS}), scrollY: window.scrollY }));
      }
      return n;
    };
    return arr;
  };
  Object.defineProperty(window, "__checkResults", { configurable: true, get: () => results, set: (v) => { results = hook(v); } });
})()`;

class Tracer {
  constructor(client, evidence) {
    Object.assign(this, { client, evidence, count: 0 });
    evidence.log.traces = [];
    fs.mkdirSync(path.join(evidence.dir, "traces"), { recursive: true });
  }

  async install() {
    const binding = `__cdpTrace_${crypto.randomBytes(8).toString("hex")}`;
    await this.client.send("Runtime.addBinding", { name: binding });
    this.client.on((msg) => {
      if (msg.method !== "Runtime.bindingCalled" || msg.params.name !== binding) return;
      let info = {};
      try {
        info = JSON.parse(msg.params.payload);
      } catch {
        info = { check: "(unreadable failure report)" };
      }
      this.record({ kind: "assertion", ...info });
    });
    await this.client.send("Runtime.evaluate", { expression: pageHook(binding) });
  }

  // Records one failure. Returns at once; the screenshot is awaited by evidence.finish().
  record({ kind, check = null, message = null, details = null, dom = null }) {
    const t = Date.now();
    const n = ++this.count;
    const base = `traces/fail-${n}`;
    const row = { n, t, kind, check, message, details, ...this.context(t), files: { screenshot: `${base}.png`, dom: dom ? `${base}.html` : null } };
    if (dom) fs.writeFileSync(path.join(this.evidence.dir, `${base}.html`), dom);
    this.evidence.log.traces.push(row);
    console.log(`TRACE ${base} ${kind}${check ? `: ${check}` : ""}`);
    const shot = this.client.send("Page.captureScreenshot", { format: "png" })
      .then(({ data }) => fs.writeFileSync(path.join(this.evidence.dir, row.files.screenshot), Buffer.from(data, "base64")))
      .catch(() => { row.files.screenshot = null; });
    this.evidence.pending.push(shot);
    return row;
  }

  // A failure the harness noticed rather than a check (a crash, a console error): reads the DOM first.
  async recordHarness(kind, message) {
    const expression = `document.documentElement.outerHTML.slice(0, ${MAX_DOM_CHARS})`;
    const { result } = await this.client.send("Runtime.evaluate", { expression, returnByValue: true }).catch(() => ({ result: {} }));
    return this.record({ kind, message, dom: result.value || null });
  }

  // What happened just before a failure: the last trusted inputs, recent console output, video time.
  context(t) {
    const { input, console: logs } = this.evidence.log;
    const frames = this.evidence.frames;
    const at = frames.length ? frames.filter((f) => f.t * 1000 <= t).pop() || frames[0] : null;
    return {
      lastInputs: input.slice(-3).map(({ action, tag, label, text }) => ({ action, tag, label, ...(text !== undefined ? { text } : {}) })),
      recentConsole: logs.filter((c) => t - c.t < 10000).slice(-5).map(({ type, source, text }) => ({ type, source, text })),
      video: at ? { frame: at.name, seconds: Math.round((at.t - frames[0].t) * 10) / 10 } : null,
    };
  }
}

// The kind of a harness-level failure from its message (see the header).
const failureKind = (message) => (/trusted input:/.test(message) ? "input-refused" : "script-threw");

module.exports = { Tracer, failureKind };
