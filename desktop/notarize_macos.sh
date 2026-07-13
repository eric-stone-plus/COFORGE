#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP="${1:-$ROOT/desktop/dist/COFORGE.app}"
PROFILE="${COFORGE_NOTARY_PROFILE:-}"
TEAM_ID="${COFORGE_TEAM_ID:-}"
APP_IDENTIFIER="com.coforge.desktop"

if [[ ! -d "$APP" || -L "$APP" ]]; then
  echo "Notarization requires a regular app bundle: $APP" >&2
  exit 1
fi
if [[ -z "$PROFILE" ]]; then
  echo "COFORGE_NOTARY_PROFILE must name credentials stored with xcrun notarytool store-credentials." >&2
  exit 1
fi
if [[ ! "$TEAM_ID" =~ ^[A-Z0-9]{10}$ ]]; then
  echo "COFORGE_TEAM_ID must be the 10-character Developer ID Team ID." >&2
  exit 1
fi

REQUIREMENT="=identifier \"$APP_IDENTIFIER\" and anchor apple generic and certificate leaf[subject.OU] = \"$TEAM_ID\" and certificate leaf[field.1.2.840.113635.100.6.1.13] exists"
codesign --verify --deep --strict --verbose=2 --test-requirement "$REQUIREMENT" "$APP"

SIGNED_TEAM_ID="$(codesign -dvv "$APP" 2>&1 | awk -F= '/^TeamIdentifier=/{print $2}')"
if [[ "$SIGNED_TEAM_ID" != "$TEAM_ID" ]]; then
  echo "Signed app TeamIdentifier mismatch: expected $TEAM_ID, received ${SIGNED_TEAM_ID:-none}" >&2
  exit 1
fi

ARCH="$(file "$APP/Contents/MacOS/COFORGE" | sed -E 's/.*(arm64|x86_64).*/\1/')"
ARCHIVE="$ROOT/desktop/dist/COFORGE-macOS-$ARCH-notarization.zip"
rm -f "$ARCHIVE"
ditto -c -k --keepParent "$APP" "$ARCHIVE"

NOTARY_RESULT="$(mktemp "$ROOT/desktop/dist/.notary-result.XXXXXX.json")"
trap 'rm -f "$NOTARY_RESULT"' EXIT
xcrun notarytool submit "$ARCHIVE" \
  --keychain-profile "$PROFILE" \
  --wait \
  --output-format json > "$NOTARY_RESULT"
NOTARY_STATUS="$(plutil -extract status raw -o - "$NOTARY_RESULT" 2>/dev/null || true)"
if [[ "$NOTARY_STATUS" != "Accepted" ]]; then
  cat "$NOTARY_RESULT" >&2
  echo "Apple notarization was not accepted; refusing to staple or publish." >&2
  exit 1
fi
xcrun stapler staple -v "$APP"
xcrun stapler validate -v "$APP"
codesign --verify --deep --strict --verbose=2 --test-requirement "$REQUIREMENT" "$APP"
spctl --assess --type execute --verbose=4 "$APP"

rm -f "$ARCHIVE"
rm -f "$NOTARY_RESULT"
FINAL_ARCHIVE="$ROOT/desktop/dist/COFORGE-macOS-$ARCH.zip"
ditto -c -k --keepParent "$APP" "$FINAL_ARCHIVE"
echo "Notarized and stapled $APP"
echo "Archived $FINAL_ARCHIVE"
