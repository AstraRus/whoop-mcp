/**
 * docker/entrypoint.sh without Docker: the script runs under `sh` with shims
 * for the commands that need root or a container (id, mkdir, chown, chmod,
 * su-exec, node), so the token-folder decision is checked in every test run.
 *
 * Regression: the 0.8.0 entrypoint first defaulted the token folder to
 * /root/.whoop-mcp. On Railway (HOME=/home/node, volume mounted at
 * /home/node/.whoop-mcp, the folder 0.7.x used through os.homedir()) the server
 * then found no tokens.json, started the WHOOP sign-in and never served
 * /health. The default must be $HOME/.whoop-mcp, and the server (which runs
 * with HOME=/home/node) must receive it through WHOOP_MCP_TOKEN_DIR.
 *
 * The real container layouts are covered by .github/workflows/docker-smoke.yml.
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

const shAvailable = ((): boolean => {
  try {
    const result = spawnSync("sh", ["-c", "exit 0"], { stdio: "ignore", timeout: 10_000 });
    return result.error === undefined && result.status === 0;
  } catch {
    return false;
  }
})();

/** Shims: each records its call in $CALLS. */
const SHIMS: Record<string, string> = {
  // `id -u` is the caller (SHIM_UID, default root); `id -u node` is 1000.
  id: `#!/bin/sh
echo "id $*" >> "$CALLS"
if [ "$1" = "-u" ] && [ -n "\${2:-}" ]; then echo 1000; exit 0; fi
echo "\${SHIM_UID:-0}"
`,
  mkdir: `#!/bin/sh
echo "mkdir $*" >> "$CALLS"
exit 0
`,
  chown: `#!/bin/sh
echo "chown $*" >> "$CALLS"
if [ "\${CHOWN_REFUSE:-}" = 1 ]; then exit 1; fi
exit 0
`,
  chmod: `#!/bin/sh
echo "chmod $*" >> "$CALLS"
exit 0
`,
  // Probe calls (su-exec node sh -c ...) succeed; the final exec reports what
  // the server process would get.
  "su-exec": `#!/bin/sh
if [ "\${2:-}" = "sh" ]; then echo "probe $*" >> "$CALLS"; exit 0; fi
user="$1"; shift
echo "SERVER user=$user HOME=\${HOME-<unset>} WHOOP_MCP_TOKEN_DIR=\${WHOOP_MCP_TOKEN_DIR-<unset>} cmd=$*"
`,
  // The server started directly (root fallback, or a non-root caller).
  node: `#!/bin/sh
echo "SERVER user=direct HOME=\${HOME-<unset>} WHOOP_MCP_TOKEN_DIR=\${WHOOP_MCP_TOKEN_DIR-<unset>} cmd=node $*"
`,
};

// Runs the copied entrypoint with only the given variables (plus PATH with the
// shims first and CALLS). Paths are built inside sh from $PWD so they are POSIX
// paths on every platform.
const RUNNER = `
PATH="$PWD/bin:$PATH"
export PATH
exec env -i PATH="$PATH" CALLS="$PWD/calls.log" "$@" sh ./entrypoint.sh node x
`;

interface Run {
  server: { user: string; home: string; tokenDir: string; cmd: string };
  logs: Array<{ ts: string; level: string; msg: string }>;
  calls: string[];
  status: number | null;
}

let work = "";

beforeAll(() => {
  if (!shAvailable) return;
  work = mkdtempSync(join(tmpdir(), "whoop-entrypoint-"));
  mkdirSync(join(work, "bin"));
  for (const [name, body] of Object.entries(SHIMS)) {
    writeFileSync(join(work, "bin", name), body, { mode: 0o755 });
  }
  // As the Dockerfile does: normalize line endings.
  const script = readFileSync(join(ROOT, "docker", "entrypoint.sh"), "utf8").replace(/\r$/gm, "");
  writeFileSync(join(work, "entrypoint.sh"), script, { mode: 0o755 });
});

afterAll(() => {
  if (work !== "") rmSync(work, { recursive: true, force: true });
});

/** Runs the entrypoint with exactly `vars` (NAME=value) in its environment. */
function runEntrypoint(vars: Record<string, string>): Run {
  writeFileSync(join(work, "calls.log"), "");
  const result = spawnSync(
    "sh",
    ["-c", RUNNER, "runner", ...Object.entries(vars).map(([k, v]) => `${k}=${v}`)],
    { cwd: work, encoding: "utf8", timeout: 20_000 }
  );
  const line = result.stdout.split(/\r?\n/).find((l) => l.startsWith("SERVER "));
  expect(line, `no server start; stderr: ${result.stderr}`).toBeDefined();
  const match =
    /^SERVER user=(\S+) HOME=(\S+) WHOOP_MCP_TOKEN_DIR=(\S+) cmd=(.*)$/.exec(line!) ?? undefined;
  expect(match, line).toBeDefined();
  const logs = result.stderr
    .split(/\r?\n/)
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as { ts: string; level: string; msg: string });
  return {
    server: { user: match![1]!, home: match![2]!, tokenDir: match![3]!, cmd: match![4]! },
    logs,
    calls: readFileSync(join(work, "calls.log"), "utf8").split(/\r?\n/).filter(Boolean),
    status: result.status,
  };
}

interface Layout {
  layout: string;
  vars: Record<string, string>;
  dir: string;
}

describe.skipIf(!shAvailable)("docker/entrypoint.sh token folder", () => {
  it.each<Layout>([
    { layout: "plain Docker (HOME=/root)", vars: { HOME: "/root" }, dir: "/root/.whoop-mcp" },
    {
      layout: "Railway (HOME=/home/node, volume at /home/node/.whoop-mcp)",
      vars: {
        HOME: "/home/node",
        PORT: "8080",
        MCP_TRUST_PROXY: "1",
        PUBLIC_URL: "https://smoke.up.railway.app",
      },
      dir: "/home/node/.whoop-mcp",
    },
    { layout: "HOME unset", vars: {}, dir: "/root/.whoop-mcp" },
    {
      layout: "WHOOP_MCP_TOKEN_DIR=/data",
      vars: { HOME: "/home/node", WHOOP_MCP_TOKEN_DIR: "/data" },
      dir: "/data",
    },
  ])("$layout: prepares $dir and runs the server as node with it", ({ vars, dir }) => {
    const run = runEntrypoint(vars);
    expect(run.status).toBe(0);
    expect(run.server).toEqual({
      user: "node",
      home: "/home/node",
      tokenDir: dir,
      cmd: "node x",
    });
    expect(run.calls).toContain(`chown node:node ${dir}`);
    expect(run.calls).toContain(`chmod 700 ${dir}`);
    // Only a folder below /root needs /root to be traversable.
    expect(run.calls.includes("chmod 711 /root")).toBe(dir.startsWith("/root/"));
    for (const call of run.calls.filter((c) => c.startsWith("chown") || c.startsWith("chmod"))) {
      expect(call.startsWith("chmod 711 /root") || call.includes(dir), call).toBe(true);
    }
    expect(run.logs).toHaveLength(1);
    expect(run.logs[0]).toMatchObject({
      level: "info",
      msg: "entrypoint: running as node (uid 1000); token folder prepared",
    });
  });

  it("never falls back to /root/.whoop-mcp when HOME points elsewhere", () => {
    const run = runEntrypoint({ HOME: "/home/node" });
    expect(run.server.tokenDir).toBe("/home/node/.whoop-mcp");
    expect(run.calls.some((c) => c.includes("/root"))).toBe(false);
  });

  it("keeps running as root with the same folder when chown is refused", () => {
    const run = runEntrypoint({ HOME: "/home/node", CHOWN_REFUSE: "1" });
    expect(run.status).toBe(0);
    expect(run.server).toEqual({
      user: "direct",
      home: "/home/node",
      tokenDir: "/home/node/.whoop-mcp",
      cmd: "node x",
    });
    expect(run.logs).toHaveLength(1);
    expect(run.logs[0]!.level).toBe("warn");
    expect(run.logs[0]!.msg).toBe(
      "entrypoint: running as root (cannot change the owner of the token folder); the server still works, see docs/deploy-railway.md"
    );
    expect(run.logs[0]!.ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    // The warning must not send anyone to a folder without the tokens.
    expect(run.logs[0]!.msg).not.toContain("/data");
  });

  it("WHOOP_MCP_RUN_AS_ROOT=1 keeps root and still exports the folder", () => {
    const run = runEntrypoint({ HOME: "/home/node", WHOOP_MCP_RUN_AS_ROOT: "1" });
    expect(run.server).toMatchObject({ user: "direct", tokenDir: "/home/node/.whoop-mcp" });
    expect(run.logs[0]!.msg).toBe(
      "entrypoint: running as root (WHOOP_MCP_RUN_AS_ROOT=1); the server still works, see docs/deploy-railway.md"
    );
    expect(run.calls.some((c) => c.startsWith("chown"))).toBe(false);
  });

  it("changes nothing for a non-root caller", () => {
    const run = runEntrypoint({ HOME: "/home/node", SHIM_UID: "1000" });
    expect(run.server).toEqual({
      user: "direct",
      home: "/home/node",
      tokenDir: "<unset>",
      cmd: "node x",
    });
    expect(run.logs).toEqual([]);
    expect(run.calls.some((c) => c.startsWith("chown") || c.startsWith("mkdir"))).toBe(false);
  });
});
