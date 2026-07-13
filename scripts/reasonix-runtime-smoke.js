#!/usr/bin/env node

const { spawn } = require("child_process");
const { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } = require("fs");
const { join, resolve } = require("path");

const binary = process.argv[2];
if (!binary || !existsSync(binary)) {
  console.error("usage: node scripts/reasonix-runtime-smoke.js /absolute/path/to/reasonix");
  process.exit(2);
}

const root = "/tmp/coforge-reasonix-runtime-smoke";
const workspace = join(root, "workspace");
const bridge = join(root, ".env");
const mcp = resolve("tests/fixtures/fake-coforge-mcp.js");
const observation = join(root, "mcp-env-observation.json");
rmSync(root, { recursive: true, force: true });
mkdirSync(workspace, { recursive: true, mode: 0o700 });
chmodSync(mcp, 0o700);
writeFileSync(join(root, "config.toml"), `config_version = 4
default_model = "deepseek-pro"
credentials_store = "file"
[desktop]
check_updates = false
telemetry = false
metrics = false
[agent]
system_prompt = "COFORGE runtime smoke"
max_steps = 2
memory_compiler = { enabled = false }
[[providers]]
name = "deepseek-pro"
kind = "openai"
base_url = "https://api.deepseek.com"
model = "deepseek-v4-pro"
api_key_env = "DEEPSEEK_API_KEY"
effort = "max"
[tools]
enabled = ["__coforge_mcp_only__"]
[environment]
enabled = false
[permissions]
mode = "deny"
[sandbox]
bash = "enforce"
network = false
[secrets]
redact_tool_output = true
filter_subprocess_env = true
protect_sensitive_files = true
[lsp]
enabled = false
`, { mode: 0o600 });

Object.assign(process.env, {
  COFORGE_DESKTOP_CAPABILITY: "must-not-reach-reasonix",
  COFORGE_CREDENTIAL_HELPER: "/must/not/reach/reasonix",
  COFORGE_CONFIG_DIR: "/must/not/reach/reasonix",
  DB_PATH: "/must/not/reach/reasonix",
  COFORGE_QUERY_AUDIT_PATH: "/must/not/reach/reasonix",
});
const env = {
  NODE_ENV: "test",
  PATH: process.env.PATH || "/usr/bin:/bin:/usr/sbin:/sbin",
  ...(process.env.LANG ? { LANG: process.env.LANG } : {}),
  ...(process.env.TMPDIR ? { TMPDIR: process.env.TMPDIR } : {}),
  REASONIX_HOME: root,
  REASONIX_STATE_HOME: join(root, "state"),
  REASONIX_CACHE_HOME: join(root, "cache"),
  REASONIX_CREDENTIALS_STORE: "file",
};
delete env.DEEPSEEK_API_KEY;
const child = spawn(resolve(binary), ["acp", "--model", "deepseek-pro", "--profile", "balanced"], {
  cwd: workspace,
  env,
  stdio: ["pipe", "pipe", "inherit"],
});

let nextId = 0;
let buffer = "";
const pending = new Map();
child.stdout.setEncoding("utf8");
child.stdout.on("data", (chunk) => {
  buffer += chunk;
  for (;;) {
    const newline = buffer.indexOf("\n");
    if (newline < 0) break;
    const frame = JSON.parse(buffer.slice(0, newline));
    buffer = buffer.slice(newline + 1);
    if (frame.id !== undefined && pending.has(frame.id)) {
      pending.get(frame.id)(frame);
      pending.delete(frame.id);
    }
  }
});

function request(method, params) {
  const id = ++nextId;
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  return new Promise((resolveFrame, reject) => {
    const timer = setTimeout(() => reject(new Error(`${method} timed out`)), 10_000);
    pending.set(id, (frame) => {
      clearTimeout(timer);
      if (frame.error) reject(new Error(frame.error.message));
      else resolveFrame(frame.result);
    });
  });
}

(async () => {
  const initialized = await request("initialize", { protocolVersion: 1, clientInfo: { name: "coforge-smoke" }, clientCapabilities: {} });
  if (initialized.protocolVersion !== 1) throw new Error("ACP protocol mismatch");
  const fd = openSync(bridge, "wx", 0o600);
  writeFileSync(fd, "DEEPSEEK_API_KEY=fixture-only\n");
  closeSync(fd);
  let session;
  try {
    session = await request("session/new", {
      cwd: workspace,
      mcpServers: [{
        name: "coforge",
        type: "stdio",
        command: process.execPath,
        args: [mcp],
        env: [{ name: "COFORGE_MCP_ENV_OBSERVATION", value: observation }],
      }],
    });
  } finally {
    rmSync(bridge, { force: true });
  }
  if (!session.sessionId) throw new Error("session/new returned no id");
  const config = readFileSync(join(root, "config.toml"), "utf8");
  for (const required of [
    "config_version = 4",
    'model = "deepseek-v4-pro"',
    'effort = "max"',
    "check_updates = false",
    "telemetry = false",
    "metrics = false",
    'enabled = ["__coforge_mcp_only__"]',
    'mode = "deny"',
    'network = false',
    'filter_subprocess_env = true',
  ]) {
    if (!config.includes(required)) throw new Error(`Reasonix runtime config lost required policy: ${required}`);
  }
  const deadline = Date.now() + 5_000;
  while (!existsSync(observation) && Date.now() < deadline) {
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  }
  if (!existsSync(observation)) throw new Error("COFORGE MCP fixture was not started");
  const mcpEnv = JSON.parse(require("fs").readFileSync(observation, "utf8"));
  if (
    mcpEnv.deepseekApiKeyPresent ||
    mcpEnv.desktopCapabilityPresent ||
    mcpEnv.credentialHelperPresent ||
    mcpEnv.configDirPresent ||
    mcpEnv.dbPathPresent ||
    mcpEnv.auditPathPresent
  ) {
    throw new Error("Reasonix leaked a credential or COFORGE control path into the MCP process");
  }
  console.log(`Reasonix runtime smoke passed (ACP v1, session ${session.sessionId}, policy retained, credential bridge removed, credential env filtered).`);
})().then(() => {
  child.stdin.end();
  rmSync(root, { recursive: true, force: true });
}).catch((error) => {
  child.kill("SIGKILL");
  rmSync(bridge, { force: true });
  console.error(error.message);
  process.exitCode = 1;
});
