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
//
// Chrome's profile goes in a short temp path: long Windows paths break IndexedDB
// ("Internal error opening backing store"). Needs Node 22+, or Node 20 with
// --experimental-websocket (the script re-launches itself with that flag when needed).

const { spawn, spawnSync } = require("child_process");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");

if (typeof WebSocket === "undefined" && !process.execArgv.includes("--experimental-websocket")) {
  const r = spawnSync(process.execPath, ["--experimental-websocket", __filename, ...process.argv.slice(2)], { stdio: "inherit" });
  process.exit(r.status ?? 1);
}

const args = {};
for (let i = 2; i < process.argv.length; i += 2) args[process.argv[i].replace(/^--/, "")] = process.argv[i + 1];
if (!args.dir) {
  console.error("usage: browser-verify.js --dir <folder> [--page index.html] [--test f.js] [--setup f.js] [--screenshot out.png]");
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
  const proc = spawn(exe, [
    "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check", "--hide-scrollbars",
    `--user-data-dir=${profile}`, "--remote-debugging-port=0", `--window-size=${width},${height}`, "about:blank",
  ], { stdio: "ignore" });
  const portFile = path.join(profile, "DevToolsActivePort");
  // Chrome creates the file before writing it and may hold it locked (EBUSY on Windows), so poll
  // until it can be read and holds a port number.
  for (let i = 0; i < 100; i++) {
    try {
      const port = fs.readFileSync(portFile, "utf8").split("\n")[0].trim();
      if (/^\d+$/.test(port)) return { proc, port };
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

async function evaluate(client, source, label) {
  const { result, exceptionDetails } = await client.send("Runtime.evaluate", {
    expression: `(async () => {\n${source}\n})()`,
    awaitPromise: true,
    returnByValue: true,
  });
  if (exceptionDetails) {
    const detail = exceptionDetails.exception ? exceptionDetails.exception.description : exceptionDetails.text;
    throw new Error(`${label} threw: ${detail}`);
  }
  return result.value;
}

// Connects to the page, records console errors, and loads the app.
async function openPage(chrome, url) {
  const targets = await (await fetch(`http://127.0.0.1:${chrome.port}/json/list`)).json();
  const client = cdp(targets.find((t) => t.type === "page").webSocketDebuggerUrl);
  await client.ready;
  const consoleErrors = [];
  client.on((msg) => {
    if (msg.method === "Runtime.exceptionThrown") consoleErrors.push(msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text);
    if (msg.method === "Runtime.consoleAPICalled" && msg.params.type === "error") consoleErrors.push(msg.params.args.map((a) => a.value ?? a.description).join(" "));
  });
  await client.send("Runtime.enable");
  await client.send("Page.enable");
  const loaded = new Promise((resolve) => client.on((msg) => msg.method === "Page.loadEventFired" && resolve()));
  await client.send("Page.navigate", { url });
  await loaded;
  console.log(`Loaded ${url}`);
  return { client, consoleErrors };
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

async function shutdown(chrome, server, profile) {
  server.close();
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
  let chrome;
  let failed = true;
  try {
    chrome = await launchChrome(profile, Number(args.width || 900), Number(args.height || 700));
    const { client, consoleErrors } = await openPage(chrome, url);
    failed = await runSteps(client, consoleErrors);
    client.close();
  } catch (err) {
    // A script that throws is a failed check; anything else means the run itself broke.
    console.log(`${/^(before|test|setup) threw/.test(err.message) ? "FAIL" : "ERROR"} ${err.message}`);
  } finally {
    await shutdown(chrome, server, profile);
  }
  console.log(failed ? "RESULT: FAIL" : "RESULT: PASS");
  process.exit(failed ? 1 : 0);
}

main();
