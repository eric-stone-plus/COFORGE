import { createHash } from "crypto";
import { lstat, open, readFile, realpath, stat } from "fs/promises";
import { basename, dirname, isAbsolute, resolve } from "path";
import releaseManifestJson from "./release-manifest.json";

export type ReasonixPlatform =
  | "darwin-x64"
  | "darwin-arm64"
  | "linux-x64"
  | "linux-arm64"
  | "win32-x64"
  | "win32-arm64";

export interface ReasonixReleaseAsset {
  archive: string;
  format: "tar.gz" | "zip";
  archiveSha256: string;
  binary: "reasonix" | "reasonix.exe";
  binarySha256: string;
}

export interface ReasonixReleaseManifest {
  schemaVersion: 1;
  upstream: "esengine/DeepSeek-Reasonix";
  version: string;
  tag: string;
  commit: string;
  protocolVersion: 1;
  license: "MIT";
  licenseFile: "LICENSE";
  licenseSha256: string;
  assets: Record<ReasonixPlatform, ReasonixReleaseAsset>;
}

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const RELEASE_MANIFEST_KEYS = [
  "assets",
  "commit",
  "license",
  "licenseFile",
  "licenseSha256",
  "protocolVersion",
  "schemaVersion",
  "tag",
  "upstream",
  "version",
] as const;
const ASSET_KEYS = ["archive", "archiveSha256", "binary", "binarySha256", "format"] as const;
const PLATFORM_ASSETS: Record<ReasonixPlatform, Pick<ReasonixReleaseAsset, "archive" | "binary" | "format">> = {
  "darwin-x64": { archive: "reasonix-darwin-amd64.tar.gz", binary: "reasonix", format: "tar.gz" },
  "darwin-arm64": { archive: "reasonix-darwin-arm64.tar.gz", binary: "reasonix", format: "tar.gz" },
  "linux-x64": { archive: "reasonix-linux-amd64.tar.gz", binary: "reasonix", format: "tar.gz" },
  "linux-arm64": { archive: "reasonix-linux-arm64.tar.gz", binary: "reasonix", format: "tar.gz" },
  "win32-x64": { archive: "reasonix-windows-amd64.zip", binary: "reasonix.exe", format: "zip" },
  "win32-arm64": { archive: "reasonix-windows-arm64.zip", binary: "reasonix.exe", format: "zip" },
};

interface PackagedReasonixManifest {
  schemaVersion: 1;
  platform: ReasonixPlatform;
  binary: string;
  upstreamBinarySha256: string;
  binarySha256: string;
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).sort().join(",") === [...keys].sort().join(",");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertManifest(manifest: unknown): asserts manifest is ReasonixReleaseManifest {
  if (!isRecord(manifest) || !hasExactKeys(manifest, RELEASE_MANIFEST_KEYS)) {
    throw new Error("Reasonix release manifest has an invalid schema");
  }
  if (
    manifest.schemaVersion !== 1 ||
    manifest.protocolVersion !== 1 ||
    manifest.upstream !== "esengine/DeepSeek-Reasonix" ||
    manifest.license !== "MIT"
  ) {
    throw new Error("Unsupported Reasonix release manifest");
  }
  if (typeof manifest.version !== "string" || !/^\d+\.\d+\.\d+$/.test(manifest.version) || manifest.tag !== `v${manifest.version}`) {
    throw new Error("Reasonix manifest has inconsistent version metadata");
  }
  if (typeof manifest.commit !== "string" || !/^[a-f0-9]{40}$/.test(manifest.commit)) {
    throw new Error("Reasonix manifest has an invalid upstream commit");
  }
  if (
    manifest.licenseFile !== "LICENSE" ||
    typeof manifest.licenseSha256 !== "string" ||
    !SHA256_PATTERN.test(manifest.licenseSha256)
  ) {
    throw new Error("Reasonix manifest has an invalid upstream license pin");
  }
  if (!isRecord(manifest.assets) || !hasExactKeys(manifest.assets, Object.keys(PLATFORM_ASSETS))) {
    throw new Error("Reasonix manifest must pin exactly the supported platforms");
  }
  for (const [platform, expected] of Object.entries(PLATFORM_ASSETS) as Array<[
    ReasonixPlatform,
    (typeof PLATFORM_ASSETS)[ReasonixPlatform],
  ]>) {
    const asset = manifest.assets[platform];
    if (!isRecord(asset) || !hasExactKeys(asset, ASSET_KEYS)) {
      throw new Error(`Reasonix manifest has an invalid asset schema for ${platform}`);
    }
    if (asset.archive !== expected.archive || asset.binary !== expected.binary || asset.format !== expected.format) {
      throw new Error(`Reasonix manifest has unexpected asset metadata for ${platform}`);
    }
    if (
      typeof asset.archiveSha256 !== "string" ||
      typeof asset.binarySha256 !== "string" ||
      !SHA256_PATTERN.test(asset.archiveSha256) ||
      !SHA256_PATTERN.test(asset.binarySha256)
    ) {
      throw new Error(`Reasonix manifest has an invalid SHA-256 for ${asset.archive}`);
    }
  }
}

const parsedReleaseManifest: unknown = releaseManifestJson;
assertManifest(parsedReleaseManifest);
export const REASONIX_RELEASE = parsedReleaseManifest;

export function currentReasonixPlatform(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): ReasonixPlatform {
  const key = `${platform}-${arch}`;
  if (key in REASONIX_RELEASE.assets) {
    return key as ReasonixPlatform;
  }
  throw new Error(`Reasonix ${REASONIX_RELEASE.version} is not packaged for ${key}`);
}

export async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.allocUnsafe(64 * 1024);
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
    }
  } finally {
    await handle.close();
  }
  return hash.digest("hex");
}

export async function verifyReasonixArchive(
  archivePath: string,
  platform: ReasonixPlatform = currentReasonixPlatform(),
): Promise<ReasonixReleaseAsset> {
  const asset = REASONIX_RELEASE.assets[platform];
  if (basename(archivePath) !== asset.archive) {
    throw new Error(`Expected Reasonix archive ${asset.archive}, received ${basename(archivePath)}`);
  }
  const actual = await sha256File(archivePath);
  if (actual !== asset.archiveSha256) {
    throw new Error(`Reasonix archive SHA-256 mismatch for ${asset.archive}`);
  }
  return asset;
}

export async function verifyReasonixBinary(
  binaryPath: string,
  platform: ReasonixPlatform = currentReasonixPlatform(),
): Promise<string> {
  const asset = REASONIX_RELEASE.assets[platform];
  if (basename(binaryPath) !== asset.binary) {
    throw new Error(`Expected Reasonix binary ${asset.binary}, received ${basename(binaryPath)}`);
  }

  const [resolvedBinary, resolvedParent] = await Promise.all([
    realpath(binaryPath),
    realpath(dirname(binaryPath)),
  ]);
  if (dirname(resolvedBinary) !== resolvedParent) {
    throw new Error("Reasonix binary must not resolve outside its package directory");
  }

  const metadata = await stat(resolvedBinary);
  if (!metadata.isFile()) throw new Error("Reasonix binary is not a regular file");
  if (platform !== "win32-x64" && platform !== "win32-arm64" && (metadata.mode & 0o111) === 0) {
    throw new Error("Reasonix binary is not executable");
  }

  const actual = await sha256File(resolvedBinary);
  if (actual !== asset.binarySha256) {
    throw new Error(`Reasonix binary SHA-256 mismatch for ${asset.binary}`);
  }
  return resolvedBinary;
}

export async function resolvePackagedReasonixBinary(
  packageRoot: string,
  platform: ReasonixPlatform = currentReasonixPlatform(),
  integrityManifestPath?: string,
): Promise<string> {
  const root = resolve(packageRoot);
  const asset = REASONIX_RELEASE.assets[platform];
  const candidate = resolve(root, platform, asset.binary);
  const resolvedRoot = await realpath(root);
  const resolvedPlatformDir = await realpath(resolve(resolvedRoot, platform));
  const [resolvedBinary, binaryMetadata] = await Promise.all([realpath(candidate), lstat(candidate)]);
  if (
    binaryMetadata.isSymbolicLink() ||
    !binaryMetadata.isFile() ||
    dirname(resolvedBinary) !== resolvedPlatformDir ||
    dirname(resolvedPlatformDir) !== resolvedRoot
  ) {
    throw new Error("Reasonix binary is outside the expected platform package directory");
  }
  if (platform !== "win32-x64" && platform !== "win32-arm64" && (binaryMetadata.mode & 0o111) === 0) {
    throw new Error("Reasonix binary is not executable");
  }

  if (!integrityManifestPath) {
    await verifyReasonixBinary(resolvedBinary, platform);
    return resolvedBinary;
  }

  const expectedManifestPath = resolve(resolvedRoot, "packaged-manifest.json");
  const requestedManifestPath = resolve(integrityManifestPath);
  if (
    !isAbsolute(integrityManifestPath) ||
    requestedManifestPath !== resolve(root, "packaged-manifest.json")
  ) {
    throw new Error("Reasonix packaged integrity manifest must be the trusted bundle manifest");
  }
  const manifestMetadata = await lstat(requestedManifestPath);
  if (!manifestMetadata.isFile() || manifestMetadata.isSymbolicLink() || manifestMetadata.size > 4096) {
    throw new Error("Reasonix packaged integrity manifest is not a regular bounded file");
  }
  const resolvedManifest = await realpath(requestedManifestPath);
  if (resolvedManifest !== expectedManifestPath || dirname(resolvedManifest) !== resolvedRoot) {
    throw new Error("Reasonix packaged integrity manifest is outside the package root");
  }

  let manifest: unknown;
  try {
    manifest = JSON.parse(await readFile(resolvedManifest, "utf8"));
  } catch {
    throw new Error("Reasonix packaged integrity manifest is invalid JSON");
  }
  if (
    typeof manifest !== "object" ||
    manifest === null ||
    Array.isArray(manifest) ||
    Object.keys(manifest).sort().join(",") !==
      "binary,binarySha256,platform,schemaVersion,upstreamBinarySha256"
  ) {
    throw new Error("Reasonix packaged integrity manifest has an invalid schema");
  }
  const packaged = manifest as Partial<PackagedReasonixManifest>;
  if (
    packaged.schemaVersion !== 1 ||
    packaged.platform !== platform ||
    packaged.binary !== asset.binary ||
    packaged.upstreamBinarySha256 !== asset.binarySha256 ||
    !SHA256_PATTERN.test(packaged.binarySha256 ?? "")
  ) {
    throw new Error("Reasonix packaged integrity manifest does not match the pinned release");
  }
  const actual = await sha256File(resolvedBinary);
  if (actual !== packaged.binarySha256) {
    throw new Error(`Reasonix packaged binary SHA-256 mismatch for ${asset.binary}`);
  }
  return resolvedBinary;
}

export async function readReleaseManifest(path: string): Promise<ReasonixReleaseManifest> {
  const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
  assertManifest(parsed);
  return parsed;
}
