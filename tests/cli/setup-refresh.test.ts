/**
 * Tests for the token refresh used by `setup --verify`'s default profile fetch.
 *
 * WHOOP rotates refresh tokens, so once a refresh succeeded a failed save must
 * not turn it into a verification failure (R20).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mockLoadTokens = vi.fn();
const mockSaveTokens = vi.fn();

vi.mock("../../src/auth/token-store.js", async (importOriginal) => ({
  // Keeps the pure helpers (resolveTokenDir, redactHomePath, TOKEN_DIR_ENV)
  ...(await importOriginal<typeof import("../../src/auth/token-store.js")>()),
  loadTokens: (...args: unknown[]) => mockLoadTokens(...args),
  saveTokens: (...args: unknown[]) => mockSaveTokens(...args),
  deleteTokens: vi.fn(),
  isTokenExpired: vi.fn(() => false),
}));

import { runSetup } from "../../src/cli/setup.js";

function makeIo(): {
  io: { input: NodeJS.ReadableStream; output: NodeJS.WritableStream };
  output: () => string;
} {
  let captured = "";
  const output = {
    write: (chunk: string | Uint8Array): boolean => {
      captured += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
      return true;
    },
  } as unknown as NodeJS.WritableStream;
  const input = { on: () => undefined, off: () => undefined } as unknown as NodeJS.ReadableStream;
  return { io: { input, output }, output: () => captured };
}

describe("setup --verify token refresh", () => {
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);
    mockLoadTokens.mockReset();
    mockSaveTokens.mockReset();
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    delete process.env.WHOOP_CLIENT_ID;
    delete process.env.WHOOP_CLIENT_SECRET;
  });

  it("verifies with the refreshed token even when saving it fails", async () => {
    mockLoadTokens.mockResolvedValue({
      access_token: "A0",
      refresh_token: "R0",
      expires_at: Date.now() + 600_000,
      token_type: "Bearer",
    });
    mockSaveTokens.mockRejectedValue(
      Object.assign(new Error("EBUSY: rename '/secret/path'"), { code: "EBUSY" })
    );
    mockFetch.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.includes("/oauth/oauth2/token")) {
        return new Response(
          JSON.stringify({
            access_token: "A1",
            refresh_token: "R1",
            expires_in: 3600,
            token_type: "bearer",
            scope: "read:profile",
          }),
          { status: 200 }
        );
      }
      const auth = new Headers(init?.headers).get("authorization");
      return auth === "Bearer A1"
        ? new Response(
            JSON.stringify({ user_id: 7, email: "e@x", first_name: "F", last_name: "L" }),
            { status: 200 }
          )
        : new Response("{}", { status: 401 });
    });
    const { io, output } = makeIo();

    await runSetup(
      { clientId: "id", clientSecret: "s", client: "claude-code", verify: true },
      { io, authenticate: vi.fn(async () => "A0") }
    );

    expect(output()).toContain("Profile OK");
    expect(mockSaveTokens).toHaveBeenCalledWith(
      expect.objectContaining({ access_token: "A1", refresh_token: "R1" })
    );
    const logged = (console.error as unknown as ReturnType<typeof vi.fn>).mock.calls
      .map((c) => String(c[0]))
      .join("\n");
    expect(logged).toContain("EBUSY");
    expect(logged).not.toContain("/secret/path");
  });
});
