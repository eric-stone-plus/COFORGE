export type KnownProvider = "deepseek" | "anthropic" | "moonshot" | "openai";

const KNOWN_PROVIDER_HOSTS: Readonly<Record<string, KnownProvider>> = {
  "api.deepseek.com": "deepseek",
  "api.anthropic.com": "anthropic",
  "api.moonshot.cn": "moonshot",
  "api.openai.com": "openai",
};

export function knownProviderFromBaseURL(value: string): KnownProvider | undefined {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:" || url.username || url.password) return undefined;
  return KNOWN_PROVIDER_HOSTS[url.hostname.toLowerCase()];
}

export function isOfficialDeepSeekBaseURL(value: string): boolean {
  const normalized = value.trim();
  if (/[?#]/.test(normalized)) return false;

  let url: URL;
  try {
    url = new URL(normalized);
  } catch {
    return false;
  }

  return (
    url.protocol === "https:" &&
    knownProviderFromBaseURL(value) === "deepseek" &&
    (url.port === "" || url.port === "443") &&
    (url.pathname === "" || url.pathname === "/" || url.pathname === "/v1" || url.pathname === "/v1/") &&
    url.username === "" &&
    url.password === "" &&
    url.search === "" &&
    url.hash === ""
  );
}
