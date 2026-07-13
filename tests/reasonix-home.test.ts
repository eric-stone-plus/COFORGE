import { access, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prepareReasonixHome, reasonixProcessEnvironment, resetReasonixWorkspace } from "../src/lib/reasonix/home";
import { firstPartyMcpServer, isAllowedReasonixTool } from "../src/lib/reasonix/policy";

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "coforge-reasonix-home-"));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe("isolated Reasonix home", () => {
  it("writes a private Pro/Max config, removes stale bridges, and leaves an empty workspace", async () => {
    const apiKey = "sk-private-test-key";
    const root = join(tempDir, "runtime");
    await import("fs/promises").then(({ mkdir }) => mkdir(root));
    await writeFile(join(root, ".env"), `DEEPSEEK_API_KEY=${apiKey}\n`);
    const layout = await prepareReasonixHome(root);
    const [config, rootStat, configStat, entries] = await Promise.all([
      readFile(layout.config, "utf8"),
      stat(layout.root),
      stat(layout.config),
      import("fs/promises").then(({ readdir }) => readdir(layout.workspace)),
    ]);

    expect(config).toContain('model = "deepseek-v4-pro"');
    expect(config).toContain('effort = "max"');
    expect(config).toContain("config_version = 4");
    expect(config).toContain("check_updates = false");
    expect(config).toContain("telemetry = false");
    expect(config).toContain("metrics = false");
    expect(config).toContain("network = false");
    expect(config).toContain("filter_subprocess_env = true");
    expect(config).toContain('enabled = ["__coforge_mcp_only__"]');
    expect(config).toContain('mode = "deny"');
    expect(config).not.toContain(apiKey);
    expect(rootStat.mode & 0o777).toBe(0o700);
    expect(configStat.mode & 0o777).toBe(0o600);
    await expect(access(layout.credentialBridge)).rejects.toThrow();
    expect(entries).toEqual([]);
  });

  it("overrides inherited Reasonix controls and never inherits a provider key", async () => {
    const layout = await prepareReasonixHome(join(tempDir, "runtime"));
    const env = reasonixProcessEnvironment(layout, {
      NODE_ENV: "test",
      PATH: "/bin",
      DEEPSEEK_API_KEY: "leaked",
      COFORGE_DESKTOP_CAPABILITY: "desktop-secret",
      COFORGE_CREDENTIAL_HELPER: "/private/helper",
      DB_PATH: "/private/database",
      REASONIX_HOME: "/attacker",
      REASONIX_STATE_HOME: "/attacker-state",
    });

    expect(env).toMatchObject({
      NODE_ENV: "test",
      PATH: "/bin",
      REASONIX_HOME: layout.root,
      REASONIX_STATE_HOME: layout.state,
      REASONIX_CACHE_HOME: layout.cache,
      REASONIX_CREDENTIALS_STORE: "file",
    });
    expect(env.DEEPSEEK_API_KEY).toBeUndefined();
    expect(env.COFORGE_DESKTOP_CAPABILITY).toBeUndefined();
    expect(env.COFORGE_CREDENTIAL_HELPER).toBeUndefined();
    expect(env.DB_PATH).toBeUndefined();
  });

  it("clears stale project configuration from the isolated workspace", async () => {
    const root = join(tempDir, "runtime");
    await mkdir(join(root, "workspace", ".reasonix", "skills"), { recursive: true });
    await writeFile(join(root, "workspace", "reasonix.toml"), 'permissions = "allow"\n');
    await writeFile(join(root, "workspace", ".mcp.json"), '{}\n');
    const layout = await prepareReasonixHome(root);
    const entries = await import("fs/promises").then(({ readdir }) => readdir(layout.workspace));
    expect(entries).toEqual([]);
  });

  it("rejects symlinked runtime directories and credential/config targets", async () => {
    const outside = join(tempDir, "outside");
    await mkdir(outside);

    const workspaceRoot = join(tempDir, "workspace-link-root");
    await mkdir(workspaceRoot);
    await symlink(outside, join(workspaceRoot, "workspace"));
    await expect(prepareReasonixHome(workspaceRoot)).rejects.toThrow(/regular directory/);

    const configRoot = join(tempDir, "config-link-root");
    await mkdir(configRoot);
    await symlink(join(outside, "config.toml"), join(configRoot, "config.toml"));
    await expect(prepareReasonixHome(configRoot)).rejects.toThrow(/config.*regular file/i);

    const bridgeRoot = join(tempDir, "bridge-link-root");
    await mkdir(bridgeRoot);
    await symlink(join(outside, ".env"), join(bridgeRoot, ".env"));
    await expect(prepareReasonixHome(bridgeRoot)).rejects.toThrow(/credential bridge.*regular file/i);
  });

  it("accepts only an absolute first-party MCP command and safe non-secret env", () => {
    expect(() => firstPartyMcpServer({ command: "node" })).toThrow("absolute path");
    expect(() => firstPartyMcpServer({ command: "/opt/coforge/mcp", env: { HOME: "/tmp" } })).toThrow(
      "not allowed",
    );
    expect(firstPartyMcpServer({
      command: "/opt/coforge/mcp",
      args: ["--stdio"],
      env: { COFORGE_TENANT_ID: "synthetic" },
    })).toEqual({
      name: "coforge",
      type: "stdio",
      command: "/opt/coforge/mcp",
      args: ["--stdio"],
      env: [{ name: "COFORGE_TENANT_ID", value: "synthetic" }],
    });
  });

  it("allows only the canonical first-party MCP namespace", () => {
    expect(isAllowedReasonixTool("mcp__coforge__query")).toBe(true);
    expect(isAllowedReasonixTool("mcp__coforge__unregistered")).toBe(false);
    expect(isAllowedReasonixTool("mcp__coforge_evil__query")).toBe(false);
    expect(isAllowedReasonixTool("bash")).toBe(false);
    expect(isAllowedReasonixTool("read_file")).toBe(false);
  });
});
