import { join } from "path";
import { ReasonixAcpClient, ReasonixAcpClientOptions } from "./acp-client";
import { prepareReasonixHome, reasonixProcessEnvironment } from "./home";
import { resolvePackagedReasonixBinary, ReasonixPlatform } from "./manifest";
import { FirstPartyMcpOptions } from "./policy";

export interface CreateReasonixRuntimeOptions {
  packageRoot: string;
  integrityManifestPath?: string;
  applicationDataDir: string;
  apiKey: string;
  mcp: FirstPartyMcpOptions;
  platform?: ReasonixPlatform;
  onUpdate?: ReasonixAcpClientOptions["onUpdate"];
  onPermission?: ReasonixAcpClientOptions["onPermission"];
  onPolicyViolation?: ReasonixAcpClientOptions["onPolicyViolation"];
  onStderr?: ReasonixAcpClientOptions["onStderr"];
}

export async function createReasonixRuntime(
  options: CreateReasonixRuntimeOptions,
): Promise<ReasonixAcpClient> {
  const binaryPath = await resolvePackagedReasonixBinary(
    options.packageRoot,
    options.platform,
    options.integrityManifestPath,
  );
  const home = await prepareReasonixHome(join(options.applicationDataDir, "reasonix"));
  return new ReasonixAcpClient({
    binaryPath,
    cwd: home.workspace,
    env: reasonixProcessEnvironment(home),
    credentialBridgePath: home.credentialBridge,
    apiKey: options.apiKey,
    mcp: options.mcp,
    onUpdate: options.onUpdate,
    onPermission: options.onPermission,
    onPolicyViolation: options.onPolicyViolation,
    onStderr: options.onStderr,
  });
}
