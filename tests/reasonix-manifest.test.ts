import { chmod, mkdtemp, mkdir, rm, symlink, writeFile } from "fs/promises";
import { createHash } from "crypto";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  currentReasonixPlatform,
  readReleaseManifest,
  REASONIX_RELEASE,
  resolvePackagedReasonixBinary,
  sha256File,
  verifyReasonixArchive,
  verifyReasonixBinary,
} from "../src/lib/reasonix/manifest";

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "coforge-reasonix-manifest-"));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe("Reasonix release manifest", () => {
  it("pins a full commit, ACP v1, and two hashes for every packaged platform", () => {
    expect(REASONIX_RELEASE).toMatchObject({
      upstream: "esengine/DeepSeek-Reasonix",
      version: "1.17.11",
      tag: "v1.17.11",
      commit: "20a64b4d15687fbddb7ccc658daf909f71d01427",
      protocolVersion: 1,
      license: "MIT",
      licenseFile: "LICENSE",
      licenseSha256: "dc024237821ac82056c37f8d82e3be919bd51e39a4529ec12a8ab3e2a346dc4c",
    });
    expect(Object.keys(REASONIX_RELEASE.assets)).toEqual([
      "darwin-x64",
      "darwin-arm64",
      "linux-x64",
      "linux-arm64",
      "win32-x64",
      "win32-arm64",
    ]);
    for (const asset of Object.values(REASONIX_RELEASE.assets)) {
      expect(asset.archiveSha256).toMatch(/^[a-f0-9]{64}$/);
      expect(asset.binarySha256).toMatch(/^[a-f0-9]{64}$/);
    }
  });

  it("rejects platforms that have no pinned artifact", () => {
    expect(() => currentReasonixPlatform("freebsd", "x64")).toThrow("not packaged");
  });

  it("rejects release metadata, platform, and asset-shape drift", async () => {
    const manifestPath = join(tempDir, "release-manifest.json");
    const cases = [
      { ...REASONIX_RELEASE, upstream: "example/Reasonix" },
      { ...REASONIX_RELEASE, tag: "v0.0.0" },
      { ...REASONIX_RELEASE, extra: true },
      {
        ...REASONIX_RELEASE,
        assets: Object.fromEntries(Object.entries(REASONIX_RELEASE.assets).filter(([platform]) => platform !== "linux-arm64")),
      },
      {
        ...REASONIX_RELEASE,
        assets: {
          ...REASONIX_RELEASE.assets,
          "darwin-arm64": { ...REASONIX_RELEASE.assets["darwin-arm64"], archive: "renamed.tar.gz" },
        },
      },
    ];

    for (const manifest of cases) {
      await writeFile(manifestPath, JSON.stringify(manifest));
      await expect(readReleaseManifest(manifestPath)).rejects.toThrow(/Reasonix/);
    }
  });

  it("hashes files without loading an executable", async () => {
    const path = join(tempDir, "payload");
    await writeFile(path, "coforge");
    await expect(sha256File(path)).resolves.toBe(
      "d67200d6eadbdbeb8f709584d72293fd2ee23ebe67eedf09f4a0107c279dc508",
    );
  });

  it("fails closed on archive name or digest mismatch", async () => {
    const asset = REASONIX_RELEASE.assets["darwin-arm64"];
    const wrongName = join(tempDir, "renamed.tar.gz");
    const rightName = join(tempDir, asset.archive);
    await writeFile(wrongName, "untrusted");
    await writeFile(rightName, "untrusted");

    await expect(verifyReasonixArchive(wrongName, "darwin-arm64")).rejects.toThrow("Expected Reasonix archive");
    await expect(verifyReasonixArchive(rightName, "darwin-arm64")).rejects.toThrow("SHA-256 mismatch");
  });

  it("rejects an executable symlink that resolves outside its package directory", async () => {
    const packageDir = join(tempDir, "darwin-arm64");
    const outside = join(tempDir, "outside-reasonix");
    await mkdir(packageDir);
    await writeFile(outside, "untrusted", { mode: 0o700 });
    await chmod(outside, 0o700);
    await symlink(outside, join(packageDir, "reasonix"));

    await expect(verifyReasonixBinary(join(packageDir, "reasonix"), "darwin-arm64")).rejects.toThrow(
      "must not resolve outside",
    );
  });

  it("accepts only a strict bundle manifest for a post-signing binary hash", async () => {
    const platform = "darwin-arm64" as const;
    const asset = REASONIX_RELEASE.assets[platform];
    const packageRoot = join(tempDir, "reasonix");
    const platformDir = join(packageRoot, platform);
    const binary = join(platformDir, asset.binary);
    const manifest = join(packageRoot, "packaged-manifest.json");
    await mkdir(platformDir, { recursive: true });
    await writeFile(binary, "signed-binary-fixture", { mode: 0o700 });
    await chmod(binary, 0o700);
    const binarySha256 = createHash("sha256").update("signed-binary-fixture").digest("hex");
    await writeFile(manifest, JSON.stringify({
      schemaVersion: 1,
      platform,
      binary: asset.binary,
      upstreamBinarySha256: asset.binarySha256,
      binarySha256,
    }));

    await expect(resolvePackagedReasonixBinary(packageRoot, platform, manifest)).resolves.toBe(
      await import("fs/promises").then(({ realpath }) => realpath(binary)),
    );
    await writeFile(manifest, JSON.stringify({
      schemaVersion: 1,
      platform,
      binary: asset.binary,
      upstreamBinarySha256: "0".repeat(64),
      binarySha256,
    }));
    await expect(resolvePackagedReasonixBinary(packageRoot, platform, manifest)).rejects.toThrow(/pinned release/);
  });

  it("accepts a bundle-sealed post-signing digest only when it preserves the upstream pin", async () => {
    const platform = "darwin-x64" as const;
    const asset = REASONIX_RELEASE.assets[platform];
    const packageRoot = join(tempDir, "reasonix");
    const platformDir = join(packageRoot, platform);
    const binary = join(platformDir, asset.binary);
    const integrityManifest = join(packageRoot, "packaged-manifest.json");
    await mkdir(platformDir, { recursive: true });
    await writeFile(binary, "signed-fixture", { mode: 0o700 });
    await chmod(binary, 0o700);
    const binarySha256 = await sha256File(binary);
    await writeFile(integrityManifest, JSON.stringify({
      schemaVersion: 1,
      platform,
      binary: asset.binary,
      upstreamBinarySha256: asset.binarySha256,
      binarySha256,
    }));

    await expect(resolvePackagedReasonixBinary(packageRoot, platform, integrityManifest)).resolves.toBe(
      await import("fs/promises").then(({ realpath }) => realpath(binary)),
    );

    await writeFile(integrityManifest, JSON.stringify({
      schemaVersion: 1,
      platform,
      binary: asset.binary,
      upstreamBinarySha256: "0".repeat(64),
      binarySha256,
    }));
    await expect(resolvePackagedReasonixBinary(packageRoot, platform, integrityManifest)).rejects.toThrow(
      "does not match the pinned release",
    );
  });

  it("rejects an untrusted or symlinked packaged integrity manifest", async () => {
    const platform = "darwin-x64" as const;
    const asset = REASONIX_RELEASE.assets[platform];
    const packageRoot = join(tempDir, "reasonix");
    const platformDir = join(packageRoot, platform);
    const binary = join(platformDir, asset.binary);
    const outside = join(tempDir, "outside.json");
    const expectedManifest = join(packageRoot, "packaged-manifest.json");
    await mkdir(platformDir, { recursive: true });
    await writeFile(binary, "signed-fixture", { mode: 0o700 });
    await chmod(binary, 0o700);
    const payload = JSON.stringify({
      schemaVersion: 1,
      platform,
      binary: asset.binary,
      upstreamBinarySha256: asset.binarySha256,
      binarySha256: await sha256File(binary),
    });
    await writeFile(outside, payload);

    await expect(resolvePackagedReasonixBinary(packageRoot, platform, outside)).rejects.toThrow(
      "trusted bundle manifest",
    );
    await symlink(outside, expectedManifest);
    await expect(resolvePackagedReasonixBinary(packageRoot, platform, expectedManifest)).rejects.toThrow(
      "regular bounded file",
    );
  });
});
