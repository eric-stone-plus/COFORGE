const { execFileSync } = require("child_process");
const { existsSync, readFileSync, statSync } = require("fs");
const { boundaryViolation } = require("./public-boundary-policy");
const maxTrackedBytes = 5 * 1024 * 1024;
const legacyArchivePrefix = "legacy/co-series/";

function reachableHistoryFiles() {
  return execFileSync(
    "git",
    ["log", "--format=", "--name-only", "-z", "HEAD"],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  )
    .split("\0")
    .filter(Boolean);
}

function historicalBoundaryViolations(files) {
  return [...new Set(files.filter((file) => boundaryViolation(file)))];
}

function candidateFiles() {
  return execFileSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    { encoding: "utf8" },
  )
    .split("\0")
    .filter(Boolean);
}

function main() {
  const files = candidateFiles();
  const errors = [];
  for (const file of files) {
    if (!existsSync(file)) continue;
    const violation = boundaryViolation(file);
    // The current worktree is also the source for the private archive. Its legacy
    // snapshot is removed before the clean public root commit is created.
    if (violation && !file.startsWith(legacyArchivePrefix)) errors.push(`${file}: ${violation}`);
    if (file !== "assets/COFORGE-Company-Pitch.pptx" && statSync(file).size > maxTrackedBytes) {
      errors.push(`${file}: tracked file exceeds 5 MiB`);
    }
  }

  if (process.env.COFORGE_PUBLIC_RELEASE === "1") {
    for (const file of files.filter((candidate) => candidate.startsWith(legacyArchivePrefix))) {
      errors.push(`${file}: private legacy snapshot must be absent from a public release tree`);
    }
    for (const file of historicalBoundaryViolations(reachableHistoryFiles())) {
      errors.push(`${file}: sensitive or private path remains in reachable Git history`);
    }
  }

  for (const workflow of files.filter((file) => file.startsWith(".github/workflows/") && /\.ya?ml$/i.test(file))) {
    const content = readFileSync(workflow, "utf8");
    for (const match of content.matchAll(/^\s*-?\s*uses:\s*([^\s#]+)(?:\s+#.*)?$/gm)) {
      const action = match[1];
      if (action.startsWith("./") || /^[^@]+@[a-f0-9]{40}$/.test(action)) continue;
      errors.push(`${workflow}: GitHub Action must be pinned to a full commit SHA (${action})`);
    }
  }

  if (errors.length) {
    console.error("Public repository boundary check failed:\n" + errors.map((error) => `- ${error}`).join("\n"));
    process.exit(1);
  }

  console.log("Public repository boundary check passed.");
}

if (require.main === module) main();

module.exports = { historicalBoundaryViolations };
