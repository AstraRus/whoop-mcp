import http from "node:http";
import { createHmac, randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";

import { MemoryCache } from "../../src/cache/memory-cache.js";
import type { Logger } from "../../src/logging/logger.js";
import { createRuntimeStatus } from "../../src/runtime-status.js";
import { createHttpServer, type HttpServerResult } from "../../src/transport/http.js";
import {
  TraceIdCache,
  WEBHOOK_MAX_BODY_BYTES,
  WEBHOOK_PATH,
  WEBHOOK_RATE_LIMIT_PER_MINUTE,
  createWhoopWebhookHandler,
  verifyWhoopWebhook,
  webhookInvalidationPredicate,
  webhookInvalidationPrefixes,
  type WhoopWebhookType,
} from "../../src/transport/webhooks.js";

const SECRET = "whoop-client-secret-current";
const PREVIOUS_SECRET = "whoop-client-secret-previous";
const AUTH_TOKEN = "static-token-0123456789abcdef";
const USER_ID = 90817263;
const RECORD_ID = "5b7c9d1e-2f3a-4b5c-8d6e-7f8091a2b3c4";

/** Every cache key shape the server writes, by what it holds. */
const KEYS = {
  workoutHistory: "HIST:v1:/v2/activity/workout:1780000000000",
  workoutList: "GET:/v2/activity/workout?limit=25&start=2026-09-14T00%3A00%3A00.000Z",
  workoutById: `GET:/v2/activity/workout/${RECORD_ID}`,
  cycleHistory: "HIST:v1:/v2/cycle:1780000000000:open",
  cycleList: "GET:/v2/cycle?limit=1",
  cycleSleep: "GET:/v2/cycle/81003/sleep",
  cycleRecovery: "GET:/v2/cycle/81003/recovery",
  sleepHistory: "HIST:v1:/v2/activity/sleep:1780000000000",
  sleepList: "GET:/v2/activity/sleep?limit=1",
  recoveryHistory: "HIST:v1:/v2/recovery:1780000000000",
  recoveryList: "GET:/v2/recovery?limit=1",
  profile: "GET:/v2/user/profile/basic",
  body: "GET:/v2/user/measurement/body",
} as const;

function filledCache(): MemoryCache {
  const cache = new MemoryCache({ maxEntries: 100, defaultTtlMs: 3_600_000 });
  for (const key of Object.values(KEYS)) cache.set(key, { cached: key });
  return cache;
}

function present(cache: MemoryCache): string[] {
  return Object.entries(KEYS)
    .filter(([, key]) => cache.has(key))
    .map(([name]) => name)
    .sort();
}

function sign(timestamp: string, body: string, secret = SECRET): string {
  return createHmac("sha256", secret)
    .update(timestamp + body)
    .digest("base64");
}

function event(type: WhoopWebhookType, traceId: string = randomUUID()): string {
  return JSON.stringify({ user_id: USER_ID, id: RECORD_ID, type, trace_id: traceId });
}

function silentLogger(): Logger & { [K in keyof Logger]: ReturnType<typeof vi.fn> } {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

// ---------------------------------------------------------------------------
// Units
// ---------------------------------------------------------------------------

describe("verifyWhoopWebhook", () => {
  const now = Date.parse("2026-09-17T10:00:00Z");
  const body = Buffer.from(event("workout.updated", "trace-1"));
  const ts = String(now);

  it("accepts base64(HMAC-SHA256(secret, timestamp + raw body))", () => {
    expect(verifyWhoopWebhook(body, ts, sign(ts, body.toString()), [SECRET], now)).toBe("ok");
  });

  it("accepts the previous secret while a rotation is in progress", () => {
    const signature = sign(ts, body.toString(), PREVIOUS_SECRET);
    expect(verifyWhoopWebhook(body, ts, signature, [SECRET, PREVIOUS_SECRET], now)).toBe("ok");
    expect(verifyWhoopWebhook(body, ts, signature, [SECRET], now)).toBe("invalid_signature");
  });

  it("rejects a signature over a different body, timestamp or secret", () => {
    const tampered = Buffer.from(body.toString().replace("workout", "sleep"));
    expect(verifyWhoopWebhook(tampered, ts, sign(ts, body.toString()), [SECRET], now)).toBe(
      "invalid_signature"
    );
    expect(
      verifyWhoopWebhook(body, String(now + 1), sign(ts, body.toString()), [SECRET], now)
    ).toBe("invalid_signature");
    expect(verifyWhoopWebhook(body, ts, sign(ts, body.toString(), "other"), [SECRET], now)).toBe(
      "invalid_signature"
    );
  });

  it.each([
    ["missing", undefined],
    ["short", Buffer.alloc(16).toString("base64")],
    ["long", Buffer.alloc(48).toString("base64")],
    ["garbage", "not base64 at all!!"],
    ["hex", createHmac("sha256", SECRET).update(ts).digest("hex")],
  ])("rejects a %s signature", (_label, signature) => {
    expect(verifyWhoopWebhook(body, ts, signature, [SECRET], now)).toBe("invalid_signature");
  });

  it.each([
    ["3 hours old", String(now - 3 * 3_600_000)],
    ["10 minutes in the future", String(now + 10 * 60_000)],
    ["in seconds", String(Math.floor(now / 1000))],
    ["not digits", "2026-09-17T10:00:00Z"],
    ["missing", undefined],
  ])("rejects a timestamp %s", (_label, timestamp) => {
    const signature = sign(timestamp ?? "", body.toString());
    expect(verifyWhoopWebhook(body, timestamp, signature, [SECRET], now)).toBe("invalid_timestamp");
  });

  it("accepts timestamps at the edges of the window", () => {
    for (const edge of [now - 2 * 3_600_000, now + 5 * 60_000]) {
      const timestamp = String(edge);
      expect(
        verifyWhoopWebhook(body, timestamp, sign(timestamp, body.toString()), [SECRET], now)
      ).toBe("ok");
    }
  });

  it("ignores empty secrets", () => {
    expect(verifyWhoopWebhook(body, ts, sign(ts, body.toString(), ""), ["", SECRET], now)).toBe(
      "invalid_signature"
    );
  });
});

describe("webhook cache invalidation", () => {
  function invalidated(type: WhoopWebhookType): string[] {
    const cache = filledCache();
    const before = present(cache);
    cache.deleteWhere(webhookInvalidationPredicate(type));
    const after = new Set(present(cache));
    return before.filter((name) => !after.has(name)).sort();
  }

  it("workout events drop workout and cycle responses only", () => {
    expect(webhookInvalidationPrefixes("workout.updated")).toEqual([
      "HIST:v1:/v2/activity/workout",
      "GET:/v2/activity/workout",
      "HIST:v1:/v2/cycle",
      "GET:/v2/cycle",
    ]);
    expect(invalidated("workout.deleted")).toEqual(
      [
        "workoutHistory",
        "workoutList",
        "workoutById",
        "cycleHistory",
        "cycleList",
        "cycleSleep",
        "cycleRecovery",
      ].sort()
    );
  });

  it("sleep events drop sleep, cycle and recovery responses", () => {
    expect(invalidated("sleep.updated")).toEqual(
      [
        "cycleHistory",
        "cycleList",
        "cycleSleep",
        "cycleRecovery",
        "sleepHistory",
        "sleepList",
        "recoveryHistory",
        "recoveryList",
      ].sort()
    );
  });

  it("recovery events drop recovery responses, including recoveries read through a cycle", () => {
    expect(invalidated("recovery.updated")).toEqual(
      ["cycleRecovery", "recoveryHistory", "recoveryList"].sort()
    );
  });

  it("never matches a longer endpoint name sharing the prefix", () => {
    const predicate = webhookInvalidationPredicate("workout.updated");
    expect(predicate("GET:/v2/cycles")).toBe(false);
    expect(predicate("GET:/v2/activity/workouts?limit=1")).toBe(false);
    expect(predicate("GET:/v2/cycle")).toBe(true);
  });
});

describe("TraceIdCache", () => {
  it("reports duplicates within the TTL and forgets them afterwards", () => {
    const traces = new TraceIdCache(10, 1000);
    expect(traces.checkAndAdd("a", 0)).toBe(false);
    expect(traces.checkAndAdd("a", 999)).toBe(true);
    expect(traces.checkAndAdd("a", 1000)).toBe(false);
  });

  it("keeps at most maxEntries, evicting the oldest", () => {
    const traces = new TraceIdCache(3, 60_000);
    for (const id of ["a", "b", "c", "d"]) traces.checkAndAdd(id, 0);
    expect(traces.size).toBe(3);
    expect(traces.checkAndAdd("a", 1)).toBe(false);
    expect(traces.checkAndAdd("d", 1)).toBe(true);
  });
});

describe("createWhoopWebhookHandler", () => {
  it("refuses to start without a secret", () => {
    expect(() => createWhoopWebhookHandler({ secrets: ["", ""], cache: filledCache() })).toThrow(
      /WHOOP_CLIENT_SECRET/
    );
  });
});

// ---------------------------------------------------------------------------
// Over HTTP
// ---------------------------------------------------------------------------

describe("POST /webhooks/whoop", () => {
  let result: HttpServerResult | null = null;

  afterEach(async () => {
    if (result) {
      await result.close();
      result = null;
    }
  });

  async function start(
    options: {
      cache?: MemoryCache;
      logger?: Logger;
      runtime?: ReturnType<typeof createRuntimeStatus>;
      webhooks?: boolean;
    } = {}
  ): Promise<{ baseUrl: string; cache: MemoryCache }> {
    const cache = options.cache ?? filledCache();
    result = await createHttpServer({
      authToken: AUTH_TOKEN,
      port: 0,
      host: "127.0.0.1",
      sseReauthIntervalMs: 0,
      ...(options.logger !== undefined ? { logger: options.logger } : {}),
      ...(options.webhooks === false
        ? {}
        : {
            webhooks: {
              secrets: [SECRET, PREVIOUS_SECRET],
              cache,
              ...(options.runtime !== undefined ? { runtime: options.runtime } : {}),
              ...(options.logger !== undefined ? { logger: options.logger } : {}),
            },
          }),
    });
    const addr = result.server.address();
    if (!addr || typeof addr === "string") throw new Error("no port");
    return { baseUrl: `http://127.0.0.1:${addr.port}`, cache };
  }

  function deliver(
    baseUrl: string,
    body: string,
    headers: Partial<Record<"timestamp" | "signature", string>> = {}
  ): Promise<Response> {
    const timestamp = headers.timestamp ?? String(Date.now());
    return fetch(`${baseUrl}${WEBHOOK_PATH}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-whoop-signature-timestamp": timestamp,
        "x-whoop-signature": headers.signature ?? sign(timestamp, body),
      },
      body,
    });
  }

  it("verifies the signature, invalidates workout and cycle keys and keeps profile and body", async () => {
    const logger = silentLogger();
    const runtime = createRuntimeStatus({ version: "0", commit: null, privacyMode: "standard" });
    const { baseUrl, cache } = await start({ logger, runtime });
    const body = event("workout.updated");
    const res = await deliver(baseUrl, body);
    expect(res.status).toBe(204);
    expect(await res.text()).toBe("");
    expect(present(cache)).toEqual(
      ["body", "profile", "recoveryHistory", "recoveryList", "sleepHistory", "sleepList"].sort()
    );
    expect(runtime.snapshot().webhooks.last_event_at).not.toBeNull();
    expect(logger.info).toHaveBeenCalledWith("whoop webhook", {
      type: "workout.updated",
      duplicate: false,
      invalidated: 7,
      requestId: res.headers.get("x-request-id"),
    });
    const logged = JSON.stringify([logger.info.mock.calls, logger.warn.mock.calls]);
    expect(logged).not.toContain(String(USER_ID));
    expect(logged).not.toContain(RECORD_ID);
  });

  it("accepts an event signed with WHOOP_CLIENT_SECRET_PREVIOUS", async () => {
    const { baseUrl, cache } = await start();
    const body = event("recovery.updated");
    const timestamp = String(Date.now());
    const res = await deliver(baseUrl, body, {
      timestamp,
      signature: sign(timestamp, body, PREVIOUS_SECRET),
    });
    expect(res.status).toBe(204);
    expect(cache.has(KEYS.recoveryList)).toBe(false);
    expect(cache.has(KEYS.cycleList)).toBe(true);
  });

  it.each([
    ["a wrong signature", { signature: sign(String(Date.now()), "{}") }],
    ["a short signature", { signature: Buffer.alloc(20).toString("base64") }],
    ["a garbage signature", { signature: "%%%garbage%%%" }],
    ["a timestamp 3 hours old", { timestamp: String(Date.now() - 3 * 3_600_000) }],
    ["a timestamp 10 minutes in the future", { timestamp: String(Date.now() + 10 * 60_000) }],
  ])("answers 401 for %s and invalidates nothing", async (_label, headers) => {
    const logger = silentLogger();
    const { baseUrl, cache } = await start({ logger });
    const body = event("sleep.updated");
    const res = await deliver(baseUrl, body, headers);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "invalid_signature" });
    expect(present(cache)).toHaveLength(Object.keys(KEYS).length);
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain(RECORD_ID);
  });

  it("acknowledges a duplicate trace_id with 204 without invalidating again", async () => {
    const logger = silentLogger();
    const { baseUrl, cache } = await start({ logger });
    const body = event("workout.updated", "trace-duplicate");
    expect((await deliver(baseUrl, body)).status).toBe(204);
    cache.set(KEYS.workoutList, "refetched after the first event");
    const again = await deliver(baseUrl, body);
    expect(again.status).toBe(204);
    expect(cache.get(KEYS.workoutList)).toBe("refetched after the first event");
    expect(logger.info).toHaveBeenLastCalledWith("whoop webhook", {
      type: "workout.updated",
      duplicate: true,
      invalidated: 0,
      requestId: again.headers.get("x-request-id"),
    });
  });

  it.each([
    ["malformed JSON", "{not json"],
    [
      "an unknown event type",
      JSON.stringify({ user_id: 1, id: "x", type: "cycle.updated", trace_id: "t" }),
    ],
    ["a missing trace_id", JSON.stringify({ user_id: 1, id: "x", type: "sleep.updated" })],
    [
      "a non-integer user_id",
      JSON.stringify({ user_id: 1.5, id: "x", type: "sleep.updated", trace_id: "t" }),
    ],
    [
      "an over-long id",
      JSON.stringify({ user_id: 1, id: "x".repeat(65), type: "sleep.updated", trace_id: "t" }),
    ],
  ])("answers 400 for %s after a valid signature", async (_label, body) => {
    const { baseUrl, cache } = await start();
    const res = await deliver(baseUrl, body);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_payload" });
    expect(present(cache)).toHaveLength(Object.keys(KEYS).length);
  });

  it("accepts a numeric record id", async () => {
    const { baseUrl } = await start();
    const body = JSON.stringify({
      user_id: USER_ID,
      id: 12345,
      type: "recovery.deleted",
      trace_id: "n",
    });
    expect((await deliver(baseUrl, body)).status).toBe(204);
  });

  it("answers 413 for a 20 KB body, declared or streamed, before verifying it", async () => {
    const { baseUrl, cache } = await start();
    const big = JSON.stringify({ padding: "x".repeat(20 * 1024) });
    expect(big.length).toBeGreaterThan(WEBHOOK_MAX_BODY_BYTES);
    const declared = await deliver(baseUrl, big);
    expect(declared.status).toBe(413);

    const url = new URL(baseUrl);
    const streamed = await new Promise<number>((resolve, reject) => {
      const req = http.request(
        {
          hostname: url.hostname,
          port: url.port,
          path: WEBHOOK_PATH,
          method: "POST",
          headers: { "content-type": "application/json", "transfer-encoding": "chunked" },
        },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        }
      );
      req.on("error", reject);
      for (let i = 0; i < 20; i++) req.write("x".repeat(1024));
      req.end();
    });
    expect(streamed).toBe(413);
    expect(present(cache)).toHaveLength(Object.keys(KEYS).length);
  });

  it("answers 405 for other methods", async () => {
    const { baseUrl } = await start();
    const res = await fetch(`${baseUrl}${WEBHOOK_PATH}`);
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("POST");
  });

  it("is absent (404) when webhooks are disabled", async () => {
    const { baseUrl } = await start({ webhooks: false });
    const body = event("workout.updated");
    expect((await deliver(baseUrl, body)).status).toBe(404);
  });

  it("does not let a fetch started before the event repopulate the cache", async () => {
    const cache = filledCache();
    cache.delete(KEYS.workoutList);
    let finishFetch: (value: string) => void = () => undefined;
    const inFlight = cache.getOrFetch(
      KEYS.workoutList,
      60_000,
      () => new Promise<string>((resolve) => (finishFetch = resolve))
    );
    const { baseUrl } = await start({ cache });
    expect((await deliver(baseUrl, event("workout.updated"))).status).toBe(204);
    finishFetch("stale list read before the edit");
    expect(await inFlight).toBe("stale list read before the edit");
    expect(cache.has(KEYS.workoutList)).toBe(false);
  });

  it("needs no bearer token and leaves /mcp authentication unchanged", async () => {
    const { baseUrl } = await start();
    const withToken = await fetch(`${baseUrl}${WEBHOOK_PATH}`, {
      method: "POST",
      headers: { authorization: `Bearer ${AUTH_TOKEN}` },
      body: "{}",
    });
    // A bearer token is not a webhook signature.
    expect(withToken.status).toBe(401);
    expect((await fetch(`${baseUrl}/mcp`, { method: "POST" })).status).toBe(401);
    const signedForMcp = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        "x-whoop-signature-timestamp": String(Date.now()),
        "x-whoop-signature": sign(String(Date.now()), "{}"),
      },
      body: "{}",
    });
    expect(signedForMcp.status).toBe(401);
  });

  it("answers 429 to the 121st request from one IP within a minute", async () => {
    const { baseUrl } = await start();
    const statuses: number[] = [];
    for (let batch = 0; batch < WEBHOOK_RATE_LIMIT_PER_MINUTE; batch += 20) {
      const results = await Promise.all(
        Array.from({ length: 20 }, () => deliver(baseUrl, "{}", { signature: "bad" }))
      );
      statuses.push(...results.map((r) => r.status));
    }
    expect(statuses).toHaveLength(WEBHOOK_RATE_LIMIT_PER_MINUTE);
    expect(statuses.every((status) => status === 401)).toBe(true);
    const limited = await deliver(baseUrl, event("workout.updated"));
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
  });
});
