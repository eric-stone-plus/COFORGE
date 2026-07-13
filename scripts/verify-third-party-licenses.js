#!/usr/bin/env node

"use strict";

const { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } = require("fs");
const { tmpdir } = require("os");
const { join, relative, resolve, sep } = require("path");
const {
  LICENSE_FILE,
  MANIFEST_NAME,
  defaultOptions,
  generateThirdPartyLicenses,
  packageDirectories,
  sha256,
} = require("./generate-third-party-licenses");

function regularFiles(root, current = root) {
  const files = [];
  for (const entry of readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join(current, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`license bundle must not contain symbolic links: ${relative(root, path)}`);
    if (entry.isDirectory()) files.push(...regularFiles(root, path));
    else if (entry.isFile()) files.push(relative(root, path).split(sep).join("/"));
    else throw new Error(`license bundle contains an unsupported filesystem entry: ${relative(root, path)}`);
  }
  return files;
}

function verifyThirdPartyLicenses({ sourceNodeModules, runtimeNodeModules, outputDirectory }) {
  const runtimeRoot = resolve(runtimeNodeModules);
  const outputRoot = resolve(outputDirectory);
  const errors = [];
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(join(outputRoot, MANIFEST_NAME), "utf8"));
  } catch {
    throw new Error(`Missing or invalid ${MANIFEST_NAME}`);
  }
  if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.components)) {
    errors.push("license manifest must use schemaVersion 1 and contain components");
  }

  const runtime = packageDirectories(runtimeRoot)
    .map((item) => `${item.locator}\0${item.metadata.name}\0${item.metadata.version}`)
    .sort();
  const declared = (manifest.components || [])
    .map((item) => `${item.locator}\0${item.name}\0${item.version}`)
    .sort();
  if (JSON.stringify(runtime) !== JSON.stringify(declared)) {
    errors.push("license manifest does not exactly match standalone runtime npm packages");
  }

  const expectedFiles = new Set([MANIFEST_NAME]);
  let priorLocator = "";
  const locators = new Set();
  for (const component of manifest.components || []) {
    if (typeof component.locator !== "string" || component.locator <= priorLocator) {
      errors.push("license components must be unique and sorted by locator");
    }
    priorLocator = component.locator;
    if (locators.has(component.locator)) errors.push(`duplicate license component: ${component.locator}`);
    locators.add(component.locator);
    if (typeof component.license !== "string" || !component.license.trim()) {
      errors.push(`${component.locator}: missing license expression`);
    }
    if (!Array.isArray(component.files) || !component.files.some((file) => LICENSE_FILE.test(file.path.split("/").at(-1) || ""))) {
      errors.push(`${component.locator}: missing license text`);
      continue;
    }
    let priorPath = "";
    for (const file of component.files) {
      if (typeof file.path !== "string" || file.path <= priorPath || !/^components\/[a-f0-9]{16}\/[A-Za-z0-9._-]+$/.test(file.path)) {
        errors.push(`${component.locator}: license file paths must be safe, unique, and sorted`);
        continue;
      }
      priorPath = file.path;
      expectedFiles.add(file.path);
      const absolute = resolve(outputRoot, file.path);
      if (!absolute.startsWith(`${outputRoot}${sep}`) || !existsSync(absolute) || !statSync(absolute).isFile()) {
        errors.push(`${component.locator}: missing bundled file ${file.path}`);
      } else if (!/^[a-f0-9]{64}$/.test(file.sha256) || sha256(readFileSync(absolute)) !== file.sha256) {
        errors.push(`${component.locator}: hash mismatch for ${file.path}`);
      }
    }
  }
  const actualFiles = regularFiles(outputRoot).sort((a, b) => a.localeCompare(b));
  const declaredFiles = [...expectedFiles].sort((a, b) => a.localeCompare(b));
  if (JSON.stringify(actualFiles) !== JSON.stringify(declaredFiles)) {
    errors.push("license bundle contains missing or undeclared files");
  }
  const expectedRoot = mkdtempSync(join(tmpdir(), "coforge-license-verify-"));
  try {
    generateThirdPartyLicenses({ sourceNodeModules, runtimeNodeModules, outputDirectory: expectedRoot });
    const expectedBundleFiles = regularFiles(expectedRoot).sort((a, b) => a.localeCompare(b));
    if (JSON.stringify(actualFiles) !== JSON.stringify(expectedBundleFiles)) {
      errors.push("license bundle does not match the locked source packages");
    } else {
      for (const file of expectedBundleFiles) {
        if (!readFileSync(join(outputRoot, file)).equals(readFileSync(join(expectedRoot, file)))) {
          errors.push(`license bundle differs from the locked source packages: ${file}`);
        }
      }
    }
  } finally {
    rmSync(expectedRoot, { recursive: true, force: true });
  }
  if (errors.length) throw new Error(`Third-party license verification failed:\n${errors.map((error) => `- ${error}`).join("\n")}`);
  return manifest;
}

if (require.main === module) {
  try {
    const options = defaultOptions();
    const manifest = verifyThirdPartyLicenses(options);
    console.log(`Verified ${manifest.components.length} standalone npm license records.`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Third-party license verification failed");
    process.exit(1);
  }
}

module.exports = { verifyThirdPartyLicenses };
