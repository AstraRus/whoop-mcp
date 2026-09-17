import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { stat, rm, readFile, readdir, chmod } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";

/** Optional failure injection for fs.promises calls made by token-store (tests below) */
const fsFaults = vi.hoisted(() => ({
  rename: null as null | ((from: string, to: string) => Promise<void> | undefined),
  writeFile: null as null | ((path: string) => Promise<void> | undefined),
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    rename: (from: string, to: string): Promise<void> =>
      fsFaults.rename?.(from, to) ?? actual.rename(from, to),
    writeFile: (...args: Parameters<typeof actual.writeFile>): Promise<void> =>
      fsFaults.writeFile?.(String(args[0])) ?? actual.writeFile(...args),
  };
});

function fsError(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code}: simulated`), { code });
}
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { OAuthTokens } from "../../src/auth/token-store.js";
import {
  isTokenExpired,
  saveTokens,
  loadTokens,
  deleteTokens,
  resolveTokenDir,
  TOKEN_DIR_ENV,
} from "../../src/auth/token-store.js";

/**
 * Windows has no POSIX file modes: chmod cannot make a folder unwritable and
 * stat reports 0666/0777. The permission tests below still run on Linux CI.
 */
const POSIX_PERMISSIONS_UNSUPPORTED = process.platform === "win32";

// ---------------------------------------------------------------------------
// Task 3a: Token types + expiry check
// ---------------------------------------------------------------------------

describe("OAuthTokens", () => {
  it("accepts a valid token object", () => {
    const tokens: OAuthTokens = {
      access_token: "abc123",
      refresh_token: "def456",
      expires_at: Date.now() + 3600 * 1000,
      token_type: "Bearer",
    };

    expect(tokens.access_token).toBe("abc123");
    expect(tokens.refresh_token).toBe("def456");
    expect(tokens.token_type).toBe("Bearer");
    expect(tokens.expires_at).toBeGreaterThan(Date.now());
  });
});

describe("isTokenExpired", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-10T12:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const NOW = new Date("2026-04-10T12:00:00.000Z").getTime();
  const BUFFER_MS = 60_000; // 60 seconds

  it("returns true when token is already expired", () => {
    const tokens: OAuthTokens = {
      access_token: "a",
      refresh_token: "r",
      expires_at: NOW - 1000, // expired 1s ago
      token_type: "Bearer",
    };

    expect(isTokenExpired(tokens)).toBe(true);
  });

  it("returns true when token expires within the 60s buffer", () => {
    const tokens: OAuthTokens = {
      access_token: "a",
      refresh_token: "r",
      expires_at: NOW + 30_000, // expires in 30s (within 60s buffer)
      token_type: "Bearer",
    };

    expect(isTokenExpired(tokens)).toBe(true);
  });

  it("returns true when token expires exactly at the buffer boundary", () => {
    const tokens: OAuthTokens = {
      access_token: "a",
      refresh_token: "r",
      expires_at: NOW + BUFFER_MS, // expires exactly at buffer
      token_type: "Bearer",
    };

    expect(isTokenExpired(tokens)).toBe(true);
  });

  it("returns false when token expires well beyond the buffer", () => {
    const tokens: OAuthTokens = {
      access_token: "a",
      refresh_token: "r",
      expires_at: NOW + 3600_000, // expires in 1 hour
      token_type: "Bearer",
    };

    expect(isTokenExpired(tokens)).toBe(false);
  });

  it("returns false when token expires 1ms beyond the buffer", () => {
    const tokens: OAuthTokens = {
      access_token: "a",
      refresh_token: "r",
      expires_at: NOW + BUFFER_MS + 1, // just past the buffer
      token_type: "Bearer",
    };

    expect(isTokenExpired(tokens)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Token folder: WHOOP_MCP_TOKEN_DIR
// ---------------------------------------------------------------------------

describe("resolveTokenDir", () => {
  const original = process.env[TOKEN_DIR_ENV];
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "whoop-mcp-dir-"));
    delete process.env[TOKEN_DIR_ENV];
  });

  afterEach(async () => {
    if (original === undefined) delete process.env[TOKEN_DIR_ENV];
    else process.env[TOKEN_DIR_ENV] = original;
    vi.restoreAllMocks();
    await rm(tempDir, { recursive: true, force: true });
  });

  const tokens: OAuthTokens = {
    access_token: "access_env",
    refresh_token: "refresh_env",
    expires_at: Date.now() + 3600_000,
    token_type: "Bearer",
  };

  it("defaults to ~/.whoop-mcp when WHOOP_MCP_TOKEN_DIR is unset or blank", () => {
    expect(TOKEN_DIR_ENV).toBe("WHOOP_MCP_TOKEN_DIR");
    expect(resolveTokenDir()).toBe(join(homedir(), ".whoop-mcp"));
    process.env[TOKEN_DIR_ENV] = "   ";
    expect(resolveTokenDir()).toBe(join(homedir(), ".whoop-mcp"));
  });

  it("honours an absolute WHOOP_MCP_TOKEN_DIR, read at call time", () => {
    process.env[TOKEN_DIR_ENV] = tempDir;
    expect(resolveTokenDir()).toBe(tempDir);
    const other = join(tempDir, "other");
    process.env[TOKEN_DIR_ENV] = other;
    expect(resolveTokenDir()).toBe(other);
  });

  it("prefers an explicit folder over WHOOP_MCP_TOKEN_DIR", () => {
    process.env[TOKEN_DIR_ENV] = tempDir;
    expect(resolveTokenDir("/explicit")).toBe("/explicit");
  });

  it.each(["tokens", "./data/whoop", "data\\whoop", "~/.whoop-mcp"])(
    "rejects the relative path %j with guidance",
    (value) => {
      process.env[TOKEN_DIR_ENV] = value;
      expect(() => resolveTokenDir()).toThrow(/WHOOP_MCP_TOKEN_DIR must be an absolute path/);
      expect(() => resolveTokenDir()).toThrow(/\/data/);
    }
  );

  it("saves, loads and deletes tokens in WHOOP_MCP_TOKEN_DIR when no folder is passed", async () => {
    const dir = join(tempDir, "volume", "whoop");
    process.env[TOKEN_DIR_ENV] = dir;

    await saveTokens(tokens);
    expect(JSON.parse(await readFile(join(dir, "tokens.json"), "utf-8"))).toEqual(tokens);
    expect(await loadTokens()).toEqual(tokens);

    await deleteTokens();
    expect(await readdir(dir)).toEqual([]);
  });

  it("rejects token file operations for a relative WHOOP_MCP_TOKEN_DIR", async () => {
    process.env[TOKEN_DIR_ENV] = "relative/dir";
    await expect(saveTokens(tokens)).rejects.toThrow(/absolute path/);
    await expect(loadTokens()).rejects.toThrow(/absolute path/);
    await expect(deleteTokens()).rejects.toThrow(/absolute path/);
  });

  it("logs a folder under the home directory with ~, never the user name", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    process.env[TOKEN_DIR_ENV] = join(homedir(), ".whoop-mcp-test-missing-folder");

    expect(await loadTokens()).toBeNull();

    const logged = errSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(logged).toContain(join("~", ".whoop-mcp-test-missing-folder"));
    expect(logged).not.toContain(homedir());
  });
});

// ---------------------------------------------------------------------------
// Task 3b: Save tokens to disk
// ---------------------------------------------------------------------------

describe("saveTokens", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "whoop-mcp-test-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true });
  });

  const sampleTokens: OAuthTokens = {
    access_token: "access_abc",
    refresh_token: "refresh_xyz",
    expires_at: Date.now() + 3600_000,
    token_type: "Bearer",
  };

  it("writes valid JSON to the token file", async () => {
    await saveTokens(sampleTokens, tempDir);

    const raw = await readFile(join(tempDir, "tokens.json"), "utf-8");
    const parsed = JSON.parse(raw) as OAuthTokens;

    expect(parsed.access_token).toBe("access_abc");
    expect(parsed.refresh_token).toBe("refresh_xyz");
    expect(parsed.token_type).toBe("Bearer");
    expect(parsed.expires_at).toBe(sampleTokens.expires_at);
  });

  it("creates the directory if it does not exist", async () => {
    const nestedDir = join(tempDir, "nested");
    await saveTokens(sampleTokens, nestedDir);

    const dirStat = await stat(nestedDir);
    expect(dirStat.isDirectory()).toBe(true);
  });

  it.skipIf(POSIX_PERMISSIONS_UNSUPPORTED)(
    "creates the directory with 0700 permissions",
    async () => {
      const nestedDir = join(tempDir, "nested");
      await saveTokens(sampleTokens, nestedDir);

      const dirStat = await stat(nestedDir);
      // 0o700 = owner rwx, group/other none. mode & 0o777 masks file type bits.
      const dirMode = dirStat.mode & 0o777;
      expect(dirMode).toBe(0o700);
    }
  );

  it.skipIf(POSIX_PERMISSIONS_UNSUPPORTED)(
    "creates the token file with 0600 permissions",
    async () => {
      await saveTokens(sampleTokens, tempDir);

      const fileStat = await stat(join(tempDir, "tokens.json"));
      const fileMode = fileStat.mode & 0o777;
      expect(fileMode).toBe(0o600);
    }
  );

  it("overwrites existing token file", async () => {
    await saveTokens(sampleTokens, tempDir);

    const updatedTokens: OAuthTokens = {
      ...sampleTokens,
      access_token: "new_access",
    };
    await saveTokens(updatedTokens, tempDir);

    const raw = await readFile(join(tempDir, "tokens.json"), "utf-8");
    const parsed = JSON.parse(raw) as OAuthTokens;
    expect(parsed.access_token).toBe("new_access");
  });
});

// ---------------------------------------------------------------------------
// Task 3c: Load tokens from disk
// ---------------------------------------------------------------------------

describe("loadTokens", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "whoop-mcp-test-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true });
  });

  const sampleTokens: OAuthTokens = {
    access_token: "access_abc",
    refresh_token: "refresh_xyz",
    expires_at: Date.now() + 3600_000,
    token_type: "Bearer",
  };

  it("returns parsed OAuthTokens when file exists with valid JSON", async () => {
    await saveTokens(sampleTokens, tempDir);

    const loaded = await loadTokens(tempDir);

    expect(loaded).not.toBeNull();
    expect(loaded!.access_token).toBe("access_abc");
    expect(loaded!.refresh_token).toBe("refresh_xyz");
    expect(loaded!.token_type).toBe("Bearer");
    expect(loaded!.expires_at).toBe(sampleTokens.expires_at);
  });

  it("returns null when file does not exist", async () => {
    const loaded = await loadTokens(tempDir);

    expect(loaded).toBeNull();
  });

  it("returns null when file contains invalid JSON", async () => {
    const { writeFile } = await import("node:fs/promises");
    await writeFile(join(tempDir, "tokens.json"), "not valid json{{{", "utf-8");

    const loaded = await loadTokens(tempDir);

    expect(loaded).toBeNull();
  });

  it("round-trips: saveTokens then loadTokens returns same data", async () => {
    await saveTokens(sampleTokens, tempDir);
    const loaded = await loadTokens(tempDir);

    expect(loaded).toEqual(sampleTokens);
  });

  it("returns null when file contains JSON with missing access_token", async () => {
    const { writeFile } = await import("node:fs/promises");
    const invalid = { refresh_token: "r", expires_at: 123, token_type: "Bearer" };
    await writeFile(join(tempDir, "tokens.json"), JSON.stringify(invalid), "utf-8");

    const loaded = await loadTokens(tempDir);
    expect(loaded).toBeNull();
  });

  it("returns null when file contains JSON with missing refresh_token", async () => {
    const { writeFile } = await import("node:fs/promises");
    const invalid = { access_token: "a", expires_at: 123, token_type: "Bearer" };
    await writeFile(join(tempDir, "tokens.json"), JSON.stringify(invalid), "utf-8");

    const loaded = await loadTokens(tempDir);
    expect(loaded).toBeNull();
  });

  it("returns null when file contains JSON with missing expires_at", async () => {
    const { writeFile } = await import("node:fs/promises");
    const invalid = { access_token: "a", refresh_token: "r", token_type: "Bearer" };
    await writeFile(join(tempDir, "tokens.json"), JSON.stringify(invalid), "utf-8");

    const loaded = await loadTokens(tempDir);
    expect(loaded).toBeNull();
  });

  it("returns null when file contains JSON with wrong types", async () => {
    const { writeFile } = await import("node:fs/promises");
    const invalid = { access_token: 123, refresh_token: "r", expires_at: "not-a-number" };
    await writeFile(join(tempDir, "tokens.json"), JSON.stringify(invalid), "utf-8");

    const loaded = await loadTokens(tempDir);
    expect(loaded).toBeNull();
  });

  it("returns null when file contains a JSON array instead of object", async () => {
    const { writeFile } = await import("node:fs/promises");
    await writeFile(join(tempDir, "tokens.json"), "[]", "utf-8");

    const loaded = await loadTokens(tempDir);
    expect(loaded).toBeNull();
  });

  it("returns null when file contains JSON null", async () => {
    const { writeFile } = await import("node:fs/promises");
    await writeFile(join(tempDir, "tokens.json"), "null", "utf-8");

    const loaded = await loadTokens(tempDir);
    expect(loaded).toBeNull();
  });

  it("returns null when access_token is an empty string", async () => {
    const { writeFile } = await import("node:fs/promises");
    const invalid = { access_token: "", refresh_token: "r", expires_at: 123, token_type: "Bearer" };
    await writeFile(join(tempDir, "tokens.json"), JSON.stringify(invalid), "utf-8");

    const loaded = await loadTokens(tempDir);
    expect(loaded).toBeNull();
  });

  it("returns null when refresh_token is an empty string", async () => {
    const { writeFile } = await import("node:fs/promises");
    const invalid = { access_token: "a", refresh_token: "", expires_at: 123, token_type: "Bearer" };
    await writeFile(join(tempDir, "tokens.json"), JSON.stringify(invalid), "utf-8");

    const loaded = await loadTokens(tempDir);
    expect(loaded).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Task 3d: Delete tokens from disk
// ---------------------------------------------------------------------------

describe("deleteTokens", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "whoop-mcp-test-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true });
  });

  const sampleTokens: OAuthTokens = {
    access_token: "access_abc",
    refresh_token: "refresh_xyz",
    expires_at: Date.now() + 3600_000,
    token_type: "Bearer",
  };

  it("removes the token file", async () => {
    await saveTokens(sampleTokens, tempDir);
    await deleteTokens(tempDir);

    const loaded = await loadTokens(tempDir);
    expect(loaded).toBeNull();
  });

  it("does not throw if file does not exist", async () => {
    // tempDir exists but has no tokens.json — should not throw
    await expect(deleteTokens(tempDir)).resolves.toBeUndefined();
  });

  it("after delete, loadTokens returns null", async () => {
    await saveTokens(sampleTokens, tempDir);

    // Confirm it exists
    const before = await loadTokens(tempDir);
    expect(before).not.toBeNull();

    // Delete and confirm
    await deleteTokens(tempDir);
    const after = await loadTokens(tempDir);
    expect(after).toBeNull();
  });

  it.skipIf(POSIX_PERMISSIONS_UNSUPPORTED)(
    "rethrows non-ENOENT errors (e.g., permission denied)",
    async () => {
      await saveTokens(sampleTokens, tempDir);

      // Make the directory non-writable so unlink fails with EACCES, not ENOENT
      await chmod(tempDir, 0o444);

      try {
        await expect(deleteTokens(tempDir)).rejects.toThrow();
      } finally {
        // Restore permissions so afterEach cleanup works
        await chmod(tempDir, 0o755);
      }
    }
  );
});

// ---------------------------------------------------------------------------
// saveTokens must not lose tokens WHOOP already rotated (R20)
// ---------------------------------------------------------------------------

describe("saveTokens when the atomic rename is not possible", () => {
  let tempDir: string;
  const originalPlatform = process.platform;

  const oldTokens: OAuthTokens = {
    access_token: "A0",
    refresh_token: "R0",
    expires_at: Date.now(),
    token_type: "Bearer",
  };
  const newTokens: OAuthTokens = {
    access_token: "A1",
    refresh_token: "R1",
    expires_at: Date.now() + 3600_000,
    token_type: "Bearer",
  };

  function setPlatform(platform: NodeJS.Platform): void {
    Object.defineProperty(process, "platform", { value: platform, configurable: true });
  }

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "whoop-mcp-test-"));
    await saveTokens(oldTokens, tempDir);
  });

  afterEach(async () => {
    fsFaults.rename = null;
    fsFaults.writeFile = null;
    setPlatform(originalPlatform);
    await rm(tempDir, { recursive: true });
  });

  it.each(["EBUSY", "EXDEV", "EPERM", "EACCES"])(
    "falls back to an in-place write when rename fails with %s (e.g. a single-file bind mount)",
    async (code) => {
      setPlatform("linux");
      const renames: string[] = [];
      fsFaults.rename = (_from, to): Promise<void> => {
        renames.push(to);
        return Promise.reject(fsError(code));
      };

      await expect(saveTokens(newTokens, tempDir)).resolves.toBeUndefined();

      expect(renames).toHaveLength(1);
      expect(await loadTokens(tempDir)).toEqual(newTokens);
      expect(await readdir(tempDir)).toEqual(["tokens.json"]);
    }
  );

  it("retries a rename blocked by another handle on Windows before falling back", async () => {
    setPlatform("win32");
    let attempts = 0;
    fsFaults.rename = (): Promise<void> | undefined => {
      attempts += 1;
      // Blocked twice (antivirus / indexer), then the real rename goes through
      return attempts <= 2 ? Promise.reject(fsError("EPERM")) : undefined;
    };

    await saveTokens(newTokens, tempDir);

    expect(attempts).toBe(3);
    expect(await loadTokens(tempDir)).toEqual(newTokens);
    expect(await readdir(tempDir)).toEqual(["tokens.json"]);
  });

  it("falls back to an in-place write when the temp file cannot be created", async () => {
    fsFaults.writeFile = (path): Promise<void> | undefined =>
      path.endsWith(".tmp") ? Promise.reject(fsError("EROFS")) : undefined;

    await saveTokens(newTokens, tempDir);

    expect(await loadTokens(tempDir)).toEqual(newTokens);
    expect(await readdir(tempDir)).toEqual(["tokens.json"]);
  });

  it("rethrows other errors and never leaves a temp copy of the tokens behind", async () => {
    fsFaults.rename = (): Promise<void> => Promise.reject(fsError("ENOSPC"));

    await expect(saveTokens(newTokens, tempDir)).rejects.toMatchObject({ code: "ENOSPC" });

    expect(await loadTokens(tempDir)).toEqual(oldTokens);
    expect(await readdir(tempDir)).toEqual(["tokens.json"]);
  });

  it("uses a distinct temp file per save", async () => {
    const temps: string[] = [];
    fsFaults.rename = (from): undefined => {
      temps.push(from);
      return undefined;
    };

    await Promise.all([saveTokens(newTokens, tempDir), saveTokens(newTokens, tempDir)]);

    expect(new Set(temps).size).toBe(2);
    expect(await loadTokens(tempDir)).toEqual(newTokens);
  });
});
