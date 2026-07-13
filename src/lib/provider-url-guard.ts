import { lookup } from "dns/promises";
import { isIP } from "net";
import { Agent, buildConnector, fetch as undiciFetch } from "undici";
import { knownProviderFromBaseURL } from "./provider-identity";

const MAX_REDIRECTS = 3;
const MAX_PROVIDER_RESPONSE_BYTES = 8 * 1024 * 1024;
const BLOCKED_HOST_SUFFIXES = [".local", ".localhost", ".internal", ".home", ".lan"];

type ResolvedAddress = { address: string; family: number };
type ProviderAddressLookup = (hostname: string) => Promise<ResolvedAddress[]>;

function ipv4Number(address: string) {
  return address.split(".").reduce((value, part) => (value << 8) + Number(part), 0) >>> 0;
}

function inV4Range(address: string, base: string, bits: number) {
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (ipv4Number(address) & mask) === (ipv4Number(base) & mask);
}

function normalizedIpv6(address: string) {
  const zone = address.indexOf("%");
  return (zone >= 0 ? address.slice(0, zone) : address).toLowerCase();
}

function ipv6Groups(address: string) {
  let value = normalizedIpv6(address);
  const dotted = value.match(/(^|:)(\d+\.\d+\.\d+\.\d+)$/)?.[2];
  if (dotted) {
    if (isIP(dotted) !== 4) return null;
    const bytes = dotted.split(".").map(Number);
    value = `${value.slice(0, value.length - dotted.length)}${((bytes[0] << 8) | bytes[1]).toString(16)}:${((bytes[2] << 8) | bytes[3]).toString(16)}`;
  }

  const halves = value.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || (halves.length === 2 && missing < 1)) return null;
  const raw = halves.length === 2 ? [...left, ...Array(missing).fill("0"), ...right] : left;
  if (raw.length !== 8 || raw.some((group) => !/^[0-9a-f]{1,4}$/.test(group))) return null;
  return raw.map((group) => Number.parseInt(group, 16));
}

function inV6Range(groups: number[], base: string, bits: number) {
  const baseGroups = ipv6Groups(base);
  if (!baseGroups) return false;
  const fullGroups = Math.floor(bits / 16);
  if (groups.slice(0, fullGroups).some((group, index) => group !== baseGroups[index])) return false;
  const remaining = bits % 16;
  if (!remaining) return true;
  const mask = (0xffff << (16 - remaining)) & 0xffff;
  return (groups[fullGroups] & mask) === (baseGroups[fullGroups] & mask);
}

function embeddedIpv4(groups: number[], highIndex: number) {
  const high = groups[highIndex];
  const low = groups[highIndex + 1];
  return `${high >>> 8}.${high & 0xff}.${low >>> 8}.${low & 0xff}`;
}

export function isPrivateOrReservedAddress(address: string): boolean {
  if (isIP(address) === 4) {
    return [
      ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
      ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24],
      ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24],
      ["224.0.0.0", 4], ["240.0.0.0", 4],
    ].some(([base, bits]) => inV4Range(address, String(base), Number(bits)));
  }

  if (isIP(address) === 6) {
    const value = normalizedIpv6(address);
    const groups = ipv6Groups(value);
    if (!groups) return true;

    if (inV6Range(groups, "::", 96)) {
      // IPv4-compatible ::/96 can route its embedded address on legacy stacks.
      return true;
    }
    if (inV6Range(groups, "::ffff:0:0", 96)) {
      return isPrivateOrReservedAddress(embeddedIpv4(groups, 6));
    }
    // RFC 8215 IPv4-translatable addresses use an extra 32-bit zero field.
    if (inV6Range(groups, "::ffff:0:0:0", 96)) {
      return isPrivateOrReservedAddress(embeddedIpv4(groups, 6));
    }
    if (inV6Range(groups, "64:ff9b::", 96)) {
      return isPrivateOrReservedAddress(embeddedIpv4(groups, 6));
    }
    // RFC 5214 ISATAP embeds IPv4 behind 0000:5efe or 0200:5efe. Block the
    // entire transition pattern because it can tunnel to private IPv4 even
    // when the surrounding IPv6 prefix appears globally routable.
    if ((groups[4] === 0 || groups[4] === 0x0200) && groups[5] === 0x5efe) {
      return true;
    }

    return [
      ["64:ff9b:1::", 48], ["100::", 64], ["2001::", 23], ["2001:db8::", 32],
      ["2002::", 16], ["3fff::", 20], ["5f00::", 16], ["fc00::", 7],
      ["fe80::", 10], ["fec0::", 10], ["ff00::", 8],
    ].some(([base, bits]) => inV6Range(groups, String(base), Number(bits)));
  }

  return true;
}

function allowPrivateProviders() {
  return process.env.COFORGE_DESKTOP === "1" && process.env.COFORGE_ALLOW_PRIVATE_PROVIDER === "1";
}

function isFakeIpAddress(address: string) {
  return isIP(address) === 4 && inV4Range(address, "198.18.0.0", 15);
}

function allowOfficialProviderFakeIp(url: URL, addresses: ResolvedAddress[]) {
  return process.env.COFORGE_DESKTOP === "1"
    && url.protocol === "https:"
    && (url.port === "" || url.port === "443")
    && knownProviderFromBaseURL(url.toString()) !== undefined
    && addresses.length > 0
    && addresses.every(({ address }) => isFakeIpAddress(address));
}

const lookupProviderAddresses: ProviderAddressLookup = async (hostname) => lookup(hostname, {
  all: true,
  verbatim: true,
});

export async function validateProviderURL(
  value: string | URL,
  resolveAddresses: ProviderAddressLookup = lookupProviderAddresses,
) {
  const url = value instanceof URL ? value : new URL(value);
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("Provider URL must use HTTP or HTTPS");
  }
  if (url.username || url.password) throw new Error("Provider URL must not contain credentials");
  const hostname = url.hostname.toLowerCase().replace(/\.$/, "").replace(/^\[|\]$/g, "");
  if (!hostname || BLOCKED_HOST_SUFFIXES.some((suffix) => hostname === suffix.slice(1) || hostname.endsWith(suffix))) {
    throw new Error("Provider hostname is not allowed");
  }

  const addresses = isIP(hostname)
    ? [{ address: hostname, family: isIP(hostname) }]
    : await resolveAddresses(hostname);
  if (!addresses.length) throw new Error("Provider hostname did not resolve");
  const privateOptIn = allowPrivateProviders();
  const allPrivate = addresses.every(({ address }) => isPrivateOrReservedAddress(address));
  const literalPrivateHost = isIP(hostname) > 0 && isPrivateOrReservedAddress(hostname);
  const explicitlyLocalHost = hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local");
  if (url.protocol === "http:" && (!privateOptIn || !allPrivate || (!literalPrivateHost && !explicitlyLocalHost))) {
    throw new Error("Provider URL must use HTTPS unless it is an explicit private desktop endpoint");
  }
  if (
    !privateOptIn
    && addresses.some(({ address }) => isPrivateOrReservedAddress(address))
    && !allowOfficialProviderFakeIp(url, addresses)
  ) {
    throw new Error("Provider URL resolves to a private or reserved address");
  }

  return { url, addresses };
}

function createPinnedAgent(addresses: Awaited<ReturnType<typeof validateProviderURL>>["addresses"]) {
  let next = 0;
  const connector = buildConnector({
    lookup: (_hostname: string, options: import("dns").LookupOptions, callback: (error: NodeJS.ErrnoException | null, address: string | import("dns").LookupAddress[], family?: number) => void) => {
      const selected = addresses[next % addresses.length];
      next += 1;
      if (options.all) {
        callback(null, addresses);
      } else {
        callback(null, selected.address, selected.family);
      }
    },
  });
  return new Agent({ connect: connector, connections: 4, pipelining: 1 });
}

function redirectLocation(response: Response) {
  return response.status >= 300 && response.status < 400 ? response.headers.get("location") : null;
}

export function resolveProviderRedirect(current: URL, location: string) {
  const next = new URL(location, current);
  if (next.origin !== current.origin) {
    throw new Error("Provider cross-origin redirects are not allowed");
  }
  return next;
}

export async function readBoundedProviderResponse(response: import("undici").Response) {
  const responseHeaders = Array.from(response.headers.entries());
  const declaredLength = Number(response.headers.get("content-length") ?? 0);
  if (declaredLength > MAX_PROVIDER_RESPONSE_BYTES) throw new Error("Provider response is too large");
  if (!response.body) {
    return new Response(null, { status: response.status, statusText: response.statusText, headers: responseHeaders });
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_PROVIDER_RESPONSE_BYTES) {
        await reader.cancel("Provider response is too large");
        throw new Error("Provider response is too large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new Response(body, { status: response.status, statusText: response.statusText, headers: responseHeaders });
}

export async function guardedProviderFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  let url = new URL(typeof input === "string" || input instanceof URL ? input.toString() : input.url);
  let method = init?.method ?? (input instanceof Request ? input.method : "GET");
  let body = init?.body;
  if (body === undefined && input instanceof Request && input.body) {
    body = await input.clone().arrayBuffer();
  }
  let headers = new Headers(input instanceof Request ? input.headers : undefined);
  new Headers(init?.headers).forEach((value, key) => headers.set(key, value));

  for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect += 1) {
    const validated = await validateProviderURL(url);
    const dispatcher = createPinnedAgent(validated.addresses);
    let response: import("undici").Response;
    try {
      response = await undiciFetch(url, {
        method,
        headers,
        body: body as never,
        signal: init?.signal,
        redirect: "manual",
        dispatcher,
      });
      const location = redirectLocation(response as unknown as Response);
      if (!location) return await readBoundedProviderResponse(response);
      await response.body?.cancel();
      if (redirect === MAX_REDIRECTS) throw new Error("Provider redirected too many times");

      const next = resolveProviderRedirect(url, location);
      if (response.status === 303 || ((response.status === 301 || response.status === 302) && method.toUpperCase() === "POST")) {
        method = "GET";
        body = undefined;
        headers.delete("content-length");
        headers.delete("content-type");
      }
      url = next;
    } finally {
      await dispatcher.close();
    }
  }

  throw new Error("Provider redirect handling failed");
}
