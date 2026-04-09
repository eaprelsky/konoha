/**
 * testbench-proxy.ts — Reverse proxy for konoha-testbench (closes #323)
 *
 * Forwards /testbench/* (port 3200) → http://127.0.0.1:3201/testbench/*
 * so callers only need one base URL (the main Konoha API).
 *
 * Auth: passes the same Bearer token through. Testbench validates it with
 * the same KONOHA_TOKEN, so no separate credential needed.
 */

import { Hono } from "hono";

const TESTBENCH_URL = process.env.TESTBENCH_URL || "http://127.0.0.1:3201";

const app = new Hono();

app.all("/testbench/*", async (c) => {
  const path = c.req.path; // e.g. /testbench/baselines
  const query = c.req.raw.url.includes("?") ? "?" + c.req.raw.url.split("?").slice(1).join("?") : "";
  const target = `${TESTBENCH_URL}${path}${query}`;

  // Forward headers — clone and strip Host to avoid upstream rejection
  const headers = new Headers(c.req.raw.headers);
  headers.delete("host");

  try {
    const upstream = await fetch(target, {
      method: c.req.method,
      headers,
      body: ["GET", "HEAD"].includes(c.req.method) ? undefined : c.req.raw.body,
      // @ts-ignore — Bun fetch supports duplex
      duplex: "half",
    });

    const body = await upstream.arrayBuffer();
    const respHeaders: Record<string, string> = {};
    upstream.headers.forEach((v, k) => {
      if (k.toLowerCase() !== "transfer-encoding") respHeaders[k] = v;
    });

    return new Response(body, {
      status: upstream.status,
      headers: respHeaders,
    });
  } catch (e: any) {
    const msg = e.message?.includes("ECONNREFUSED")
      ? "TestBench service unavailable (port 3201 not responding)"
      : e.message;
    return c.json({ error: msg }, 502);
  }
});

export default app;
