#!/usr/bin/env node

"use strict";

const { existsSync, readdirSync, readFileSync, statSync, writeFileSync } = require("fs");
const { join, resolve, sep } = require("path");

const USER_PATH = /(?:\/(?:Users|home|private)\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._@+~-]+)+|[A-Za-z]:\\+(?:Users|Documents and Settings)\\+[^\s"']+)/i;
const GENERIC_ROOT = "/coforge";

function regularTextFiles(directory, files = []) {
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Standalone output must not contain symbolic links: ${path}`);
    if (entry.isDirectory()) regularTextFiles(path, files);
    else if (entry.isFile() && !entry.isSymbolicLink()) {
      const contents = readFileSync(path);
      if (!contents.includes(0)) files.push({ path, contents });
    } else throw new Error(`Standalone output contains an unsupported filesystem entry: ${path}`);
  }
  return files;
}

function sanitizeStandalone(directory, sourceRoot = process.cwd()) {
  const root = resolve(directory);
  const source = resolve(sourceRoot);
  if (!statSync(root).isDirectory()) throw new Error(`Standalone directory is missing: ${root}`);
  const desktopBuildOutput = join(root, "desktop", "dist");
  if (existsSync(desktopBuildOutput)) {
    throw new Error(`Standalone output contains recursive desktop build artifacts: ${desktopBuildOutput}`);
  }
  const candidates = regularTextFiles(root);
  let changed = 0;
  for (const candidate of candidates) {
    const original = candidate.contents.toString("utf8");
    const sourcePrefix = `${source}${sep}`;
    let sanitized = original.split(sourcePrefix).join(`${GENERIC_ROOT}/`);
    for (const quote of ['"', "'"]) {
      sanitized = sanitized.split(`${quote}${source}${quote}`).join(`${quote}${GENERIC_ROOT}${quote}`);
    }
    if (sanitized !== original) {
      writeFileSync(candidate.path, sanitized, { encoding: "utf8", mode: statSync(candidate.path).mode & 0o777 });
      changed += 1;
    }
  }
  const leaks = regularTextFiles(root)
    .filter((candidate) => {
      const contents = candidate.contents.toString("utf8");
      if (contents.includes(`${source}${sep}`) || contents.includes(`"${source}"`) || contents.includes(`'${source}'`)) return true;
      return !candidate.path.startsWith(`${join(root, "node_modules")}${sep}`) && USER_PATH.test(contents);
    })
    .map((candidate) => candidate.path.slice(root.length + sep.length));
  if (leaks.length) throw new Error(`Standalone output contains local user paths:\n${leaks.join("\n")}`);
  return { changed, scanned: candidates.length };
}

if (require.main === module) {
  try {
    const directory = resolve(process.argv[2] || join(__dirname, "..", ".next", "standalone"));
    const sourceRoot = resolve(process.argv[3] || join(__dirname, ".."));
    const result = sanitizeStandalone(directory, sourceRoot);
    console.log(`Sanitized ${result.changed} of ${result.scanned} standalone text files.`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Standalone sanitization failed");
    process.exit(1);
  }
}

module.exports = { sanitizeStandalone };
