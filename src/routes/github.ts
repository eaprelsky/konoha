/**
 * github.ts — GitHub webhook receiver.
 * POST /webhooks/github — no auth, HMAC-SHA256 verified.
 * Publishes events to Redis stream "github:events" and routes relevant
 * events to agents via Konoha bus.
 */
import { Hono } from "hono";
import { createHmac, timingSafeEqual } from "crypto";
import { redis } from "../redis";
import { sendMessage } from "../redis";
import { createLogger } from "../logger";
import { dispatchGithubIssueEvent } from "../adapters/github";
import { normalizeGithubIssueEvent } from "../github-issue-events";

const log = createLogger("routes:github");

const router = new Hono();

const GITHUB_EVENTS_STREAM = "github:events";
const GITHUB_EVENTS_MAX_LEN = 5000;

// Routed events → agent mapping
// New/reopened issues → naruto for triage; others can be added here
const ISSUE_ROUTE_AGENT = "naruto";

function verifySignature(body: string, signature: string, secret: string): boolean {
  if (!signature.startsWith("sha256=")) return false;
  const expected = createHmac("sha256", secret).update(body).digest("hex");
  const sigBuf = Buffer.from(signature.slice(7), "hex");
  const expBuf = Buffer.from(expected, "hex");
  if (sigBuf.length !== expBuf.length) return false;
  try { return timingSafeEqual(sigBuf, expBuf); } catch { return false; }
}

async function publishGithubEvent(
  eventType: string,
  action: string,
  repo: string,
  sender: string,
  number: number | null,
  title: string | null,
  url: string | null,
  rawPayload: string,
): Promise<string> {
  const fields: string[] = [
    "event", eventType,
    "action", action,
    "repo", repo,
    "sender", sender,
    "timestamp", new Date().toISOString(),
  ];
  if (number != null) fields.push("number", String(number));
  if (title)  fields.push("title", title);
  if (url)    fields.push("url", url);
  // Store trimmed payload (first 2000 chars to avoid huge entries)
  fields.push("payload", rawPayload.slice(0, 2000));

  const id = await redis.xadd(
    GITHUB_EVENTS_STREAM,
    "MAXLEN", "~", GITHUB_EVENTS_MAX_LEN,
    "*",
    ...fields,
  );
  return id as string;
}

router.post("/webhooks/github", async (c) => {
  const secret = process.env.GITHUB_WEBHOOK_SECRET;

  // Read raw body for HMAC verification
  const rawBody = await c.req.text();

  // Verify signature if secret is configured
  if (secret) {
    const sig = c.req.header("x-hub-signature-256") || "";
    if (!verifySignature(rawBody, sig, secret)) {
      log.warn("invalid webhook signature");
      return c.json({ error: "Invalid signature" }, 401);
    }
  }

  const eventType = c.req.header("x-github-event") || "unknown";
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return c.json({ error: "Invalid JSON" }, 400);
  }

  const action   = (payload.action as string) || "";
  const repo     = ((payload.repository as any)?.full_name as string) || "";
  const sender   = ((payload.sender as any)?.login as string) || "";
  const issue    = payload.issue as any;
  const pr       = payload.pull_request as any;
  const number   = issue?.number ?? pr?.number ?? null;
  const title    = issue?.title ?? pr?.title ?? null;
  const htmlUrl  = issue?.html_url ?? pr?.html_url ?? null;

  // Publish to Redis stream
  const streamId = await publishGithubEvent(
    eventType, action, repo, sender, number, title, htmlUrl, rawBody,
  ).catch(e => { log.error("stream publish error", { error: e.message }); return ""; });

  log.info("webhook received", { event: eventType, action, repo, number, stream: streamId });

  const normalized = normalizeGithubIssueEvent(eventType, payload);
  if (normalized) {
    const delivered = dispatchGithubIssueEvent(normalized);
    if (delivered > 0) {
      log.info("dispatched normalized github issue event", { type: normalized.type, delivered });
    }
  }

  // Route to agents
  try {
    if (eventType === "issues" && (action === "opened" || action === "reopened")) {
      const labels = (issue?.labels as any[] || []).map((l: any) => l.name).join(", ");
      const text = [
        `[GitHub] Новый issue #${number}: ${title}`,
        `Repo: ${repo} | Автор: ${sender}`,
        labels ? `Labels: ${labels}` : "",
        htmlUrl ? `URL: ${htmlUrl}` : "",
      ].filter(Boolean).join("\n");
      await sendMessage({ from: "github", to: ISSUE_ROUTE_AGENT, type: "event", text });
      log.info("routed issue to agent", { number, agent: ISSUE_ROUTE_AGENT });
    } else if (eventType === "issues" && action === "labeled") {
      const label = (payload.label as any)?.name || "";
      // Only route priority labels (skip noise)
      if (label.startsWith("P0") || label.startsWith("P1")) {
        const text = [
          `[GitHub] Issue #${number} помечен "${label}": ${title}`,
          `Repo: ${repo} | ${htmlUrl || ""}`,
        ].filter(Boolean).join("\n");
        await sendMessage({ from: "github", to: ISSUE_ROUTE_AGENT, type: "event", text });
      }
    }
    // pull_request events: log only — no automatic routing to avoid loops
  } catch (e: any) {
    log.error("routing error", { error: e.message });
  }

  return c.json({ ok: true, event: eventType, action, stream_id: streamId });
});

export default router;
