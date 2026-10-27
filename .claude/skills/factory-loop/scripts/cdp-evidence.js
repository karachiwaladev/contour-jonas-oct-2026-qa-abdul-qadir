// Evidence pack for a browser-verify run, recorded from Chrome's own DevTools events rather than from
// anything page code reports about itself:
//   console.jsonl   every console message and exception, with the source that produced it, taken from
//                   Chrome's own record of the script (Debugger.scriptParsed), not from its claimed URL:
//                     app:<file>          a script file Chrome fetched from the app's server
//                     app-inline:<file>   code inline in, or injected into, an app page
//                     page-eval           eval / new Function / injected code with no URL
//                     self-named:<url>    code that named itself with a //# sourceURL comment
//                     harness:<step>      the harness's test, before and setup scripts
//                     browser:<area>      Chrome itself
//   network.jsonl   every request the page made, flagged local or external (page-level CDP view)
//   egress.jsonl    every connection Chrome made to anything but loopback, logged by egress-proxy.js;
//                   this one also covers workers, service workers, WebSockets and WebRTC
//   input.jsonl     every trusted click/typing the harness dispatched (see cdp-input.js)
//   indexeddb-*.json  database contents read by Chrome through the IndexedDB domain
//   frames/ + video.html  screencast of the rendered page (when video is on)
//   manifest.json   Chrome version and binary SHA-256, test-script hashes, and a SHA-256 of every file
// In CI the pack is produced and stored by GitHub, so nobody involved can edit it after the run.

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const sha256 = (data) => crypto.createHash("sha256").update(data).digest("hex");
const sha256File = (file) => sha256(fs.readFileSync(file));

// The browser binary, plus the real chrome binary when the launcher is a wrapper script (Linux).
function chromeBinaries(exe) {
  const real = fs.realpathSync(exe);
  const bin = path.join(path.dirname(real), process.platform === "win32" ? "chrome.exe" : "chrome");
  return [...new Set([real, fs.existsSync(bin) ? bin : real])].map((file) => ({ file, sha256: sha256File(file) }));
}

// browser-verify.js names the scripts it evaluates with this sourceURL prefix.
const HARNESS_PREFIX = "browser-verify-harness/";

class Evidence {
  constructor(dir, { origin, exe, video, egress }) {
    Object.assign(this, { dir, origin, exe, video, frames: [], scripts: new Map(), fetchedScripts: new Set(),
      log: { console: [], network: [], input: [], egress: egress || [] }, pending: [] });
    fs.mkdirSync(path.join(dir, video ? "frames" : ""), { recursive: true });
  }

  // Attach before navigating, so the app's load-time console output and requests are captured too.
  async attach(client) {
    this.client = client;
    client.on((msg) => this.onEvent(msg));
    await client.send("Network.enable");
    await client.send("Log.enable");
    // The Debugger domain reports every script Chrome compiles, which is what source() trusts. It never
    // pauses: `debugger;` statements in the app are ignored.
    await client.send("Debugger.enable");
    await client.send("Debugger.setSkipAllPauses", { skip: true });
    if (this.video) await client.send("Page.startScreencast", { format: "jpeg", quality: 50, maxWidth: 800, maxHeight: 1000 });
  }

  isLocal(url) {
    return url === this.origin || url.startsWith(`${this.origin}/`) || /^(data|blob|about):/.test(url);
  }

  // Who produced a console message, from Chrome's record of the script that ran (see the header).
  source(scriptId, fallbackUrl) {
    const s = this.scripts.get(scriptId);
    const url = s ? s.url : fallbackUrl || "";
    if (s?.hasSourceURL) return url.startsWith(HARNESS_PREFIX) ? `harness:${url.slice(HARNESS_PREFIX.length)}` : `self-named:${url}`;
    if (!url) return "page-eval";
    if (!url.startsWith(`${this.origin}/`)) return `other:${url}`;
    const file = url.slice(this.origin.length + 1);
    return this.fetchedScripts.has(url) && s && !s.startLine && !s.startColumn ? `app:${file}` : `app-inline:${file}`;
  }

  onEvent({ method, params: p }) {
    const t = Date.now();
    if (method === "Debugger.scriptParsed") {
      this.scripts.set(p.scriptId, { url: p.url, hasSourceURL: !!p.hasSourceURL, startLine: p.startLine, startColumn: p.startColumn });
    } else if (method === "Runtime.consoleAPICalled") {
      const frame = p.stackTrace?.callFrames?.[0];
      this.log.console.push({ t, type: p.type, source: this.source(frame?.scriptId, frame?.url), line: frame?.lineNumber, text: p.args.map((a) => a.value ?? a.description).join(" ") });
    } else if (method === "Runtime.exceptionThrown") {
      const d = p.exceptionDetails;
      const frame = d.stackTrace?.callFrames?.[0];
      this.log.console.push({ t, type: "exception", source: this.source(d.scriptId || frame?.scriptId, d.url || frame?.url), text: d.exception?.description || d.text });
    } else if (method === "Log.entryAdded") {
      this.log.console.push({ t, type: p.entry.level, source: `browser:${p.entry.source}`, text: p.entry.text, url: p.entry.url });
    } else if (method === "Network.requestWillBeSent") {
      const url = p.request.url;
      if (p.type === "Script") this.fetchedScripts.add(url);
      this.log.network.push({ t, method: p.request.method, type: p.type, url, local: this.isLocal(url) });
    } else if (method === "Page.screencastFrame") {
      this.client.send("Page.screencastFrameAck", { sessionId: p.sessionId }).catch(() => {});
      const name = `frames/${String(this.frames.length).padStart(5, "0")}.jpg`;
      fs.writeFileSync(path.join(this.dir, name), Buffer.from(p.data, "base64"));
      this.frames.push({ name, t: p.metadata.timestamp });
    }
  }

  recordInput(entry) {
    this.log.input.push({ t: Date.now(), ...entry });
  }

  // Reads every IndexedDB store of the app's origin through Chrome, independent of page code.
  async dumpIndexedDb(label) {
    const out = {};
    try {
      const securityOrigin = this.origin;
      const { databaseNames } = await this.client.send("IndexedDB.requestDatabaseNames", { securityOrigin });
      for (const databaseName of databaseNames) {
        const { databaseWithObjectStores: db } = await this.client.send("IndexedDB.requestDatabase", { securityOrigin, databaseName });
        for (const store of db.objectStores) {
          const { objectStoreDataEntries } = await this.client.send("IndexedDB.requestData",
            { securityOrigin, databaseName, objectStoreName: store.name, skipCount: 0, pageSize: 1000 });
          out[`${databaseName}/${store.name}`] = await Promise.all(objectStoreDataEntries.map((e) => this.toJson(e.value)));
        }
      }
    } catch (err) {
      out.error = err.message;
    }
    fs.writeFileSync(path.join(this.dir, `indexeddb-${label.replace(/[^\w-]/g, "_")}.json`), JSON.stringify(out, null, 2));
  }

  async toJson(remote) {
    if (!remote.objectId) return remote.value;
    const { result } = await this.client.send("Runtime.callFunctionOn",
      { objectId: remote.objectId, functionDeclaration: "function () { return JSON.parse(JSON.stringify(this)); }", returnByValue: true });
    return result.value;
  }

  writeVideoViewer() {
    const frames = JSON.stringify(this.frames);
    fs.writeFileSync(path.join(this.dir, "video.html"), `<!doctype html><meta charset="utf-8"><title>Run recording</title>
<body style="margin:0;background:#111;color:#ddd;font:14px sans-serif"><p style="padding:8px">Screencast recorded by Chrome
(${this.frames.length} frames). <button id="p">Pause</button> <input id="s" type="range" min="0" value="0" style="width:60%"></p>
<img id="f" style="display:block;margin:auto;max-width:100%"><script>
const F=${frames};let i=0,on=true;const img=document.getElementById("f"),s=document.getElementById("s");s.max=F.length-1;
const show=()=>{img.src=F[i].name;s.value=i};s.oninput=()=>{i=+s.value;show()};document.getElementById("p").onclick=(e)=>{on=!on;e.target.textContent=on?"Pause":"Play";if(on)tick()};
function tick(){if(!on||!F.length)return;show();const cur=F[i],next=F[i+1];i=next?i+1:0;setTimeout(tick,next?Math.min(1000,Math.max(30,(next.t-cur.t)*1000)):1500)}tick();
</script></body>`);
  }

  // Stops recording, writes the logs and a manifest that hashes every file; returns the manifest.
  async finish(meta) {
    await Promise.allSettled(this.pending); // failure-trace screenshots still being written (cdp-trace.js)
    if (this.video) await this.client.send("Page.stopScreencast").catch(() => {});
    await this.dumpIndexedDb("end");
    for (const [name, rows] of Object.entries(this.log)) {
      fs.writeFileSync(path.join(this.dir, `${name}.jsonl`), rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : ""));
    }
    if (this.video) this.writeVideoViewer();
    const { product, revision, userAgent } = await this.client.send("Browser.getVersion");
    const files = listFiles(this.dir).map((rel) => ({ path: rel, sha256: sha256File(path.join(this.dir, rel)) }));
    const manifest = {
      ...meta, chrome: { product, revision, userAgent, binaries: chromeBinaries(this.exe) }, node: process.version,
      counts: { console: this.log.console.length, network: this.log.network.length, external: this.log.network.filter((r) => !r.local).length,
        egress: this.log.egress.filter((r) => !r.refused).length, trustedInputs: this.log.input.length, frames: this.frames.length,
        failureTraces: (this.log.traces || []).length },
      files,
    };
    const text = JSON.stringify(manifest, null, 2);
    fs.writeFileSync(path.join(this.dir, "manifest.json"), text);
    return { ...manifest, manifestSha256: sha256(text) };
  }
}

function listFiles(dir, base = dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    return e.isDirectory() ? listFiles(full, base) : [path.relative(base, full).replace(/\\/g, "/")];
  }).filter((rel) => rel !== "manifest.json");
}

module.exports = { Evidence, sha256, sha256File, listFiles, HARNESS_PREFIX };
