#!/usr/bin/env node

"use strict";

const { createHash } = require("crypto");
const {
  cpSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} = require("fs");
const { basename, join, relative, resolve, sep } = require("path");

const MANIFEST_NAME = "THIRD-PARTY-LICENSES.json";
const LICENSE_FILE = /^(?:licen[cs]e|copying)(?:[._-].*)?$/i;
const NOTICE_FILE = /^(?:notice|copyright)(?:[._-].*)?$/i;
const SPDX_ID = /^[A-Za-z0-9][A-Za-z0-9.+-]*$/;

function packageDirectories(nodeModulesRoot, prefix = "node_modules") {
  const packages = [];
  for (const entry of readdirSync(nodeModulesRoot, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory() || entry.name === ".bin") continue;
    const entryPath = join(nodeModulesRoot, entry.name);
    if (entry.name.startsWith("@")) {
      for (const scoped of readdirSync(entryPath, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        if (!scoped.isDirectory()) continue;
        collectPackage(join(entryPath, scoped.name), `${prefix}/${entry.name}/${scoped.name}`, packages);
      }
    } else {
      collectPackage(entryPath, `${prefix}/${entry.name}`, packages);
    }
  }
  return packages;
}

function collectPackage(directory, locator, packages) {
  const packageJsonPath = join(directory, "package.json");
  let metadata;
  try {
    metadata = JSON.parse(readFileSync(packageJsonPath, "utf8"));
  } catch {
    return;
  }
  if (typeof metadata.name !== "string" || typeof metadata.version !== "string") return;
  packages.push({ directory, locator, metadata });
  const nested = join(directory, "node_modules");
  try {
    if (statSync(nested).isDirectory()) packages.push(...packageDirectories(nested, `${locator}/node_modules`));
  } catch {
    // Most packages are flattened and have no nested node_modules directory.
  }
}

function sha256(contents) {
  return createHash("sha256").update(contents).digest("hex");
}

function findSourcePackage(runtimePackage, sourcePackages) {
  const exact = sourcePackages.find((candidate) => candidate.locator === runtimePackage.locator);
  if (exact && exact.metadata.name === runtimePackage.metadata.name && exact.metadata.version === runtimePackage.metadata.version) {
    return exact;
  }
  const matches = sourcePackages.filter((candidate) => (
    candidate.metadata.name === runtimePackage.metadata.name
    && candidate.metadata.version === runtimePackage.metadata.version
  ));
  if (matches.length !== 1) {
    throw new Error(`Unable to uniquely locate license source for ${runtimePackage.metadata.name}@${runtimePackage.metadata.version}`);
  }
  return matches[0];
}

function licenseFiles(directory) {
  const names = readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && (LICENSE_FILE.test(entry.name) || NOTICE_FILE.test(entry.name)))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));
  const readme = readdirSync(directory, { withFileTypes: true })
    .find((entry) => entry.isFile() && /^readme\.md$/i.test(entry.name));
  if (readme && /(?:^|\n)#{1,3}\s+Licen[cs]ing\s*(?:\n|$)/i.test(readFileSync(join(directory, readme.name), "utf8"))) {
    names.push(readme.name);
  }
  return names.sort((a, b) => a.localeCompare(b));
}

function spdxLicenseText(expression) {
  if (!SPDX_ID.test(expression)) return null;
  try {
    const record = require(`spdx-license-list/licenses/${expression}.json`);
    return typeof record.licenseText === "string" && record.licenseText.trim()
      ? `${record.licenseText.trimEnd()}\n`
      : null;
  } catch {
    return null;
  }
}

function generateThirdPartyLicenses({ sourceNodeModules, runtimeNodeModules, outputDirectory }) {
  const sourceRoot = resolve(sourceNodeModules);
  const runtimeRoot = resolve(runtimeNodeModules);
  const outputRoot = resolve(outputDirectory);
  const runtimePackages = packageDirectories(runtimeRoot);
  const sourcePackages = packageDirectories(sourceRoot);
  if (runtimePackages.length === 0) throw new Error("Standalone runtime contains no npm packages");

  rmSync(outputRoot, { recursive: true, force: true });
  mkdirSync(join(outputRoot, "components"), { recursive: true, mode: 0o755 });
  const components = runtimePackages
    .sort((a, b) => a.locator.localeCompare(b.locator))
    .map((runtimePackage) => {
      const sourcePackage = findSourcePackage(runtimePackage, sourcePackages);
      const expression = typeof sourcePackage.metadata.license === "string" ? sourcePackage.metadata.license.trim() : "";
      if (!expression) throw new Error(`${runtimePackage.metadata.name}@${runtimePackage.metadata.version} has no license expression`);
      const names = licenseFiles(sourcePackage.directory);
      const fallbackText = names.some((name) => LICENSE_FILE.test(name)) ? null : spdxLicenseText(expression);
      if (!names.some((name) => LICENSE_FILE.test(name)) && !fallbackText) {
        throw new Error(`${runtimePackage.metadata.name}@${runtimePackage.metadata.version} has no distributable or exact SPDX license text`);
      }
      const componentId = sha256(runtimePackage.locator).slice(0, 16);
      const sources = names.map((name) => ({
        name: /^readme\.md$/i.test(name) ? "NOTICE-README.md" : name,
        source: join(sourcePackage.directory, name),
      }));
      if (fallbackText) sources.push({ name: "LICENSE.spdx.txt", contents: Buffer.from(fallbackText, "utf8") });
      const files = sources.sort((a, b) => a.name.localeCompare(b.name)).map(({ name, source, contents }) => {
        const body = contents ?? readFileSync(source);
        const destination = join("components", componentId, basename(name));
        mkdirSync(join(outputRoot, "components", componentId), { recursive: true, mode: 0o755 });
        if (source) cpSync(source, join(outputRoot, destination));
        else writeFileSync(join(outputRoot, destination), body, { mode: 0o644 });
        return { path: destination.split(sep).join("/"), sha256: sha256(body) };
      });
      return {
        locator: runtimePackage.locator,
        name: runtimePackage.metadata.name,
        version: runtimePackage.metadata.version,
        license: expression,
        files,
      };
    });

  const manifest = { schemaVersion: 1, components };
  writeFileSync(join(outputRoot, MANIFEST_NAME), `${JSON.stringify(manifest, null, 2)}\n`, { encoding: "utf8", mode: 0o644 });
  return manifest;
}

function defaultOptions(args = process.argv.slice(2)) {
  const root = resolve(__dirname, "..");
  return {
    sourceNodeModules: resolve(args[0] || join(root, "node_modules")),
    runtimeNodeModules: resolve(args[1] || join(root, ".next", "standalone", "node_modules")),
    outputDirectory: resolve(args[2] || join(root, "artifacts", "licenses", "third-party")),
  };
}

if (require.main === module) {
  try {
    const options = defaultOptions();
    const manifest = generateThirdPartyLicenses(options);
    console.log(`Bundled ${manifest.components.length} standalone npm license records in ${relative(process.cwd(), options.outputDirectory) || "."}.`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Third-party license generation failed");
    process.exit(1);
  }
}

module.exports = {
  LICENSE_FILE,
  MANIFEST_NAME,
  defaultOptions,
  generateThirdPartyLicenses,
  packageDirectories,
  sha256,
  spdxLicenseText,
};
