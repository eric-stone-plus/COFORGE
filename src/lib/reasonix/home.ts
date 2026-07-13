import { chmod, lstat, mkdir, readdir, realpath, rename, rm, stat, writeFile } from "fs/promises";
import { dirname, isAbsolute, join, resolve } from "path";
import { randomUUID } from "crypto";

export interface ReasonixHomeLayout {
  root: string;
  workspace: string;
  config: string;
  credentialBridge: string;
  state: string;
  cache: string;
}

const RUNTIME_SYSTEM_PROMPT = `You are the private reasoning runtime embedded in COFORGE.
Use only the injected mcp__coforge__* tools for business data or actions.
Never request shell, filesystem, web, memory, skill, plugin, session-history, or configuration tools.
If the COFORGE MCP tools cannot answer safely, explain the limitation instead of inventing data.`;

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function runtimeConfig(apiKeyEnv: string): string {
  return `config_version = 4
default_model = "deepseek-pro"
credentials_store = "file"

[desktop]
check_updates = false
telemetry = false
metrics = false

[agent]
system_prompt = ${tomlString(RUNTIME_SYSTEM_PROMPT)}
max_steps = 32
planner_max_steps = 0
auto_plan = "off"
memory_compiler = { enabled = false }

[[providers]]
name = "deepseek-pro"
kind = "openai"
base_url = "https://api.deepseek.com"
model = "deepseek-v4-pro"
api_key_env = ${tomlString(apiKeyEnv)}
context_window = 1000000
effort = "max"
supported_efforts = ["disabled", "high", "max"]
default_effort = "max"
no_proxy = true

[tools]
# Empty means every built-in upstream; this unknown sentinel deliberately yields none.
enabled = ["__coforge_mcp_only__"]
mcp_call_timeout_seconds = 60

[environment]
enabled = false

[permissions]
mode = "deny"
deny = [
  "bash", "bash_output", "kill_shell", "wait", "todo_write", "complete_step",
  "read_file", "write_file", "edit_file", "multi_edit", "move_file",
  "notebook_edit", "delete_range", "delete_symbol", "ls", "glob", "grep",
  "code_index", "web_fetch", "history", "list_sessions", "read_session",
  "memory", "remember", "forget", "ask", "task", "parallel_tasks",
  "read_only_task", "run_skill", "read_skill", "read_only_skill", "install_skill",
  "explore", "research", "review", "security_review", "install_source",
  "slash_command", "connect_tool_source", "use_capability"
]

[sandbox]
bash = "enforce"
network = false

[skills]
paths = []
excluded_paths = []
disabled_skills = []

[lsp]
enabled = false

[secrets]
redact_tool_output = true
filter_subprocess_env = true
protect_sensitive_files = true
`;
}

async function ensurePrivateDirectory(path: string, recreate = false): Promise<void> {
  const existing = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (existing && (!existing.isDirectory() || existing.isSymbolicLink())) {
    throw new Error(`Reasonix runtime directory is not a regular directory: ${path}`);
  }
  if (existing && recreate) await rm(path, { recursive: true });
  if (!existing || recreate) await mkdir(path, { mode: 0o700 });
  await chmod(path, 0o700);
}

export async function resetReasonixWorkspace(root: string, workspace = join(resolve(root), "workspace")): Promise<void> {
  if (!isAbsolute(root) || !isAbsolute(workspace)) {
    throw new Error("Reasonix workspace paths must be absolute");
  }
  const expectedRoot = resolve(root);
  const expectedWorkspace = join(expectedRoot, "workspace");
  if (resolve(workspace) !== expectedWorkspace) {
    throw new Error("Reasonix workspace must be the isolated runtime workspace");
  }

  const [rootMetadata, workspaceMetadata] = await Promise.all([
    lstat(expectedRoot),
    lstat(expectedWorkspace),
  ]);
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) {
    throw new Error("Reasonix home is not a regular directory");
  }
  if (!workspaceMetadata.isDirectory() || workspaceMetadata.isSymbolicLink()) {
    throw new Error("Reasonix workspace is not a regular directory");
  }

  const [resolvedRoot, resolvedWorkspace] = await Promise.all([
    realpath(expectedRoot),
    realpath(expectedWorkspace),
  ]);
  if (dirname(resolvedWorkspace) !== resolvedRoot) {
    throw new Error("Reasonix workspace escapes the isolated runtime home");
  }

  await chmod(expectedRoot, 0o700);
  await chmod(expectedWorkspace, 0o700);
  const originalIdentity = await stat(resolvedWorkspace);
  for (const entry of await readdir(resolvedWorkspace)) {
    await rm(join(resolvedWorkspace, entry), { recursive: true, force: true });
  }

  const [finalMetadata, finalResolvedWorkspace] = await Promise.all([
    lstat(expectedWorkspace),
    realpath(expectedWorkspace),
  ]);
  const finalIdentity = await stat(finalResolvedWorkspace);
  if (
    !finalMetadata.isDirectory() ||
    finalMetadata.isSymbolicLink() ||
    dirname(finalResolvedWorkspace) !== resolvedRoot ||
    finalIdentity.dev !== originalIdentity.dev ||
    finalIdentity.ino !== originalIdentity.ino ||
    (await readdir(finalResolvedWorkspace)).length !== 0
  ) {
    throw new Error("Reasonix workspace changed while it was being reset");
  }
}

async function rejectUnsafeFile(path: string, label: string): Promise<void> {
  const existing = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (existing && (!existing.isFile() || existing.isSymbolicLink())) {
    throw new Error(`${label} is not a regular file.`);
  }
}

async function writePrivateConfig(path: string, contents: string): Promise<void> {
  await rejectUnsafeFile(path, "Reasonix config");
  const temporary = join(dirname(path), `.config.${process.pid}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, contents, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await rename(temporary, path);
    await chmod(path, 0o600);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

export async function prepareReasonixHome(
  root: string,
  apiKeyEnv = "DEEPSEEK_API_KEY",
): Promise<ReasonixHomeLayout> {
  if (!isAbsolute(root)) throw new Error("Reasonix home must be an absolute path");
  if (!/^[A-Z_][A-Z0-9_]*$/.test(apiKeyEnv)) throw new Error("Invalid provider API key variable name");

  const layout: ReasonixHomeLayout = {
    root: resolve(root),
    workspace: join(resolve(root), "workspace"),
    config: join(resolve(root), "config.toml"),
    credentialBridge: join(resolve(root), ".env"),
    state: join(resolve(root), "state"),
    cache: join(resolve(root), "cache"),
  };

  await mkdir(dirname(layout.root), { recursive: true, mode: 0o700 });
  await ensurePrivateDirectory(layout.root);
  const [resolvedRoot, resolvedParent] = await Promise.all([
    realpath(layout.root),
    realpath(dirname(layout.root)),
  ]);
  if (dirname(resolvedRoot) !== resolvedParent) {
    throw new Error("Reasonix home must not traverse symbolic links.");
  }

  await rejectUnsafeFile(layout.credentialBridge, "Reasonix credential bridge");
  await rm(layout.credentialBridge, { force: true });
  // Keep the directory inode stable because a running ACP process may use it as cwd.
  await ensurePrivateDirectory(layout.workspace);
  await resetReasonixWorkspace(layout.root, layout.workspace);
  await ensurePrivateDirectory(layout.state);
  await ensurePrivateDirectory(layout.cache);
  await writePrivateConfig(layout.config, runtimeConfig(apiKeyEnv));

  const workspaceStat = await stat(layout.workspace);
  const [resolvedWorkspace, resolvedRuntimeRoot] = await Promise.all([
    realpath(layout.workspace),
    realpath(layout.root),
  ]);
  if (!workspaceStat.isDirectory() || dirname(resolvedWorkspace) !== resolvedRuntimeRoot) {
    throw new Error("Reasonix workspace is not an isolated directory");
  }
  return layout;
}

const RUNTIME_ENV_ALLOWLIST = new Set([
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "PATH",
  "SSL_CERT_DIR",
  "SSL_CERT_FILE",
  "SystemRoot",
  "TEMP",
  "TMP",
  "TMPDIR",
  "WINDIR",
]);

export function reasonixProcessEnvironment(
  layout: ReasonixHomeLayout,
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { NODE_ENV: source.NODE_ENV ?? "production" };
  for (const [name, value] of Object.entries(source)) {
    if (RUNTIME_ENV_ALLOWLIST.has(name) && value !== undefined) env[name] = value;
  }
  env.PATH ||= process.platform === "win32"
    ? source.SystemRoot ? `${source.SystemRoot}\\System32` : ""
    : "/usr/bin:/bin:/usr/sbin:/sbin";
  env.REASONIX_HOME = layout.root;
  env.REASONIX_STATE_HOME = layout.state;
  env.REASONIX_CACHE_HOME = layout.cache;
  env.REASONIX_CREDENTIALS_STORE = "file";
  return env;
}
