import { lstat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { resolveTokenDir, TOKEN_DIR_ENV } from "../auth/token-store.js";
import { privacyModeSchema } from "../privacy.js";

export interface DoctorDependencies {
  env: NodeJS.ProcessEnv;
  nodeVersion: string;
  platform: NodeJS.Platform;
  inspectToken: () => Promise<{
    exists: boolean;
    regular: boolean;
    mode: number;
    directoryMode: number;
  }>;
  write: (text: string) => void;
}

/** Where the token folder comes from: the default, WHOOP_MCP_TOKEN_DIR, or an unusable value */
function tokenDirectorySource(
  env: NodeJS.ProcessEnv
): "default" | "WHOOP_MCP_TOKEN_DIR" | "invalid" {
  const value = env[TOKEN_DIR_ENV];
  if (value === undefined || value.trim() === "") return "default";
  return isAbsolute(value) ? "WHOOP_MCP_TOKEN_DIR" : "invalid";
}

async function inspectToken(): ReturnType<DoctorDependencies["inspectToken"]> {
  // Throws for a relative WHOOP_MCP_TOKEN_DIR; runDoctor reports that as a failed check.
  const directory = resolveTokenDir();
  const [folder, file] = await Promise.all([
    lstat(directory),
    lstat(join(directory, "tokens.json")),
  ]);
  return {
    exists: true,
    regular:
      folder.isDirectory() && !folder.isSymbolicLink() && file.isFile() && !file.isSymbolicLink(),
    mode: file.mode & 0o777,
    directoryMode: folder.mode & 0o777,
  };
}

export async function runDoctor(
  args: string[],
  dependencies: DoctorDependencies = {
    env: process.env,
    nodeVersion: process.versions.node,
    platform: process.platform,
    inspectToken,
    write: (text) => {
      process.stdout.write(`${text}\n`);
    },
  }
): Promise<number> {
  if (args.length > 1 || args.some((arg) => arg !== "--json")) {
    dependencies.write("Usage: whoop-ai-mcp doctor [--json]");
    return 2;
  }
  const { env } = dependencies;
  const transport = (env.MCP_TRANSPORT ?? "stdio").trim().toLowerCase();
  const privacy = privacyModeSchema.safeParse(env.WHOOP_MCP_PRIVACY_MODE ?? "standard");
  const port = Number(env.MCP_PORT ?? "3000");
  const tokenDirectory = tokenDirectorySource(env);
  const checks = {
    runtime: Number(dependencies.nodeVersion.split(".")[0]) >= 20,
    credentials_configured: Boolean(env.WHOOP_CLIENT_ID?.trim() && env.WHOOP_CLIENT_SECRET?.trim()),
    transport_configuration:
      ["stdio", "http", "both"].includes(transport) &&
      (transport === "stdio" ||
        (Boolean(env.MCP_AUTH_TOKEN?.trim()) &&
          Number.isInteger(port) &&
          port >= 0 &&
          port <= 65535)),
    privacy_configuration: privacy.success,
    token_directory_configuration: tokenDirectory !== "invalid",
    private_token_file: false,
  };
  try {
    const token = await dependencies.inspectToken();
    checks.private_token_file =
      dependencies.platform !== "win32" &&
      token.exists &&
      token.regular &&
      token.mode === 0o600 &&
      token.directoryMode === 0o700;
  } catch {
    checks.private_token_file = false;
  }
  const ready = Object.values(checks).every(Boolean);
  const report = {
    ready,
    checks,
    transport: ["stdio", "http", "both"].includes(transport) ? transport : "invalid",
    privacy_mode: privacy.success ? privacy.data : "invalid",
    token_directory: tokenDirectory,
    scope_status: "unknown",
    token_validity: "unknown",
    next_step:
      "Use setup --verify for explicit live authorization verification. No network requests were made.",
  };
  dependencies.write(
    args.includes("--json")
      ? JSON.stringify(report, null, 2)
      : [
          ready ? "Local checks passed." : "Local configuration needs attention.",
          ...Object.entries(checks).map(
            ([name, passed]) => `${name}: ${passed ? "pass" : "needs attention"}`
          ),
          report.next_step,
        ].join("\n")
  );
  return ready ? 0 : 1;
}
