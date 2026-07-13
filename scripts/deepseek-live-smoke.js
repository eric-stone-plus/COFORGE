#!/usr/bin/env node

const API_URL = "https://api.deepseek.com/chat/completions";
const MODEL = "deepseek-v4-pro";
const apiKey = process.env.DEEPSEEK_API_KEY;

function fail(message) {
  console.error(message);
  process.exit(1);
}

if (!apiKey) {
  fail("DEEPSEEK_API_KEY is required. The key is read from the environment and is never printed.");
}

async function main() {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);

  try {
    const response = await fetch(API_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: MODEL,
        reasoning_effort: "max",
        messages: [
          { role: "system", content: "Reply with OK only." },
          { role: "user", content: "Return OK." },
        ],
        temperature: 0,
        max_tokens: 16,
        stream: false,
      }),
      signal: controller.signal,
    });

    const requestId = response.headers.get("x-request-id") || response.headers.get("request-id") || "n/a";
    let payload;
    try {
      payload = await response.json();
    } catch {
      fail(`DeepSeek returned HTTP ${response.status} with a non-JSON response (request ${requestId}).`);
    }

    if (!response.ok) {
      const providerMessage = typeof payload?.error?.message === "string"
        ? payload.error.message.replace(/sk-[A-Za-z0-9_-]+/g, "sk-***").slice(0, 240)
        : "provider rejected the request";
      fail(`DeepSeek live smoke failed: HTTP ${response.status}, ${providerMessage} (request ${requestId}).`);
    }

    if (payload?.model !== MODEL || !Array.isArray(payload?.choices)) {
      fail(`DeepSeek returned an unexpected response shape (request ${requestId}).`);
    }

    const usage = payload.usage ?? {};
    console.log(
      `DeepSeek live smoke passed: model=${payload.model}, reasoning_effort=max, ` +
      `tokens=${usage.total_tokens ?? "n/a"}, request=${requestId}.`,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    fail(`DeepSeek live smoke failed: ${message.replace(apiKey, "***").slice(0, 240)}`);
  } finally {
    clearTimeout(timeout);
  }
}

void main();
