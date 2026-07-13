#!/usr/bin/env node

const { mkdirSync, readFileSync } = require("fs");
const { dirname, join, resolve } = require("path");
const { spawnSync } = require("child_process");

const root = resolve(__dirname, "..");
const output = resolve(process.argv[2] || join(root, "artifacts", "sbom", "coforge.cdx.json"));
const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const pinnedVersion = packageJson.devDependencies?.["@cyclonedx/cyclonedx-npm"];

if (!/^\d+\.\d+\.\d+$/.test(pinnedVersion ?? "")) {
  console.error("@cyclonedx/cyclonedx-npm must be pinned to an exact version.");
  process.exit(1);
}

const cli = join(root, "node_modules", "@cyclonedx", "cyclonedx-npm", "bin", "cyclonedx-npm-cli.js");
mkdirSync(dirname(output), { recursive: true, mode: 0o755 });
const result = spawnSync(process.execPath, [
  cli,
  "--package-lock-only",
  "--omit", "dev",
  "--flatten-components",
  "--spec-version", "1.6",
  "--output-format", "JSON",
  "--output-reproducible",
  "--validate",
  "--output-file", output,
  join(root, "package.json"),
], {
  cwd: root,
  env: { ...process.env, BOM_REPRODUCIBLE: "1" },
  encoding: "utf8",
});

if (result.status !== 0 || result.error) {
  if (result.stderr) process.stderr.write(result.stderr);
  console.error(result.error?.message || "CycloneDX SBOM generation failed.");
  process.exit(result.status || 1);
}

const verification = spawnSync(process.execPath, [join(__dirname, "verify-sbom.js"), output], {
  cwd: root,
  encoding: "utf8",
});
if (verification.stdout) process.stdout.write(verification.stdout);
if (verification.status !== 0 || verification.error) {
  if (verification.stderr) process.stderr.write(verification.stderr);
  process.exit(verification.status || 1);
}
