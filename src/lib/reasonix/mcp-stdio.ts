#!/usr/bin/env node
import { once } from "events";
import type { Readable, Writable } from "stream";
import { handleCoforgeMcpRequest, mcpContextFromEnvironment, NdjsonFrameDecoder } from "./mcp-server";

async function writeFrame(output: Writable, value: unknown): Promise<void> {
  if (!output.write(`${JSON.stringify(value)}\n`)) await once(output, "drain");
}

export async function serveCoforgeMcpStdio(options: {
  input?: Readable;
  output?: Writable;
  env?: Readonly<Record<string, string | undefined>>;
} = {}): Promise<void> {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const context = mcpContextFromEnvironment(options.env);
  const decoder = input.pipe(new NdjsonFrameDecoder());
  // Sequential dispatch keeps stdout ordering deterministic and bounds concurrent work.
  for await (const frame of decoder) {
    const response = await handleCoforgeMcpRequest(frame, context);
    if (response !== null) await writeFrame(output, response);
  }
}

if (require.main === module) {
  serveCoforgeMcpStdio().catch((error) => {
    process.stderr.write(`COFORGE MCP server stopped: ${error instanceof Error ? error.message : "unknown error"}\n`);
    process.exitCode = 1;
  });
}
