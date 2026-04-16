#!/usr/bin/env bash
set -euo pipefail

# ─────────────────────────────────────────────────────────────────────
# ClaudeBox — build · sign · publish
# Usage:
#   ./build.sh dmg              Build .app + DMG (unsigned)
#   ./build.sh sign             Codesign + notarize built .app & DMG
#   ./build.sh publish          Upload DMG to GitHub Release + update Homebrew Cask
#   ./build.sh all              dmg → sign → publish
#
# Required env vars (sign):
#   APPLE_SIGNING_IDENTITY      e.g. "Developer ID Application: Lele Huang (XXXXXXXXXX)"
#                               (auto-detected from Keychain if unset)
#   APPLE_ID                    Apple ID email
#   APPLE_ID_PASSWORD           App-specific password  (or @keychain:AC_PASSWORD)
#   APPLE_TEAM_ID               10-char team ID
#
# Required env vars (publish):
#   GITHUB_TOKEN                gh PAT with repo scope
#
# Optional:
#   HOMEBREW_TAP                Tap repo (default: braverior/homebrew-tap)
#   TAURI_SIGNING_PRIVATE_KEY   Tauri updater private key (for .sig files)
#   TAURI_SIGNING_PRIVATE_KEY_PASSWORD
# ─────────────────────────────────────────────────────────────────────

ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"

# ── Read version & arch ──────────────────────────────────────────────

VERSION=$(grep '"version"' src-tauri/tauri.conf.json | head -1 | sed 's/.*: *"\(.*\)".*/\1/')
ARCH=$(uname -m)
case "$ARCH" in
  arm64)  ARCH_LABEL="aarch64" ;;
  x86_64) ARCH_LABEL="x64" ;;
  *)      ARCH_LABEL="$ARCH" ;;
esac

APP_NAME="ClaudeBox"
BUNDLE_DIR="src-tauri/target/release/bundle"
APP_PATH="$BUNDLE_DIR/macos/${APP_NAME}.app"
DMG_PATH="$BUNDLE_DIR/dmg/${APP_NAME}_${VERSION}_${ARCH_LABEL}.dmg"

GITHUB_REPO="braverior/ClaudeBox"
HOMEBREW_TAP="${HOMEBREW_TAP:-braverior/homebrew-tap}"

info()  { printf "\033[1;34m[info]\033[0m  %s\n" "$*"; }
ok()    { printf "\033[1;32m[done]\033[0m  %s\n" "$*"; }
warn()  { printf "\033[1;33m[warn]\033[0m  %s\n" "$*"; }
err()   { printf "\033[1;31m[error]\033[0m %s\n" "$*" >&2; exit 1; }

# ═════════════════════════════════════════════════════════════════════
# dmg — build sidecars + Tauri app
# ═════════════════════════════════════════════════════════════════════

cmd_dmg() {
  info "Building ClaudeBox v${VERSION} (${ARCH_LABEL})..."

  info "Building sidecars..."
  npm run build:lark-sidecar
  npm run build:sidecar

  info "Building Tauri app..."
  npx tauri build

  if [[ ! -f "$DMG_PATH" ]]; then
    DMG_PATH=$(find "$BUNDLE_DIR/dmg" -name "*.dmg" | head -1)
  fi

  [[ -f "$DMG_PATH" ]] || err "DMG not found after build"
  ok "DMG ready: $DMG_PATH"
}

# ═════════════════════════════════════════════════════════════════════
# sign — codesign .app + notarize + staple + re-package DMG
# ═════════════════════════════════════════════════════════════════════

cmd_sign() {
  [[ -d "$APP_PATH" ]] || err ".app not found at $APP_PATH — run './build.sh dmg' first"

  # ── Auto-detect signing identity if not set ──
  if [[ -z "${APPLE_SIGNING_IDENTITY:-}" ]]; then
    info "APPLE_SIGNING_IDENTITY not set, searching Keychain..."
    APPLE_SIGNING_IDENTITY=$(
      security find-identity -v -p codesigning \
      | grep "Developer ID Application" \
      | head -1 \
      | sed 's/.*"\(.*\)"/\1/' || true
    )
    [[ -n "$APPLE_SIGNING_IDENTITY" ]] || err "No 'Developer ID Application' certificate found. Set APPLE_SIGNING_IDENTITY."
    ok "Found identity: $APPLE_SIGNING_IDENTITY"
  fi

  : "${APPLE_ID:?Set APPLE_ID for notarization}"
  : "${APPLE_ID_PASSWORD:?Set APPLE_ID_PASSWORD for notarization}"
  : "${APPLE_TEAM_ID:?Set APPLE_TEAM_ID for notarization}"

  # ── Step 1: Deep codesign with hardened runtime ──
  info "Codesigning ${APP_NAME}.app..."
  codesign --deep --force --verify --verbose \
    --sign "$APPLE_SIGNING_IDENTITY" \
    --options runtime \
    --entitlements "$ROOT/src-tauri/entitlements.plist" \
    "$APP_PATH"

  codesign --verify --verbose=2 "$APP_PATH" || err "Codesign verification failed"
  ok "Codesign complete"

  # ── Step 2: Re-create DMG with signed .app ──
  info "Re-creating signed DMG..."
  rm -f "$DMG_PATH"

  local DMG_TEMP
  DMG_TEMP=$(mktemp -d)
  cp -R "$APP_PATH" "$DMG_TEMP/"
  ln -s /Applications "$DMG_TEMP/Applications"
  hdiutil create -volname "$APP_NAME" \
    -srcfolder "$DMG_TEMP" \
    -ov -format UDZO \
    "$DMG_PATH"
  rm -rf "$DMG_TEMP"

  # ── Step 3: Sign the DMG itself ──
  codesign --force --sign "$APPLE_SIGNING_IDENTITY" "$DMG_PATH"
  ok "DMG signed"

  # ── Step 4: Notarize ──
  info "Submitting for notarization (this may take a few minutes)..."
  xcrun notarytool submit "$DMG_PATH" \
    --apple-id "$APPLE_ID" \
    --password "$APPLE_ID_PASSWORD" \
    --team-id "$APPLE_TEAM_ID" \
    --wait

  # ── Step 5: Staple ──
  info "Stapling notarization ticket..."
  xcrun stapler staple "$DMG_PATH"

  ok "Signed & notarized: $DMG_PATH"
}

# ═════════════════════════════════════════════════════════════════════
# publish — upload to GitHub Release + update Homebrew Cask
# ═════════════════════════════════════════════════════════════════════

cmd_publish() {
  command -v gh >/dev/null 2>&1 || err "'gh' CLI required — brew install gh"

  [[ -f "$DMG_PATH" ]] || {
    DMG_PATH=$(find "$BUNDLE_DIR/dmg" -name "*.dmg" 2>/dev/null | head -1)
    [[ -f "${DMG_PATH:-}" ]] || err "DMG not found — run './build.sh dmg' first"
  }

  local TAG="v${VERSION}"

  # ── Step 1: Create / upload GitHub Release ──
  info "Publishing to GitHub Release ${TAG}..."
  if ! gh release view "$TAG" --repo "$GITHUB_REPO" &>/dev/null; then
    gh release create "$TAG" \
      --repo "$GITHUB_REPO" \
      --title "ClaudeBox ${TAG}" \
      --generate-notes \
      --draft
    ok "Created draft release ${TAG}"
  fi

  info "Uploading $(basename "$DMG_PATH")..."
  gh release upload "$TAG" "$DMG_PATH" \
    --repo "$GITHUB_REPO" \
    --clobber

  # Upload .sig + .tar.gz + .tar.gz.sig if present (Tauri updater)
  for ext in .sig .tar.gz .tar.gz.sig; do
    local f="${DMG_PATH}${ext}"
    [[ -f "$f" ]] && gh release upload "$TAG" "$f" --repo "$GITHUB_REPO" --clobber
  done

  # Upload latest.json if present
  local LATEST_JSON
  LATEST_JSON=$(find "$BUNDLE_DIR" -name "latest.json" 2>/dev/null | head -1 || true)
  [[ -n "$LATEST_JSON" && -f "$LATEST_JSON" ]] && \
    gh release upload "$TAG" "$LATEST_JSON" --repo "$GITHUB_REPO" --clobber

  ok "Assets uploaded to ${TAG}"

  # ── Step 2: Update Homebrew Cask ──
  info "Updating Homebrew Cask..."
  update_homebrew_cask "$TAG"

  echo ""
  ok "Published ${TAG} — mark the draft release as public when ready:"
  info "  https://github.com/${GITHUB_REPO}/releases/tag/${TAG}"
}

# ── Homebrew Cask update helper ─────────────────────────────────────

update_homebrew_cask() {
  local TAG="$1"
  local SHA256
  SHA256=$(shasum -a 256 "$DMG_PATH" | awk '{print $1}')
  info "DMG SHA256: ${SHA256}"

  local TAP_DIR
  TAP_DIR=$(mktemp -d)

  # Clone tap (create if not exists)
  if ! gh repo view "$HOMEBREW_TAP" &>/dev/null; then
    info "Creating tap repo: $HOMEBREW_TAP"
    gh repo create "$HOMEBREW_TAP" --public --description "Homebrew tap for ClaudeBox" --clone "$TAP_DIR"
  else
    gh repo clone "$HOMEBREW_TAP" "$TAP_DIR" -- --depth 1
  fi

  mkdir -p "$TAP_DIR/Casks"

  # Determine SHA256 for each architecture
  local SHA_ARM="" SHA_INTEL=""
  if [[ "$ARCH_LABEL" == "aarch64" ]]; then
    SHA_ARM="$SHA256"
    local INTEL_DMG="$BUNDLE_DIR/dmg/${APP_NAME}_${VERSION}_x64.dmg"
    if [[ -f "$INTEL_DMG" ]]; then
      SHA_INTEL=$(shasum -a 256 "$INTEL_DMG" | awk '{print $1}')
    else
      SHA_INTEL="$SHA256"
      warn "Intel DMG not found — using same SHA (update manually if building both arches)"
    fi
  else
    SHA_INTEL="$SHA256"
    local ARM_DMG="$BUNDLE_DIR/dmg/${APP_NAME}_${VERSION}_aarch64.dmg"
    if [[ -f "$ARM_DMG" ]]; then
      SHA_ARM=$(shasum -a 256 "$ARM_DMG" | awk '{print $1}')
    else
      SHA_ARM="$SHA256"
      warn "ARM DMG not found — using same SHA (update manually if building both arches)"
    fi
  fi

  cat > "$TAP_DIR/Casks/claudebox.rb" << FORMULA
cask "claudebox" do
  version "${VERSION}"

  on_arm do
    url "https://github.com/${GITHUB_REPO}/releases/download/v#{version}/ClaudeBox_#{version}_aarch64.dmg"
    sha256 "${SHA_ARM}"
  end

  on_intel do
    url "https://github.com/${GITHUB_REPO}/releases/download/v#{version}/ClaudeBox_#{version}_x64.dmg"
    sha256 "${SHA_INTEL}"
  end

  name "ClaudeBox"
  desc "Native desktop GUI for Claude Code"
  homepage "https://github.com/${GITHUB_REPO}"

  livecheck do
    url :url
    strategy :github_latest
  end

  depends_on macos: ">= :ventura"

  app "ClaudeBox.app"

  zap trash: [
    "~/.claudebox",
    "~/Library/Application Support/com.claudebox.desktop",
    "~/Library/Caches/com.claudebox.desktop",
    "~/Library/Preferences/com.claudebox.desktop.plist",
    "~/Library/Saved Application State/com.claudebox.desktop.savedState",
  ]
end
FORMULA

  cd "$TAP_DIR"
  git add Casks/claudebox.rb
  if git diff --cached --quiet; then
    info "Cask formula unchanged"
  else
    git commit -m "claudebox ${VERSION}"
    git push
    ok "Homebrew Cask pushed — install with: brew install --cask ${HOMEBREW_TAP/homebrew-/}/claudebox"
  fi

  cd "$ROOT"
  rm -rf "$TAP_DIR"
}

# ═════════════════════════════════════════════════════════════════════
# Entrypoint
# ═════════════════════════════════════════════════════════════════════

case "${1:-}" in
  dmg)     cmd_dmg ;;
  sign)    cmd_sign ;;
  publish) cmd_publish ;;
  all)     cmd_dmg; cmd_sign; cmd_publish ;;
  *)
    echo "Usage: $0 {dmg|sign|publish|all}"
    echo ""
    echo "  dmg      Build .app and DMG"
    echo "  sign     Codesign + notarize (requires Apple Developer creds)"
    echo "  publish  Upload to GitHub Release + update Homebrew Cask"
    echo "  all      dmg → sign → publish"
    echo ""
    echo "Quick start:"
    echo "  export APPLE_ID=you@example.com"
    echo "  export APPLE_ID_PASSWORD=xxxx-xxxx-xxxx-xxxx"
    echo "  export APPLE_TEAM_ID=XXXXXXXXXX"
    echo "  ./build.sh all"
    exit 1
    ;;
esac
