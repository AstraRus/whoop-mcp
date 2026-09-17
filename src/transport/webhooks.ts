/**
 * WHOOP webhook receiver (opt-in: WHOOP_WEBHOOKS=1).
 *
 * WHOOP POSTs a small JSON event ({user_id, id, type, trace_id}) when a
 * recovery, workout or sleep is created, updated or deleted. The receiver
 * verifies the signature and drops the cached WHOOP responses the event can
 * make stale, so edits show up without waiting for cache lifetimes. It never
 * fetches from WHOOP and never stores the event.
 *
 * Verification (in order): raw body of at most 16 KB (413), a millisecond
 * X-WHOOP-Signature-Timestamp within [now - 2 h, now + 5 min] and an
 * X-WHOOP-Signature equal to base64(HMAC-SHA256(client secret,
 * timestamp + raw body)) under WHOOP_CLIENT_SECRET or
 * WHOOP_CLIENT_SECRET_PREVIOUS (401), then the JSON payload (400). A trace_id
 * seen in the last 2 hours is acknowledged without invalidating again.
 *
 * Logs carry the event type, whether it was a duplicate and how many cache
 * entries were dropped: never user_id, id, the body or a signature.
 *
 * Routing, the per-IP rate limit and method checks live in http.ts.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";

import type { MemoryCache } from "../cache/memory-cache.js";
import type { Logger } from "../logging/logger.js";
import type { RuntimeStatus } from "../runtime-status.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Path WHOOP delivers webhooks to. */
export const WEBHOOK_PATH = "/webhooks/whoop";

/** Largest accepted webhook body. */
export const WEBHOOK_MAX_BODY_BYTES = 16 * 1024;

/** Webhook requests accepted per IP per minute. */
export const WEBHOOK_RATE_LIMIT_PER_MINUTE = 120;

/** Oldest accepted signature timestamp, relative to now. */
export const WEBHOOK_MAX_AGE_MS = 2 * 60 * 60 * 1000;

/** Furthest accepted signature timestamp in the future (clock skew). */
export const WEBHOOK_MAX_FUTURE_SKEW_MS = 5 * 60 * 1000;

/** trace_ids remembered for duplicate detection. */
export const WEBHOOK_TRACE_CACHE_SIZE = 1000;

/** How long a trace_id is remembered. */
export const WEBHOOK_TRACE_TTL_MS = 2 * 60 * 60 * 1000;

/** Bytes in an HMAC-SHA256 signature. */
const SIGNATURE_BYTES = 32;

const TIMESTAMP_PATTERN = /^\d{10,16}$/;

/** Base64 of exactly 32 bytes (43 characters plus optional padding). */
const SIGNATURE_PATTERN = /^[A-Za-z0-9+/]{43}=?$/;

// ---------------------------------------------------------------------------
// Payload
// ---------------------------------------------------------------------------

/** WHOOP webhook event types. */
export const WHOOP_WEBHOOK_TYPES = [
  "recovery.updated",
  "recovery.deleted",
  "workout.updated",
  "workout.deleted",
  "sleep.updated",
  "sleep.deleted",
] as const;

export type WhoopWebhookType = (typeof WHOOP_WEBHOOK_TYPES)[number];

/** A WHOOP webhook event (unknown extra fields are ignored). */
export const whoopWebhookPayloadSchema = z.object({
  user_id: z.number().int(),
  id: z.union([z.string().max(64), z.number()]),
  type: z.enum(WHOOP_WEBHOOK_TYPES),
  trace_id: z.string().min(1).max(128),
});

export type WhoopWebhookPayload = z.infer<typeof whoopWebhookPayloadSchema>;

// ---------------------------------------------------------------------------
// Cache invalidation
// ---------------------------------------------------------------------------

/** WHOOP collection endpoints whose cached responses an event type can make stale. */
const STALE_ENDPOINTS: Record<"recovery" | "workout" | "sleep", readonly string[]> = {
  // A workout changes its cycle's strain.
  workout: ["/v2/activity/workout", "/v2/cycle"],
  // A sleep moves cycle boundaries (a cycle starts at sleep onset) and is
  // scored into the recovery.
  sleep: ["/v2/activity/sleep", "/v2/cycle", "/v2/recovery"],
  recovery: ["/v2/recovery"],
};

/**
 * Cache key prefixes an event of `type` invalidates: the history chunks
 * (`HIST:v1:<endpoint>`) and client GET responses (`GET:<endpoint>`) of every
 * affected endpoint. Profile and body measurement keys are never included.
 */
export function webhookInvalidationPrefixes(type: WhoopWebhookType): string[] {
  const kind = type.slice(0, type.indexOf(".")) as keyof typeof STALE_ENDPOINTS;
  return STALE_ENDPOINTS[kind].flatMap((endpoint) => [`HIST:v1:${endpoint}`, `GET:${endpoint}`]);
}

/** A recovery read through its cycle: GET /v2/cycle/{id}/recovery. */
const CYCLE_RECOVERY_KEY = /^GET:\/v2\/cycle\/[^/?]+\/recovery(?:\?|$)/;

/**
 * The cache-key predicate for an event of `type`: a key matches a prefix when
 * the prefix ends the key or is followed by ':' (chunk), '?' (query) or '/'
 * (a record under the endpoint). Recovery events also match recoveries read
 * through their cycle.
 */
export function webhookInvalidationPredicate(type: WhoopWebhookType): (key: string) => boolean {
  const prefixes = webhookInvalidationPrefixes(type);
  const recovery = type.startsWith("recovery.");
  return (key: string): boolean => {
    for (const prefix of prefixes) {
      if (!key.startsWith(prefix)) continue;
      const next = key.charAt(prefix.length);
      if (next === "" || next === ":" || next === "?" || next === "/") return true;
    }
    return recovery && CYCLE_RECOVERY_KEY.test(key);
  };
}

// ---------------------------------------------------------------------------
// Signature verification
// ---------------------------------------------------------------------------

/** Why a delivery failed verification, or "ok". */
export type WebhookVerification = "ok" | "invalid_timestamp" | "invalid_signature";

/** The first value of a header. */
function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * Verify a delivery: the timestamp (epoch ms, 10-16 digits) must lie within
 * [now - WEBHOOK_MAX_AGE_MS, now + WEBHOOK_MAX_FUTURE_SKEW_MS], and the
 * signature must be the base64 HMAC-SHA256 of timestamp + raw body under one
 * of `secrets` (compared in constant time).
 */
export function verifyWhoopWebhook(
  rawBody: Buffer,
  timestamp: string | undefined,
  signature: string | undefined,
  secrets: readonly string[],
  nowMs: number
): WebhookVerification {
  if (timestamp === undefined || !TIMESTAMP_PATTERN.test(timestamp)) return "invalid_timestamp";
  const timestampMs = Number(timestamp);
  if (
    timestampMs < nowMs - WEBHOOK_MAX_AGE_MS ||
    timestampMs > nowMs + WEBHOOK_MAX_FUTURE_SKEW_MS
  ) {
    return "invalid_timestamp";
  }
  if (signature === undefined || !SIGNATURE_PATTERN.test(signature)) return "invalid_signature";
  const provided = Buffer.from(signature, "base64");
  if (provided.length !== SIGNATURE_BYTES) return "invalid_signature";

  let valid = false;
  for (const secret of secrets) {
    if (secret.length === 0) continue;
    const expected = createHmac("sha256", Buffer.from(secret, "utf8"))
      .update(Buffer.from(timestamp, "utf8"))
      .update(rawBody)
      .digest();
    // Every secret is checked, so timing does not reveal which one matched.
    if (timingSafeEqual(expected, provided)) valid = true;
  }
  return valid ? "ok" : "invalid_signature";
}

// ---------------------------------------------------------------------------
// Duplicate detection
// ---------------------------------------------------------------------------

/** A bounded, time-limited set of recently seen trace_ids (oldest evicted first). */
export class TraceIdCache {
  private readonly seen = new Map<string, number>();

  constructor(
    private readonly maxEntries = WEBHOOK_TRACE_CACHE_SIZE,
    private readonly ttlMs = WEBHOOK_TRACE_TTL_MS
  ) {}

  /** True when `traceId` was remembered within the TTL; otherwise remembers it and returns false. */
  checkAndAdd(traceId: string, nowMs: number): boolean {
    const expiresAt = this.seen.get(traceId);
    if (expiresAt !== undefined && expiresAt > nowMs) return true;
    this.seen.delete(traceId);
    this.seen.set(traceId, nowMs + this.ttlMs);
    while (this.seen.size > this.maxEntries) {
      const oldest = this.seen.keys().next().value;
      if (oldest === undefined) break;
      this.seen.delete(oldest);
    }
    return false;
  }

  get size(): number {
    return this.seen.size;
  }
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/** Options for {@link createWhoopWebhookHandler}. */
export interface WhoopWebhookOptions {
  /**
   * Signing secrets, tried in order: WHOOP_CLIENT_SECRET, then
   * WHOOP_CLIENT_SECRET_PREVIOUS while a rotation is in progress. Empty
   * strings are ignored.
   */
  secrets: readonly string[];
  /** The process-wide cache whose WHOOP responses events invalidate. */
  cache: Pick<MemoryCache, "deleteWhere">;
  /** Records the time of each new verified event. */
  runtime?: Pick<RuntimeStatus, "recordWebhook">;
  logger?: Logger;
  /** Clock in epoch ms (tests). Default Date.now. */
  now?: () => number;
}

/** Handles one POST to {@link WEBHOOK_PATH} (after routing and rate limiting). */
export type WhoopWebhookHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  requestId: string
) => Promise<void>;

function sendJson(res: ServerResponse, status: number, data: unknown): void {
  if (res.headersSent || res.writableEnded) return;
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
  });
  res.end(body);
}

function sendNoContent(res: ServerResponse): void {
  if (res.headersSent || res.writableEnded) return;
  res.writeHead(204, { "Cache-Control": "no-store" });
  res.end();
}

/**
 * Read the raw body up to `maxBytes`. A larger body (by Content-Length or as
 * it streams) resolves "too_large"; the rest of it is drained and discarded.
 */
export function readRawBody(req: IncomingMessage, maxBytes: number): Promise<Buffer | "too_large"> {
  return new Promise((resolve, reject) => {
    const declared = req.headers["content-length"];
    if (declared !== undefined && /^\d+$/.test(declared) && Number(declared) > maxBytes) {
      req.resume();
      resolve("too_large");
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    req.on("data", (chunk: Buffer) => {
      if (settled) return;
      size += chunk.length;
      if (size > maxBytes) {
        settled = true;
        chunks.length = 0;
        resolve("too_large");
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks));
    });
    req.on("error", (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
    // Aborted before the end: settle, so the handler does not wait forever.
    req.on("close", () => {
      if (settled) return;
      settled = true;
      reject(new Error("Request aborted"));
    });
  });
}

/**
 * Build the webhook handler. Responses: 204 (processed or duplicate), 413
 * (body too large), 401 {error: 'invalid_signature'} (timestamp or signature),
 * 400 {error: 'invalid_payload'} (JSON or schema).
 *
 * @throws Error when no non-empty secret is configured
 */
export function createWhoopWebhookHandler(options: WhoopWebhookOptions): WhoopWebhookHandler {
  const secrets = options.secrets.filter((secret) => secret.length > 0);
  if (secrets.length === 0) {
    throw new Error("WHOOP webhooks need WHOOP_CLIENT_SECRET to verify signatures.");
  }
  const now = options.now ?? ((): number => Date.now());
  const traces = new TraceIdCache();
  const logger = options.logger;

  const reject = (reason: string, requestId: string): void => {
    logger?.warn("whoop webhook rejected", { reason, requestId });
  };

  return async (req, res, requestId) => {
    let raw: Buffer | "too_large";
    try {
      raw = await readRawBody(req, WEBHOOK_MAX_BODY_BYTES);
    } catch {
      reject("body_read_failed", requestId);
      sendJson(res, 400, { error: "invalid_payload" });
      return;
    }
    if (raw === "too_large") {
      reject("body_too_large", requestId);
      res.setHeader("Connection", "close");
      sendJson(res, 413, { error: "payload_too_large" });
      return;
    }

    const verification = verifyWhoopWebhook(
      raw,
      headerValue(req.headers["x-whoop-signature-timestamp"]),
      headerValue(req.headers["x-whoop-signature"]),
      secrets,
      now()
    );
    if (verification !== "ok") {
      reject(verification, requestId);
      sendJson(res, 401, { error: "invalid_signature" });
      return;
    }

    let payload: WhoopWebhookPayload;
    try {
      const parsed = whoopWebhookPayloadSchema.safeParse(JSON.parse(raw.toString("utf8")));
      if (!parsed.success) throw new Error("invalid payload");
      payload = parsed.data;
    } catch {
      reject("invalid_payload", requestId);
      sendJson(res, 400, { error: "invalid_payload" });
      return;
    }

    if (traces.checkAndAdd(payload.trace_id, now())) {
      logger?.info("whoop webhook", {
        type: payload.type,
        duplicate: true,
        invalidated: 0,
        requestId,
      });
      sendNoContent(res);
      return;
    }

    const invalidated = options.cache.deleteWhere(webhookInvalidationPredicate(payload.type));
    options.runtime?.recordWebhook();
    logger?.info("whoop webhook", { type: payload.type, duplicate: false, invalidated, requestId });
    sendNoContent(res);
  };
}
