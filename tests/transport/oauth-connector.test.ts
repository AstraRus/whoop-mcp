import { describe, it, expect, beforeEach, vi } from "vitest";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { Response } from "express";
import {
  InvalidClientMetadataError,
  InvalidTargetError,
  InvalidTokenError,
} from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type { OAuthClientInformationFull } from "@modelcontextprotocol/sdk/shared/auth.js";

import {
  DCR_CLIENT_ID_PREFIX,
  OAuthConnectorProvider,
  REGISTER_MAX_BODY_BYTES,
  REGISTER_RATE_LIMIT_PER_MINUTE,
  SignedClientsStore,
  authorizePageCsp,
  createOAuthApp,
  type ConnectorClientConfig,
} from "../../src/transport/oauth-connector.js";
import { AuthCodeStore } from "../../src/transport/oauth-helpers.js";
import { signToken } from "../../src/transport/oauth-jwt.js";
import { createHttpServer } from "../../src/transport/http.js";
import { createWhoopServer } from "../../src/server.js";
import { createWhoopFixtureClient } from "../helpers/whoop-fixture-client.js";
import { liveShapedUser } from "../helpers/whoop-users.js";

const PUBLIC_URL = "https://mcp.example.com";
const CLAUDE_AI_CALLBACK = "https://claude.ai/api/mcp/auth_callback";
const CLAUDE_COM_CALLBACK = "https://claude.com/api/mcp/auth_callback";
const STATIC_REDIRECT = "https://claude.ai/api/mcp/callback";
const BASE64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

// Helpers
function makeProvider(
  overrides: Partial<{
    redirectUris: string[];
    allowedRedirectUris: string[];
    authCodeStore: AuthCodeStore;
    secret: Uint8Array;
  }> = {}
): { provider: OAuthConnectorProvider; client: ConnectorClientConfig; secret: Uint8Array } {
  const client: ConnectorClientConfig = {
    clientId: "claude-ai-connector",
    redirectUris: overrides.redirectUris ?? [STATIC_REDIRECT],
    clientName: "Claude AI Connector",
  };
  const secret = overrides.secret ?? new Uint8Array(randomBytes(32));
  const provider = new OAuthConnectorProvider({
    client,
    allowedRedirectUris: overrides.allowedRedirectUris ?? client.redirectUris,
    jwtSecret: secret,
    publicUrl: PUBLIC_URL,
    ...(overrides.authCodeStore && { authCodeStore: overrides.authCodeStore }),
  });
  return { provider, client, secret };
}

// Mock Express Response just enough to capture redirects
function mockRes(): { res: Response; getRedirect: () => string | undefined } {
  let redirected: string | undefined;
  const redirect = vi.fn((url: string) => {
    redirected = url;
  });
  return { res: { redirect } as unknown as Response, getRedirect: () => redirected };
}

function staticClient(provider: OAuthConnectorProvider, id: string): OAuthClientInformationFull {
  const client = provider.clientsStore.getClient(id);
  if (!client) throw new Error("static client missing");
  return client;
}

/** Authorize and return the code. */
async function codeFor(
  provider: OAuthConnectorProvider,
  client: OAuthClientInformationFull,
  params: { scopes?: string[]; resource?: URL; redirectUri?: string } = {}
): Promise<string> {
  const { res, getRedirect } = mockRes();
  await provider.authorize(
    client,
    {
      codeChallenge: "challenge",
      redirectUri: params.redirectUri ?? STATIC_REDIRECT,
      state: "s",
      ...(params.scopes !== undefined && { scopes: params.scopes }),
      ...(params.resource !== undefined && { resource: params.resource }),
    },
    res
  );
  return new URL(getRedirect()!).searchParams.get("code")!;
}

describe("OAuthConnectorProvider", () => {
  describe("clientsStore", () => {
    it("returns the registered client by id", () => {
      const { provider, client } = makeProvider();
      const found = provider.clientsStore.getClient(client.clientId);
      expect(found).toBeDefined();
      expect(found?.client_id).toBe(client.clientId);
      expect(found?.redirect_uris).toEqual(client.redirectUris);
      expect(found?.grant_types).toContain("authorization_code");
      expect(found?.grant_types).toContain("refresh_token");
    });

    it("returns undefined for unknown client id", () => {
      const { provider } = makeProvider();
      expect(provider.clientsStore.getClient("unknown")).toBeUndefined();
    });
  });

  describe("authorize", () => {
    it("issues a code and redirects with code+state", async () => {
      const { provider, client } = makeProvider();
      const { res, getRedirect } = mockRes();

      await provider.authorize(
        staticClient(provider, client.clientId),
        {
          codeChallenge: "abc123challenge",
          redirectUri: STATIC_REDIRECT,
          state: "xyz-state",
          scopes: ["read:profile"],
        },
        res
      );

      const url = getRedirect();
      expect(url).toBeDefined();
      const parsed = new URL(url!);
      expect(parsed.origin + parsed.pathname).toBe(STATIC_REDIRECT);
      expect(parsed.searchParams.get("code")).toBeTruthy();
      expect(parsed.searchParams.get("state")).toBe("xyz-state");
    });

    it("rejects redirect_uri not in allowlist", async () => {
      const { provider, client } = makeProvider();
      const { res } = mockRes();

      await expect(
        provider.authorize(
          staticClient(provider, client.clientId),
          { codeChallenge: "abc123", redirectUri: "https://evil.example.com/callback", state: "s" },
          res
        )
      ).rejects.toThrow(/ALLOWED_REDIRECT_URIS/);
    });

    it("rejects when codeChallenge is missing", async () => {
      const { provider, client } = makeProvider();
      const { res } = mockRes();

      await expect(
        provider.authorize(
          staticClient(provider, client.clientId),
          { codeChallenge: "", redirectUri: STATIC_REDIRECT },
          res
        )
      ).rejects.toThrow(/code_challenge/);
    });

    it("omits state from redirect when not provided", async () => {
      const { provider, client } = makeProvider();
      const { res, getRedirect } = mockRes();

      await provider.authorize(
        staticClient(provider, client.clientId),
        { codeChallenge: "abc", redirectUri: STATIC_REDIRECT },
        res
      );

      const url = new URL(getRedirect()!);
      expect(url.searchParams.has("state")).toBe(false);
      expect(url.searchParams.get("code")).toBeTruthy();
    });

    it.each([[["claudeai"]], [[]], [["read:profile", "mcp", "offline"]]])(
      "always grants exactly the mcp scope (requested %j)",
      async (scopes) => {
        const { provider, client } = makeProvider();
        const full = staticClient(provider, client.clientId);
        const code = await codeFor(provider, full, { scopes });
        const tokens = await provider.exchangeAuthorizationCode(full, code, "v", STATIC_REDIRECT);
        expect(tokens.scope).toBe("mcp");
        expect((await provider.verifyAccessToken(tokens.access_token)).scopes).toEqual(["mcp"]);
      }
    );

    it("rejects a resource indicator naming another server with invalid_target", async () => {
      const { provider, client } = makeProvider();
      const { res } = mockRes();
      const attempt = provider.authorize(
        staticClient(provider, client.clientId),
        {
          codeChallenge: "c",
          redirectUri: STATIC_REDIRECT,
          resource: new URL("https://evil.example/mcp"),
        },
        res
      );
      await expect(attempt).rejects.toBeInstanceOf(InvalidTargetError);
    });

    it.each([[`${PUBLIC_URL}/mcp`], [`${PUBLIC_URL}/mcp/`], [PUBLIC_URL], [`${PUBLIC_URL}/`]])(
      "accepts the resource %s and binds tokens to it",
      async (resource) => {
        const { provider, client } = makeProvider();
        const full = staticClient(provider, client.clientId);
        const code = await codeFor(provider, full, { resource: new URL(resource) });
        const tokens = await provider.exchangeAuthorizationCode(full, code, "v", STATIC_REDIRECT);
        const info = await provider.verifyAccessToken(tokens.access_token);
        expect(info.resource?.href).toBe(new URL(resource).href);
      }
    );
  });

  describe("challengeForAuthorizationCode", () => {
    it("returns the codeChallenge for a valid code", async () => {
      const { provider, client } = makeProvider();
      const full = staticClient(provider, client.clientId);
      const code = await codeFor(provider, full);
      expect(await provider.challengeForAuthorizationCode(full, code)).toBe("challenge");
    });

    it("throws for unknown code", async () => {
      const { provider, client } = makeProvider();
      await expect(
        provider.challengeForAuthorizationCode(
          staticClient(provider, client.clientId),
          "no-such-code"
        )
      ).rejects.toThrow(/Invalid or expired/);
    });
  });

  describe("exchangeAuthorizationCode", () => {
    let provider: OAuthConnectorProvider;
    let fullClient: OAuthClientInformationFull;
    let code: string;

    beforeEach(async () => {
      const made = makeProvider();
      provider = made.provider;
      fullClient = staticClient(provider, made.client.clientId);
      code = await codeFor(provider, fullClient, { scopes: ["read:profile", "read:recovery"] });
    });

    it("returns access + refresh tokens for a valid code", async () => {
      const tokens = await provider.exchangeAuthorizationCode(
        fullClient,
        code,
        "v",
        STATIC_REDIRECT
      );
      expect(tokens.access_token).toBeTruthy();
      expect(tokens.refresh_token).toBeTruthy();
      expect(tokens.token_type).toBe("Bearer");
      expect(tokens.expires_in).toBeGreaterThan(0);
      expect(tokens.scope).toBe("mcp");
    });

    it("rejects replay of consumed code", async () => {
      await provider.exchangeAuthorizationCode(fullClient, code, "v", STATIC_REDIRECT);
      await expect(
        provider.exchangeAuthorizationCode(fullClient, code, "v", STATIC_REDIRECT)
      ).rejects.toThrow(/already-consumed|expired|Invalid/);
    });

    it("rejects mismatched redirect_uri", async () => {
      await expect(
        provider.exchangeAuthorizationCode(
          fullClient,
          code,
          "v",
          "https://attacker.example.com/callback"
        )
      ).rejects.toThrow(/redirect_uri/);
    });

    it("rejects when code belongs to different client", async () => {
      await expect(
        provider.exchangeAuthorizationCode(
          { ...fullClient, client_id: "different-client" },
          code,
          "v",
          STATIC_REDIRECT
        )
      ).rejects.toThrow(/different client/);
    });

    it("rejects unknown code", async () => {
      await expect(
        provider.exchangeAuthorizationCode(fullClient, "no-such-code", "v", STATIC_REDIRECT)
      ).rejects.toThrow(/Invalid|expired/);
    });

    it("rejects a token-request resource naming another server", async () => {
      await expect(
        provider.exchangeAuthorizationCode(
          fullClient,
          code,
          "v",
          STATIC_REDIRECT,
          new URL("https://evil.example/mcp")
        )
      ).rejects.toBeInstanceOf(InvalidTargetError);
    });

    it("binds a resource sent only to /token", async () => {
      const tokens = await provider.exchangeAuthorizationCode(
        fullClient,
        code,
        "v",
        STATIC_REDIRECT,
        new URL(`${PUBLIC_URL}/mcp`)
      );
      const info = await provider.verifyAccessToken(tokens.access_token);
      expect(info.resource?.href).toBe(`${PUBLIC_URL}/mcp`);
    });

    it("rejects a token-request resource that differs from the authorized one", async () => {
      const bound = await codeFor(provider, fullClient, { resource: new URL(`${PUBLIC_URL}/mcp`) });
      await expect(
        provider.exchangeAuthorizationCode(
          fullClient,
          bound,
          "v",
          STATIC_REDIRECT,
          new URL(PUBLIC_URL)
        )
      ).rejects.toBeInstanceOf(InvalidTargetError);
    });
  });

  describe("exchangeRefreshToken", () => {
    let provider: OAuthConnectorProvider;
    let secret: Uint8Array;
    let fullClient: OAuthClientInformationFull;
    let refreshToken: string;

    beforeEach(async () => {
      const made = makeProvider();
      provider = made.provider;
      secret = made.secret;
      fullClient = staticClient(provider, made.client.clientId);
      const code = await codeFor(provider, fullClient);
      const tokens = await provider.exchangeAuthorizationCode(
        fullClient,
        code,
        "v",
        STATIC_REDIRECT
      );
      refreshToken = tokens.refresh_token!;
    });

    it("issues a fresh access token", async () => {
      const next = await provider.exchangeRefreshToken(fullClient, refreshToken);
      expect(next.access_token).toBeTruthy();
      expect(next.refresh_token).toBeTruthy();
      expect(next.token_type).toBe("Bearer");
      expect(next.scope).toBe("mcp");
    });

    it("ignores requested scopes and always issues mcp", async () => {
      const next = await provider.exchangeRefreshToken(fullClient, refreshToken, ["claudeai"]);
      expect(next.scope).toBe("mcp");
    });

    it("re-issues mcp for a refresh token granted with no scope", async () => {
      const legacy = await signToken(
        {
          clientId: fullClient.client_id,
          scopes: [],
          ttlSeconds: 3600,
          type: "refresh",
          jti: "legacy-jti",
        },
        secret
      );
      const next = await provider.exchangeRefreshToken(fullClient, legacy);
      expect(next.scope).toBe("mcp");
      expect((await provider.verifyAccessToken(next.access_token)).scopes).toEqual(["mcp"]);
    });

    it("rejects access token used as refresh token", async () => {
      const code = await codeFor(provider, fullClient);
      const tokens = await provider.exchangeAuthorizationCode(
        fullClient,
        code,
        "v",
        STATIC_REDIRECT
      );
      await expect(provider.exchangeRefreshToken(fullClient, tokens.access_token)).rejects.toThrow(
        /not a refresh token/
      );
    });

    it("rejects refresh token from different client", async () => {
      await expect(
        provider.exchangeRefreshToken(
          { ...fullClient, client_id: "different-client" },
          refreshToken
        )
      ).rejects.toThrow(/different client/);
    });

    it("rejects a garbage refresh token with invalid_grant", async () => {
      await expect(provider.exchangeRefreshToken(fullClient, "garbage")).rejects.toThrow(
        /Invalid or expired refresh token/
      );
    });

    it("rejects a resource when the grant had none", async () => {
      await expect(
        provider.exchangeRefreshToken(
          fullClient,
          refreshToken,
          undefined,
          new URL(`${PUBLIC_URL}/mcp`)
        )
      ).rejects.toBeInstanceOf(InvalidTargetError);
    });
  });

  describe("verifyAccessToken", () => {
    it("returns AuthInfo for a valid access token", async () => {
      const { provider, client } = makeProvider();
      const full = staticClient(provider, client.clientId);
      const code = await codeFor(provider, full, { resource: new URL(`${PUBLIC_URL}/mcp`) });
      const tokens = await provider.exchangeAuthorizationCode(full, code, "v", STATIC_REDIRECT);

      const info = await provider.verifyAccessToken(tokens.access_token);
      expect(info.token).toBe(tokens.access_token);
      expect(info.clientId).toBe(client.clientId);
      expect(info.scopes).toEqual(["mcp"]);
      expect(info.resource?.href).toBe(`${PUBLIC_URL}/mcp`);
      expect(info.expiresAt).toBeGreaterThan(Math.floor(Date.now() / 1000));
    });

    it("rejects refresh token used as access token", async () => {
      const { provider, client } = makeProvider();
      const full = staticClient(provider, client.clientId);
      const code = await codeFor(provider, full);
      const tokens = await provider.exchangeAuthorizationCode(full, code, "v", STATIC_REDIRECT);

      await expect(provider.verifyAccessToken(tokens.refresh_token!)).rejects.toThrow(
        /not an access token/
      );
    });

    it("rejects garbage tokens", async () => {
      const { provider } = makeProvider();
      await expect(provider.verifyAccessToken("not-a-jwt")).rejects.toBeInstanceOf(
        InvalidTokenError
      );
    });

    it("rejects a token signed with another key", async () => {
      const { provider } = makeProvider();
      const foreign = await signToken(
        { clientId: "claude-ai-connector", scopes: ["mcp"], ttlSeconds: 3600, type: "access" },
        new Uint8Array(randomBytes(32))
      );
      await expect(provider.verifyAccessToken(foreign)).rejects.toBeInstanceOf(InvalidTokenError);
    });
  });

  describe("stop", () => {
    it("stops the auth code cleanup timer", () => {
      const store = new AuthCodeStore();
      const { provider } = makeProvider({ authCodeStore: store });
      provider.stop();
      // No assertion needed — if this throws or hangs the process, the test fails
    });
  });
});

// ---------------------------------------------------------------------------
// Stateless dynamic client registration
// ---------------------------------------------------------------------------

describe("SignedClientsStore", () => {
  const allowed = [CLAUDE_AI_CALLBACK, CLAUDE_COM_CALLBACK];
  const staticConfig: ConnectorClientConfig = {
    clientId: "whoop-mcp-connector",
    redirectUris: allowed,
  };
  const secret = new Uint8Array(randomBytes(32));

  function store(
    allowlist: readonly string[] = allowed,
    key: Uint8Array = secret
  ): SignedClientsStore {
    return new SignedClientsStore(staticConfig, allowlist, key);
  }

  function registration(
    overrides: Partial<Omit<OAuthClientInformationFull, "client_id" | "client_id_issued_at">> = {}
  ): Omit<OAuthClientInformationFull, "client_id" | "client_id_issued_at"> {
    return {
      redirect_uris: [CLAUDE_AI_CALLBACK],
      client_name: "Claude",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      ...overrides,
    };
  }

  it("registers a public client ('none') without a secret and recognizes its id", () => {
    const registered = store().registerClient(registration({ token_endpoint_auth_method: "none" }));
    expect(registered.client_id.startsWith(DCR_CLIENT_ID_PREFIX)).toBe(true);
    expect(registered.client_secret).toBeUndefined();
    expect(registered.token_endpoint_auth_method).toBe("none");
    expect(typeof registered.client_id_issued_at).toBe("number");
    const found = store().getClient(registered.client_id);
    expect(found).toMatchObject({
      client_id: registered.client_id,
      redirect_uris: [CLAUDE_AI_CALLBACK],
      client_name: "Claude",
      token_endpoint_auth_method: "none",
      scope: "mcp",
    });
    expect(found?.client_secret).toBeUndefined();
  });

  it.each([["client_secret_post"], [undefined]])(
    "registers a confidential client for token_endpoint_auth_method %s with a derived secret",
    (method) => {
      const registered = store().registerClient(
        registration(method === undefined ? {} : { token_endpoint_auth_method: method })
      );
      const expectedSecret = createHmac("sha256", secret)
        .update(`dcr-secret-v1|${registered.client_id}`)
        .digest("base64url");
      expect(registered.client_secret).toBe(expectedSecret);
      expect(registered.client_secret_expires_at).toBe(0);
      expect(registered.token_endpoint_auth_method).toBe("client_secret_post");
      expect(store().getClient(registered.client_id)?.client_secret).toBe(expectedSecret);
    }
  );

  it("derives the id from the signed payload (sorted redirect URIs, name, mode, nonce)", () => {
    const registered = store().registerClient(
      registration({
        redirect_uris: [CLAUDE_COM_CALLBACK, CLAUDE_AI_CALLBACK, CLAUDE_COM_CALLBACK],
        client_name: "x".repeat(80),
        token_endpoint_auth_method: "none",
        scope: "claudeai",
      })
    );
    const [, payload, mac] = registered.client_id.split(".");
    expect(JSON.parse(Buffer.from(payload!, "base64url").toString("utf8"))).toEqual({
      r: [CLAUDE_AI_CALLBACK, CLAUDE_COM_CALLBACK].sort(),
      n: "x".repeat(64),
      m: "n",
      i: expect.stringMatching(/^[A-Za-z0-9_-]{22}$/),
    });
    expect(mac).toBe(createHmac("sha256", secret).update(`dcr-v1|${payload}`).digest("base64url"));
    // The requested scope is ignored.
    expect(registered.scope).toBe("mcp");
  });

  it("gives two registrations with identical metadata different ids and secrets", () => {
    const first = store().registerClient(
      registration({ token_endpoint_auth_method: "client_secret_post" })
    );
    const second = store().registerClient(
      registration({ token_endpoint_auth_method: "client_secret_post" })
    );

    expect(second.client_id).not.toBe(first.client_id);
    expect(second.client_secret).toBeDefined();
    expect(second.client_secret).not.toBe(first.client_secret);
    for (const registered of [first, second]) {
      const found = store().getClient(registered.client_id);
      expect(found?.client_id).toBe(registered.client_id);
      expect(found?.client_secret).toBe(registered.client_secret);
    }
  });

  it("does not recognize a signed id without a nonce, or with a malformed one", () => {
    const sign = (payload: unknown): string => {
      const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
      const mac = createHmac("sha256", secret).update(`dcr-v1|${encoded}`).digest("base64url");
      return `dcr.${encoded}.${mac}`;
    };
    expect(store().getClient(sign({ r: [CLAUDE_AI_CALLBACK], m: "p" }))).toBeUndefined();
    expect(
      store().getClient(sign({ r: [CLAUDE_AI_CALLBACK], m: "p", i: "short" }))
    ).toBeUndefined();
    expect(
      store().getClient(sign({ r: [CLAUDE_AI_CALLBACK], m: "p", i: "A".repeat(21) + "=" }))
    ).toBeUndefined();
    expect(
      store().getClient(sign({ r: [CLAUDE_AI_CALLBACK], m: "p", i: "A".repeat(22) }))
    ).toBeDefined();
  });

  it("rejects client_secret_basic and unknown auth methods as invalid client metadata", () => {
    for (const method of ["client_secret_basic", "private_key_jwt"]) {
      expect(() =>
        store().registerClient(registration({ token_endpoint_auth_method: method }))
      ).toThrow(InvalidClientMetadataError);
    }
  });

  it("rejects redirect URIs outside ALLOWED_REDIRECT_URIS", () => {
    expect(() =>
      store().registerClient(registration({ redirect_uris: ["https://evil.example/callback"] }))
    ).toThrow(expect.objectContaining({ errorCode: "invalid_redirect_uri" }));
    expect(() =>
      store().registerClient(
        registration({ redirect_uris: [CLAUDE_AI_CALLBACK, "https://evil.example/callback"] })
      )
    ).toThrow(/ALLOWED_REDIRECT_URIS/);
  });

  it("rejects unsupported grant and response types", () => {
    expect(() =>
      store().registerClient(registration({ grant_types: ["client_credentials"] }))
    ).toThrow(InvalidClientMetadataError);
    expect(() => store().registerClient(registration({ response_types: ["token"] }))).toThrow(
      InvalidClientMetadataError
    );
    // Omitted types are fine.
    expect(() => store().registerClient({ redirect_uris: [CLAUDE_AI_CALLBACK] })).not.toThrow();
  });

  it("does not recognize tampered, foreign or no-longer-allowed ids", () => {
    const registered = store().registerClient(registration({ token_endpoint_auth_method: "none" }));
    const [, payload, mac] = registered.client_id.split(".");
    const otherPayload = Buffer.from(
      JSON.stringify({ r: ["https://evil.example/callback"], m: "n" })
    ).toString("base64url");
    const flipped = `${mac!.startsWith("A") ? "B" : "A"}${mac!.slice(1)}`;
    // The last character of a 32-byte base64url MAC carries 2 unused bits:
    // a spelling that decodes to the same bytes must still be rejected.
    const lastIndex = BASE64URL.indexOf(mac!.charAt(42));
    const sameBytes = `${mac!.slice(0, 42)}${BASE64URL.charAt(lastIndex ^ 0b01)}`;
    expect(Buffer.from(sameBytes, "base64url").equals(Buffer.from(mac!, "base64url"))).toBe(true);
    expect(store().getClient(`dcr.${otherPayload}.${mac}`)).toBeUndefined();
    expect(store().getClient(`dcr.${payload}.${flipped}`)).toBeUndefined();
    expect(store().getClient(`dcr.${payload}.${sameBytes}`)).toBeUndefined();
    expect(store().getClient(`dcr.${payload}`)).toBeUndefined();
    expect(store().getClient(`dcr.${payload}.${mac}.extra`)).toBeUndefined();
    expect(
      store(allowed, new Uint8Array(randomBytes(32))).getClient(registered.client_id)
    ).toBeUndefined();
    expect(store([CLAUDE_COM_CALLBACK]).getClient(registered.client_id)).toBeUndefined();
    expect(store().getClient(registered.client_id)).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Integration tests: createOAuthApp end-to-end
// ---------------------------------------------------------------------------

function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

interface AppContext {
  baseUrl: string;
  close: () => Promise<void>;
  password: string;
  redirectUri: string;
  clientId: string;
  secret: Uint8Array;
  provider: OAuthConnectorProvider;
  app: ReturnType<typeof createOAuthApp>;
}

async function listen(handler: Parameters<typeof createServer>[1]): Promise<{
  server: Server;
  baseUrl: string;
}> {
  const server: Server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (typeof addr === "string" || addr === null) throw new Error("bad address");
  return { server, baseUrl: `http://127.0.0.1:${addr.port}` };
}

async function startApp(
  opts: { connectorPassword?: string; secret?: Uint8Array; allowedRedirectUris?: string[] } = {}
): Promise<AppContext> {
  const password = opts.connectorPassword ?? "test-connector-pwd-123";
  const redirectUri = STATIC_REDIRECT;
  const clientId = "claude-ai-connector";
  const secret = opts.secret ?? new Uint8Array(randomBytes(32));

  const app = createOAuthApp({
    connectorPassword: password,
    publicUrl: PUBLIC_URL,
    allowedRedirectUris: opts.allowedRedirectUris ?? [
      redirectUri,
      CLAUDE_AI_CALLBACK,
      CLAUDE_COM_CALLBACK,
    ],
    jwtSecret: secret,
    client: {
      clientId,
      redirectUris: [redirectUri],
      clientName: "Claude AI Connector",
    },
  });

  const { server, baseUrl } = await listen(app.app);

  return {
    baseUrl,
    password,
    redirectUri,
    clientId,
    secret,
    provider: app.provider,
    app,
    close: async () => {
      app.close();
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}

const FORM = { "content-type": "application/x-www-form-urlencoded" };

async function registerClient(
  baseUrl: string,
  body: unknown
): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${baseUrl}/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

async function postAuthorize(
  ctx: AppContext,
  params: Record<string, string>
): Promise<globalThis.Response> {
  return fetch(`${ctx.baseUrl}/authorize`, {
    method: "POST",
    headers: FORM,
    body: new URLSearchParams({
      response_type: "code",
      code_challenge_method: "S256",
      state: "s",
      connector_password: ctx.password,
      ...params,
    }),
    redirect: "manual",
  });
}

async function authorizeCode(
  ctx: AppContext,
  params: Record<string, string>
): Promise<{ code: string; verifier: string }> {
  const { verifier, challenge } = pkcePair();
  const res = await postAuthorize(ctx, { code_challenge: challenge, ...params });
  expect(res.status).toBe(302);
  const location = new URL(res.headers.get("location")!);
  expect(location.searchParams.get("error")).toBeNull();
  return { code: location.searchParams.get("code")!, verifier };
}

async function postToken(
  ctx: AppContext,
  params: Record<string, string>
): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${ctx.baseUrl}/token`, {
    method: "POST",
    headers: FORM,
    body: new URLSearchParams(params),
  });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

const CLAUDE_REGISTRATION = {
  client_name: "Claude",
  redirect_uris: [CLAUDE_AI_CALLBACK],
  grant_types: ["authorization_code", "refresh_token"],
  response_types: ["code"],
  token_endpoint_auth_method: "client_secret_post",
  scope: "claudeai",
};

describe("createOAuthApp (integration)", () => {
  it("rejects too-short connector password at startup", () => {
    expect(() =>
      createOAuthApp({
        connectorPassword: "short",
        publicUrl: PUBLIC_URL,
        allowedRedirectUris: ["https://claude.ai/cb"],
        jwtSecret: new Uint8Array(32),
        client: { clientId: "c", redirectUris: ["https://claude.ai/cb"] },
      })
    ).toThrow(/at least 12/);
  });

  it("rejects non-https publicUrl at startup", () => {
    expect(() =>
      createOAuthApp({
        connectorPassword: "long-enough-password",
        publicUrl: "http://mcp.example.com",
        allowedRedirectUris: ["https://claude.ai/cb"],
        jwtSecret: new Uint8Array(32),
        client: { clientId: "c", redirectUris: ["https://claude.ai/cb"] },
      })
    ).toThrow(/https/);
  });

  it("serves OAuth metadata at /.well-known/oauth-authorization-server", async () => {
    const ctx = await startApp();
    try {
      const res = await fetch(`${ctx.baseUrl}/.well-known/oauth-authorization-server`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.issuer).toBe(`${PUBLIC_URL}/`);
      expect(body.authorization_endpoint).toBe(`${PUBLIC_URL}/authorize`);
      expect(body.token_endpoint).toBe(`${PUBLIC_URL}/token`);
      expect(body.registration_endpoint).toBe(`${PUBLIC_URL}/register`);
      expect(body.scopes_supported).toEqual(["mcp"]);
      expect(body.code_challenge_methods_supported).toContain("S256");
      expect(body.token_endpoint_auth_methods_supported).toEqual(
        expect.arrayContaining(["client_secret_post", "none"])
      );
    } finally {
      await ctx.close();
    }
  });

  it("serves protected resource metadata for /mcp and an identical root alias", async () => {
    const ctx = await startApp();
    try {
      const pathSpecific = await fetch(`${ctx.baseUrl}/.well-known/oauth-protected-resource/mcp`);
      const root = await fetch(`${ctx.baseUrl}/.well-known/oauth-protected-resource`);
      expect(pathSpecific.status).toBe(200);
      expect(root.status).toBe(200);
      const pathText = await pathSpecific.text();
      expect(await root.text()).toBe(pathText);
      expect(JSON.parse(pathText)).toEqual({
        resource: `${PUBLIC_URL}/mcp`,
        authorization_servers: [`${PUBLIC_URL}/`],
        scopes_supported: ["mcp"],
        resource_name: "WHOOP MCP",
      });
      expect(ctx.app.resourceUrls).toEqual({
        origin: PUBLIC_URL,
        canonicalResource: `${PUBLIC_URL}/mcp`,
        resourceMetadataUrl: `${PUBLIC_URL}/.well-known/oauth-protected-resource/mcp`,
      });
    } finally {
      await ctx.close();
    }
  });

  it("GET /authorize renders the password prompt with hidden OAuth params", async () => {
    const ctx = await startApp();
    try {
      const url = new URL(`${ctx.baseUrl}/authorize`);
      url.searchParams.set("client_id", ctx.clientId);
      url.searchParams.set("redirect_uri", ctx.redirectUri);
      url.searchParams.set("response_type", "code");
      url.searchParams.set("code_challenge", "abc");
      url.searchParams.set("code_challenge_method", "S256");
      url.searchParams.set("state", "xyz-state");

      const res = await fetch(url, { redirect: "manual" });
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toMatch(/text\/html/);
      const html = await res.text();
      expect(html).toContain('name="connector_password"');
      expect(html).toContain('value="' + ctx.clientId + '"');
      expect(html).toContain('value="xyz-state"');
      expect(html).toContain('value="' + ctx.redirectUri + '"');
    } finally {
      await ctx.close();
    }
  });

  it("GET /authorize for an unknown client answers 400 without a password form", async () => {
    const ctx = await startApp();
    try {
      const res = await fetch(`${ctx.baseUrl}/authorize?client_id=unknown&response_type=code`);
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error: "invalid_client" });
    } finally {
      await ctx.close();
    }
  });

  it("POST /authorize with wrong password re-renders form with 401", async () => {
    const ctx = await startApp();
    try {
      const res = await postAuthorize(ctx, {
        client_id: ctx.clientId,
        redirect_uri: ctx.redirectUri,
        code_challenge: "abc",
        connector_password: "wrong-password!",
      });
      expect(res.status).toBe(401);
      const html = await res.text();
      expect(html).toContain("Incorrect password");
    } finally {
      await ctx.close();
    }
  });

  it("completes the full authorize → token flow with valid PKCE", async () => {
    const ctx = await startApp();
    try {
      const { code, verifier } = await authorizeCode(ctx, {
        client_id: ctx.clientId,
        redirect_uri: ctx.redirectUri,
        scope: "read:profile read:recovery",
      });
      const tokens = await postToken(ctx, {
        grant_type: "authorization_code",
        code,
        redirect_uri: ctx.redirectUri,
        client_id: ctx.clientId,
        code_verifier: verifier,
      });
      expect(tokens.status).toBe(200);
      expect(tokens.json.access_token).toBeTruthy();
      expect(tokens.json.refresh_token).toBeTruthy();
      expect(tokens.json.token_type).toBe("Bearer");
      expect(tokens.json.scope).toBe("mcp");
    } finally {
      await ctx.close();
    }
  });

  it("rejects /token with wrong PKCE verifier", async () => {
    const ctx = await startApp();
    try {
      const { code } = await authorizeCode(ctx, {
        client_id: ctx.clientId,
        redirect_uri: ctx.redirectUri,
      });
      const tokens = await postToken(ctx, {
        grant_type: "authorization_code",
        code,
        redirect_uri: ctx.redirectUri,
        client_id: ctx.clientId,
        code_verifier: randomBytes(32).toString("base64url"),
      });
      expect(tokens.status).toBe(400);
      expect(tokens.json.error).toBe("invalid_grant");
    } finally {
      await ctx.close();
    }
  });

  it("rejects /token replay of a used authorization code", async () => {
    const ctx = await startApp();
    try {
      const { code, verifier } = await authorizeCode(ctx, {
        client_id: ctx.clientId,
        redirect_uri: ctx.redirectUri,
      });
      const body = {
        grant_type: "authorization_code",
        code,
        redirect_uri: ctx.redirectUri,
        client_id: ctx.clientId,
        code_verifier: verifier,
      };
      expect((await postToken(ctx, body)).status).toBe(200);
      expect((await postToken(ctx, body)).status).toBe(400);
    } finally {
      await ctx.close();
    }
  });

  it("password page sets anti-clickjacking headers and a CSP allowing the redirect origins", async () => {
    const ctx = await startApp();
    try {
      const url = new URL(`${ctx.baseUrl}/authorize`);
      url.searchParams.set("client_id", ctx.clientId);
      url.searchParams.set("redirect_uri", ctx.redirectUri);
      url.searchParams.set("response_type", "code");
      url.searchParams.set("code_challenge", "abc");
      url.searchParams.set("code_challenge_method", "S256");
      const res = await fetch(url, { redirect: "manual" });
      expect(res.headers.get("x-frame-options")).toBe("DENY");
      const csp = res.headers.get("content-security-policy") ?? "";
      expect(csp).toContain("frame-ancestors 'none'");
      expect(csp).toContain("default-src 'none'");
      expect(csp).toContain("form-action 'self' https://claude.ai https://claude.com;");
      expect(res.headers.get("referrer-policy")).toBe("no-referrer");
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    } finally {
      await ctx.close();
    }
  });

  it("authorizePageCsp lists each redirect origin once and skips invalid URIs", () => {
    expect(
      authorizePageCsp([CLAUDE_AI_CALLBACK, STATIC_REDIRECT, CLAUDE_COM_CALLBACK, "not a url"])
    ).toContain("form-action 'self' https://claude.ai https://claude.com;");
  });

  it("redirects resource=https://evil.example/mcp back with invalid_target and no code", async () => {
    const ctx = await startApp();
    try {
      const res = await postAuthorize(ctx, {
        client_id: ctx.clientId,
        redirect_uri: ctx.redirectUri,
        code_challenge: pkcePair().challenge,
        resource: "https://evil.example/mcp",
      });
      expect(res.status).toBe(302);
      const location = new URL(res.headers.get("location")!);
      expect(location.searchParams.get("error")).toBe("invalid_target");
      expect(location.searchParams.get("code")).toBeNull();
    } finally {
      await ctx.close();
    }
  });

  it("rejects reuse of a rotated refresh token with 400 invalid_grant", async () => {
    const ctx = await startApp();
    try {
      const { code, verifier } = await authorizeCode(ctx, {
        client_id: ctx.clientId,
        redirect_uri: ctx.redirectUri,
      });
      const first = await postToken(ctx, {
        grant_type: "authorization_code",
        code,
        redirect_uri: ctx.redirectUri,
        client_id: ctx.clientId,
        code_verifier: verifier,
      });
      const refresh = String(first.json.refresh_token);
      const rotated = await postToken(ctx, {
        grant_type: "refresh_token",
        refresh_token: refresh,
        client_id: ctx.clientId,
      });
      expect(rotated.status).toBe(200);
      const reused = await postToken(ctx, {
        grant_type: "refresh_token",
        refresh_token: refresh,
        client_id: ctx.clientId,
      });
      expect(reused.status).toBe(400);
      expect(reused.json.error).toBe("invalid_grant");
    } finally {
      await ctx.close();
    }
  });

  describe("dynamic client registration", () => {
    it("registers a public client (201) whose id round-trips through /authorize and /token", async () => {
      const ctx = await startApp();
      try {
        const registered = await registerClient(ctx.baseUrl, {
          client_name: "Inspector",
          redirect_uris: [CLAUDE_COM_CALLBACK],
          token_endpoint_auth_method: "none",
        });
        expect(registered.status).toBe(201);
        const clientId = String(registered.json.client_id);
        expect(clientId.startsWith("dcr.")).toBe(true);
        expect(registered.json.client_secret).toBeUndefined();

        const { code, verifier } = await authorizeCode(ctx, {
          client_id: clientId,
          redirect_uri: CLAUDE_COM_CALLBACK,
        });
        const tokens = await postToken(ctx, {
          grant_type: "authorization_code",
          code,
          redirect_uri: CLAUDE_COM_CALLBACK,
          client_id: clientId,
          code_verifier: verifier,
        });
        expect(tokens.status).toBe(200);
        expect(tokens.json.scope).toBe("mcp");
      } finally {
        await ctx.close();
      }
    });

    it("completes a claude.ai-shaped registration, authorization and refresh", async () => {
      const ctx = await startApp();
      try {
        const registered = await registerClient(ctx.baseUrl, CLAUDE_REGISTRATION);
        expect(registered.status).toBe(201);
        expect(registered.json).toMatchObject({
          client_name: "Claude",
          redirect_uris: [CLAUDE_AI_CALLBACK],
          token_endpoint_auth_method: "client_secret_post",
          client_secret_expires_at: 0,
        });
        const clientId = String(registered.json.client_id);
        const clientSecret = String(registered.json.client_secret);
        expect(clientSecret.length).toBeGreaterThan(20);

        const { code, verifier } = await authorizeCode(ctx, {
          client_id: clientId,
          redirect_uri: CLAUDE_AI_CALLBACK,
          scope: "claudeai",
          resource: `${PUBLIC_URL}/mcp`,
        });
        const tokens = await postToken(ctx, {
          grant_type: "authorization_code",
          code,
          redirect_uri: CLAUDE_AI_CALLBACK,
          client_id: clientId,
          client_secret: clientSecret,
          code_verifier: verifier,
          resource: `${PUBLIC_URL}/mcp`,
        });
        expect(tokens.status).toBe(200);
        expect(tokens.json.scope).toBe("mcp");

        const refreshed = await postToken(ctx, {
          grant_type: "refresh_token",
          refresh_token: String(tokens.json.refresh_token),
          client_id: clientId,
          client_secret: clientSecret,
          scope: "claudeai",
        });
        expect(refreshed.status).toBe(200);
        expect(refreshed.json.scope).toBe("mcp");

        const wrongSecret = await postToken(ctx, {
          grant_type: "refresh_token",
          refresh_token: String(refreshed.json.refresh_token),
          client_id: clientId,
          client_secret: `${clientSecret}x`,
        });
        expect(wrongSecret.status).toBe(400);
        expect(wrongSecret.json.error).toBe("invalid_client");

        const noSecret = await postToken(ctx, {
          grant_type: "refresh_token",
          refresh_token: String(refreshed.json.refresh_token),
          client_id: clientId,
        });
        expect(noSecret.status).toBe(400);
        expect(noSecret.json.error).toBe("invalid_client");
      } finally {
        await ctx.close();
      }
    });

    it("never lets a second identical registration use the first registrant's refresh token", async () => {
      const ctx = await startApp();
      try {
        const owner = await registerClient(ctx.baseUrl, CLAUDE_REGISTRATION);
        const other = await registerClient(ctx.baseUrl, CLAUDE_REGISTRATION);
        expect(owner.status).toBe(201);
        expect(other.status).toBe(201);
        expect(other.json.client_id).not.toBe(owner.json.client_id);
        expect(other.json.client_secret).not.toBe(owner.json.client_secret);
        const ownerId = String(owner.json.client_id);
        const ownerSecret = String(owner.json.client_secret);

        const { code, verifier } = await authorizeCode(ctx, {
          client_id: ownerId,
          redirect_uri: CLAUDE_AI_CALLBACK,
        });
        const tokens = await postToken(ctx, {
          grant_type: "authorization_code",
          code,
          redirect_uri: CLAUDE_AI_CALLBACK,
          client_id: ownerId,
          client_secret: ownerSecret,
          code_verifier: verifier,
        });
        expect(tokens.status).toBe(200);
        const refreshToken = String(tokens.json.refresh_token);

        const stolen = await postToken(ctx, {
          grant_type: "refresh_token",
          refresh_token: refreshToken,
          client_id: String(other.json.client_id),
          client_secret: String(other.json.client_secret),
        });
        expect(stolen.status).toBe(400);
        expect(["invalid_grant", "invalid_client"]).toContain(stolen.json.error);
        expect(stolen.json.access_token).toBeUndefined();
        // The owner's secret under the other id is refused as well.
        const mixed = await postToken(ctx, {
          grant_type: "refresh_token",
          refresh_token: refreshToken,
          client_id: String(other.json.client_id),
          client_secret: ownerSecret,
        });
        expect(mixed.status).toBe(400);

        // The refused attempts did not consume the owner's refresh token.
        const refreshed = await postToken(ctx, {
          grant_type: "refresh_token",
          refresh_token: refreshToken,
          client_id: ownerId,
          client_secret: ownerSecret,
        });
        expect(refreshed.status).toBe(200);
        expect(refreshed.json.access_token).toBeTruthy();
      } finally {
        await ctx.close();
      }
    });

    it("rejects client_secret_basic and non-allowlisted redirect URIs with 400", async () => {
      const ctx = await startApp();
      try {
        const basic = await registerClient(ctx.baseUrl, {
          ...CLAUDE_REGISTRATION,
          token_endpoint_auth_method: "client_secret_basic",
        });
        expect(basic.status).toBe(400);
        expect(basic.json.error).toBe("invalid_client_metadata");

        const evil = await registerClient(ctx.baseUrl, {
          ...CLAUDE_REGISTRATION,
          redirect_uris: ["https://evil.example/callback"],
        });
        expect(evil.status).toBe(400);
        expect(evil.json.error).toBe("invalid_redirect_uri");

        const notJson = await fetch(`${ctx.baseUrl}/register`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{not json",
        });
        expect(notJson.status).toBe(400);
      } finally {
        await ctx.close();
      }
    });

    it("rejects a registration body over 2 KB with 413", async () => {
      const ctx = await startApp();
      try {
        const res = await fetch(`${ctx.baseUrl}/register`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            ...CLAUDE_REGISTRATION,
            client_name: "x".repeat(REGISTER_MAX_BODY_BYTES),
          }),
        });
        expect(res.status).toBe(413);
      } finally {
        await ctx.close();
      }
    });

    it("limits registrations to 10 per minute per IP", async () => {
      const ctx = await startApp();
      try {
        for (let i = 0; i < REGISTER_RATE_LIMIT_PER_MINUTE; i++) {
          expect((await registerClient(ctx.baseUrl, CLAUDE_REGISTRATION)).status).toBe(201);
        }
        expect((await registerClient(ctx.baseUrl, CLAUDE_REGISTRATION)).status).toBe(429);
      } finally {
        await ctx.close();
      }
    });

    it("answers 400 at /authorize for a tampered client id", async () => {
      const ctx = await startApp();
      try {
        const registered = await registerClient(ctx.baseUrl, CLAUDE_REGISTRATION);
        const clientId = String(registered.json.client_id);
        const mac = clientId.slice(clientId.lastIndexOf(".") + 1);
        const tampered = `${clientId.slice(0, clientId.lastIndexOf(".") + 1)}${
          mac.startsWith("A") ? "B" : "A"
        }${mac.slice(1)}`;
        const res = await postAuthorize(ctx, {
          client_id: tampered,
          redirect_uri: CLAUDE_AI_CALLBACK,
          code_challenge: pkcePair().challenge,
        });
        expect(res.status).toBe(400);
        expect(await res.json()).toMatchObject({ error: "invalid_client" });
      } finally {
        await ctx.close();
      }
    });

    it("recognizes an id and secret registered before a restart (same JWT key)", async () => {
      const secret = new Uint8Array(randomBytes(32));
      const before = await startApp({ secret });
      let clientId: string;
      let clientSecret: string;
      try {
        const registered = await registerClient(before.baseUrl, CLAUDE_REGISTRATION);
        clientId = String(registered.json.client_id);
        clientSecret = String(registered.json.client_secret);
      } finally {
        await before.close();
      }

      const after = await startApp({ secret });
      try {
        const { code, verifier } = await authorizeCode(after, {
          client_id: clientId,
          redirect_uri: CLAUDE_AI_CALLBACK,
        });
        const tokens = await postToken(after, {
          grant_type: "authorization_code",
          code,
          redirect_uri: CLAUDE_AI_CALLBACK,
          client_id: clientId,
          client_secret: clientSecret,
          code_verifier: verifier,
        });
        expect(tokens.status).toBe(200);
      } finally {
        await after.close();
      }

      const rotatedKey = await startApp();
      try {
        const res = await postAuthorize(rotatedKey, {
          client_id: clientId,
          redirect_uri: CLAUDE_AI_CALLBACK,
          code_challenge: pkcePair().challenge,
        });
        expect(res.status).toBe(400);
      } finally {
        await rotatedKey.close();
      }
    });
  });
});

// ---------------------------------------------------------------------------
// Connector sign-in, then MCP over HTTP with the issued access token
// ---------------------------------------------------------------------------

describe("connector access tokens on /mcp (end to end)", () => {
  it("signs in with the password, exchanges the code with PKCE and calls /mcp with the token", async () => {
    const secret = new Uint8Array(randomBytes(32));
    const oauth = createOAuthApp({
      connectorPassword: "test-connector-pwd-123",
      publicUrl: PUBLIC_URL,
      allowedRedirectUris: [CLAUDE_AI_CALLBACK],
      jwtSecret: secret,
      client: { clientId: "whoop-mcp-connector", redirectUris: [CLAUDE_AI_CALLBACK] },
    });
    const fixture = liveShapedUser();
    const whoop = createWhoopFixtureClient({ ...fixture, now: fixture.now });
    const http = await createHttpServer({
      authToken: "static-token-0123456789abcdef",
      port: 0,
      host: "127.0.0.1",
      sseReauthIntervalMs: 0,
      oauthHandler: oauth.app as unknown as Parameters<typeof createHttpServer>[0]["oauthHandler"],
      authenticateBearer: async (token) => {
        try {
          return await oauth.provider.verifyAccessToken(token);
        } catch {
          return null;
        }
      },
      canonicalResource: oauth.resourceUrls.canonicalResource,
      resourceMetadataUrl: oauth.resourceUrls.resourceMetadataUrl,
      createMcpServer: () => createWhoopServer(whoop, { disableResources: true }).server,
    });
    const addr = http.server.address();
    if (!addr || typeof addr === "string") throw new Error("no port");
    const ctx: AppContext = {
      baseUrl: `http://127.0.0.1:${addr.port}`,
      password: "test-connector-pwd-123",
      redirectUri: CLAUDE_AI_CALLBACK,
      clientId: "whoop-mcp-connector",
      secret,
      provider: oauth.provider,
      app: oauth,
      close: async () => {
        oauth.close();
        await http.close();
      },
    };
    const mcp = (token: string, message: unknown): Promise<globalThis.Response> =>
      fetch(`${ctx.baseUrl}/mcp`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify(message),
      });

    try {
      // Discovery: the unauthenticated 401 points at the resource metadata.
      const anonymous = await fetch(`${ctx.baseUrl}/mcp`, { method: "POST" });
      expect(anonymous.status).toBe(401);
      expect(anonymous.headers.get("www-authenticate")).toContain(
        `resource_metadata="${PUBLIC_URL}/.well-known/oauth-protected-resource/mcp"`
      );

      // GET renders the password page; POST with the password issues a code.
      const { challenge, verifier } = pkcePair();
      const page = await fetch(
        `${ctx.baseUrl}/authorize?${new URLSearchParams({
          client_id: ctx.clientId,
          redirect_uri: CLAUDE_AI_CALLBACK,
          response_type: "code",
          code_challenge: challenge,
          code_challenge_method: "S256",
          state: "s",
        })}`
      );
      expect(page.status).toBe(200);
      const authorized = await postAuthorize(ctx, {
        client_id: ctx.clientId,
        redirect_uri: CLAUDE_AI_CALLBACK,
        code_challenge: challenge,
        resource: `${PUBLIC_URL}/mcp`,
      });
      expect(authorized.status).toBe(302);
      const code = new URL(authorized.headers.get("location")!).searchParams.get("code")!;
      const tokens = await postToken(ctx, {
        grant_type: "authorization_code",
        code,
        redirect_uri: CLAUDE_AI_CALLBACK,
        client_id: ctx.clientId,
        code_verifier: verifier,
      });
      expect(tokens.status).toBe(200);
      const accessToken = String(tokens.json.access_token);

      const init = await mcp(accessToken, {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "connector-e2e", version: "0" },
        },
      });
      expect(init.status).toBe(200);
      const list = await mcp(accessToken, { jsonrpc: "2.0", id: 2, method: "tools/list" });
      expect(list.status).toBe(200);
      const listed = (await list.json()) as { result: { tools: Array<{ name: string }> } };
      expect(listed.result.tools.map((tool) => tool.name)).toContain("get_profile");

      // The refresh token is not an access token.
      expect(
        (await mcp(String(tokens.json.refresh_token), { jsonrpc: "2.0", id: 3, method: "ping" }))
          .status
      ).toBe(401);
    } finally {
      await ctx.close();
    }
  });
});
