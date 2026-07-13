const ANSI_ESCAPE = /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001b\\))/g;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/g;

function replaceSecret(value: string, secret: string): string {
  if (!secret) return value;
  let redacted = value.split(secret).join("[REDACTED]");
  try {
    const encoded = encodeURIComponent(secret);
    if (encoded !== secret) redacted = redacted.split(encoded).join("[REDACTED]");
  } catch {
    // The literal value is still redacted if it cannot be URI encoded.
  }
  return redacted;
}

export function compactProviderError(
  error: unknown,
  secrets: string | readonly string[] = [],
): string {
  const raw = error instanceof Error ? error.message : String(error);
  const values = typeof secrets === "string" ? [secrets] : secrets;
  const redacted = values.reduce(replaceSecret, raw)
    .replace(/sk-[A-Za-z0-9_-]+/g, "sk-***")
    .replace(/Bearer\s+[^\s,;]+/gi, "Bearer ***")
    .replace(ANSI_ESCAPE, "")
    .replace(/[\r\n\t]+/g, " ")
    .replace(CONTROL_CHARACTERS, "")
    .replace(/\s+/g, " ")
    .trim();
  return redacted.slice(0, 240);
}
