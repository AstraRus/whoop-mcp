import { describe, expect, it } from "vitest";

import {
  DEFAULT_MAX_CONNECTIONS,
  DEFAULT_PORT,
  parsePortValue,
  resolveMaxConnections,
  resolvePort,
} from "../../src/transport/port-config.js";

describe("resolvePort", () => {
  it("defaults to 3000 when neither MCP_PORT nor PORT is set", () => {
    expect(resolvePort({})).toBe(DEFAULT_PORT);
    expect(DEFAULT_PORT).toBe(3000);
  });

  it("uses PORT when MCP_PORT is unset (hosts such as Railway)", () => {
    expect(resolvePort({ PORT: "8080" })).toBe(8080);
  });

  it("prefers MCP_PORT over PORT", () => {
    expect(resolvePort({ MCP_PORT: "3000", PORT: "8080" })).toBe(3000);
    expect(resolvePort({ MCP_PORT: "0", PORT: "8080" })).toBe(0);
  });

  it("accepts the full port range and surrounding whitespace", () => {
    expect(resolvePort({ MCP_PORT: "65535" })).toBe(65535);
    expect(resolvePort({ PORT: " 4001 " })).toBe(4001);
  });

  it.each([["abc"], ["99999"], ["65536"], ["-1"], ["3000abc"], ["30.5"], [""], ["1e3"]])(
    "rejects MCP_PORT=%j naming the variable",
    (value) => {
      expect(() => resolvePort({ MCP_PORT: value })).toThrow(/Invalid MCP_PORT/);
    }
  );

  it.each([["abc"], ["70000"], [""]])("rejects PORT=%j naming the variable", (value) => {
    expect(() => resolvePort({ PORT: value })).toThrow(/Invalid PORT/);
  });

  it("validates PORT even when MCP_PORT takes precedence", () => {
    expect(() => resolvePort({ MCP_PORT: "3000", PORT: "not-a-port" })).toThrow(/Invalid PORT/);
  });

  it("parsePortValue names the variable it was given", () => {
    expect(parsePortValue("X_PORT", "12")).toBe(12);
    expect(() => parsePortValue("X_PORT", "x")).toThrow(/Invalid X_PORT: "x"/);
  });
});

describe("resolveMaxConnections", () => {
  it("defaults to 16", () => {
    expect(resolveMaxConnections({})).toBe(DEFAULT_MAX_CONNECTIONS);
    expect(DEFAULT_MAX_CONNECTIONS).toBe(16);
  });

  it("accepts 1-100", () => {
    expect(resolveMaxConnections({ MCP_MAX_CONNECTIONS: "1" })).toBe(1);
    expect(resolveMaxConnections({ MCP_MAX_CONNECTIONS: "100" })).toBe(100);
  });

  it.each([["0"], ["101"], ["abc"], [""], ["-5"], ["2.5"]])(
    "rejects MCP_MAX_CONNECTIONS=%j",
    (value) => {
      expect(() => resolveMaxConnections({ MCP_MAX_CONNECTIONS: value })).toThrow(
        /Invalid MCP_MAX_CONNECTIONS/
      );
    }
  );
});
