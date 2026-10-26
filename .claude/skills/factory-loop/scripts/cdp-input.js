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
    const frames = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
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
  const { result } = await client.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (!result.value || result.value.error) throw new Error(`${result.value ? result.value.error : "no result"} (${selector})`);
  return result.value;
}

async function mouseClick(client, { x, y }) {
  await client.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
  await client.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
  await client.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
}

async function perform(client, req, evidence) {
  if (req.action === "snapshot") {
    if (evidence) await evidence.dumpIndexedDb(req.label);
    return { ok: true };
  }
  const where = await locate(client, req.selector);
  await mouseClick(client, where);
  if (req.action === "type") {
    // Select what's there, then let Chrome insert the text as real keyboard input.
    await client.send("Runtime.evaluate", { expression: "document.activeElement && document.activeElement.select && document.activeElement.select()" });
    await client.send("Input.insertText", { text: req.text });
  }
  if (evidence) evidence.recordInput({ action: req.action, ...where, text: req.text });
  return { ok: true };
}

// Wires the binding and the page helpers. Call after the page has loaded, before the test runs.
async function installTrustedInput(client, evidence) {
  await client.send("Runtime.addBinding", { name: BINDING });
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
    await client.send("Runtime.evaluate", { expression: `window.__cdpInputDone(${Number(req.id)}, ${JSON.stringify(result)})` }).catch(() => {});
  });
  await client.send("Runtime.evaluate", { expression: PAGE_HELPERS });
}

module.exports = { installTrustedInput };
