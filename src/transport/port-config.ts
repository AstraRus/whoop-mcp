/**
 * HTTP transport settings read from the environment: the listening port and
 * the number of MCP requests handled at once.
 *
 * Every value is validated strictly; an invalid value is a startup error that
 * names the variable (never a silent fallback).
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Port used when neither MCP_PORT nor PORT is set. */
export const DEFAULT_PORT = 3000;

/** Highest valid TCP port. */
export const MAX_PORT = 65_535;

/** MCP requests handled at once when MCP_MAX_CONNECTIONS is unset. */
export const DEFAULT_MAX_CONNECTIONS = 16;

/** Smallest accepted MCP_MAX_CONNECTIONS. */
export const MIN_MAX_CONNECTIONS = 1;

/** Largest accepted MCP_MAX_CONNECTIONS. */
export const MAX_MAX_CONNECTIONS = 100;

/** Environment variables as read from process.env. */
export type EnvSource = Readonly<Record<string, string | undefined>>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A whole number written with digits only (after trimming), or null. */
function parseDigits(raw: string): number | null {
  const value = raw.trim();
  if (!/^\d{1,6}$/.test(value)) return null;
  return Number(value);
}

/**
 * Parse one port variable: an integer 0-65535.
 *
 * @throws Error naming the variable when the value is not a valid port
 */
export function parsePortValue(name: string, raw: string): number {
  const port = parseDigits(raw);
  if (port === null || port > MAX_PORT) {
    throw new Error(`Invalid ${name}: "${raw}". Must be an integer 0-${MAX_PORT}.`);
  }
  return port;
}

// ---------------------------------------------------------------------------
// Resolvers
// ---------------------------------------------------------------------------

/**
 * The HTTP port: MCP_PORT, else PORT (set by hosts such as Railway), else 3000.
 * Both variables are validated whenever they are set, so a broken PORT is
 * reported even while MCP_PORT takes precedence.
 *
 * @throws Error naming the variable when a set value is not an integer 0-65535
 */
export function resolvePort(env: EnvSource): number {
  const mcpPort = env.MCP_PORT === undefined ? undefined : parsePortValue("MCP_PORT", env.MCP_PORT);
  const hostPort = env.PORT === undefined ? undefined : parsePortValue("PORT", env.PORT);
  return mcpPort ?? hostPort ?? DEFAULT_PORT;
}

/**
 * MCP_MAX_CONNECTIONS: MCP requests handled at once (1-100, default 16). Extra
 * requests wait in a short queue.
 *
 * @throws Error naming the variable when the value is not an integer 1-100
 */
export function resolveMaxConnections(env: EnvSource): number {
  const raw = env.MCP_MAX_CONNECTIONS;
  if (raw === undefined) return DEFAULT_MAX_CONNECTIONS;
  const value = parseDigits(raw);
  if (value === null || value < MIN_MAX_CONNECTIONS || value > MAX_MAX_CONNECTIONS) {
    throw new Error(
      `Invalid MCP_MAX_CONNECTIONS: "${raw}". Must be an integer ${MIN_MAX_CONNECTIONS}-${MAX_MAX_CONNECTIONS}.`
    );
  }
  return value;
}
