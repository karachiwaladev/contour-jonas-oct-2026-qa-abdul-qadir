// Egress proxy for browser-verify. The app runs in a browser context whose proxy is this server, so
// every connection the app's context makes to anything but loopback passes through here and is
// logged, whichever page, frame, worker, service worker or WebSocket made it; WebRTC is forced onto
// the proxy too (--force-webrtc-ip-handling-policy). Unlike the page-level CDP network log, nothing
// running in the page can route around it. Traffic is forwarded unchanged, so apps behave as usual.
//
// Until proxy.open() is called (right before the app is navigated to), connections are refused:
// Chrome preconnects to its search engine when a tab is created, and a pooled connection from then
// could otherwise carry later app requests without a new CONNECT being logged.

const http = require("http");
const net = require("net");

// onRequest({ t, kind: "http" | "connect", method, target, refused? }) is called for every request.
function startEgressProxy(onRequest) {
  let open = false;
  const server = http.createServer((req, res) => {
    onRequest({ t: Date.now(), kind: "http", method: req.method, target: req.url, ...(open ? {} : { refused: true }) });
    if (!open) { res.statusCode = 403; return res.end(); }
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
  server.on("connect", (req, socket, head) => {
    onRequest({ t: Date.now(), kind: "connect", method: "CONNECT", target: req.url, ...(open ? {} : { refused: true }) });
    if (!open) return socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
    const [host, port] = req.url.split(/:(?=\d+$)/);
    const upstream = net.connect(Number(port) || 443, host.replace(/^\[|\]$/g, ""), () => {
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    upstream.on("error", () => socket.end("HTTP/1.1 502 Bad Gateway\r\n\r\n"));
    socket.on("error", () => upstream.destroy());
  });
  server.open = () => { open = true; };
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

module.exports = { startEgressProxy };
