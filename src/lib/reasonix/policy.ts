import { isAbsolute, resolve } from "path";

export const COFORGE_MCP_SERVER_NAME = "coforge";
const COFORGE_MCP_TOOL_NAMES = new Set([
  "schema",
  "query",
  "bidding",
  "sourcing",
  "freight",
  "laytime",
  "inventory",
  "blending",
  "coswap",
]);

export interface ReasonixMcpServer {
  name: string;
  type: "stdio";
  command: string;
  args?: string[];
  env?: Array<{ name: string; value: string }>;
}

export interface FirstPartyMcpOptions {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

const SAFE_ENV_NAME = /^[A-Z_][A-Z0-9_]*$/;
const FORBIDDEN_MCP_ENV = new Set([
  "HOME",
  "USERPROFILE",
  "APPDATA",
  "XDG_CONFIG_HOME",
  "XDG_STATE_HOME",
  "XDG_CACHE_HOME",
  "REASONIX_HOME",
  "REASONIX_STATE_HOME",
  "REASONIX_CACHE_HOME",
  "DEEPSEEK_API_KEY",
]);

export function firstPartyMcpServer(options: FirstPartyMcpOptions): ReasonixMcpServer {
  if (!isAbsolute(options.command)) {
    throw new Error("The first-party COFORGE MCP command must be an absolute path");
  }
  const env = Object.entries(options.env ?? {}).map(([name, value]) => {
    if (!SAFE_ENV_NAME.test(name) || FORBIDDEN_MCP_ENV.has(name)) {
      throw new Error(`Environment variable ${name} is not allowed for the COFORGE MCP server`);
    }
    if (value.includes("\0")) {
      throw new Error(`Environment variable ${name} contains a NUL byte`);
    }
    return { name, value };
  });
  return {
    name: COFORGE_MCP_SERVER_NAME,
    type: "stdio",
    command: resolve(options.command),
    args: [...(options.args ?? [])],
    env,
  };
}

export function isAllowedReasonixTool(toolName: string): boolean {
  const prefix = `mcp__${COFORGE_MCP_SERVER_NAME}__`;
  return toolName.startsWith(prefix) && COFORGE_MCP_TOOL_NAMES.has(toolName.slice(prefix.length));
}

export interface PermissionDecisionResult {
  outcome: { outcome: "selected"; optionId: "allow_once" | "reject_once" };
}

export function denyPermissionResult(): PermissionDecisionResult {
  return { outcome: { outcome: "selected", optionId: "reject_once" } };
}
