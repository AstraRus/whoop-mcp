/**
 * Print what an MCP client sees from this server in each privacy mode: the
 * tools/list entries (name, title, description, input schema, whether an
 * output schema is advertised), the resources and the prompts.
 *
 * Used to write and check the README tool reference. It never contacts WHOOP:
 * the server gets a client that refuses every request, and no tool is called.
 *
 *   npx tsx scripts/print-tools.mts              # JSON for both modes
 *   npx tsx scripts/print-tools.mts --markdown   # a README-style outline
 *   npx tsx scripts/print-tools.mts aggregate    # one mode only
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Prompt, Resource, Tool } from "@modelcontextprotocol/sdk/types.js";
import type { WhoopClient } from "../src/api/client.js";
import type { PrivacyMode } from "../src/privacy.js";
import { createWhoopServer } from "../src/server.js";

interface ModeListing {
  mode: PrivacyMode;
  instructions: string | null;
  tools: Tool[];
  resources: Resource[];
  prompts: Prompt[];
}

const offlineClient: WhoopClient = {
  get: () => Promise.reject(new Error("print-tools does not contact WHOOP")),
};

async function listMode(mode: PrivacyMode): Promise<ModeListing> {
  const { server } = createWhoopServer(offlineClient, { privacyMode: mode });
  const client = new Client({ name: "print-tools", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const capabilities = client.getServerCapabilities() ?? {};
    const tools = (await client.listTools()).tools;
    const resources = capabilities.resources ? (await client.listResources()).resources : [];
    const prompts = capabilities.prompts ? (await client.listPrompts()).prompts : [];
    return { mode, instructions: client.getInstructions() ?? null, tools, resources, prompts };
  } finally {
    await client.close();
    await server.close();
  }
}

interface JsonProperty {
  type?: string | string[];
  description?: string;
  enum?: unknown[];
  minimum?: number;
  exclusiveMinimum?: number;
  maximum?: number;
  default?: unknown;
  items?: JsonProperty;
}

/** A bound worth printing (zod writes ±Number.MAX_SAFE_INTEGER for plain integers). */
function bound(value: number | undefined): number | undefined {
  return value === undefined || Math.abs(value) >= Number.MAX_SAFE_INTEGER ? undefined : value;
}

function describeProperty(name: string, property: JsonProperty, required: boolean): string {
  const parts: string[] = [];
  const type = Array.isArray(property.type) ? property.type.join("|") : (property.type ?? "any");
  const itemEnum = property.items?.enum;
  parts.push(
    property.enum
      ? property.enum.map((value) => JSON.stringify(value)).join(" | ")
      : itemEnum
        ? `array of ${itemEnum.map((value) => JSON.stringify(value)).join(" | ")}`
        : type
  );
  const minimum = bound(property.minimum);
  const maximum = bound(property.maximum);
  if (property.exclusiveMinimum !== undefined && maximum === undefined) {
    parts.push(`> ${property.exclusiveMinimum}`);
  } else if (minimum !== undefined || maximum !== undefined) {
    parts.push(`${minimum ?? ""}-${maximum ?? ""}`);
  }
  if (property.default !== undefined) parts.push(`default ${JSON.stringify(property.default)}`);
  if (!required) parts.push("optional");
  const description = property.description ? ` ${property.description}` : "";
  return `- \`${name}\` (${parts.join(", ")}):${description}`;
}

function markdown(listings: ModeListing[]): string {
  const lines: string[] = [];
  for (const listing of listings) {
    lines.push(`# ${listing.mode} mode`, "");
    lines.push(
      `${listing.tools.length} tools, ${listing.resources.length} resources, ${listing.prompts.length} prompts`,
      ""
    );
    for (const tool of listing.tools) {
      lines.push(`### \`${tool.name}\``, "");
      if (tool.title) lines.push(`Title: ${tool.title}`, "");
      lines.push(tool.description ?? "", "");
      const properties = (tool.inputSchema.properties ?? {}) as Record<string, JsonProperty>;
      const required = new Set(tool.inputSchema.required ?? []);
      const names = Object.keys(properties);
      if (names.length === 0) lines.push("Inputs: none", "");
      else {
        lines.push("Inputs:");
        for (const name of names) {
          lines.push(describeProperty(name, properties[name] ?? {}, required.has(name)));
        }
        lines.push("");
      }
      const output = tool.outputSchema?.properties
        ? Object.keys(tool.outputSchema.properties).join(", ")
        : "(no output schema)";
      lines.push(`Output fields: ${output}`, "");
    }
    lines.push("## Resources", "");
    for (const resource of listing.resources) {
      lines.push(
        `- \`${resource.uri}\` (${resource.mimeType ?? "?"}): ${resource.description ?? ""}`
      );
    }
    lines.push("", "## Prompts", "");
    for (const prompt of listing.prompts) {
      const args = (prompt.arguments ?? []).map((argument) => argument.name).join(", ");
      lines.push(`- \`${prompt.name}\`${args ? ` (${args})` : ""}: ${prompt.description ?? ""}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

const argv = process.argv.slice(2);
const modes = (["standard", "aggregate"] as const).filter(
  (mode) => !argv.some((arg) => arg === "standard" || arg === "aggregate") || argv.includes(mode)
);
const listings: ModeListing[] = [];
for (const mode of modes) listings.push(await listMode(mode));
process.stdout.write(
  argv.includes("--markdown") ? markdown(listings) : `${JSON.stringify(listings, null, 2)}\n`
);
