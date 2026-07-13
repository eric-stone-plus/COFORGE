const { createHash } = require("crypto");
const { existsSync, readFileSync, statSync } = require("fs");
const { basename, join } = require("path");

const manifestPath = join(__dirname, "..", "src", "lib", "reasonix", "release-manifest.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const sha256Pattern = /^[a-f0-9]{64}$/;
const commitPattern = /^[a-f0-9]{40}$/;
const expectedPlatforms = [
  "darwin-x64",
  "darwin-arm64",
  "linux-x64",
  "linux-arm64",
  "win32-x64",
  "win32-arm64",
];
const expectedAssets = {
  "darwin-x64": ["reasonix-darwin-amd64.tar.gz", "tar.gz", "reasonix", "5424abde113f91291d49b775b48ad92b5db0d0d78cf9a6a4577adb8a776bd107", "f839fcc1b85539eb2bd8c921239c72570a02b8f38eec23d51b1987148c349adc"],
  "darwin-arm64": ["reasonix-darwin-arm64.tar.gz", "tar.gz", "reasonix", "2d10cf48643441fa854d878f036c62acb0d78eec6f5483f2469f113e2500d857", "a7adba9ee65175e73a4218b2ffb78a3c09e81c5a47b59d6ceb153ba3bdab1ff6"],
  "linux-x64": ["reasonix-linux-amd64.tar.gz", "tar.gz", "reasonix", "109b90fb6421b6015614a19dfcdb2f38e825d90e5c658d8a9f25b0e89c58595d", "65b1de073d7c4c6fb4d2a6b009e42987e2f7d3e300ba9a496f57966285d8b0c3"],
  "linux-arm64": ["reasonix-linux-arm64.tar.gz", "tar.gz", "reasonix", "7f6b89e30c128b5f3a9ab06f6d4d7c07cab2e2db21e7bb7a3d08c2bd44526147", "2436ad221a4a8d6235c854eb2ee0a7e55a716aa6420db36f4b3a949118cc7e41"],
  "win32-x64": ["reasonix-windows-amd64.zip", "zip", "reasonix.exe", "0cbf662cb24545a1a910796224659709d42899a956a9dc479b16e5a6a050d990", "7c7e68fbc9ea8187e6c01c17b139dfafa26ad65978684e99db2ef2e21a3b9b69"],
  "win32-arm64": ["reasonix-windows-arm64.zip", "zip", "reasonix.exe", "6109b66ecb91da6184b8df63778589bd788f27789cc5e1a8418f82283d20e9bc", "ba5f232f62e78bd10a031f4569536fbfcca0bf9a5d51324fe3003d3c1e308460"],
};
const manifestKeys = [
  "assets", "commit", "license", "licenseFile", "licenseSha256", "protocolVersion",
  "schemaVersion", "tag", "upstream", "version",
];
const assetKeys = ["archive", "archiveSha256", "binary", "binarySha256", "format"];

function hasExactKeys(value, expected) {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).sort().join(",") === [...expected].sort().join(",");
}

const errors = [];
if (!hasExactKeys(manifest, manifestKeys)) errors.push("manifest has unknown or missing top-level fields");
if (manifest.schemaVersion !== 1) errors.push("schemaVersion must be 1");
if (manifest.protocolVersion !== 1) errors.push("protocolVersion must be 1");
if (manifest.upstream !== "esengine/DeepSeek-Reasonix") errors.push("unexpected upstream repository");
if (manifest.version !== "1.17.11" || manifest.tag !== "v1.17.11") errors.push("release version drifted from the reviewed release");
if (manifest.commit !== "20a64b4d15687fbddb7ccc658daf909f71d01427" || !commitPattern.test(manifest.commit ?? "")) {
  errors.push("upstream commit drifted from the reviewed release");
}
if (manifest.license !== "MIT" || manifest.licenseFile !== "LICENSE") errors.push("unexpected upstream license metadata");
if (manifest.licenseSha256 !== "dc024237821ac82056c37f8d82e3be919bd51e39a4529ec12a8ab3e2a346dc4c") {
  errors.push("upstream license SHA-256 drifted from the reviewed release");
}
const manifestPlatforms = Object.keys(manifest.assets ?? {});
if (manifestPlatforms.length !== expectedPlatforms.length || expectedPlatforms.some((platform) => !manifestPlatforms.includes(platform))) {
  errors.push("manifest must contain exactly the reviewed platform set");
}

for (const platform of expectedPlatforms) {
  const asset = manifest.assets?.[platform];
  if (!asset) {
    errors.push(`missing release asset for ${platform}`);
    continue;
  }
  if (!hasExactKeys(asset, assetKeys)) errors.push(`${platform}: asset has unknown or missing fields`);
  if (!sha256Pattern.test(asset.archiveSha256 ?? "")) errors.push(`${platform}: invalid archive SHA-256`);
  if (!sha256Pattern.test(asset.binarySha256 ?? "")) errors.push(`${platform}: invalid binary SHA-256`);
  if (basename(asset.archive ?? "") !== asset.archive) errors.push(`${platform}: archive must be a basename`);
  const expected = expectedAssets[platform];
  if (
    asset.archive !== expected[0] ||
    asset.format !== expected[1] ||
    asset.binary !== expected[2] ||
    asset.archiveSha256 !== expected[3] ||
    asset.binarySha256 !== expected[4]
  ) {
    errors.push(`${platform}: manifest drifted from the reviewed upstream release`);
  }
}

const packageRoot = process.argv[2];
if (packageRoot) {
  for (const platform of expectedPlatforms) {
    const asset = manifest.assets[platform];
    const binaryPath = join(packageRoot, platform, asset.binary);
    if (!existsSync(binaryPath) || !statSync(binaryPath).isFile()) {
      errors.push(`${platform}: packaged binary is missing`);
      continue;
    }
    const actual = createHash("sha256").update(readFileSync(binaryPath)).digest("hex");
    if (actual !== asset.binarySha256) errors.push(`${platform}: packaged binary SHA-256 mismatch`);
  }
}

if (errors.length) {
  console.error("Reasonix release verification failed:\n" + errors.map((error) => `- ${error}`).join("\n"));
  process.exit(1);
}

console.log(`Reasonix ${manifest.version} release manifest verified (${manifest.commit}).`);
