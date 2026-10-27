#!/usr/bin/env node
// Verifies a web project in real headless Chrome via the Chrome DevTools Protocol (CDP).
//
//   node browser-verify.js --dir <folder> [--page index.html] [--before mutate.js]
//                          [--test checks.js] [--setup setup.js] [--screenshot out.png]
//                          [--width 900] [--height 700]
//
// --dir         folder served on a local http://127.0.0.1 port (no file:// quirks)
// --before      JS evaluated (async) after load and before --test; the verification audit uses
//               it to inject a mutation that breaks one feature
// --test        JS evaluated in the page as an async function body. It must return an
//               array of one-line strings starting with "PASS " or "FAIL ". Exit code is 1 on any FAIL.
//               Keep the array in window.__checkResults too: if the script crashes, the results
//               so far are still printed before the crash.
// --setup       JS evaluated (async) before the screenshot, e.g. to seed demo data.
// --screenshot  PNG written after --test/--setup finish, so it shows the settled page.
//
// Output: PASS/FAIL lines are check results (and failures of the scripts themselves); ERROR lines
// mean the run couldn't happen (no Chrome, CDP trouble), so they say nothing about the app.
// --evidence    folder for an evidence pack recorded from Chrome's own events (cdp-evidence.js):
//               console with sources, network, trusted inputs, IndexedDB, Chrome hash, manifest
// --video 1     also record a screencast of the run into the evidence pack
//
// The test script gets `trusted` (cdp-input.js): click/type via real Chrome input, not .click().
// The app's browser context reaches anything but loopback only through egress-proxy.js, which logs
// every connection (pages, workers, service workers, WebSockets, WebRTC) as egress.jsonl.
//
// Chrome's profile goes in a short temp path: long Windows paths break IndexedDB
// ("Internal error opening backing store"). Needs Node 22+, or Node 20 with
// --experimental-websocket (the script re-launches itself with that flag when needed).

const { spawn, spawnSync } = require("child_process");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const { Evidence, sha256File, HARNESS_PREFIX } = require("./cdp-evidence");
const { installTrustedInput, TAKE_TRUSTED } = require("./cdp-input");
const { startEgressProxy } = require("./egress-proxy");

if (typeof WebSocket === "undefined" && !process.execArgv.includes("--experimental-websocket")) {
  const r = spawnSync(process.execPath, ["--experimental-websocket", __filename, ...process.argv.slice(2)], { stdio: "inherit" });
  process.exit(r.status ?? 1);
}

const args = {};
for (let i = 2; i < process.argv.length; i += 2) args[process.argv[i].replace(/^--/, "")] = process.argv[i + 1];
if (!args.dir) {
  console.error("usage: browser-verify.js --dir <folder> [--page index.html] [--before f.js] [--test f.js] [--setup f.js] [--screenshot out.png] [--evidence dir] [--video 1]");
  process.exit(2);
}

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
].filter(Boolean);

const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".png": "image/png", ".svg": "image/svg+xml" };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function serve(root) {
  const server = http.createServer((req, res) => {
    const rel = decodeURIComponent(req.url.split("?")[0]).replace(/^\/+/, "") || "index.html";
    const file = path.resolve(root, rel);
    if (!file.startsWith(path.resolve(root))) { res.statusCode = 403; return res.end(); }
    fs.readFile(file, (err, data) => {
      if (err) { res.statusCode = 404; return res.end(); }
      res.setHeader("Content-Type", MIME[path.extname(file)] || "application/octet-stream");
      res.end(data);
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

async function launchChrome(profile, width, height) {
  const exe = CHROME_CANDIDATES.find((p) => fs.existsSync(p));
  if (!exe) throw new Error("Chrome/Edge not found; set CHROME_PATH");
  const flags = [
    "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check", "--hide-scrollbars",
    `--user-data-dir=${profile}`, "--remote-debugging-port=0", `--window-size=${width},${height}`,
    // WebRTC may only use the (egress) proxy, never direct UDP; see openPage.
    "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
    // Profile features that call Google from the app's context (search preconnect, autofill), which would
    // otherwise show up in the egress log as if the app made them.
    "--disable-background-networking", "--disable-sync", "--disable-extensions", "--dns-prefetch-disable",
    "--disable-features=PreconnectToSearch,AutofillServerCommunication,OptimizationHints,Translate,NetworkTimeServiceQuerying,MediaRouter",
  ];
  // Ubuntu CI runners block Chrome's user-namespace sandbox; the page served there is the repo's own app.
  if (process.env.CI && process.platform === "linux") flags.push("--no-sandbox");
  // No preconnects or prefetches: Chrome would otherwise warm up connections to its search engine.
  fs.mkdirSync(path.join(profile, "Default"), { recursive: true });
  fs.writeFileSync(path.join(profile, "Default", "Preferences"), JSON.stringify({ net: { network_prediction_options: 2 } }));
  const proc = spawn(exe, [...flags, "about:blank"], { stdio: "ignore" });
  const portFile = path.join(profile, "DevToolsActivePort");
  // Chrome creates the file before writing it and may hold it locked (EBUSY on Windows), so poll
  // until it can be read and holds a port number.
  for (let i = 0; i < 100; i++) {
    try {
      const port = fs.readFileSync(portFile, "utf8").split("\n")[0].trim();
      if (/^\d+$/.test(port)) return { proc, port, exe };
    } catch (err) {
      if (!["ENOENT", "EBUSY", "EPERM"].includes(err.code)) throw err;
    }
    await sleep(100);
  }
  throw new Error("Chrome did not start (no readable DevToolsActivePort)");
}

function cdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let id = 0;
  const pending = new Map();
  const listeners = [];
  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
    } else if (msg.method) {
      listeners.forEach((fn) => fn(msg));
    }
  };
  const ready = new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = () => reject(new Error("CDP connection failed")); });
  return {
    ready,
    send: (method, params = {}) => new Promise((resolve, reject) => {
      const msgId = ++id;
      pending.set(msgId, { resolve, reject });
      ws.send(JSON.stringify({ id: msgId, method, params }));
    }),
    on: (fn) => listeners.push(fn),
    close: () => ws.close(),
  };
}

// The test script receives the trusted-input API as its `trusted` parameter. It's handed over only
// once, so if page code grabbed it first, the test fails instead of input being driven unnoticed.
async function evaluate(client, source, label) {
  const take = `(window.${TAKE_TRUSTED} || (() => { throw new Error("trusted input was taken before the test ran"); }))()`;
  const { result, exceptionDetails } = await client.send("Runtime.evaluate", {
    expression: (label === "test" ? `(async (trusted) => {\n${source}\n})(${take})` : `(async () => {\n${source}\n})()`) +
      `\n//# sourceURL=${HARNESS_PREFIX}${label}.js`,
    awaitPromise: true,
    returnByValue: true,
  });
  if (exceptionDetails) {
    const detail = exceptionDetails.exception ? exceptionDetails.exception.description : exceptionDetails.text;
    throw new Error(`${label} threw: ${detail}`);
  }
  return result.value;
}

// Opens the app in its own browser context whose only route off the machine is the egress proxy, so
// everything the app does (pages, workers, service workers, WebSockets) is logged there, while Chrome's
// own background traffic (updates, sign-in) stays out of the log. The browser connection that owns
// the context must stay open for the whole run.
async function openAppTarget(chrome, proxy, width, height) {
  const { webSocketDebuggerUrl } = await (await fetch(`http://127.0.0.1:${chrome.port}/json/version`)).json();
  const browser = cdp(webSocketDebuggerUrl);
  await browser.ready;
  const { browserContextId } = await browser.send("Target.createBrowserContext", { proxyServer: `http://127.0.0.1:${proxy.address().port}` });
  const { targetId } = await browser.send("Target.createTarget", { url: "about:blank", browserContextId, width, height });
  const client = cdp(`ws://127.0.0.1:${chrome.port}/devtools/page/${targetId}`);
  await client.ready;
  return { browser, client };
}

// Connects to the page, records console errors (and the evidence pack, if any), loads the app and
// installs trusted input for the test script.
async function openPage(chrome, proxy, url, evidence) {
  const { browser, client } = await openAppTarget(chrome, proxy, Number(args.width || 900), Number(args.height || 700));
  const consoleErrors = [];
  client.on((msg) => {
    if (msg.method === "Runtime.exceptionThrown") consoleErrors.push(msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text);
    if (msg.method === "Runtime.consoleAPICalled" && msg.params.type === "error") consoleErrors.push(msg.params.args.map((a) => a.value ?? a.description).join(" "));
  });
  await client.send("Runtime.enable");
  await client.send("Page.enable");
  if (evidence) await evidence.attach(client);
  const loaded = new Promise((resolve) => client.on((msg) => msg.method === "Page.loadEventFired" && resolve()));
  await sleep(500); // let tab-creation preconnects hit the closed proxy first (see egress-proxy.js)
  proxy.open();
  await client.send("Page.navigate", { url });
  await loaded;
  await installTrustedInput(client, evidence);
  console.log(`Loaded ${url}`);
  return { browser, client, consoleErrors };
}

const scriptInfo = (file) => (file ? { file: path.basename(file), sha256: sha256File(file) } : undefined);

// Writes the evidence manifest and prints its hash, so the pack is tied to this run's output.
async function sealEvidence(evidence, url, failed) {
  try {
    const m = await evidence.finish({
      page: url, result: failed ? "FAIL" : "PASS", finishedAt: new Date().toISOString(),
      scripts: { test: scriptInfo(args.test), before: scriptInfo(args.before), setup: scriptInfo(args.setup) },
    });
    console.log(`EVIDENCE ${evidence.dir} manifest-sha256=${m.manifestSha256} trusted-inputs=${m.counts.trustedInputs} ` +
      `requests=${m.counts.network} external=${m.counts.external} egress=${m.counts.egress} frames=${m.counts.frames}`);
  } catch (err) {
    console.log(`ERROR couldn't write the evidence pack: ${err.message}`);
  }
}

// Prints check results; returns true if any is missing, not a PASS, or not a single line
// (a result with a line break could otherwise print as several fake PASS lines).
function reportResults(results) {
  if (!Array.isArray(results) || results.length === 0) {
    console.log("FAIL test returned no results");
    return true;
  }
  let failed = false;
  for (const raw of results) {
    const line = String(raw);
    if (/[\r\n]/.test(line)) {
      console.log(`FAIL result contains a line break: ${JSON.stringify(line)}`);
      failed = true;
    } else {
      console.log(line);
      if (!line.startsWith("PASS ")) failed = true;
    }
  }
  return failed;
}

async function saveScreenshot(client, file) {
  await sleep(300); // let the last render paint
  const { data } = await client.send("Page.captureScreenshot", { format: "png" });
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  fs.writeFileSync(file, Buffer.from(data, "base64"));
  console.log(`Screenshot: ${path.resolve(file)}`);
}

// If the test script crashes, prints the results it had published so far in window.__checkResults,
// so it's still visible which checks failed before the crash.
async function printPartialResults(client) {
  const { result } = await client.send("Runtime.evaluate", { expression: "window.__checkResults || []", returnByValue: true });
  if (Array.isArray(result.value) && result.value.length) reportResults(result.value);
}

// Runs --before, --test, --setup and --screenshot in order; returns true if anything failed.
async function runSteps(client, consoleErrors) {
  let failed = false;
  if (args.before) await evaluate(client, fs.readFileSync(args.before, "utf8"), "before");
  if (args.test) {
    try {
      failed = reportResults(await evaluate(client, fs.readFileSync(args.test, "utf8"), "test"));
    } catch (err) {
      await printPartialResults(client);
      throw err;
    }
  }
  if (args.setup) await evaluate(client, fs.readFileSync(args.setup, "utf8"), "setup");
  if (consoleErrors.length) {
    failed = true;
    consoleErrors.forEach((e) => console.log(`FAIL console error: ${e}`));
  }
  if (args.screenshot) await saveScreenshot(client, args.screenshot);
  return failed;
}

async function shutdown(chrome, server, proxy, profile) {
  server.close();
  proxy.close();
  if (chrome) {
    if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(chrome.proc.pid), "/T", "/F"], { stdio: "ignore" });
    else chrome.proc.kill();
    await sleep(500);
  }
  // Chrome's crash handler can keep a profile file locked (EBUSY) for a while after exit. A leftover
  // temp profile is harmless, so cleanup never fails the run.
  try {
    fs.rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  } catch (err) {
    console.error(`note: couldn't remove temp profile ${profile} (${err.code}); it's safe to delete later`);
  }
}

async function main() {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "bv-"));
  const server = await serve(path.resolve(args.dir));
  const url = `http://127.0.0.1:${server.address().port}/${args.page || "index.html"}`;
  const egress = [];
  const proxy = await startEgressProxy((row) => egress.push(row));
  let chrome;
  let page;
  let evidence;
  let failed = true;
  try {
    chrome = await launchChrome(profile, Number(args.width || 900), Number(args.height || 700));
    const origin = `http://127.0.0.1:${server.address().port}`;
    if (args.evidence) evidence = new Evidence(path.resolve(args.evidence), { origin, exe: chrome.exe, video: args.video === "1", egress });
    page = await openPage(chrome, proxy, url, evidence);
    failed = await runSteps(page.client, page.consoleErrors);
  } catch (err) {
    // A script that throws is a failed check; anything else means the run itself broke.
    console.log(`${/^(before|test|setup) threw/.test(err.message) ? "FAIL" : "ERROR"} ${err.message}`);
  } finally {
    if (evidence && page) await sealEvidence(evidence, url, failed);
    if (page) { page.client.close(); page.browser.close(); }
    await shutdown(chrome, server, proxy, profile);
  }
  console.log(failed ? "RESULT: FAIL" : "RESULT: PASS");
  process.exit(failed ? 1 : 0);
}

main();
