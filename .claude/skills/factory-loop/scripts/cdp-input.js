// Trusted input for page-side test scripts. checks.js calls window.trusted.click(el) / .type(el, text)
// / .snapshot(label); the request crosses a CDP binding to Node, which makes Chrome itself dispatch real
// mouse and keyboard events (event.isTrusted === true, impossible to forge from page JavaScript) and
// logs every action to the evidence pack.

const BINDING = "__cdpInput";

// Installed in the page before the test runs.
const PAGE_HELPERS = `(() => {
  const pending = new Map();
  let seq = 0;
  window.__cdpInputDone = (id, result) => {
    const done = pending.get(id);
    pending.delete(id);
    if (done) done(result);
  };
  const call = (msg) => new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, (r) => (r && r.error ? reject(new Error("trusted input: " + r.error)) : resolve(r)));
    window.${BINDING}(JSON.stringify({ id, ...msg }));
  });
  const target = (el) => {
    if (!(el instanceof Element)) throw new Error("trusted input: element not found");
    const key = "t" + (++seq);
    el.setAttribute("data-trusted-target", key);
    return '[data-trusted-target="' + key + '"]';
  };
  window.trusted = {
    click: (el) => call({ action: "click", selector: target(el) }),
    type: (el, text) => call({ action: "type", selector: target(el), text: String(text) }),
    snapshot: (label) => call({ action: "snapshot", label: String(label) }),
  };
})()`;

// Scrolls the element into view, waits until its position is stable (a pending re-render can move
// it), and returns its centre plus a description for the log. Like a person, it won't click something
// that is still moving, and it refuses if another element covers the click point.
async function locate(client, selector) {
  const expression = `(async () => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return { error: "element not found" };
    el.removeAttribute("data-trusted-target");
    el.scrollIntoView({ block: "center", inline: "center" });
    // setTimeout, not requestAnimationFrame: headless Chrome can stop producing frames on an idle page.
    const frames = () => new Promise((r) => setTimeout(r, 40));
    let r = el.getBoundingClientRect();
    for (let i = 0; i < 20; i++) {
      await frames();
      if (!el.isConnected) return { error: "element was replaced by a re-render before the click; wait for the UI to settle" };
      const next = el.getBoundingClientRect();
      if (next.x === r.x && next.y === r.y && i > 0) break;
      r = next;
    }
    const x = r.left + r.width / 2, y = r.top + r.height / 2;
    const hit = document.elementFromPoint(x, y);
    if (!hit || !(hit === el || el.contains(hit))) return { error: "another element covers the click point (" + (hit ? hit.tagName.toLowerCase() : "nothing") + ")" };
    return { x, y, tag: el.tagName.toLowerCase(),
      label: el.getAttribute("aria-label") || (el.textContent || el.value || "").trim().slice(0, 60) };
  })()`;
  const { result } = await send(client, "Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (!result.value || result.value.error) throw new Error(`${result.value ? result.value.error : "no result"} (${selector})`);
  return result.value;
}

async function mouseClick(client, { x, y }) {
  for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) {
    trace("  dispatch", type, Math.round(x), Math.round(y));
    await send(client, "Input.dispatchMouseEvent", { type, x, y, ...(type === "mouseMoved" ? {} : { button: "left", clickCount: 1 }) });
  }
  trace("  clicked");
}

// BV_DEBUG=1 traces every input step on stderr (to diagnose a hanging run).
const trace = (...parts) => process.env.BV_DEBUG && process.stderr.write(`[input ${new Date().toISOString()}] ${parts.join(" ")}\n`);

// Every input step gets a deadline, so Chrome not acknowledging one fails the action with a clear
// message instead of hanging the whole run.
const STEP_TIMEOUT_MS = 15000;
function send(client, method, params) {
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Chrome didn't acknowledge ${method} within ${STEP_TIMEOUT_MS / 1000}s`)), STEP_TIMEOUT_MS);
  });
  return Promise.race([client.send(method, params), deadline]).finally(() => clearTimeout(timer));
}

async function perform(client, req, evidence) {
  trace(req.id, req.action, req.selector || req.label || "");
  if (req.action === "snapshot") {
    if (evidence) await evidence.dumpIndexedDb(req.label);
    return { ok: true };
  }
  const where = await locate(client, req.selector);
  await mouseClick(client, where);
  if (req.action === "type") {
    // Select what's there, then let Chrome insert the text as real keyboard input.
    await send(client, "Runtime.evaluate", { expression: "document.activeElement && document.activeElement.select && document.activeElement.select()" });
    await send(client, "Input.insertText", { text: req.text });
  }
  if (evidence) evidence.recordInput({ action: req.action, ...where, text: req.text });
  return { ok: true };
}

// Wires the binding and the page helpers. Call after the page has loaded, before the test runs.
async function installTrustedInput(client, evidence) {
  await send(client, "Runtime.addBinding", { name: BINDING });
  client.on(async (msg) => {
    if (msg.method !== "Runtime.bindingCalled" || msg.params.name !== BINDING) return;
    let req = {};
    let result;
    try {
      req = JSON.parse(msg.params.payload);
      result = await perform(client, req, evidence);
    } catch (err) {
      result = { error: err.message };
    }
    await send(client, "Runtime.evaluate", { expression: `window.__cdpInputDone(${Number(req.id)}, ${JSON.stringify(result)})` }).catch(() => {});
  });
  await send(client, "Runtime.evaluate", { expression: PAGE_HELPERS });
}

module.exports = { installTrustedInput };
