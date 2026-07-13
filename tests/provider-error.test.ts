import { describe, expect, it } from "vitest";
import { compactProviderError } from "../src/lib/provider-error";

describe("provider error sanitization", () => {
  it("redacts the configured key even when it does not use a known prefix", () => {
    const secret = "custom.token:+/with spaces";
    const encoded = encodeURIComponent(secret);
    const message = compactProviderError(
      new Error(`provider rejected api_key=${secret}; url_key=${encoded}`),
      secret,
    );

    expect(message).toBe("provider rejected api_key=[REDACTED]; url_key=[REDACTED]");
    expect(message).not.toContain(secret);
    expect(message).not.toContain(encoded);
  });

  it("removes terminal escapes and control characters before persistence", () => {
    const message = compactProviderError("\u001b[31mfailed\u001b[0m\r\nBearer unsafe-token\u0000");

    expect(message).toBe("failed Bearer ***");
    expect(message).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
  });

  it("keeps stored messages bounded", () => {
    expect(compactProviderError("x".repeat(500))).toHaveLength(240);
  });
});
