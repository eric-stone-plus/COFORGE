#!/usr/bin/env node

const readline = require("readline");
const path = require("path");

let nextSession = 1;
const cancelled = new Set();

function send(frame) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...frame })}\n`);
}

function response(id, result) {
  send({ id, result });
}

function update(sessionId, body) {
  send({ method: "session/update", params: { sessionId, update: body } });
}

const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on("line", (line) => {
  const frame = JSON.parse(line);
  if (frame.method === "initialize") {
    if (process.env.FAKE_ACP_MODE === "silent") return;
    if (process.env.FAKE_ACP_MODE === "crash-initialize") {
      process.exit(24);
      return;
    }
    response(frame.id, {
      protocolVersion: process.env.FAKE_ACP_MODE === "wrong-version" ? 2 : 1,
      agentCapabilities: {},
      agentInfo: { name: "reasonix", version: "fixture" },
      authMethods: [],
    });
    return;
  }
  if (frame.method === "session/new") {
    const servers = frame.params?.mcpServers;
    if (
      !path.isAbsolute(frame.params?.cwd ?? "") ||
      !Array.isArray(servers) ||
      servers.length !== 1 ||
      servers[0].name !== "coforge" ||
      servers[0].type !== "stdio" ||
      !path.isAbsolute(servers[0].command ?? "")
    ) {
      send({ id: frame.id, error: { code: -32602, message: "invalid COFORGE session boundary" } });
      return;
    }
    const result = { sessionId: `fixture-${nextSession++}` };
    const delay = Number(process.env.FAKE_ACP_SESSION_DELAY_MS ?? 0);
    if (delay > 0) setTimeout(() => response(frame.id, result), delay);
    else response(frame.id, result);
    return;
  }
  if (frame.method === "session/load") {
    response(frame.id, {});
    return;
  }
  if (frame.method === "session/close") {
    response(frame.id, {});
    return;
  }
  if (frame.method === "session/cancel") {
    cancelled.add(frame.params.sessionId);
    return;
  }
  if (frame.method !== "session/prompt") return;

  const { sessionId } = frame.params;
  const text = frame.params.prompt[0].text;
  if (text === "hang") return;
  if (text === "crash") {
    process.exit(23);
    return;
  }
  if (text === "unsafe") {
    update(sessionId, {
      sessionUpdate: "tool_call",
      toolCallId: "unsafe-1",
      title: "bash",
      status: "pending",
      rawInput: { command: "id" },
    });
    setTimeout(() => response(frame.id, { stopReason: cancelled.has(sessionId) ? "cancelled" : "end_turn" }), 10);
    return;
  }
  if (text === "unsafe-hang") {
    update(sessionId, {
      sessionUpdate: "tool_call",
      toolCallId: "unsafe-hang-1",
      title: "bash",
      status: "pending",
      rawInput: { command: "id" },
    });
    return;
  }
  if (text === "delayed-cancel") {
    setTimeout(() => {
      const toolCallId = "stale-query-1";
      const envelope = {
        schemaVersion: 1,
        tool: "query",
        operation: "select",
        result: {
          ok: true,
          rows: [{ vessel_name: "Stale" }],
          executedSql: "SELECT vessel_name FROM cargoes LIMIT 1",
          meta: {
            queryId: "stale-query",
            auditEventId: "stale-audit",
            source: "agent",
            tables: ["cargoes"],
            rowCount: 1,
            columnCount: 1,
            responseBytes: 24,
            resultHash: "b".repeat(64),
            durationMs: 1,
            limit: 1,
            truncated: false,
          },
        },
        evidence: {
          callId: "stale-call",
          inputHash: "a".repeat(64),
          resultHash: "c".repeat(64),
          auditEventId: "stale-audit",
        },
      };
      update(sessionId, {
        sessionUpdate: "tool_call",
        toolCallId,
        title: "mcp__coforge__query",
        status: "pending",
      });
      update(sessionId, {
        sessionUpdate: "tool_call_update",
        toolCallId,
        status: "completed",
        content: [{ type: "text", text: JSON.stringify(envelope) }],
      });
      update(sessionId, {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "stale:delayed-cancel" },
      });
      response(frame.id, { stopReason: cancelled.has(sessionId) ? "cancelled" : "end_turn" });
    }, 60);
    return;
  }
  if (text === "fresh-after-cancel") {
    setTimeout(() => {
      update(sessionId, {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "echo:fresh-after-cancel" },
      });
      response(frame.id, { stopReason: "end_turn" });
    }, 120);
    return;
  }
  if (text === "mcp") {
    update(sessionId, {
      sessionUpdate: "tool_call",
      toolCallId: "mcp-1",
      title: "mcp__coforge__query",
      status: "pending",
      rawInput: { question: "fixture" },
    });
    update(sessionId, {
      sessionUpdate: "tool_call_update",
      toolCallId: "mcp-1",
      status: "completed",
      content: [{ type: "content", content: { type: "text", text: "synthetic" } }],
    });
  }
  update(sessionId, {
    sessionUpdate: "agent_message_chunk",
    content: { type: "text", text: `echo:${text}` },
  });
  response(frame.id, { stopReason: "end_turn" });
});
