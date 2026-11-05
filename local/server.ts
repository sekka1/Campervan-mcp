/** Serves the local src/index.ts worker on http://localhost:8787 against dev D1/Vectorize. */
import http from "node:http";
import worker from "../src/index.js";
import { makeLocalEnv } from "./env.js";

const env = makeLocalEnv();
const port = Number(process.env["PORT"] ?? 8787);

http
  .createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = chunks.length ? Buffer.concat(chunks) : undefined;
    const request = new Request(`http://localhost:${port}${req.url}`, {
      method: req.method,
      headers: req.headers as Record<string, string>,
      body: req.method === "GET" || req.method === "HEAD" ? undefined : body,
    });
    try {
      const r = await worker.fetch(request, env, { waitUntil() {}, passThroughOnException() {} } as never);
      res.writeHead(r.status, Object.fromEntries(r.headers));
      res.end(Buffer.from(await r.arrayBuffer()));
    } catch (e) {
      console.error(e);
      res.writeHead(500).end(String(e));
    }
  })
  .listen(port, () => console.log(`local MCP worker on http://localhost:${port}`));
