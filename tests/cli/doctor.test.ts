import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { saveTokens } from "../../src/auth/token-store.js";
import { runDoctor, type DoctorDependencies } from "../../src/cli/doctor.js";

function dependencies(overrides: Partial<DoctorDependencies> = {}): DoctorDependencies {
  return {
    env: { WHOOP_CLIENT_ID: "private-id", WHOOP_CLIENT_SECRET: "private-secret" },
    nodeVersion: "22.0.0",
    platform: "darwin",
    inspectToken: vi
      .fn()
      .mockResolvedValue({ exists: true, regular: true, mode: 0o600, directoryMode: 0o700 }),
    write: vi.fn(),
    ...overrides,
  };
}
afterEach(() => vi.unstubAllGlobals());
describe("doctor", () => {
  it("reports local readiness without network requests or secrets", async () => {
    const fetch = vi.fn(() => {
      throw new Error("Unexpected network");
    });
    vi.stubGlobal("fetch", fetch);
    const deps = dependencies();
    expect(await runDoctor(["--json"], deps)).toBe(0);
    const text = vi.mocked(deps.write).mock.calls[0]![0];
    expect(JSON.parse(text)).toMatchObject({
      ready: true,
      scope_status: "unknown",
      token_validity: "unknown",
    });
    expect(text).not.toContain("private-id");
    expect(text).not.toContain("private-secret");
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each([
    { nodeVersion: "18.0.0" },
    { env: {} },
    { env: { WHOOP_CLIENT_ID: "x", WHOOP_CLIENT_SECRET: "y", MCP_TRANSPORT: "http" } },
    {
      inspectToken: vi
        .fn()
        .mockResolvedValue({ exists: false, regular: false, mode: 0, directoryMode: 0 }),
    },
    {
      inspectToken: vi
        .fn()
        .mockResolvedValue({ exists: true, regular: true, mode: 0o644, directoryMode: 0o700 }),
    },
    {
      inspectToken: vi
        .fn()
        .mockResolvedValue({ exists: true, regular: false, mode: 0o600, directoryMode: 0o700 }),
    },
    { platform: "win32" as const },
  ])("returns remediation status for unsafe local state %j", async (overrides) => {
    expect(await runDoctor([], dependencies(overrides))).toBe(1);
  });
  it("rejects unknown arguments without inspecting tokens", async () => {
    const deps = dependencies();
    expect(await runDoctor(["--verify"], deps)).toBe(2);
    expect(deps.inspectToken).not.toHaveBeenCalled();
  });
  it("sanitizes filesystem failures", async () => {
    const deps = dependencies({
      inspectToken: vi.fn().mockRejectedValue(new Error("/private/token/path")),
    });
    expect(await runDoctor(["--json"], deps)).toBe(1);
    expect(vi.mocked(deps.write).mock.calls[0]![0]).not.toContain("/private");
  });

  describe("token folder (WHOOP_MCP_TOKEN_DIR)", () => {
    const report = (deps: DoctorDependencies): Record<string, unknown> =>
      JSON.parse(vi.mocked(deps.write).mock.calls[0]![0]) as Record<string, unknown>;
    const credentials = { WHOOP_CLIENT_ID: "private-id", WHOOP_CLIENT_SECRET: "private-secret" };

    it.each([
      [{}, "default", 0],
      [{ WHOOP_MCP_TOKEN_DIR: " " }, "default", 0],
      [{ WHOOP_MCP_TOKEN_DIR: resolve("/data/whoop") }, "WHOOP_MCP_TOKEN_DIR", 0],
      [{ WHOOP_MCP_TOKEN_DIR: "data/whoop" }, "invalid", 1],
    ])("reports the token folder source for %j", async (env, source, exitCode) => {
      const deps = dependencies({ env: { ...credentials, ...env } });
      expect(await runDoctor(["--json"], deps)).toBe(exitCode);
      expect(report(deps)).toMatchObject({
        token_directory: source,
        checks: { token_directory_configuration: source !== "invalid" },
      });
      // Never the folder itself (it can contain the user name)
      const text = vi.mocked(deps.write).mock.calls[0]![0];
      for (const value of Object.values(env) as string[]) {
        if (value.trim() === "") continue;
        expect(text).not.toContain(value);
        expect(text).not.toContain(JSON.stringify(value).slice(1, -1));
      }
    });

    describe("default token inspection", () => {
      const original = process.env.WHOOP_MCP_TOKEN_DIR;
      let tempDir: string;

      beforeEach(async () => {
        tempDir = await mkdtemp(join(tmpdir(), "whoop-doctor-"));
      });

      afterEach(async () => {
        if (original === undefined) delete process.env.WHOOP_MCP_TOKEN_DIR;
        else process.env.WHOOP_MCP_TOKEN_DIR = original;
        vi.restoreAllMocks();
        await rm(tempDir, { recursive: true, force: true });
      });

      async function runDefaultDoctor(): Promise<Record<string, unknown>> {
        let text = "";
        vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
          text += String(chunk);
          return true;
        });
        await runDoctor(["--json"]);
        return JSON.parse(text) as Record<string, unknown>;
      }

      it("inspects tokens.json in WHOOP_MCP_TOKEN_DIR (none there)", async () => {
        process.env.WHOOP_MCP_TOKEN_DIR = join(tempDir, "empty");
        expect(await runDefaultDoctor()).toMatchObject({
          token_directory: "WHOOP_MCP_TOKEN_DIR",
          checks: { private_token_file: false },
        });
      });

      it.skipIf(process.platform === "win32")(
        "passes the private token file check for tokens saved to WHOOP_MCP_TOKEN_DIR",
        async () => {
          const folder = join(tempDir, "volume");
          process.env.WHOOP_MCP_TOKEN_DIR = folder;
          await saveTokens({
            access_token: "a",
            refresh_token: "r",
            expires_at: Date.now() + 3_600_000,
            token_type: "Bearer",
          });
          expect(await runDefaultDoctor()).toMatchObject({
            checks: { private_token_file: true, token_directory_configuration: true },
          });
        }
      );

      it("fails the checks without throwing for a relative WHOOP_MCP_TOKEN_DIR", async () => {
        process.env.WHOOP_MCP_TOKEN_DIR = "relative";
        expect(await runDefaultDoctor()).toMatchObject({
          ready: false,
          token_directory: "invalid",
          checks: { private_token_file: false, token_directory_configuration: false },
        });
      });
    });
  });
});
