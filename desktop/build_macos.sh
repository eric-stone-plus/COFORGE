#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIST="$ROOT/desktop/dist"
APP="$DIST/COFORGE.app"
RUNTIME="$ROOT/desktop/.runtime"
NODE_DOWNLOAD=""
HELPER_CONFIG_SOURCE=""
HELPER_CONFIG_DIR=""
NODE_ENTITLEMENTS_PLIST=""
ARCHIVE_VERIFY_DIR=""
cleanup() {
  rm -f "$NODE_DOWNLOAD" "$HELPER_CONFIG_SOURCE" "$NODE_ENTITLEMENTS_PLIST"
  [[ -z "$HELPER_CONFIG_DIR" ]] || rm -rf "$HELPER_CONFIG_DIR"
  [[ -z "$ARCHIVE_VERIFY_DIR" ]] || rm -rf "$ARCHIVE_VERIFY_DIR"
}
trap cleanup EXIT
# Remove only the obsolete literal temp name created by pre-fix BSD mktemp use.
rm -f "$RUNTIME/.node-entitlements.XXXXXX.plist"
HOST_ARCH="$(uname -m)"
ARCH="${ARCH:-$HOST_ARCH}"
TARGET="$ARCH-apple-macos14.0"
LSREGISTER="/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister"
NODE_VERSION="${NODE_VERSION:-22.22.3}"
SIGNING_IDENTITY="${COFORGE_SIGNING_IDENTITY:--}"
REQUIRE_DISTRIBUTION_SIGNATURE="${COFORGE_REQUIRE_DISTRIBUTION_SIGNATURE:-0}"
EXPECTED_TEAM_ID="${COFORGE_TEAM_ID:-}"
NOTARIZE="${COFORGE_NOTARIZE:-0}"
APP_IDENTIFIER="com.coforge.desktop"
NODE_IDENTIFIER="com.coforge.desktop.node"
HELPER_IDENTIFIER="com.coforge.desktop.credential-helper"
REASONIX_IDENTIFIER="com.coforge.desktop.reasonix"
REASONIX_MANIFEST="$ROOT/src/lib/reasonix/release-manifest.json"
if [[ "$ARCH" == "x86_64" ]]; then
  NODE_PLATFORM_ARCH="x64"
  NODE_TARBALL_SHA256="45830ba752fa0d892c6dcd640946669801293cac820a33591ded40ac075198ec"
  REASONIX_PLATFORM="darwin-x64"
else
  NODE_PLATFORM_ARCH="$ARCH"
  NODE_TARBALL_SHA256="0da7ff74ef8611328c8212f17943368713a2ad953fb7d89a8c8a0eae87c23207"
  REASONIX_PLATFORM="darwin-arm64"
fi
NODE_DIST="node-v$NODE_VERSION-darwin-$NODE_PLATFORM_ARCH"
NODE_TARBALL="$RUNTIME/$NODE_DIST.tar.gz"
NODE_DIR="$RUNTIME/$NODE_DIST"
SQLITE_ADDON="$ROOT/node_modules/better-sqlite3/build/Release/better_sqlite3.node"

read_manifest_field() {
  node -e 'const manifest=require(process.argv[1]); const keys=process.argv[2].split("."); let value=manifest; for (const key of keys) value=value[key]; if (typeof value !== "string") process.exit(2); process.stdout.write(value);' "$REASONIX_MANIFEST" "$1"
}

verify_sha256() {
  local path="$1"
  local expected="$2"
  local label="$3"
  if [[ ! -f "$path" || -L "$path" ]]; then
    echo "$label is missing or is not a regular file: $path" >&2
    exit 1
  fi
  local actual
  actual="$(shasum -a 256 "$path" | awk '{print $1}')"
  if [[ "$actual" != "$expected" ]]; then
    echo "$label SHA-256 mismatch: expected $expected, received $actual" >&2
    exit 1
  fi
}

verify_regular_file() {
  local path="$1"
  local label="$2"
  if [[ ! -f "$path" || -L "$path" ]]; then
    echo "$label is missing or is not a regular file: $path" >&2
    exit 1
  fi
}

sign_code() {
  local path="$1"
  local identifier="$2"
  shift 2
  codesign --force --options runtime "${TIMESTAMP_ARGS[@]}" \
    --identifier "$identifier" --sign "$SIGNING_IDENTITY" "$@" "$path"
}

verify_signed_code() {
  local path="$1"
  local identifier="$2"
  codesign --verify --strict --verbose=2 --test-requirement "=identifier \"$identifier\"$SIGNING_REQUIREMENT_SUFFIX" "$path"
}

REASONIX_VERSION="$(read_manifest_field version)"
REASONIX_BINARY_SHA256="$(read_manifest_field "assets.$REASONIX_PLATFORM.binarySha256")"
REASONIX_LICENSE_SHA256="$(read_manifest_field licenseSha256)"
REASONIX_CACHE_DIR="$RUNTIME/reasonix-v$REASONIX_VERSION-$REASONIX_PLATFORM"
REASONIX_BINARY_SOURCE="${REASONIX_BINARY:-$REASONIX_CACHE_DIR/reasonix}"
REASONIX_LICENSE_SOURCE="${REASONIX_LICENSE:-$REASONIX_CACHE_DIR/LICENSE}"

if [[ "$ARCH" != "$HOST_ARCH" ]]; then
  echo "Unsupported ARCH=$ARCH on host $HOST_ARCH because the desktop bundle embeds the host Node runtime." >&2
  exit 1
fi

if [[ "$REQUIRE_DISTRIBUTION_SIGNATURE" != "0" && "$REQUIRE_DISTRIBUTION_SIGNATURE" != "1" ]]; then
  echo "COFORGE_REQUIRE_DISTRIBUTION_SIGNATURE must be 0 or 1." >&2
  exit 1
fi
if [[ "$NOTARIZE" != "0" && "$NOTARIZE" != "1" ]]; then
  echo "COFORGE_NOTARIZE must be 0 or 1." >&2
  exit 1
fi

if [[ "$SIGNING_IDENTITY" == "-" ]]; then
  if [[ "$REQUIRE_DISTRIBUTION_SIGNATURE" == "1" || "$NOTARIZE" == "1" ]]; then
    echo "A Developer ID Application identity is required for distribution and notarization." >&2
    exit 1
  fi
  if [[ -n "$EXPECTED_TEAM_ID" ]]; then
    echo "COFORGE_TEAM_ID must not be set for an ad-hoc development build." >&2
    exit 1
  fi
  DISTRIBUTION_BUILD=0
  TIMESTAMP_ARGS=(--timestamp=none)
  SIGNING_REQUIREMENT_SUFFIX=""
  HELPER_REQUIRES_DEVELOPER_ID=false
  NODE_ENTITLEMENTS="$ROOT/desktop/NodeDevelopment.entitlements"
else
  if [[ ! "$SIGNING_IDENTITY" =~ ^Developer\ ID\ Application:\ .+\ \(([A-Z0-9]{10})\)$ ]]; then
    echo "COFORGE_SIGNING_IDENTITY must be a full Developer ID Application identity." >&2
    exit 1
  fi
  IDENTITY_TEAM_ID="${BASH_REMATCH[1]}"
  if [[ ! "$EXPECTED_TEAM_ID" =~ ^[A-Z0-9]{10}$ ]]; then
    echo "COFORGE_TEAM_ID must be the 10-character Team ID for the release identity." >&2
    exit 1
  fi
  if [[ "$EXPECTED_TEAM_ID" != "$IDENTITY_TEAM_ID" ]]; then
    echo "COFORGE_TEAM_ID does not match the Team ID in COFORGE_SIGNING_IDENTITY." >&2
    exit 1
  fi
  if ! security find-identity -v -p codesigning | awk -v identity="$SIGNING_IDENTITY" 'index($0, "\"" identity "\"") { found=1 } END { exit !found }'; then
    echo "Configured Developer ID Application identity is unavailable: $SIGNING_IDENTITY" >&2
    exit 1
  fi
  DISTRIBUTION_BUILD=1
  TIMESTAMP_ARGS=(--timestamp)
  SIGNING_REQUIREMENT_SUFFIX=" and anchor apple generic and certificate leaf[subject.OU] = \"$EXPECTED_TEAM_ID\" and certificate leaf[field.1.2.840.113635.100.6.1.13] exists"
  HELPER_REQUIRES_DEVELOPER_ID=true
  NODE_ENTITLEMENTS="$ROOT/desktop/Node.entitlements"
fi

if [[ "$DISTRIBUTION_BUILD" == "1" ]] && \
   /usr/libexec/PlistBuddy -c 'Print :com.apple.security.cs.disable-library-validation' "$NODE_ENTITLEMENTS" >/dev/null 2>&1; then
  echo "Developer ID builds must keep Node library validation enabled." >&2
  exit 1
fi

verify_sha256 "$REASONIX_BINARY_SOURCE" "$REASONIX_BINARY_SHA256" "Reasonix $REASONIX_VERSION binary"
verify_sha256 "$REASONIX_LICENSE_SOURCE" "$REASONIX_LICENSE_SHA256" "Reasonix $REASONIX_VERSION license"
if [[ ! -x "$REASONIX_BINARY_SOURCE" ]]; then
  echo "Reasonix binary is not executable: $REASONIX_BINARY_SOURCE" >&2
  exit 1
fi
if ! file "$REASONIX_BINARY_SOURCE" | grep -q "$ARCH"; then
  echo "Reasonix binary architecture does not match ARCH=$ARCH" >&2
  file "$REASONIX_BINARY_SOURCE" >&2
  exit 1
fi

mkdir -p "$RUNTIME"

if [[ ! -f "$NODE_TARBALL" || -L "$NODE_TARBALL" ]]; then
  rm -f "$NODE_TARBALL"
  NODE_DOWNLOAD="$(mktemp "$RUNTIME/.node-download.XXXXXX")"
  echo "Downloading Node.js $NODE_VERSION runtime for darwin-$NODE_PLATFORM_ARCH..."
  curl -fL "https://nodejs.org/dist/v$NODE_VERSION/$NODE_DIST.tar.gz" -o "$NODE_DOWNLOAD"
  verify_sha256 "$NODE_DOWNLOAD" "$NODE_TARBALL_SHA256" "Node.js $NODE_VERSION archive"
  mv "$NODE_DOWNLOAD" "$NODE_TARBALL"
  NODE_DOWNLOAD=""
fi
verify_sha256 "$NODE_TARBALL" "$NODE_TARBALL_SHA256" "Node.js $NODE_VERSION archive"

# Never trust a previously extracted runtime: rebuild it from the pinned archive every time.
rm -rf "$NODE_DIR"
tar -xzf "$NODE_TARBALL" -C "$RUNTIME"
verify_regular_file "$NODE_DIR/bin/node" "Extracted Node.js runtime"
verify_regular_file "$NODE_DIR/LICENSE" "Extracted Node.js license"

npm rebuild better-sqlite3 --build-from-source

if ! file "$NODE_DIR/bin/node" | grep -q "$ARCH"; then
  echo "Bundled Node architecture does not match ARCH=$ARCH" >&2
  file "$NODE_DIR/bin/node" >&2
  exit 1
fi

if [[ -f "$SQLITE_ADDON" ]] && ! file "$SQLITE_ADDON" | grep -q "$ARCH"; then
  echo "better-sqlite3 native addon architecture does not match ARCH=$ARCH" >&2
  file "$SQLITE_ADDON" >&2
  exit 1
fi

# Next's file tracer must never see a prior app bundle. Otherwise it can copy
# desktop/dist back into standalone output and recursively nest old releases.
rm -rf "$DIST"
mkdir -p "$DIST"
npm run build
npm run licenses:generate
npm run licenses:verify
"$ROOT/node_modules/.bin/esbuild" \
  "$ROOT/src/lib/reasonix/mcp-stdio.ts" \
  --bundle \
  --platform=node \
  --format=cjs \
  --target=node22 \
  --external:better-sqlite3 \
  --outfile="$ROOT/.next/standalone/coforge-mcp-server.cjs"

mkdir -p \
  "$APP/Contents/MacOS" \
  "$APP/Contents/Resources/app" \
  "$APP/Contents/Resources/data" \
  "$APP/Contents/Resources/licenses" \
  "$APP/Contents/Resources/node/bin" \
  "$APP/Contents/Resources/reasonix/$REASONIX_PLATFORM" \
  "$DIST"

swiftc \
  -target "$TARGET" \
  -parse-as-library \
  -O \
  "$ROOT/desktop/COFORGE.swift" \
  -o "$APP/Contents/MacOS/COFORGE"

HELPER_CONFIG_DIR="$(mktemp -d "$RUNTIME/.credential-helper-config.XXXXXX")"
HELPER_CONFIG_SOURCE="$HELPER_CONFIG_DIR/BuildConfig.swift"
cat > "$HELPER_CONFIG_SOURCE" <<EOF
enum CredentialHelperBuildConfig {
    static let requiresDeveloperID = $HELPER_REQUIRES_DEVELOPER_ID
    static let expectedTeamIdentifier = "$EXPECTED_TEAM_ID"
}
EOF
swiftc \
  -target "$TARGET" \
  -parse-as-library \
  -O \
  "$HELPER_CONFIG_SOURCE" \
  "$ROOT/desktop/CredentialHelper.swift" \
  -o "$APP/Contents/Resources/credential-helper"
rm -rf "$HELPER_CONFIG_DIR"
HELPER_CONFIG_SOURCE=""
HELPER_CONFIG_DIR=""

cp "$ROOT/desktop/Info.plist" "$APP/Contents/Info.plist"
cp "$ROOT/desktop/AppIcon.icns" "$APP/Contents/Resources/AppIcon.icns"
cp -R "$ROOT/.next/standalone/." "$APP/Contents/Resources/app/"
rm -rf "$APP/Contents/Resources/app/data"
mkdir -p "$APP/Contents/Resources/app/.next"
cp -R "$ROOT/.next/static" "$APP/Contents/Resources/app/.next/static"
if [[ -d "$ROOT/public" ]]; then
  cp -R "$ROOT/public" "$APP/Contents/Resources/app/public"
fi
cp "$ROOT/data/coal-demo.db" "$APP/Contents/Resources/data/coal-demo.db"
node -e "const Database=require('better-sqlite3'); const db=new Database(process.argv[1]); db.pragma('wal_checkpoint(TRUNCATE)'); db.pragma('journal_mode=DELETE'); db.close();" "$APP/Contents/Resources/data/coal-demo.db"
cp "$NODE_DIR/bin/node" "$APP/Contents/Resources/node/bin/node"
cp "$REASONIX_BINARY_SOURCE" "$APP/Contents/Resources/reasonix/$REASONIX_PLATFORM/reasonix"
cp "$ROOT/LICENSE" "$APP/Contents/Resources/licenses/COFORGE-LICENSE"
cp "$ROOT/NOTICE" "$APP/Contents/Resources/licenses/COFORGE-NOTICE"
cp "$NODE_DIR/LICENSE" "$APP/Contents/Resources/licenses/Node-LICENSE"
cp "$REASONIX_LICENSE_SOURCE" "$APP/Contents/Resources/licenses/Reasonix-LICENSE"
cp -R "$ROOT/artifacts/licenses/third-party" "$APP/Contents/Resources/licenses/third-party"
printf 'APPL????' > "$APP/Contents/PkgInfo"

chmod 755 "$APP/Contents/MacOS/COFORGE"
chmod 755 "$APP/Contents/Resources/credential-helper"
chmod 755 "$APP/Contents/Resources/node/bin/node"
chmod 755 "$APP/Contents/Resources/reasonix/$REASONIX_PLATFORM/reasonix"
chmod 644 \
  "$APP/Contents/Info.plist" \
  "$APP/Contents/PkgInfo" \
  "$APP/Contents/Resources/AppIcon.icns" \
  "$APP/Contents/Resources/app/coforge-mcp-server.cjs" \
  "$APP/Contents/Resources/data/coal-demo.db" \
  "$APP/Contents/Resources/licenses/COFORGE-LICENSE" \
  "$APP/Contents/Resources/licenses/COFORGE-NOTICE" \
  "$APP/Contents/Resources/licenses/Node-LICENSE" \
  "$APP/Contents/Resources/licenses/Reasonix-LICENSE"

verify_sha256 "$APP/Contents/Resources/reasonix/$REASONIX_PLATFORM/reasonix" "$REASONIX_BINARY_SHA256" "Packaged Reasonix binary"
verify_sha256 "$APP/Contents/Resources/licenses/Reasonix-LICENSE" "$REASONIX_LICENSE_SHA256" "Packaged Reasonix license"
for required_file in \
  "$APP/Contents/Resources/licenses/COFORGE-LICENSE" \
  "$APP/Contents/Resources/licenses/COFORGE-NOTICE" \
  "$APP/Contents/Resources/licenses/Node-LICENSE"; do
  if [[ ! -s "$required_file" || -L "$required_file" ]]; then
    echo "Required license resource is missing or invalid: $required_file" >&2
    exit 1
  fi
done
node "$ROOT/scripts/verify-third-party-licenses.js" \
  "$ROOT/node_modules" \
  "$APP/Contents/Resources/app/node_modules" \
  "$APP/Contents/Resources/licenses/third-party"

xattr -cr "$APP" 2>/dev/null || true

# Sign every Mach-O nested inside the standalone server before the parent app seal.
while IFS= read -r -d '' native_code; do
  native_identifier="com.coforge.desktop.native.$(printf '%s' "${native_code#"$APP/Contents/Resources/app/"}" | shasum -a 256 | cut -c1-24)"
  sign_code "$native_code" "$native_identifier"
  verify_signed_code "$native_code" "$native_identifier"
done < <(find "$APP/Contents/Resources/app" -type f \( -name '*.node' -o -name '*.dylib' -o -name '*.so' \) -print0)

sign_code "$APP/Contents/Resources/node/bin/node" "$NODE_IDENTIFIER" \
  --entitlements "$NODE_ENTITLEMENTS"
sign_code "$APP/Contents/Resources/reasonix/$REASONIX_PLATFORM/reasonix" "$REASONIX_IDENTIFIER"
sign_code "$APP/Contents/Resources/credential-helper" "$HELPER_IDENTIFIER"
sign_code "$APP/Contents/MacOS/COFORGE" "$APP_IDENTIFIER"

for signed_code in \
  "$APP/Contents/Resources/node/bin/node:$NODE_IDENTIFIER" \
  "$APP/Contents/Resources/reasonix/$REASONIX_PLATFORM/reasonix:$REASONIX_IDENTIFIER" \
  "$APP/Contents/Resources/credential-helper:$HELPER_IDENTIFIER" \
  "$APP/Contents/MacOS/COFORGE:$APP_IDENTIFIER"; do
  verify_signed_code "${signed_code%%:*}" "${signed_code#*:}"
done

PACKAGED_REASONIX_SHA256="$(shasum -a 256 "$APP/Contents/Resources/reasonix/$REASONIX_PLATFORM/reasonix" | awk '{print $1}')"
node -e '
const fs = require("fs");
const [path, platform, binary, upstreamBinarySha256, binarySha256] = process.argv.slice(1);
const manifest = { schemaVersion: 1, platform, binary, upstreamBinarySha256, binarySha256 };
fs.writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: "utf8", mode: 0o644, flag: "wx" });
' "$APP/Contents/Resources/reasonix/packaged-manifest.json" "$REASONIX_PLATFORM" "reasonix" "$REASONIX_BINARY_SHA256" "$PACKAGED_REASONIX_SHA256"

codesign --force --options runtime "${TIMESTAMP_ARGS[@]}" --identifier "$APP_IDENTIFIER" --sign "$SIGNING_IDENTITY" "$APP"
codesign --verify --deep --strict --verbose=2 "$APP"
verify_signed_code "$APP" "$APP_IDENTIFIER"
NODE_ENTITLEMENTS_PLIST="$(mktemp "$RUNTIME/.node-entitlements.XXXXXX")"
codesign -d --entitlements :- "$APP/Contents/Resources/node/bin/node" 2>/dev/null > "$NODE_ENTITLEMENTS_PLIST"
if [[ "$DISTRIBUTION_BUILD" == "1" ]]; then
  if /usr/libexec/PlistBuddy -c 'Print :com.apple.security.cs.disable-library-validation' "$NODE_ENTITLEMENTS_PLIST" >/dev/null 2>&1; then
    echo "Signed Developer ID Node unexpectedly disables library validation." >&2
    exit 1
  fi
elif [[ "$(/usr/libexec/PlistBuddy -c 'Print :com.apple.security.cs.disable-library-validation' "$NODE_ENTITLEMENTS_PLIST" 2>/dev/null)" != "true" ]]; then
  echo "Signed ad-hoc Node is missing the development-only library validation exception." >&2
  exit 1
fi
rm -f "$NODE_ENTITLEMENTS_PLIST"
NODE_ENTITLEMENTS_PLIST=""

# Exercise the actual packaged Node and native modules after all signatures are sealed.
(
  cd "$APP/Contents/Resources/app"
  "$APP/Contents/Resources/node/bin/node" - <<'NODE'
const Database = require("better-sqlite3");
const sharp = require("sharp");

const db = new Database(":memory:");
if (db.prepare("SELECT 1 AS ok").get().ok !== 1) process.exit(1);
db.close();

sharp({
  create: { width: 1, height: 1, channels: 4, background: "#00000000" },
}).png().toBuffer().then((buffer) => {
  if (buffer.length === 0) process.exit(1);
}).catch((error) => {
  console.error(error);
  process.exit(1);
});
NODE
)
if [[ "$DISTRIBUTION_BUILD" == "1" ]]; then
  APP_TEAM_ID="$(codesign -dvv "$APP" 2>&1 | awk -F= '/^TeamIdentifier=/{print $2}')"
  if [[ "$APP_TEAM_ID" != "$EXPECTED_TEAM_ID" ]]; then
    echo "Signed app TeamIdentifier mismatch: expected $EXPECTED_TEAM_ID, received ${APP_TEAM_ID:-none}" >&2
    exit 1
  fi
fi
touch "$APP"
"$LSREGISTER" -f "$APP" 2>/dev/null || true

rm -f "$DIST/COFORGE-macOS-$ARCH.zip"
(
  cd "$DIST"
  ditto -c -k --norsrc --noextattr --noacl --noqtn --keepParent \
    "COFORGE.app" "COFORGE-macOS-$ARCH.zip"
)

ARCHIVE_VERIFY_DIR="$(mktemp -d "$RUNTIME/.archive-verify.XXXXXX")"
unzip -q "$DIST/COFORGE-macOS-$ARCH.zip" -d "$ARCHIVE_VERIFY_DIR"
if find "$ARCHIVE_VERIFY_DIR" -name '._*' -print -quit | grep -q .; then
  echo "macOS archive contains forbidden AppleDouble sidecars." >&2
  exit 1
fi
if find "$ARCHIVE_VERIFY_DIR/COFORGE.app/Contents/Resources/app" \
  -path '*/desktop/dist/*' -print -quit | grep -q .; then
  echo "Extracted app contains recursive desktop build artifacts." >&2
  exit 1
fi
codesign --verify --deep --strict --verbose=2 "$ARCHIVE_VERIFY_DIR/COFORGE.app"
verify_signed_code "$ARCHIVE_VERIFY_DIR/COFORGE.app" "$APP_IDENTIFIER"
rm -rf "$ARCHIVE_VERIFY_DIR"
ARCHIVE_VERIFY_DIR=""

echo "Built $APP"
echo "Archived $DIST/COFORGE-macOS-$ARCH.zip"

if [[ "$NOTARIZE" == "1" ]]; then
  COFORGE_TEAM_ID="$EXPECTED_TEAM_ID" "$ROOT/desktop/notarize_macos.sh" "$APP"
fi
