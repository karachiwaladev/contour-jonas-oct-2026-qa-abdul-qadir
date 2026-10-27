// Egress proxy for browser-verify. The app runs in a browser context whose proxy is this server, so
// every connection the app's context makes to anything but loopback passes through here and is
// logged, whichever page, frame, worker, service worker or WebSocket made it; WebRTC is forced onto
// the proxy too (--force-webrtc-ip-handling-policy). Unlike the page-level CDP network log, nothing
// running in the page can route around it. Traffic is forwarded unchanged, so apps behave as usual.
//
// Some connections are refused, so no byte of them leaves the machine; they're logged as refused:
//   - everything until proxy.open() is called, right before the app is navigated to. Chrome warms up
//     connections when a tab is created, and a pooled one could otherwise carry later app requests
//     without a new CONNECT being logged;
//   - Chrome's own services (CHROME_SERVICES), which a fresh profile calls at unpredictable times
//     (e.g. www.google.com/async/folae, AI-mode eligibility). The app can't use them either, and a
//     page request to them still shows as external in Chrome's page network log.

const http = require("http");
const net = require("net");

const CHROME_SERVICES = new Set([
  "www.google.com", "accounts.google.com", "clients2.google.com", "www.gstatic.com", "update.googleapis.com",
  "content-autofill.googleapis.com", "optimizationguide-pa.googleapis.com", "edgedl.me.gvt1.com", "redirector.gvt1.com",
]);

const hostOf = (target) => {
  try {
    return /^[a-z]+:\/\//i.test(target) ? new URL(target).hostname : target.replace(/:\d+$/, "").replace(/^\[|\]$/g, "");
  } catch {
    return target;
  }
};

// onRequest({ t, kind: "http" | "connect", method, target, refused? }) is called for every request.
function startEgressProxy(onRequest) {
  let open = false;
  const refusal = (target) => (!open ? { refused: "before-app" } : CHROME_SERVICES.has(hostOf(target).toLowerCase()) ? { refused: "chrome-service" } : {});
  const server = http.createServer((req, res) => {
    req.on("error", () => res.destroy());
    const why = refusal(req.url);
    onRequest({ t: Date.now(), kind: "http", method: req.method, target: req.url, ...why });
    if (why.refused) { res.statusCode = 403; return res.end(); }
    let upstream;
    try {
      upstream = http.request(req.url, { method: req.method, headers: req.headers }, (up) => {
        res.writeHead(up.statusCode, up.headers);
        up.pipe(res);
      });
    } catch {
      res.statusCode = 400;
      return res.end();
    }
    upstream.on("error", () => { res.statusCode = 502; res.end(); });
    req.pipe(upstream);
  });
  // Chrome resets connections it gives up on; an unhandled socket error would crash the whole run.
  server.on("clientError", (err, socket) => socket.destroy());
  server.on("connect", (req, socket, head) => {
    socket.on("error", () => socket.destroy());
    const why = refusal(req.url);
    onRequest({ t: Date.now(), kind: "connect", method: "CONNECT", target: req.url, ...why });
    if (why.refused) return socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
    const [host, port] = req.url.split(/:(?=\d+$)/);
    const upstream = net.connect(Number(port) || 443, host.replace(/^\[|\]$/g, ""), () => {
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    upstream.on("error", () => socket.end("HTTP/1.1 502 Bad Gateway\r\n\r\n"));
    socket.on("close", () => upstream.destroy());
  });
  server.open = () => { open = true; };
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

module.exports = { startEgressProxy };
