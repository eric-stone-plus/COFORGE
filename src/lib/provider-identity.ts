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
    url.hostname.toLowerCase() === "api.deepseek.com" &&
    (url.port === "" || url.port === "443") &&
    (url.pathname === "" || url.pathname === "/" || url.pathname === "/v1" || url.pathname === "/v1/") &&
    url.username === "" &&
    url.password === "" &&
    url.search === "" &&
    url.hash === ""
  );
}
