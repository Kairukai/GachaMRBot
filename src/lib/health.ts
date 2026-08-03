import { createServer } from "node:http";

/**
 * Minimal HTTP endpoint, started only when PORT is set.
 *
 * Exists for platforms that require a bound port — Render marks a Web Service
 * deploy as failed without one, and its free tier sleeps a service that gets no
 * HTTP traffic. An external uptime pinger hitting this keeps the gateway
 * connection alive. On hosts that don't set PORT (Docker, panel hosts) nothing
 * is started at all.
 */
export function startHealthServer(isReady: () => boolean) {
  const port = Number(process.env.PORT);
  if (!Number.isFinite(port) || port <= 0) return;

  const server = createServer((req, res) => {
    const ready = isReady();
    res.writeHead(ready ? 200 : 503, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: ready ? "ok" : "starting", uptime: process.uptime() }));
  });

  server.listen(port, () => console.log(`health endpoint listening on :${port}`));
  // Never let a health check hold the process open on shutdown.
  server.unref();
}
