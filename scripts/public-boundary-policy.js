const blockedRoots = [
  "coal-balance-sheet/",
  "coal-price/",
  "knowledge-gems/",
  "legacy/general-reports/",
  "legacy/model-design/",
  "legacy/co-series/",
  "project-overviews/",
  "reports/",
  "tools/",
  "workflows/",
  "data/private/",
  "data/raw/",
  "data/company/",
];

const blockedBasenames = new Set([
  ".npmrc", ".pypirc", ".netrc", "credentials", "credentials.json",
  "settings.json", "token-ledger.sqlite", "token-ledger.sqlite-shm", "token-ledger.sqlite-wal",
]);

const blockedExtensions = [
  ".7z", ".bundle", ".db", ".doc", ".docx", ".key", ".p12", ".pem", ".pfx",
  ".ppt", ".pptx", ".rar", ".sqlite", ".sqlite3", ".tar", ".tgz", ".xls", ".xlsx", ".zip",
];

const allowedExactFiles = new Set([
  ".env.example",
  "assets/COFORGE-Company-Pitch.pptx",
  "data/coal-demo.db",
]);

function boundaryViolation(file) {
  const normalized = file.replaceAll("\\", "/");
  const lower = normalized.toLowerCase();
  const basename = lower.split("/").at(-1) ?? lower;
  if (allowedExactFiles.has(normalized)) return null;
  if (lower.startsWith("data/")) return "only the reviewed synthetic demo database may be tracked under data/";
  if (blockedRoots.some((root) => lower.startsWith(root))) return "internal working archive must not be tracked";
  if (blockedBasenames.has(basename)) return "credential or runtime configuration file is blocked";
  if (blockedExtensions.some((extension) => lower.endsWith(extension))) return "private/archive/database file type is blocked";
  if (/(^|\/)\.env(\.|$)/.test(lower)) return "environment file is blocked";
  if (/^id_(rsa|ed25519)(\.|$)/.test(basename)) return "private key file is blocked";
  return null;
}

module.exports = { boundaryViolation };
