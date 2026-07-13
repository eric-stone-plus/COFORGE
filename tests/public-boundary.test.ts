import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { spawnSync } from "child_process";
import { join } from "path";
import { tmpdir } from "os";

// CommonJS keeps the same policy consumable by the standalone Node gate.
const { boundaryViolation } = require("../scripts/public-boundary-policy") as {
  boundaryViolation(file: string): string | null;
};
const { historicalBoundaryViolations } = require("../scripts/check-public-boundary") as {
  historicalBoundaryViolations(files: string[]): string[];
};

describe("public repository boundary policy", () => {
  it.each([
    ".npmrc",
    ".netrc",
    "client.pem",
    "client.key",
    "client.p12",
    "data/production.db",
    "data/customer-export.csv",
    "data/private/contracts.csv",
    "data/raw/export.csv",
    "data/company/suppliers.csv",
    "legacy/co-series/private-snapshot/README.md",
    "credentials.json",
    ".env.production",
  ])("blocks sensitive candidate %s", (file) => {
    expect(boundaryViolation(file)).toBeTruthy();
  });

  it.each([".env.example", "data/coal-demo.db", "src/app/page.tsx", "assets/hero.svg", "assets/COFORGE-Company-Pitch.pptx"])(
    "allows reviewed public file %s",
    (file) => expect(boundaryViolation(file)).toBeNull(),
  );
});

describe("workflow supply-chain pins", () => {
  it.each(["ci.yml", "codeql.yml", "secret-scan.yml"])("pins every action in %s to a commit SHA", (name) => {
    const content = readFileSync(join(process.cwd(), ".github", "workflows", name), "utf8");
    const actions = [...content.matchAll(/^\s*-?\s*uses:\s*([^\s#]+)/gm)].map((match) => match[1]);
    expect(actions.length).toBeGreaterThan(0);
    expect(actions.every((action) => action.startsWith("./") || /^[^@]+@[a-f0-9]{40}$/.test(action))).toBe(true);
  });
});

describe("dependency update policy", () => {
  it("tracks npm and GitHub Actions updates", () => {
    const content = readFileSync(join(process.cwd(), ".github", "dependabot.yml"), "utf8");
    expect(content).toMatch(/package-ecosystem:\s*npm/);
    expect(content).toMatch(/package-ecosystem:\s*github-actions/);
    expect(content).toMatch(/github-actions:\s*\n\s+patterns:\s*\n\s+- ["']\*["']/);
  });
});

describe("public release mode", () => {
  it("rejects the private legacy snapshot through the shared policy", () => {
    expect(boundaryViolation("legacy/co-series/private-snapshot/README.md")).toMatch(/internal working archive/);
  });

  it("runs CI in strict public-release mode", () => {
    const content = readFileSync(join(process.cwd(), ".github", "workflows", "ci.yml"), "utf8");
    expect(content).toMatch(/COFORGE_PUBLIC_RELEASE:\s*["']?1["']?/);
  });

  it("checks every path reachable from HEAD history without depending on archive history", () => {
    const source = readFileSync(join(process.cwd(), "scripts", "check-public-boundary.js"), "utf8");
    expect(source).toMatch(/\["log", "--format=", "--name-only", "-z", "HEAD"\]/);
    expect(source).toMatch(/sensitive or private path remains in reachable Git history/);

    expect(historicalBoundaryViolations([
      "README.md",
      "legacy/co-series/private-snapshot/README.md",
      ".env.production",
      "legacy/co-series/private-snapshot/README.md",
    ])).toEqual([
      "legacy/co-series/private-snapshot/README.md",
      ".env.production",
    ]);
  });
});

describe("SBOM completeness", () => {
  it("reconciles generated components with the production package-lock graph", () => {
    const source = readFileSync(join(process.cwd(), "scripts", "verify-sbom.js"), "utf8");
    expect(source).toMatch(/production lockfile component is missing from SBOM/);
    expect(source).toMatch(/SBOM version mismatch/);
    expect(source).toMatch(/SBOM contains a non-production or unknown lockfile component/);
    expect(source).toMatch(/SBOM dependency edge is missing/);
    expect(source).toMatch(/SBOM contains an unexpected dependency edge/);
  });

  it("rejects a dependency edge that is removed from an otherwise valid SBOM", () => {
    const directory = mkdtempSync(join(tmpdir(), "coforge-sbom-edge-"));
    const output = join(directory, "tampered.cdx.json");
    const lockfile = join(directory, "package-lock.json");
    try {
      const bom = {
        bomFormat: "CycloneDX",
        specVersion: "1.6",
        version: 1,
        metadata: { component: { type: "application", name: "coforge", version: "0.1.0", "bom-ref": "coforge@0.1.0", licenses: [{ license: { id: "Apache-2.0" } }] } },
        components: [{ type: "library", name: "fixture", version: "1.0.0", "bom-ref": "fixture@1.0.0", properties: [{ name: "cdx:npm:package:path", value: "node_modules/fixture" }] }],
        dependencies: [{ ref: "coforge@0.1.0", dependsOn: [] }, { ref: "fixture@1.0.0", dependsOn: [] }],
      };
      const lock = { lockfileVersion: 3, packages: { "": { name: "coforge", version: "0.1.0", dependencies: { fixture: "1.0.0" } }, "node_modules/fixture": { version: "1.0.0" } } };
      writeFileSync(output, `${JSON.stringify(bom, null, 2)}\n`);
      writeFileSync(lockfile, `${JSON.stringify(lock, null, 2)}\n`);
      const result = spawnSync(process.execPath, [join(process.cwd(), "scripts", "verify-sbom.js"), output, lockfile], { encoding: "utf8" });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("SBOM dependency edge is missing");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rejects duplicate dependency edges in an otherwise valid SBOM", () => {
    const directory = mkdtempSync(join(tmpdir(), "coforge-sbom-duplicate-"));
    const output = join(directory, "duplicate.cdx.json");
    const lockfile = join(directory, "package-lock.json");
    try {
      const bom = {
        bomFormat: "CycloneDX", specVersion: "1.6", version: 1,
        metadata: { component: { type: "application", name: "coforge", version: "0.1.0", "bom-ref": "coforge@0.1.0", licenses: [{ license: { id: "Apache-2.0" } }] } },
        components: [{ type: "library", name: "fixture", version: "1.0.0", "bom-ref": "fixture@1.0.0", properties: [{ name: "cdx:npm:package:path", value: "node_modules/fixture" }] }],
        dependencies: [{ ref: "coforge@0.1.0", dependsOn: ["fixture@1.0.0", "fixture@1.0.0"] }, { ref: "fixture@1.0.0", dependsOn: [] }],
      };
      const lock = { lockfileVersion: 3, packages: { "": { name: "coforge", version: "0.1.0", dependencies: { fixture: "1.0.0" } }, "node_modules/fixture": { version: "1.0.0" } } };
      writeFileSync(output, `${JSON.stringify(bom, null, 2)}\n`);
      writeFileSync(lockfile, `${JSON.stringify(lock, null, 2)}\n`);
      const result = spawnSync(process.execPath, [join(process.cwd(), "scripts", "verify-sbom.js"), output, lockfile], { encoding: "utf8" });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("dependency graph contains duplicate edges");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe("macOS desktop release defaults", () => {
  it("keeps Web Inspector disabled unless an explicit development switch is set", () => {
    const source = readFileSync(join(process.cwd(), "desktop", "COFORGE.swift"), "utf8");
    expect(source.match(/developerExtrasEnabled/g)).toHaveLength(1);
    expect(source).toMatch(
      /if ProcessInfo\.processInfo\.environment\["COFORGE_ENABLE_WEB_INSPECTOR"\] == "1" \{\s+config\.preferences\.setValue\(true, forKey: "developerExtrasEnabled"\)\s+\}/,
    );
  });

  it("limits the library-validation exception to ad-hoc Node builds", () => {
    const development = readFileSync(join(process.cwd(), "desktop", "NodeDevelopment.entitlements"), "utf8");
    const distribution = readFileSync(join(process.cwd(), "desktop", "Node.entitlements"), "utf8");
    const build = readFileSync(join(process.cwd(), "desktop", "build_macos.sh"), "utf8");

    expect(development).toContain("com.apple.security.cs.disable-library-validation");
    expect(distribution).not.toContain("com.apple.security.cs.disable-library-validation");
    expect(build).toMatch(/Developer ID builds must keep Node library validation enabled/);
    expect(build).toMatch(/Signed Developer ID Node unexpectedly disables library validation/);
    expect(build).toMatch(/Signed ad-hoc Node is missing the development-only library validation exception/);
  });

  it("packages and verifies standalone npm license resources", () => {
    const build = readFileSync(join(process.cwd(), "desktop", "build_macos.sh"), "utf8");
    expect(build).toContain("npm run licenses:generate");
    expect(build).toContain("npm run licenses:verify");
    expect(build).toContain('Resources/licenses/third-party');
    expect(build).toContain('scripts/verify-third-party-licenses.js');
  });

  it("cleans prior desktop output and verifies the extracted archive seal", () => {
    const build = readFileSync(join(process.cwd(), "desktop", "build_macos.sh"), "utf8");
    expect(build.indexOf('rm -rf "$DIST"')).toBeLessThan(build.indexOf("npm run build"));
    expect(build).toMatch(/ditto -c -k --norsrc --noextattr --noacl --noqtn --keepParent/);
    expect(build).toContain("unzip -q");
    expect(build).toContain("-name '._*'");
    expect(build).toContain('codesign --verify --deep --strict --verbose=2 "$ARCHIVE_VERIFY_DIR/COFORGE.app"');
  });
});
