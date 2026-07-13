import { afterEach, describe, expect, it } from "vitest";
import { Readable } from "stream";
import { Response as UndiciResponse } from "undici";
import { isPrivateOrReservedAddress, readBoundedProviderResponse, resolveProviderRedirect, validateProviderURL } from "../src/lib/provider-url-guard";

const env = { ...process.env };

afterEach(() => {
  process.env = { ...env };
});

describe("provider URL guard", () => {
  it("recognizes private, metadata, loopback and documentation ranges", () => {
    for (const address of [
      "127.0.0.1", "10.2.3.4", "169.254.169.254", "192.168.1.2", "::1", "fd00::1", "2001:db8::1",
      "::ffff:127.0.0.1", "::ffff:7f00:1", "::ffff:c0a8:1", "0:0:0:0:0:ffff:7f00:1",
      "::127.0.0.1", "::10.77.0.3", "::ffff:0:127.0.0.1",
      "64:ff9b::7f00:1", "64:ff9b:1::1", "2002:7f00:1::", "fec0::1", "100::1", "3fff::1", "5f00::1",
      "2001:4860:1234:5678:200:5efe:0a4d:0003", "2001:4860:1234:5678:0:5efe:0a4d:0003",
    ]) {
      expect(isPrivateOrReservedAddress(address)).toBe(true);
    }
    expect(isPrivateOrReservedAddress("8.8.8.8")).toBe(false);
    expect(isPrivateOrReservedAddress("2606:4700:4700::1111")).toBe(false);
  });

  it("blocks non-HTTPS URLs and embedded credentials", async () => {
    await expect(validateProviderURL("http://example.com/v1")).rejects.toThrow(/HTTPS/);
    await expect(validateProviderURL("https://user:pass@example.com/v1")).rejects.toThrow(/credentials/);
    await expect(validateProviderURL("file:///etc/passwd")).rejects.toThrow(/HTTP/);
  });

  it("blocks IPv6 transition and special-use literals that can reach private networks", async () => {
    for (const url of [
      "https://[64:ff9b::7f00:1]/v1",
      "https://[64:ff9b:1::1]/v1",
      "https://[2002:7f00:1::]/v1",
      "https://[2001:4860:1234:5678:200:5efe:a4d:3]/v1",
      "https://[2001:4860:1234:5678:0:5efe:a4d:3]/v1",
      "https://[fec0::1]/v1",
    ]) {
      await expect(validateProviderURL(url)).rejects.toThrow(/private or reserved/);
    }
  });

  it("only permits private providers with explicit desktop opt-in", async () => {
    await expect(validateProviderURL("https://127.0.0.1:11434/v1")).rejects.toThrow(/private or reserved/);
    process.env.COFORGE_DESKTOP = "1";
    process.env.COFORGE_ALLOW_PRIVATE_PROVIDER = "1";
    await expect(validateProviderURL("http://127.0.0.1:11434/v1")).resolves.toMatchObject({ url: expect.any(URL) });
    await expect(validateProviderURL("http://example.com/v1")).rejects.toThrow(/HTTPS/);
  });

  it("stops chunked responses that exceed the byte ceiling", async () => {
    const response = new UndiciResponse(Readable.from([
      new Uint8Array(5 * 1024 * 1024),
      new Uint8Array(4 * 1024 * 1024),
    ]));
    await expect(readBoundedProviderResponse(response)).rejects.toThrow(/too large/);
  });

  it("rejects cross-origin redirects before a request can be replayed", () => {
    expect(() => resolveProviderRedirect(
      new URL("https://example.com/v1/chat/completions"),
      "https://other.example/v1/chat/completions",
    )).toThrow(/cross-origin redirects/);
    expect(resolveProviderRedirect(
      new URL("https://example.com/v1/chat/completions"),
      "/v2/chat/completions",
    ).href).toBe("https://example.com/v2/chat/completions");
  });
});
