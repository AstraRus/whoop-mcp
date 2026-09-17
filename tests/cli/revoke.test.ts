/**
 * Tests for the human-only `whoop-ai-mcp revoke` CLI (DELETE /v2/user/access).
 *
 * WHOOP is never contacted: fetch is mocked. Tokens live in a temporary
 * WHOOP_MCP_TOKEN_DIR, so the real token store is exercised.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdir, mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { REVOKE_ACCESS_PATH, runRevoke } from "../../src/cli/revoke.js";
import { WHOOP_API_BASE_URL, WHOOP_TOKEN_URL } from "../../src/api/endpoints.js";
import { loadTokens, saveTokens, type OAuthTokens } from "../../src/auth/token-store.js";
import { connectServer } from "../helpers/contract.js";
import { createWhoopFixtureClient } from "../helpers/whoop-fixture-client.js";

const REVOKE_URL = `${WHOOP_API_BASE_URL}${REVOKE_ACCESS_PATH}`;

interface RecordedRequest {
  url: string;
  method: string;
  authorization: string | null;
  body: string | null;
}

describe("whoop-ai-mcp revoke", () => {
  const originalEnv = { ...process.env };
  let tokenDir: string;
  let output: string[];
  let requests: RecordedRequest[];
  let respond: (request: RecordedRequest) => Response | Promise<Response>;

  const write = (text: string): void => {
    output.push(text);
  };
  const text = (): string => output.join("\n");

  const freshTokens = (): OAuthTokens => ({
    access_token: "ACCESS-STORED-1",
    refresh_token: "REFRESH-STORED-1",
    expires_at: Date.now() + 3_600_000,
    token_type: "Bearer",
  });

  beforeEach(async () => {
    tokenDir = join(await mkdtemp(join(tmpdir(), "whoop-revoke-")), "tokens");
    process.env.WHOOP_MCP_TOKEN_DIR = tokenDir;
    process.env.WHOOP_CLIENT_ID = "client-id";
    process.env.WHOOP_CLIENT_SECRET = "client-secret";
    output = [];
    requests = [];
    respond = (): Response => new Response(null, { status: 204 });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
        const request: RecordedRequest = {
          url: String(input),
          method: init?.method ?? "GET",
          authorization: new Headers(init?.headers).get("authorization"),
          body: typeof init?.body === "string" ? init.body : null,
        };
        requests.push(request);
        return respond(request);
      })
    );
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    process.env = { ...originalEnv };
    await rm(join(tokenDir, ".."), { recursive: true, force: true });
  });

  function expectNoSecrets(): void {
    expect(text()).not.toMatch(/ACCESS-|REFRESH-|client-secret|BODY-/);
  }

  describe("without --yes", () => {
    it.each([[[]], [["--keep-tokens"]]])(
      "explains what would happen, sends nothing and exits 2 (%j)",
      async (args) => {
        await saveTokens(freshTokens());

        expect(await runRevoke(args, { write })).toBe(2);

        expect(requests).toEqual([]);
        expect(text()).toMatch(
          /stop the running service first: a refresh here rotates the refresh token it uses/i
        );
        expect(text()).toContain("DELETE /v2/user/access");
        expect(text()).toContain("Nothing was sent.");
        expect(await loadTokens()).toEqual(
          expect.objectContaining({ refresh_token: "REFRESH-STORED-1" })
        );
        expect(await readdir(tokenDir)).toEqual(["tokens.json"]);
      }
    );

    it("does not even read the token folder", async () => {
      process.env.WHOOP_MCP_TOKEN_DIR = "relative/folder";
      expect(await runRevoke([], { write })).toBe(2);
      expect(requests).toEqual([]);
      expect(text()).not.toContain("absolute path");
    });

    it.each([[["--force"]], [["--yes", "extra"]], [["-y"]]])(
      "rejects unknown arguments %j with usage and exit 2",
      async (args) => {
        await saveTokens(freshTokens());
        expect(await runRevoke(args, { write })).toBe(2);
        expect(text()).toContain("Usage: whoop-ai-mcp revoke --yes [--keep-tokens]");
        expect(requests).toEqual([]);
      }
    );
  });

  describe("with --yes", () => {
    it("prints the permission guidance, sends nothing and exits 1 when tokens.json cannot be read", async () => {
      // A directory named tokens.json: reading it fails with EISDIR, like a
      // root-owned file read by another user fails with EACCES.
      await mkdir(join(tokenDir, "tokens.json"), { recursive: true });

      expect(await runRevoke(["--yes"], { write })).toBe(1);

      expect(requests).toEqual([]);
      expect(text()).toContain("Cannot read the WHOOP token file");
      expect(text()).toContain("(EISDIR)");
      expect(text()).toContain("WHOOP_MCP_TOKEN_DIR");
      expect(text()).toContain("Nothing was revoked.");
      expect(text()).not.toContain("No usable WHOOP tokens");
      expect((await stat(join(tokenDir, "tokens.json"))).isDirectory()).toBe(true);
    });

    it("revokes with HTTP 204 and deletes tokens.json", async () => {
      await saveTokens(freshTokens());

      expect(await runRevoke(["--yes"], { write })).toBe(0);

      expect(requests).toEqual([
        {
          url: REVOKE_URL,
          method: "DELETE",
          authorization: "Bearer ACCESS-STORED-1",
          body: null,
        },
      ]);
      expect(REVOKE_URL).toBe("https://api.prod.whoop.com/developer/v2/user/access");
      expect(await readdir(tokenDir)).toEqual([]);
      expect(text()).toContain("WHOOP revoked this app's access to the account (HTTP 204).");
      expect(text()).toContain("Deleted tokens.json");
      expectNoSecrets();
    });

    it("keeps tokens.json with --keep-tokens", async () => {
      await saveTokens(freshTokens());

      expect(await runRevoke(["--keep-tokens", "--yes"], { write })).toBe(0);

      expect(requests).toHaveLength(1);
      expect(await loadTokens()).toEqual(
        expect.objectContaining({ refresh_token: "REFRESH-STORED-1" })
      );
      expect(text()).toContain("Kept tokens.json");
    });

    it("treats HTTP 401 as already revoked: deletes tokens.json with a message", async () => {
      await saveTokens(freshTokens());
      respond = (): Response => new Response("BODY-unauthorized", { status: 401 });

      expect(await runRevoke(["--yes"], { write })).toBe(0);

      expect(await readdir(tokenDir)).toEqual([]);
      expect(text()).toContain("WHOOP no longer accepts the stored access token (HTTP 401)");
      expect(text()).toContain("Deleted tokens.json");
      expectNoSecrets();
    });

    it.each([
      [500, "HTTP 500"],
      [503, "HTTP 503"],
      [429, "HTTP 429"],
      [400, "HTTP 400"],
      [403, "HTTP 403"],
      [302, "HTTP 302"],
    ])("keeps tokens.json and exits 1 on HTTP %i", async (status, mention) => {
      await saveTokens(freshTokens());
      respond = (): Response => new Response("BODY-detail", { status });

      expect(await runRevoke(["--yes"], { write })).toBe(1);

      expect(requests).toHaveLength(1);
      expect(await loadTokens()).toEqual(
        expect.objectContaining({ access_token: "ACCESS-STORED-1" })
      );
      expect(text()).toContain(mention);
      expect(text()).toContain("tokens.json was kept");
      expectNoSecrets();
    });

    it("keeps tokens.json and exits 1 when WHOOP cannot be reached", async () => {
      await saveTokens(freshTokens());
      respond = (): Response => {
        throw new TypeError("fetch failed");
      };

      expect(await runRevoke(["--yes"], { write })).toBe(1);

      expect(await readdir(tokenDir)).toEqual(["tokens.json"]);
      expect(text()).toContain("revocation is not confirmed");
    });

    it("exits 1 without a request when there are no stored tokens", async () => {
      expect(await runRevoke(["--yes"], { write })).toBe(1);
      expect(requests).toEqual([]);
      expect(text()).toContain("No usable WHOOP tokens found");
    });

    it("exits 1 with guidance for a relative WHOOP_MCP_TOKEN_DIR", async () => {
      process.env.WHOOP_MCP_TOKEN_DIR = "relative/folder";
      expect(await runRevoke(["--yes"], { write })).toBe(1);
      expect(requests).toEqual([]);
      expect(text()).toContain("WHOOP_MCP_TOKEN_DIR must be an absolute path");
    });

    describe("with an expired access token", () => {
      const expired = (): OAuthTokens => ({ ...freshTokens(), expires_at: Date.now() - 1000 });

      it("refreshes first, saves the rotated tokens, then revokes with the new access token", async () => {
        await saveTokens(expired());
        respond = (request): Response =>
          request.url === WHOOP_TOKEN_URL
            ? new Response(
                JSON.stringify({
                  access_token: "ACCESS-NEW-2",
                  refresh_token: "REFRESH-NEW-2",
                  expires_in: 3600,
                  token_type: "bearer",
                  scope: "read:profile",
                }),
                { status: 200 }
              )
            : new Response(null, { status: 204 });

        expect(await runRevoke(["--yes", "--keep-tokens"], { write })).toBe(0);

        expect(requests.map((r) => [r.method, r.url])).toEqual([
          ["POST", WHOOP_TOKEN_URL],
          ["DELETE", REVOKE_URL],
        ]);
        const form = new URLSearchParams(requests[0]!.body ?? "");
        expect(form.get("grant_type")).toBe("refresh_token");
        expect(form.get("refresh_token")).toBe("REFRESH-STORED-1");
        expect(requests[1]!.authorization).toBe("Bearer ACCESS-NEW-2");
        expect(await loadTokens()).toEqual(
          expect.objectContaining({ access_token: "ACCESS-NEW-2", refresh_token: "REFRESH-NEW-2" })
        );
        expectNoSecrets();
      });

      it.each([
        ["invalid_grant", 400, "rejected the stored refresh token"],
        ["invalid_client", 401, "rejected this app's client credentials"],
        [undefined, 503, "could not refresh the stored tokens right now"],
      ])(
        "does not revoke when the refresh fails with %s (HTTP %i)",
        async (code, status, message) => {
          await saveTokens(expired());
          respond = (): Response =>
            new Response(JSON.stringify({ error: code, error_description: "BODY-description" }), {
              status,
            });

          expect(await runRevoke(["--yes"], { write })).toBe(1);

          expect(requests.map((r) => r.url)).toEqual([WHOOP_TOKEN_URL]);
          expect(await loadTokens()).toEqual(
            expect.objectContaining({ refresh_token: "REFRESH-STORED-1" })
          );
          expect(text()).toContain(message);
          expect(text()).toContain("Nothing was revoked; tokens.json was kept.");
          expectNoSecrets();
        }
      );

      it("does not refresh without WHOOP_CLIENT_ID and WHOOP_CLIENT_SECRET", async () => {
        await saveTokens(expired());

        expect(await runRevoke(["--yes"], { write, env: {} })).toBe(1);

        expect(requests).toEqual([]);
        expect(text()).toContain("needs WHOOP_CLIENT_ID and WHOOP_CLIENT_SECRET");
      });
    });
  });
});

describe("revoke is never an MCP tool", () => {
  it.each(["standard", "aggregate"] as const)("tools/list in %s mode", async (privacyMode) => {
    const connection = await connectServer(createWhoopFixtureClient(), { privacyMode });
    try {
      const tools = await connection.listTools();
      expect(tools.length).toBeGreaterThan(0);
      for (const tool of tools) {
        expect(tool.name).not.toMatch(/revoke|disconnect|user_access/i);
        expect(tool.description ?? "").not.toContain("/v2/user/access");
      }
    } finally {
      await connection.close();
    }
  });
});
