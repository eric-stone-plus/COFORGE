import Database from "better-sqlite3";
import { copyFile, mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", async () => import("../src/lib/db"));
vi.mock("@/lib/bounded-json", async () => import("../src/lib/bounded-json"));
vi.mock("@/lib/request-security", async () => import("../src/lib/request-security"));
vi.mock("@/lib/agent", async () => import("../src/lib/agent"));
vi.mock("@/lib/demo-cache", async () => import("../src/lib/demo-cache"));
vi.mock("@/lib/local-settings", async () => import("../src/lib/local-settings"));
vi.mock("@/lib/provider-error", async () => import("../src/lib/provider-error"));
vi.mock("@/lib/reasonix/orchestrator", async () => import("../src/lib/reasonix/orchestrator"));

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "coforge-query-route-test-"));
  process.env.COFORGE_CONFIG_DIR = tempDir;
  process.env.COFORGE_QUERY_AUDIT_PATH = join(tempDir, "query-audit.jsonl");
  delete process.env.COFORGE_DESKTOP;
  vi.resetModules();
});

afterEach(async () => {
  delete process.env.COFORGE_CONFIG_DIR;
  delete process.env.COFORGE_QUERY_AUDIT_PATH;
  delete process.env.DB_PATH;
  await rm(tempDir, { recursive: true, force: true });
});

function jsonRequest(path: string, body: Record<string, unknown>) {
  return new Request(`http://localhost${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Host: "localhost", Origin: "http://localhost" },
    body: JSON.stringify(body),
  });
}

describe("query API envelope", () => {
  it("returns the shared success envelope", async () => {
    const { POST } = await import("../src/app/api/query/route");
    const response = await POST(jsonRequest("/api/query", {
      sql: "SELECT vessel_name, status FROM cargoes LIMIT 2",
    }));
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload).toMatchObject({
      ok: true,
      error: null,
      meta: { source: "api", rowCount: 2, limit: 2 },
    });
    expect(payload.meta.auditEventId).toMatch(/^[a-f0-9-]{36}$/);
    expect(payload.meta.resultHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("returns 413 for both declared and streamed request-body overflow", async () => {
    const { POST } = await import("../src/app/api/query/route");
    const declared = await POST(new Request("http://localhost/api/query", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Host: "localhost",
        Origin: "http://localhost",
        "Content-Length": String(64 * 1024 + 1),
      },
      body: "{}",
    }));
    expect(declared.status).toBe(413);

    const chunks = [
      new TextEncoder().encode('{"sql":"'),
      new Uint8Array(64 * 1024).fill(97),
      new TextEncoder().encode('"}'),
    ];
    const streamed = await POST(new Request("http://localhost/api/query", {
      method: "POST",
      headers: { "Content-Type": "application/json", Host: "localhost", Origin: "http://localhost" },
      body: new ReadableStream({
        pull(controller) {
          const chunk = chunks.shift();
          if (chunk) controller.enqueue(chunk);
          else controller.close();
        },
      }),
      duplex: "half",
    } as RequestInit & { duplex: "half" }));
    expect(streamed.status).toBe(413);
    expect(await streamed.json()).toMatchObject({
      error: { code: "QUERY_INVALID_REQUEST", message: "Request body is too large." },
    });
  });
});

describe("chat demo cache evidence", () => {
  it("links refreshed cache rows to their append-only audit event", async () => {
    const { POST } = await import("../src/app/api/chat/route");
    const response = await POST(jsonRequest("/api/chat", {
      message: "哪些在途船最需要关注？",
      context: [],
    }));
    const stream = await response.text();
    const resultLine = stream.split("\n").find((line) => line.startsWith("data: ") && line.includes('"type":"result"'));
    const result = JSON.parse(resultLine!.slice(6)) as Record<string, unknown>;
    const evidence = result.evidence as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(result).toMatchObject({ type: "result", _cached: true });
    expect(Array.isArray(result.data)).toBe(true);
    expect(evidence).toMatchObject({ source: "demo-cache", tables: ["cargoes", "coal_specs"] });

    const { readQueryAuditEvents } = await import("../src/lib/query-audit");
    const events = await readQueryAuditEvents();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      eventId: evidence.auditEventId,
      queryId: evidence.queryId,
      source: "demo-cache",
      outcome: "success",
      resultHash: evidence.resultHash,
    });
  });

  it("regenerates exact explanation figures from the current database rows", async () => {
    const dbPath = join(tempDir, "mutated-demo.db");
    await copyFile(join(process.cwd(), "data", "coal-demo.db"), dbPath);
    const db = new Database(dbPath);
    db.prepare("UPDATE inventory SET stock_mt = stock_mt + 1000").run();
    db.close();
    process.env.DB_PATH = dbPath;

    const { POST } = await import("../src/app/api/chat/route");
    const response = await POST(jsonRequest("/api/chat", {
      message: "库存还能覆盖多少天？",
      context: [],
    }));
    const stream = await response.text();
    const resultLine = stream.split("\n").find((line) => line.startsWith("data: ") && line.includes('"type":"result"'));
    const result = JSON.parse(resultLine!.slice(6)) as { data: Record<string, unknown>[]; explanation: string };
    const totalStock = result.data.reduce((sum, row) => sum + Number(row.stock_mt), 0);

    expect(totalStock).toBe(391_000);
    expect(result.explanation).toContain("391,000 吨");
    expect(result.explanation).toContain("24.4 天");
    expect(result.explanation).not.toContain("386,000");
  });
});
