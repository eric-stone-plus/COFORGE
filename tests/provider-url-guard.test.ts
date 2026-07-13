import { afterEach, describe, expect, it } from "vitest";
import { Readable } from "stream";
import { Response as UndiciResponse } from "undici";
import { isPrivateOrReservedAddress, readBoundedProviderResponse, resolveProviderRedirect, validateProviderURL } from "../src/lib/provider-url-guard";
import { knownProviderFromBaseURL } from "../src/lib/provider-identity";

const env = { ...process.env };

afterEach(() => {
  process.env = { ...env };
});

describe("provider URL guard", () => {
  it("classifies known providers only by the parsed exact hostname", () => {
    expect(knownProviderFromBaseURL("https://api.anthropic.com/v1")).toBe("anthropic");
    expect(knownProviderFromBaseURL("https://api.openai.com/v1")).toBe("openai");
    expect(knownProviderFromBaseURL("https://api.moonshot.cn/v1")).toBe("moonshot");
    expect(knownProviderFromBaseURL("https://api.openai.com.evil.example/v1")).toBeUndefined();
    expect(knownProviderFromBaseURL("https://evil.example/openai.com/v1")).toBeUndefined();
    expect(knownProviderFromBaseURL("https://user@api.openai.com/v1")).toBeUndefined();
  });

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

  it("permits proxy fake-IP DNS only for exact official HTTPS providers in desktop mode", async () => {
    const fakeIpLookup = async () => [{ address: "198.18.0.40", family: 4 }];
    await expect(validateProviderURL("https://api.deepseek.com", fakeIpLookup)).rejects.toThrow(/private or reserved/);

    process.env.COFORGE_DESKTOP = "1";
    for (const providerURL of [
      "https://api.deepseek.com",
      "https://api.anthropic.com/v1",
      "https://api.moonshot.cn/v1",
      "https://api.openai.com:443/v1",
    ]) {
      await expect(validateProviderURL(providerURL, fakeIpLookup)).resolves.toMatchObject({
        url: expect.any(URL),
        addresses: [{ address: "198.18.0.40", family: 4 }],
      });
    }
    await expect(validateProviderURL("https://api.deepseek.com.evil.example", fakeIpLookup)).rejects.toThrow(/private or reserved/);
    await expect(validateProviderURL("https://example.com", fakeIpLookup)).rejects.toThrow(/private or reserved/);
    await expect(validateProviderURL("https://api.deepseek.com:8443", fakeIpLookup)).rejects.toThrow(/private or reserved/);
    await expect(validateProviderURL(
      "https://api.deepseek.com",
      async () => [{ address: "198.18.0.40", family: 4 }, { address: "10.0.0.8", family: 4 }],
    )).rejects.toThrow(/private or reserved/);
    await expect(validateProviderURL(
      "https://api.deepseek.com",
      async () => [{ address: "198.18.0.40", family: 4 }, { address: "8.8.8.8", family: 4 }],
    )).rejects.toThrow(/private or reserved/);

    expect(isPrivateOrReservedAddress("198.17.255.255")).toBe(false);
    expect(isPrivateOrReservedAddress("198.20.0.0")).toBe(false);
    for (const address of ["198.18.0.0", "198.19.255.255"]) {
      await expect(validateProviderURL(
        "https://api.deepseek.com",
        async () => [{ address, family: 4 }],
      )).resolves.toMatchObject({ addresses: [{ address, family: 4 }] });
    }
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
