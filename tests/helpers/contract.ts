/**
 * Contract-level access to the MCP server: a real McpServer and MCP Client over
 * an in-memory transport, as a connector would see it.
 *
 * connectServer lists the tools once on connect, which makes the SDK client
 * validate every structured result against the tool's advertised outputSchema
 * (a mismatch rejects callTool). Tool results must carry exactly one text
 * content item.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type {
  CallToolResult,
  GetPromptResult,
  Prompt,
  ReadResourceResult,
  Resource,
  Tool,
} from "@modelcontextprotocol/sdk/types.js";
import type { WhoopClient } from "../../src/api/client.js";
import type { MemoryCache } from "../../src/cache/memory-cache.js";
import type { Logger } from "../../src/logging/logger.js";
import type { PrivacyMode } from "../../src/privacy.js";
import type { RuntimeStatus } from "../../src/runtime-status.js";
import { createWhoopServer, type CreateServerOptions } from "../../src/server.js";
import { createWhoopFixtureClient } from "./whoop-fixture-client.js";

/** Options for {@link connectServer}. */
export interface ConnectServerOptions {
  /** Default "standard". */
  privacyMode?: PrivacyMode;
  disableResources?: boolean;
  /** History chunk cache for registry tools. */
  historyCache?: MemoryCache;
  /** Logical clock for registry tools. */
  now?: () => Date;
  runtimeStatus?: RuntimeStatus;
  logger?: Logger;
}

/** A tool result as a client sees it. */
export interface ToolCallOutcome {
  isError: boolean;
  /** The single text content item. */
  text: string;
  /** structuredContent, or null when the result has none. */
  structured: Record<string, unknown> | null;
}

/** A connected server/client pair. */
export interface ContractConnection {
  client: Client;
  server: McpServer;
  /** The tools listed on connect. */
  tools: Tool[];
  callTool(name: string, args?: Record<string, unknown>): Promise<ToolCallOutcome>;
  listTools(): Promise<Tool[]>;
  listResources(): Promise<Resource[]>;
  readResource(uri: string): Promise<ReadResourceResult>;
  listPrompts(): Promise<Prompt[]>;
  getPrompt(name: string, args?: Record<string, string>): Promise<GetPromptResult>;
  close(): Promise<void>;
}

/** Reduce a CallToolResult to its single text item and structured content. */
export function toToolCallOutcome(name: string, result: CallToolResult): ToolCallOutcome {
  const content = result.content;
  const first = content[0];
  if (content.length !== 1 || first?.type !== "text") {
    throw new Error(
      `${name} returned ${content.length} content item(s); expected exactly one text item`
    );
  }
  return {
    isError: result.isError === true,
    text: first.text,
    structured: (result.structuredContent as Record<string, unknown> | undefined) ?? null,
  };
}

/** Create a WHOOP MCP server for `whoopClient` and connect an MCP client to it. */
export async function connectServer(
  whoopClient: WhoopClient,
  options: ConnectServerOptions = {}
): Promise<ContractConnection> {
  const serverOptions: CreateServerOptions = {
    privacyMode: options.privacyMode ?? "standard",
    ...(options.disableResources !== undefined
      ? { disableResources: options.disableResources }
      : {}),
    ...(options.historyCache !== undefined ? { historyCache: options.historyCache } : {}),
    ...(options.now !== undefined ? { now: options.now } : {}),
    ...(options.runtimeStatus !== undefined ? { runtimeStatus: options.runtimeStatus } : {}),
    ...(options.logger !== undefined ? { logger: options.logger } : {}),
  };
  const { server } = createWhoopServer(whoopClient, serverOptions);
  const client = new Client({ name: "whoop-contract-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const { tools } = await client.listTools();

  return {
    client,
    server,
    tools,
    async callTool(name, args = {}) {
      const result = (await client.callTool({ name, arguments: args })) as CallToolResult;
      return toToolCallOutcome(name, result);
    },
    async listTools() {
      return (await client.listTools()).tools;
    },
    async listResources() {
      return (await client.listResources()).resources;
    },
    readResource(uri) {
      return client.readResource({ uri });
    },
    async listPrompts() {
      return (await client.listPrompts()).prompts;
    },
    getPrompt(name, args) {
      return client.getPrompt(args === undefined ? { name } : { name, arguments: args });
    },
    async close() {
      await client.close();
      await server.close();
    },
  };
}

/** Connect, call one tool, and close. */
export async function callTool(
  whoopClient: WhoopClient,
  name: string,
  args: Record<string, unknown> = {},
  options: ConnectServerOptions = {}
): Promise<ToolCallOutcome> {
  const connection = await connectServer(whoopClient, options);
  try {
    return await connection.callTool(name, args);
  } finally {
    await connection.close();
  }
}

/** Sorted names of the tools listed in `mode` (backed by an empty fixture client by default). */
export async function listToolNames(
  mode: PrivacyMode,
  whoopClient: WhoopClient = createWhoopFixtureClient()
): Promise<string[]> {
  const connection = await connectServer(whoopClient, { privacyMode: mode });
  try {
    return connection.tools.map((tool) => tool.name).sort();
  } finally {
    await connection.close();
  }
}

/** Wording generated analysis text must not use (advice, causation). */
export const NON_NEUTRAL_TEXT =
  /\b(should|must|try to|avoid|causes?|caused|because of|leads? to|due to|recommend\w*)\b/i;

/** Every string in `value` (recursing through arrays and objects), with its path. */
function stringLeaves(value: unknown, path: string, out: Array<[string, string]>): void {
  if (typeof value === "string") out.push([path, value]);
  else if (Array.isArray(value))
    value.forEach((item, index) => stringLeaves(item, `${path}[${index}]`, out));
  else if (value !== null && typeof value === "object")
    for (const [key, item] of Object.entries(value))
      stringLeaves(item, path ? `${path}.${key}` : key, out);
}

/**
 * Throw when any string in `value` (a string, or every string inside an array
 * or object) matches {@link NON_NEUTRAL_TEXT}.
 */
export function assertNeutralText(value: unknown): void {
  const leaves: Array<[string, string]> = [];
  stringLeaves(value, "", leaves);
  const violations = leaves.flatMap(([path, text]) => {
    const match = NON_NEUTRAL_TEXT.exec(text);
    return match ? [`${path || "(value)"}: "${match[0]}" in ${JSON.stringify(text)}`] : [];
  });
  if (violations.length > 0) {
    throw new Error(`Non-neutral wording in generated text:\n${violations.join("\n")}`);
  }
}
