import { PassThrough } from "stream";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { describe, expect, it } from "vitest";
import { serveCoforgeMcpStdio } from "../src/lib/reasonix/mcp-stdio";

describe("COFORGE MCP stdio integration", () => {
  it("runs the initialize/list/call lifecycle over newline-delimited JSON-RPC", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "coforge-mcp-stdio-audit-"));
    const input = new PassThrough();
    const output = new PassThrough();
    let text = "";
    output.setEncoding("utf8");
    output.on("data", (chunk: string) => { text += chunk; });

    const serving = serveCoforgeMcpStdio({
      input,
      output,
      env: { COFORGE_MCP_ROLE: "desktop", COFORGE_MCP_AUDIT_PATH: join(tempDir, "mcp-events.jsonl") },
    });
    input.end([
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05" } }),
      JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
      JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
      JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "schema", arguments: {} } }),
      "",
    ].join("\n"));
    await serving;

    const responses = text.trim().split("\n").map((line) => JSON.parse(line));
    expect(responses).toHaveLength(3);
    expect(responses[0]).toMatchObject({ id: 1, result: { serverInfo: { name: "coforge" } } });
    expect(responses[1].result.tools).toHaveLength(9);
    const payload = JSON.parse(responses[2].result.content[0].text);
    expect(payload).toMatchObject({ schemaVersion: 1, tool: "schema", operation: "schema" });
    await rm(tempDir, { recursive: true, force: true });
  });

  it("returns a parse error and continues after malformed JSON", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "coforge-mcp-stdio-audit-"));
    const input = new PassThrough();
    const output = new PassThrough();
    let text = "";
    output.setEncoding("utf8");
    output.on("data", (chunk: string) => { text += chunk; });
    const serving = serveCoforgeMcpStdio({
      input,
      output,
      env: { COFORGE_MCP_ROLE: "analyst", COFORGE_MCP_AUDIT_PATH: join(tempDir, "mcp-events.jsonl") },
    });
    input.end('{bad-json}\n{"jsonrpc":"2.0","id":2,"method":"tools/list"}\n');
    await serving;
    const responses = text.trim().split("\n").map((line) => JSON.parse(line));
    expect(responses).toMatchObject([
      { id: null, error: { code: -32700 } },
      { id: 2, result: { tools: expect.any(Array) } },
    ]);
    await rm(tempDir, { recursive: true, force: true });
  });
});
