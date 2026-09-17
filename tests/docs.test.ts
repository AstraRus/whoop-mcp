/**
 * Documentation stays in step with the code:
 * - README has a tool reference heading and a privacy matrix row for every tool
 *   of either privacy mode, and matrix rows for every resource and prompt;
 * - every environment variable read in src/ (process.env.NAME,
 *   process.env["NAME"], getRequiredEnv("NAME"), env.NAME on an injected
 *   environment, env[CONSTANT] resolved through its string constant) and by the
 *   container entrypoint appears in the README environment table, and the
 *   table lists nothing the code does not read;
 * - the CHANGELOG has a heading for the package version, and server.json
 *   carries the same version;
 * - the counts the README and CLAUDE.md state match the server.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PrivacyMode } from "../src/privacy.js";
import { connectServer, type ContractConnection } from "./helpers/contract.js";
import { createWhoopFixtureClient } from "./helpers/whoop-fixture-client.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path: string): string =>
  readFileSync(join(ROOT, path), "utf8").replace(/\r\n/g, "\n");

const README = read("README.md");
const CHANGELOG = read("CHANGELOG.md");
const CLAUDE = read("CLAUDE.md");
const RAILWAY = read("docs/deploy-railway.md");

const MODES = ["standard", "aggregate"] as const;

/** The variables the release plan requires in the environment table. */
const REQUIRED_ENV_NAMES = [
  "WHOOP_CLIENT_ID",
  "WHOOP_CLIENT_SECRET",
  "MCP_AUTH_TOKEN",
  "MCP_TRANSPORT",
  "MCP_PORT",
  "PORT",
  "MCP_HOST",
  "MCP_ALLOWED_ORIGINS",
  "MCP_TRUST_PROXY",
  "MCP_MAX_CONNECTIONS",
  "LOG_LEVEL",
  "LOG_FORMAT",
  "WHOOP_MCP_PRIVACY_MODE",
  "WHOOP_MCP_DISABLE_RESOURCES",
  "CALLBACK_HOST",
  "CALLBACK_TIMEOUT_MS",
  "WHOOP_REDIRECT_URI",
  "APPDATA",
  "WHOOP_MCP_TOKEN_DIR",
  "WHOOP_MCP_RUN_AS_ROOT",
  "WHOOP_RATE_LIMIT_PER_MINUTE",
  "WHOOP_WEBHOOKS",
  "WHOOP_CLIENT_SECRET_PREVIOUS",
  "MCP_CONNECTOR_PASSWORD",
  "PUBLIC_URL",
  "ALLOWED_REDIRECT_URIS",
  "MCP_JWT_SECRET",
  "MCP_OAUTH_CLIENT_ID",
  "RAILWAY_GIT_COMMIT_SHA",
  "SOURCE_COMMIT",
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sourceFiles(directory: string): string[] {
  return readdirSync(join(ROOT, directory)).flatMap((entry) => {
    const path = `${directory}/${entry}`;
    if (statSync(join(ROOT, path)).isDirectory()) return sourceFiles(path);
    return path.endsWith(".ts") ? [path] : [];
  });
}

const NAME = "[A-Z][A-Z0-9_]*";

/** Environment variable names read in `text` (see the file header for the patterns). */
function envNamesIn(text: string, constants: ReadonlyMap<string, string>): Set<string> {
  const names = new Set<string>();
  const patterns = [
    new RegExp(`process\\.env\\.(${NAME})`, "g"),
    new RegExp(`process\\.env\\[\\s*["'\`](${NAME})["'\`]\\s*\\]`, "g"),
    new RegExp(`getRequiredEnv\\(\\s*["'\`](${NAME})["'\`]\\s*\\)`, "g"),
    new RegExp(`\\benv\\??\\.(${NAME})\\b`, "g"),
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) names.add(match[1]!);
  }
  for (const match of text.matchAll(new RegExp(`\\benv\\[\\s*(${NAME})\\s*\\]`, "g"))) {
    const resolved = constants.get(match[1]!);
    if (resolved === undefined) throw new Error(`env[${match[1]}] uses an unknown constant`);
    names.add(resolved);
  }
  return names;
}

/** String constants declared anywhere in src/: `const NAME = "VALUE"`. */
function stringConstants(texts: readonly string[]): Map<string, string> {
  const constants = new Map<string, string>();
  for (const text of texts) {
    for (const match of text.matchAll(
      new RegExp(`\\bconst\\s+(${NAME})\\s*=\\s*["'](${NAME})["']`, "g")
    )) {
      constants.set(match[1]!, match[2]!);
    }
  }
  return constants;
}

/** The markdown section starting at `heading` up to the next heading of the same level. */
function section(markdown: string, heading: string): string {
  const start = markdown.indexOf(`\n${heading}\n`);
  expect(start, `section ${heading}`).toBeGreaterThanOrEqual(0);
  const level = heading.match(/^#+/)![0];
  const rest = markdown.slice(start + heading.length + 2);
  const next = rest.search(new RegExp(`^${level} `, "m"));
  return next === -1 ? rest : rest.slice(0, next);
}

/** The trimmed cells of every markdown table row in `markdown` (column padding ignored). */
function tableRows(markdown: string): string[][] {
  return markdown
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("|") && line.endsWith("|"))
    .map((line) =>
      line
        .slice(1, -1)
        .split("|")
        .map((cell) => cell.trim())
    );
}

/** Names written as code in the first cell of a markdown table (`| \`name\` | ...`). */
function tableNames(markdown: string): string[] {
  return tableRows(markdown).flatMap((cells) => {
    const match = /^`([^`]+)`$/.exec(cells[0] ?? "");
    return match ? [match[1]!] : [];
  });
}

/** The cells of the table row whose first cell is `\`name\`` (and second `kind`, when given). */
function rowFor(markdown: string, name: string, kind?: string): string[] | undefined {
  return tableRows(markdown).find(
    (cells) => cells[0] === `\`${name}\`` && (kind === undefined || cells[1] === kind)
  );
}

// ---------------------------------------------------------------------------
// Server inventory
// ---------------------------------------------------------------------------

interface Inventory {
  tools: string[];
  resources: string[];
  prompts: string[];
}

const inventory = new Map<PrivacyMode, Inventory>();

beforeAll(async () => {
  for (const mode of MODES) {
    const connection: ContractConnection = await connectServer(createWhoopFixtureClient(), {
      privacyMode: mode,
    });
    try {
      inventory.set(mode, {
        tools: (await connection.listTools()).map((tool) => tool.name),
        resources: (await connection.listResources()).map((resource) => resource.uri),
        prompts: (await connection.listPrompts()).map((prompt) => prompt.name),
      });
    } finally {
      await connection.close();
    }
  }
});

afterAll(() => {
  inventory.clear();
});

function union(key: keyof Inventory): string[] {
  return [...new Set(MODES.flatMap((mode) => inventory.get(mode)![key]))].sort();
}

// ---------------------------------------------------------------------------
// README tool reference and privacy matrix
// ---------------------------------------------------------------------------

describe("README tool reference", () => {
  it("has a heading for every tool of both privacy modes", () => {
    const tools = union("tools");
    expect(tools.length).toBe(28);
    for (const tool of tools) {
      expect(README, `### \`${tool}\``).toMatch(new RegExp(`^### \`${tool}\`$`, "m"));
    }
  });

  it("has no heading for a tool the server does not register", () => {
    const tools = new Set(union("tools"));
    const headings = [...README.matchAll(/^### `([a-z][a-z0-9_]+)`$/gm)].map((match) => match[1]!);
    for (const heading of headings) expect(tools.has(heading), heading).toBe(true);
  });

  it("lists the WHOOP calls of every tool", () => {
    for (const tool of union("tools")) {
      const reference = section(README, `### \`${tool}\``);
      expect(reference, tool).toContain("**WHOOP calls:**");
    }
  });
});

describe("README privacy matrix", () => {
  const matrix = (): string => section(README, "## Privacy modes");

  it("has a row for every tool with its availability per mode", () => {
    const text = matrix();
    const aggregateTools = new Set(inventory.get("aggregate")!.tools);
    for (const tool of union("tools")) {
      const cells = rowFor(text, tool, "tool");
      expect(cells, `privacy matrix row for ${tool}`).toBeDefined();
      expect(cells![2], `${tool} standard`).toBe("yes");
      if (aggregateTools.has(tool)) expect(cells![3], `${tool} aggregate`).not.toBe("—");
      else expect(cells![3], `${tool} aggregate`).toBe("—");
    }
  });

  it("has a row for every resource and names every prompt", () => {
    const text = matrix();
    const aggregateResources = new Set(inventory.get("aggregate")!.resources);
    for (const uri of union("resources")) {
      const cells = rowFor(text, uri, "resource");
      expect(cells, `privacy matrix row for ${uri}`).toBeDefined();
      expect(cells![3] !== "—", `${uri} aggregate`).toBe(aggregateResources.has(uri));
    }
    for (const prompt of union("prompts")) expect(text, prompt).toContain(`\`${prompt}\``);
  });

  it("describes released weeks, the 2-day lag and the minimal get_sync_status", () => {
    const text = matrix();
    expect(text).toContain("released two days after it ends");
    expect(text).toContain("at least 3 samples");
    expect(rowFor(text, "get_sync_status", "tool")?.[3]).toMatch(/^minimal/);
  });
});

describe("README resources and prompts", () => {
  it("documents every resource and prompt", () => {
    const resources = tableNames(section(README, "## Resources"));
    expect(resources.sort()).toEqual(union("resources"));
    const prompts = tableNames(section(README, "## Prompts"));
    expect(prompts.sort()).toEqual(union("prompts"));
  });

  it("states the counts the server registers", () => {
    const standard = inventory.get("standard")!;
    expect(README).toContain(`**${standard.tools.length} read-only tools**`);
    expect(README).toContain(`**${standard.resources.length} MCP resources**`);
    expect(README).toContain(`**${standard.prompts.length} MCP prompts**`);
    expect(README).toContain(`**${inventory.get("aggregate")!.tools.length} tools** that release`);
    expect(CLAUDE).toContain(
      `standard mode: ${standard.tools.length} tools, ${standard.resources.length} resources, ${standard.prompts.length} prompts`
    );
  });
});

// ---------------------------------------------------------------------------
// Environment variables
// ---------------------------------------------------------------------------

describe("README environment table", () => {
  const files = sourceFiles("src");
  const texts = files.map(read);
  const constants = stringConstants(texts);
  const fromSource = new Set(texts.flatMap((text) => [...envNamesIn(text, constants)]));
  const entrypoint = read("docker/entrypoint.sh");
  const fromEntrypoint = new Set(
    [...entrypoint.matchAll(new RegExp(`\\$\\{(${NAME}):-`, "g"))].map((match) => match[1]!)
  );
  const table = (): string[] => tableNames(section(README, "### Environment variables"));

  it("finds variables through every read pattern", () => {
    // process.env.NAME
    expect(fromSource.has("MCP_TRANSPORT")).toBe(true);
    // getRequiredEnv("NAME")
    expect(fromSource.has("MCP_AUTH_TOKEN")).toBe(true);
    // process.env[CONSTANT] with const TOKEN_DIR_ENV = "WHOOP_MCP_TOKEN_DIR"
    expect(fromSource.has("WHOOP_MCP_TOKEN_DIR")).toBe(true);
    // env.NAME on an injected environment
    expect(fromSource.has("PORT")).toBe(true);
    expect(fromSource.has("SOURCE_COMMIT")).toBe(true);
    // The entrypoint's defaulted reads
    expect(fromEntrypoint.has("WHOOP_MCP_RUN_AS_ROOT")).toBe(true);
    expect(
      [...envNamesIn("process.env[\"A_B\"]; getRequiredEnv('C_D'); env.E_F", new Map())].sort()
    ).toEqual(["A_B", "C_D", "E_F"]);
  });

  it("lists every variable read in src/ and by the entrypoint", () => {
    const documented = new Set(table());
    for (const name of [...fromSource, ...fromEntrypoint].sort()) {
      expect(documented.has(name), `${name} missing from the README environment table`).toBe(true);
    }
  });

  it("lists the variables the release requires", () => {
    const documented = new Set(table());
    for (const name of REQUIRED_ENV_NAMES) expect(documented.has(name), name).toBe(true);
  });

  it("lists nothing the code does not read", () => {
    const read = new Set([...fromSource, ...fromEntrypoint]);
    for (const name of table()) expect(read.has(name), `${name} is not read anywhere`).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Release metadata and runbook
// ---------------------------------------------------------------------------

describe("release metadata", () => {
  const pkg = JSON.parse(read("package.json")) as { version: string };
  const server = JSON.parse(read("server.json")) as {
    version: string;
    packages: Array<{ version: string }>;
  };

  it("has a CHANGELOG heading for the package version", () => {
    expect(pkg.version).toBe("0.8.0");
    expect(CHANGELOG).toMatch(
      new RegExp(`^## \\[${pkg.version.replace(/\./g, "\\.")}\\] - \\d{4}-\\d{2}-\\d{2}$`, "m")
    );
    expect(CHANGELOG).toMatch(new RegExp(`^\\[${pkg.version.replace(/\./g, "\\.")}\\]: `, "m"));
  });

  it("has the 0.8.0 changelog sections", () => {
    const entry = section(CHANGELOG, "## [0.8.0] - 2026-09-17");
    for (const heading of [
      "### Added",
      "### Changed",
      "### Fixed",
      "### Security",
      "### Compatibility",
    ]) {
      expect(entry, heading).toContain(`\n${heading}\n`);
    }
    expect(entry).toContain("Breaking for aggregate privacy mode");
    expect(entry).toContain("Sleep hours are time asleep");
  });

  it("uses the package version in server.json", () => {
    expect(server.version).toBe(pkg.version);
    for (const entry of server.packages) expect(entry.version).toBe(pkg.version);
    expect(CLAUDE).toContain(`Version ${pkg.version}`);
  });
});

describe("Railway runbook", () => {
  it("covers the volume, first sign-in, rotation, degraded startup, rollback and single instance", () => {
    for (const text of [
      "WHOOP_MCP_TOKEN_DIR=/data",
      "/root/.whoop-mcp",
      "First WHOOP sign-in on the hosted server",
      "Rotating secrets",
      "Without `MCP_JWT_SECRET`",
      "Degraded startup",
      "Rollback",
      "Never run two instances with the same `tokens.json`",
    ]) {
      expect(RAILWAY, text).toContain(text);
    }
  });
});
