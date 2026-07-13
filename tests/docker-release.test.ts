import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { join, resolve } from "path";
import { tmpdir } from "os";

const { generateThirdPartyLicenses } = require("../scripts/generate-third-party-licenses") as {
  generateThirdPartyLicenses(options: Record<string, string>): { components: unknown[] };
};
const { verifyThirdPartyLicenses } = require("../scripts/verify-third-party-licenses") as {
  verifyThirdPartyLicenses(options: Record<string, string>): { components: unknown[] };
};
const { sanitizeStandalone } = require("../scripts/sanitize-standalone") as {
  sanitizeStandalone(directory: string, sourceRoot?: string): { changed: number; scanned: number };
};

const desktopEnvironment = {
  COFORGE_DESKTOP: process.env.COFORGE_DESKTOP,
  COFORGE_DESKTOP_CAPABILITY: process.env.COFORGE_DESKTOP_CAPABILITY,
};

afterEach(() => {
  for (const [name, value] of Object.entries(desktopEnvironment)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

function fakePackage(root: string, locator: string, metadata: Record<string, unknown>, license = "license text") {
  const directory = join(root, locator);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "package.json"), JSON.stringify(metadata));
  writeFileSync(join(directory, "LICENSE"), license);
}

describe("Docker release boundary", () => {
  it("exposes a dependency-free liveness response", async () => {
    const { GET } = await import("../src/app/api/live/route");
    delete process.env.COFORGE_DESKTOP;
    delete process.env.COFORGE_DESKTOP_CAPABILITY;
    const response = await GET(new Request("http://localhost/api/live", { headers: { host: "localhost" } }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "live" });
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("requires the desktop capability without adding a hosted role dependency", async () => {
    const { GET } = await import("../src/app/api/live/route");
    process.env.COFORGE_DESKTOP = "1";
    process.env.COFORGE_DESKTOP_CAPABILITY = "test-capability";
    const rejected = await GET(new Request("http://localhost/api/live", { headers: { host: "localhost" } }));
    expect(rejected.status).toBe(401);

    const accepted = await GET(new Request("http://localhost/api/live", {
      headers: { host: "localhost", "x-coforge-capability": "test-capability" },
    }));
    expect(accepted.status).toBe(200);
  });

  it("uses an independent local healthcheck and avoids globally rebuilding optional native modules", () => {
    const dockerfile = readFileSync(join(process.cwd(), "Dockerfile"), "utf8");
    expect(dockerfile).toContain('CMD ["node", "/app/container-healthcheck.js"]');
    expect(dockerfile).not.toMatch(/fetch\([^\n]*api\/health/);
    expect(dockerfile).toContain("npm_config_build_from_source=true npm rebuild better-sqlite3");
    expect(dockerfile).not.toContain("npm_config_build_from_source=true npm ci");
    expect(dockerfile).toContain("./licenses/third-party");
    const smoke = readFileSync(join(process.cwd(), "scripts", "docker-runtime-smoke.sh"), "utf8");
    expect(smoke).toContain("AS cargo_count FROM cargoes");
    expect(smoke).not.toContain("AS count FROM cargoes");
  });

  it("resolves the native query dependency at runtime instead of bundling a module id", () => {
    const executor = readFileSync(resolve("src/lib/query-executor.ts"), "utf8");
    expect(executor).toContain("__non_webpack_require__");
    expect(executor).toContain("runtimeRequire.resolve(DATABASE_PACKAGE)");
    expect(executor).toContain('process.env.COFORGE_DATABASE_PACKAGE || "better-sqlite3"');
    expect(executor).not.toContain('require.resolve("better-sqlite3")');
  });

  it("removes the build root and rejects any other local user path in standalone output", () => {
    const root = mkdtempSync(join(tmpdir(), "coforge-standalone-"));
    const standalone = join(root, "project", ".next", "standalone");
    mkdirSync(standalone, { recursive: true });
    const server = join(standalone, "server.js");
    writeFileSync(server, `const root = ${JSON.stringify(join(root, "project"))};\n`);
    try {
      expect(sanitizeStandalone(standalone, join(root, "project"))).toEqual({ changed: 1, scanned: 1 });
      expect(readFileSync(server, "utf8")).toContain("/coforge");
      writeFileSync(join(standalone, "leak.js"), 'const privatePath = "/Users/private/company";\n');
      expect(() => sanitizeStandalone(standalone, join(root, "project"))).toThrow(/local user paths/);
      rmSync(join(standalone, "leak.js"));
      writeFileSync(join(standalone, "windows-leak.js"), 'const privatePath = "C:\\\\Users\\\\private\\\\company";\n');
      expect(() => sanitizeStandalone(standalone, join(root, "project"))).toThrow(/local user paths/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not rewrite module names when the build root is /app", () => {
    const root = mkdtempSync(join(tmpdir(), "coforge-short-root-"));
    const standalone = join(root, "standalone");
    mkdirSync(standalone);
    const server = join(standalone, "server.js");
    writeFileSync(server, 'const moduleName = "./app-render/unit"; const root = "/app"; const file = "/app/src/index.js";\n');
    try {
      expect(sanitizeStandalone(standalone, "/app")).toEqual({ changed: 1, scanned: 1 });
      expect(readFileSync(server, "utf8")).toBe('const moduleName = "./app-render/unit"; const root = "/coforge"; const file = "/coforge/src/index.js";\n');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects symbolic links in standalone output", () => {
    const root = mkdtempSync(join(tmpdir(), "coforge-standalone-link-"));
    const standalone = join(root, "standalone");
    mkdirSync(standalone);
    writeFileSync(join(root, "outside.js"), 'const privatePath = "/Users/private/company";\n');
    symlinkSync(join(root, "outside.js"), join(standalone, "linked.js"));
    try {
      expect(() => sanitizeStandalone(standalone, root)).toThrow(/must not contain symbolic links/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects recursive desktop build artifacts in standalone output", () => {
    const root = mkdtempSync(join(tmpdir(), "coforge-standalone-desktop-dist-"));
    const standalone = join(root, "standalone");
    mkdirSync(join(standalone, "desktop", "dist", "COFORGE.app"), { recursive: true });
    try {
      expect(() => sanitizeStandalone(standalone, root)).toThrow(/recursive desktop build artifacts/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("excludes desktop release artifacts from every Next.js output trace", () => {
    const config = readFileSync(resolve("next.config.mjs"), "utf8");
    expect(config).toMatch(/outputFileTracingExcludes/);
    expect(config).toMatch(/["']\*["']:\s*\[["']desktop\/dist\/\*\*\/\*["']\]/);
  });

  it("generates and verifies a deterministic standalone license bundle", () => {
    const root = mkdtempSync(join(tmpdir(), "coforge-licenses-"));
    const source = join(root, "source", "node_modules");
    const runtime = join(root, "runtime", "node_modules");
    const output = join(root, "output");
    try {
      fakePackage(source, "@scope/pkg", { name: "@scope/pkg", version: "1.2.3", license: "MIT" }, "MIT text");
      fakePackage(runtime, "@scope/pkg", { name: "@scope/pkg", version: "1.2.3" }, "runtime placeholder");
      const first = generateThirdPartyLicenses({ sourceNodeModules: source, runtimeNodeModules: runtime, outputDirectory: output });
      const firstSource = readFileSync(join(output, "THIRD-PARTY-LICENSES.json"), "utf8");
      const second = generateThirdPartyLicenses({ sourceNodeModules: source, runtimeNodeModules: runtime, outputDirectory: output });
      expect(second).toEqual(first);
      expect(readFileSync(join(output, "THIRD-PARTY-LICENSES.json"), "utf8")).toBe(firstSource);
      expect(verifyThirdPartyLicenses({ sourceNodeModules: source, runtimeNodeModules: runtime, outputDirectory: output }).components).toHaveLength(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("uses exact SPDX text when an npm package omits its license file", () => {
    const root = mkdtempSync(join(tmpdir(), "coforge-license-missing-"));
    const source = join(root, "source", "node_modules", "pkg");
    const runtime = join(root, "runtime", "node_modules", "pkg");
    mkdirSync(source, { recursive: true });
    mkdirSync(runtime, { recursive: true });
    writeFileSync(join(source, "package.json"), JSON.stringify({ name: "pkg", version: "1.0.0", license: "MIT" }));
    writeFileSync(join(runtime, "package.json"), JSON.stringify({ name: "pkg", version: "1.0.0" }));
    try {
      const result = generateThirdPartyLicenses({ sourceNodeModules: join(root, "source", "node_modules"), runtimeNodeModules: join(root, "runtime", "node_modules"), outputDirectory: join(root, "out") });
      expect(result.components).toHaveLength(1);
      expect(readFileSync(join(root, "out", "components", "7de5007bebfad17d", "LICENSE.spdx.txt"), "utf8")).toContain("MIT License");
      expect(verifyThirdPartyLicenses({ sourceNodeModules: join(root, "source", "node_modules"), runtimeNodeModules: join(root, "runtime", "node_modules"), outputDirectory: join(root, "out") }).components).toHaveLength(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects a self-consistent manifest that differs from locked source packages", () => {
    const root = mkdtempSync(join(tmpdir(), "coforge-license-tampered-"));
    const source = join(root, "source", "node_modules");
    const runtime = join(root, "runtime", "node_modules");
    const output = join(root, "output");
    try {
      fakePackage(source, "pkg", { name: "pkg", version: "1.0.0", license: "MIT" });
      fakePackage(runtime, "pkg", { name: "pkg", version: "1.0.0" });
      generateThirdPartyLicenses({ sourceNodeModules: source, runtimeNodeModules: runtime, outputDirectory: output });
      const manifestPath = join(output, "THIRD-PARTY-LICENSES.json");
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      manifest.components[0].license = "Proprietary";
      writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
      expect(() => verifyThirdPartyLicenses({ sourceNodeModules: source, runtimeNodeModules: runtime, outputDirectory: output })).toThrow(/locked source packages/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects symbolic links in the license bundle", () => {
    const root = mkdtempSync(join(tmpdir(), "coforge-license-link-"));
    const source = join(root, "source", "node_modules");
    const runtime = join(root, "runtime", "node_modules");
    const output = join(root, "output");
    try {
      fakePackage(source, "pkg", { name: "pkg", version: "1.0.0", license: "MIT" });
      fakePackage(runtime, "pkg", { name: "pkg", version: "1.0.0" });
      generateThirdPartyLicenses({ sourceNodeModules: source, runtimeNodeModules: runtime, outputDirectory: output });
      symlinkSync(join(source, "pkg", "LICENSE"), join(output, "linked-license"));
      expect(() => verifyThirdPartyLicenses({ sourceNodeModules: source, runtimeNodeModules: runtime, outputDirectory: output })).toThrow(/must not contain symbolic links/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails closed when neither package nor SPDX supplies license text", () => {
    const root = mkdtempSync(join(tmpdir(), "coforge-license-invalid-"));
    const source = join(root, "source", "node_modules", "pkg");
    const runtime = join(root, "runtime", "node_modules", "pkg");
    mkdirSync(source, { recursive: true });
    mkdirSync(runtime, { recursive: true });
    writeFileSync(join(source, "package.json"), JSON.stringify({ name: "pkg", version: "1.0.0", license: "LicenseRef-Unknown" }));
    writeFileSync(join(runtime, "package.json"), JSON.stringify({ name: "pkg", version: "1.0.0" }));
    try {
      expect(() => generateThirdPartyLicenses({ sourceNodeModules: join(root, "source", "node_modules"), runtimeNodeModules: join(root, "runtime", "node_modules"), outputDirectory: join(root, "out") })).toThrow(/no distributable or exact SPDX license text/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
