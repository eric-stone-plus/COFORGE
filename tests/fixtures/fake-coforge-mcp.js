#!/usr/bin/env node

const readline = require("readline");
const { writeFileSync } = require("fs");

if (process.env.COFORGE_MCP_ENV_OBSERVATION) {
  writeFileSync(process.env.COFORGE_MCP_ENV_OBSERVATION, JSON.stringify({
    deepseekApiKeyPresent: Object.prototype.hasOwnProperty.call(process.env, "DEEPSEEK_API_KEY"),
    reasonixHomePresent: Object.prototype.hasOwnProperty.call(process.env, "REASONIX_HOME"),
    homePresent: Object.prototype.hasOwnProperty.call(process.env, "HOME"),
    desktopCapabilityPresent: Object.prototype.hasOwnProperty.call(process.env, "COFORGE_DESKTOP_CAPABILITY"),
    credentialHelperPresent: Object.prototype.hasOwnProperty.call(process.env, "COFORGE_CREDENTIAL_HELPER"),
    configDirPresent: Object.prototype.hasOwnProperty.call(process.env, "COFORGE_CONFIG_DIR"),
    dbPathPresent: Object.prototype.hasOwnProperty.call(process.env, "DB_PATH"),
    auditPathPresent: Object.prototype.hasOwnProperty.call(process.env, "COFORGE_QUERY_AUDIT_PATH"),
  }), { mode: 0o600 });
}

function send(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}

readline.createInterface({ input: process.stdin, crlfDelay: Infinity }).on("line", (line) => {
  const frame = JSON.parse(line);
  if (frame.id === undefined) return;
  switch (frame.method) {
    case "initialize":
      send(frame.id, {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "coforge-test", version: "fixture" },
      });
      break;
    case "tools/list":
      send(frame.id, {
        tools: [{
          name: "query",
          description: "Return a synthetic COFORGE fixture result",
          inputSchema: { type: "object", properties: {} },
          annotations: { readOnlyHint: true },
        }],
      });
      break;
    case "tools/call":
      send(frame.id, { content: [{ type: "text", text: "synthetic" }], isError: false });
      break;
    default:
      send(frame.id, {});
  }
});
