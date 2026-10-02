#!/usr/bin/env node
/* pr-preview router — one port (6099) fans pr-<N>.truss.rewis out to the
   per-PR web dev server at 127.0.0.1:(6000+N). HTTP + WS upgrade. A PR with
   no tilt session up gets a plain 404 page. */
import http from "node:http";
import net from "node:net";

const MATCH = /^pr-(\d+)\.truss\.rewis$/i;

function prPort(host) {
  const m = (host ?? "").match(MATCH);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isInteger(n) || n < 1 || n > 9000) return null;
  return 6000 + n;
}

const DOWN = (n) =>
  `pr-${n}.truss.rewis — no preview running.\n` +
  `Start one: systemctl start truss-pr@${n} (tilt builds + serves the PR's branch).\n`;

const srv = http.createServer((req, res) => {
  /* caddy's on-demand ask endpoint: only pr-<digits>.truss.rewis may mint */
  if (req.url?.startsWith("/ask")) {
    const domain = new URL(req.url, "http://x").searchParams.get("domain") ?? "";
    res.writeHead(prPort(domain) != null ? 200 : 400).end();
    return;
  }
  const port = prPort(req.headers.host);
  if (port == null) {
    res.writeHead(400).end("unknown preview host\n");
    return;
  }
  const upstream = http.request(
    { host: "127.0.0.1", port, path: req.url, method: req.method, headers: req.headers },
    (up) => {
      res.writeHead(up.statusCode ?? 502, up.headers);
      up.pipe(res);
    },
  );
  upstream.on("error", () => {
    res.writeHead(404, { "content-type": "text/plain" }).end(DOWN(port - 6000));
  });
  req.pipe(upstream);
});

/* WS: vite HMR + the app's /events bus both upgrade — tunnel bytes raw */
srv.on("upgrade", (req, sock, head) => {
  const port = prPort(req.headers.host);
  if (port == null) {
    sock.destroy();
    return;
  }
  const up = net.connect(port, "127.0.0.1", () => {
    up.write(`${req.method} ${req.url} HTTP/${req.httpVersion}\r\n`);
    for (const [k, v] of Object.entries(req.headers)) up.write(`${k}: ${v}\r\n`);
    up.write("\r\n");
    if (head?.length) up.write(head);
    up.pipe(sock);
    sock.pipe(up);
  });
  up.on("error", () => sock.destroy());
});

srv.listen(6099, "127.0.0.1", () => console.log("pr-preview router on 127.0.0.1:6099"));
