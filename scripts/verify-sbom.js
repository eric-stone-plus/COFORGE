#!/usr/bin/env node

const { readFileSync } = require("fs");
const { isAbsolute, join, posix, resolve } = require("path");

function productionLockPackage(metadata) {
  return metadata && typeof metadata === "object" && !metadata.dev && !metadata.link;
}

function resolveLockDependency(lockPackages, packagePath, dependencyName) {
  let directory = packagePath;
  while (true) {
    const candidate = posix.join(directory, "node_modules", dependencyName);
    if (productionLockPackage(lockPackages[candidate])) return candidate;
    if (!directory) return null;
    const nestedAt = directory.lastIndexOf("/node_modules/");
    directory = nestedAt >= 0 ? directory.slice(0, nestedAt) : "";
  }
}

const path = resolve(process.argv[2] || "artifacts/sbom/coforge.cdx.json");
const projectRoot = resolve(__dirname, "..");
const packageLockPath = resolve(process.argv[3] || join(projectRoot, "package-lock.json"));
let source;
let bom;
try {
  source = readFileSync(path, "utf8");
  bom = JSON.parse(source);
} catch (error) {
  console.error(`Unable to read CycloneDX SBOM: ${error instanceof Error ? error.message : "invalid file"}`);
  process.exit(1);
}

const errors = [];
let packageLock;
try {
  packageLock = JSON.parse(readFileSync(packageLockPath, "utf8"));
} catch {
  errors.push("package-lock.json could not be loaded for SBOM completeness verification");
}
if (bom.bomFormat !== "CycloneDX" || bom.specVersion !== "1.6" || bom.version !== 1) {
  errors.push("SBOM must be CycloneDX 1.6 JSON with version 1");
}
if (bom.serialNumber !== undefined || bom.metadata?.timestamp !== undefined) {
  errors.push("SBOM must use reproducible output without serial number or timestamp");
}
const root = bom.metadata?.component;
if (root?.type !== "application" || root?.name !== "coforge" || root?.version !== "0.1.0") {
  errors.push("SBOM root component must be coforge 0.1.0 application");
}
if (root?.licenses?.[0]?.license?.id !== "Apache-2.0") {
  errors.push("SBOM root component must declare Apache-2.0");
}
if (!Array.isArray(bom.components) || bom.components.length === 0) {
  errors.push("SBOM has no production dependency components");
}
if (!Array.isArray(bom.dependencies) || bom.dependencies.length === 0) {
  errors.push("SBOM has no dependency graph");
}

const refs = new Set([root?.["bom-ref"]]);
const componentsByPath = new Map();
for (const component of bom.components ?? []) {
  if (typeof component?.["bom-ref"] !== "string") errors.push("component is missing bom-ref");
  else if (refs.has(component["bom-ref"])) errors.push(`duplicate bom-ref: ${component["bom-ref"]}`);
  else refs.add(component["bom-ref"]);
  const packagePath = component?.properties?.find?.((entry) => entry?.name === "cdx:npm:package:path")?.value;
  if (typeof packagePath !== "string" || !packagePath.startsWith("node_modules/")) {
    errors.push(`component has no valid npm package path: ${component?.["bom-ref"] ?? "unknown"}`);
  } else if (componentsByPath.has(packagePath)) {
    errors.push(`duplicate npm package path: ${packagePath}`);
  } else {
    componentsByPath.set(packagePath, component);
  }
}
const graphRefs = new Set();
const graphByRef = new Map();
for (const dependency of bom.dependencies ?? []) {
  if (typeof dependency?.ref !== "string") {
    errors.push("dependency graph entry is missing ref");
    continue;
  }
  const children = dependency.dependsOn ?? [];
  if (!Array.isArray(children) || children.some((child) => typeof child !== "string")) {
    errors.push(`dependency graph children must be a string array: ${dependency.ref}`);
    continue;
  }
  const sortedChildren = [...children].sort((a, b) => a.localeCompare(b));
  if (new Set(children).size !== children.length) {
    errors.push(`dependency graph contains duplicate edges: ${dependency.ref}`);
  }
  if (JSON.stringify(sortedChildren) !== JSON.stringify(children)) {
    errors.push(`dependency graph edges must be sorted: ${dependency.ref}`);
  }
  if (graphByRef.has(dependency.ref)) errors.push(`duplicate dependency graph entry: ${dependency.ref}`);
  graphByRef.set(dependency.ref, new Set(children));
  graphRefs.add(dependency.ref);
  for (const child of children) {
    if (!refs.has(child)) errors.push(`dependency graph references unknown component: ${child}`);
  }
}
for (const ref of refs) {
  if (typeof ref === "string" && !graphRefs.has(ref)) errors.push(`component is absent from dependency graph: ${ref}`);
}

const lockPackages = packageLock?.packages;
if (!lockPackages || typeof lockPackages !== "object") {
  errors.push("package-lock.json must contain a packages map");
} else {
  const productionPackages = Object.entries(lockPackages).filter(([packagePath, metadata]) => (
    packagePath.startsWith("node_modules/") && productionLockPackage(metadata)
  ));
  for (const [packagePath, metadata] of productionPackages) {
    const component = componentsByPath.get(packagePath);
    if (!component) {
      errors.push(`production lockfile component is missing from SBOM: ${packagePath}`);
      continue;
    }
    if (component.version !== metadata.version) {
      errors.push(`SBOM version mismatch for ${packagePath}: expected ${metadata.version}, received ${component.version ?? "missing"}`);
    }
  }
  for (const packagePath of componentsByPath.keys()) {
    if (!productionPackages.some(([expectedPath]) => expectedPath === packagePath)) {
      errors.push(`SBOM contains a non-production or unknown lockfile component: ${packagePath}`);
    }
  }

  const refByPath = new Map([...componentsByPath.entries()].map(([packagePath, component]) => [packagePath, component["bom-ref"]]));
  refByPath.set("", root?.["bom-ref"]);
  for (const [packagePath, metadata] of [["", lockPackages[""]], ...productionPackages]) {
    if (!productionLockPackage(metadata)) continue;
    const parentRef = refByPath.get(packagePath);
    if (typeof parentRef !== "string") continue;
    const expected = new Set();
    const dependencyNames = new Set([
      ...Object.keys(metadata.dependencies ?? {}),
      ...Object.keys(metadata.optionalDependencies ?? {}),
      ...Object.keys(metadata.peerDependencies ?? {}),
    ]);
    for (const dependencyName of dependencyNames) {
      const resolvedPath = resolveLockDependency(lockPackages, packagePath, dependencyName);
      if (resolvedPath) {
        const childRef = refByPath.get(resolvedPath);
        if (typeof childRef === "string") expected.add(childRef);
      } else if (!(metadata.optionalDependencies?.[dependencyName] || metadata.peerDependenciesMeta?.[dependencyName]?.optional)) {
        errors.push(`production lockfile dependency cannot be resolved: ${packagePath || "root"} -> ${dependencyName}`);
      }
    }
    const actual = graphByRef.get(parentRef) ?? new Set();
    for (const childRef of expected) {
      if (!actual.has(childRef)) errors.push(`SBOM dependency edge is missing: ${parentRef} -> ${childRef}`);
    }
    for (const childRef of actual) {
      if (!expected.has(childRef)) errors.push(`SBOM contains an unexpected dependency edge: ${parentRef} -> ${childRef}`);
    }
  }
}

const privatePathPatterns = [
  /(?:^|["'])\/(?:Users|home|private|tmp)\//,
  /[A-Za-z]:\\(?:Users|Documents and Settings)\\/i,
  /file:\/\//i,
];
if (privatePathPatterns.some((pattern) => pattern.test(source))) {
  errors.push("SBOM contains a local absolute path or file URI");
}
if (isAbsolute(root?.properties?.find?.((entry) => entry?.name === "cdx:npm:package:path")?.value ?? "")) {
  errors.push("SBOM root npm package path must be relative");
}

if (errors.length) {
  console.error(`CycloneDX SBOM verification failed:\n${errors.map((error) => `- ${error}`).join("\n")}`);
  process.exit(1);
}

console.log(`CycloneDX SBOM verified (${bom.components.length} production components, ${bom.dependencies.length} graph entries): ${path}`);
