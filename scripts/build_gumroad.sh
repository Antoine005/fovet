#!/usr/bin/env bash
# =============================================================================
# Ardent — build_gumroad.sh
# Génère les packages Gumroad dans dist/gumroad/
#
# Usage:
#   bash scripts/build_gumroad.sh           # builds both packages
#   bash scripts/build_gumroad.sh pulse     # Pulse SDK only
#   bash scripts/build_gumroad.sh full      # Full Stack only
#
# Output:
#   dist/gumroad/ardent-pulse-sdk-v{VERSION}.zip
#   dist/gumroad/ardent-full-stack-v{VERSION}.zip
#
# Requirements: zip, cp, mkdir (standard POSIX — works in MSYS2/WSL/Linux/Mac)
# =============================================================================

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VERSION=$(grep '"version"' "$REPO_ROOT/edge-core/library.json" | head -1 | sed 's/.*"\([0-9][^"]*\)".*/\1/')
DIST="$REPO_ROOT/gumroad/packages"
PULSE_DIR="$DIST/ardent-pulse-sdk-v$VERSION"
FULL_DIR="$DIST/ardent-full-stack-v$VERSION"

TARGET="${1:-all}"

echo ""
echo "═══════════════════════════════════════════"
echo "  Ardent — Gumroad package builder"
echo "  Version : $VERSION"
echo "  Output  : dist/gumroad/"
echo "═══════════════════════════════════════════"
echo ""

mkdir -p "$DIST"

# ─── Helper ──────────────────────────────────────────────────────────────────

copy_license() {
  local dest="$1"
  if [ -f "$REPO_ROOT/LICENCE_LGPL.txt" ]; then
    cp "$REPO_ROOT/LICENCE_LGPL.txt" "$dest/"
  else
    # Generate minimal LGPL notice if file is missing
    cat > "$dest/LICENCE_LGPL.txt" <<'EOF'
GNU LESSER GENERAL PUBLIC LICENSE
Version 3, 29 June 2007

Ardent SDK — Copyright (C) 2026 Antoine Porte. All rights reserved.

This library is free software; you can redistribute it and/or modify it
under the terms of the GNU Lesser General Public License as published by
the Free Software Foundation; either version 3 of the License, or (at
your option) any later version.

This library is distributed in the hope that it will be useful, but
WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU Lesser
General Public License for more details.

Full license text: https://www.gnu.org/licenses/lgpl-3.0.html

Commercial licensing for production deployments, defense, and industrial
applications: contact@ardent-ai.fr
EOF
  fi
}

# ─── Pulse SDK ───────────────────────────────────────────────────────────────

build_pulse() {
  local ZIP="$DIST/ardent-pulse-sdk-v$VERSION.zip"

  echo "► Building Pulse SDK package..."

  # Clean
  rm -rf "$PULSE_DIR"
  mkdir -p "$PULSE_DIR"

  # edge-core (exclude build artifacts and credentials)
  mkdir -p "$PULSE_DIR/edge-core"
  cp -r "$REPO_ROOT/edge-core/include"   "$PULSE_DIR/edge-core/"
  cp -r "$REPO_ROOT/edge-core/src"       "$PULSE_DIR/edge-core/"
  cp -r "$REPO_ROOT/edge-core/tests"     "$PULSE_DIR/edge-core/"
  cp -r "$REPO_ROOT/edge-core/examples"  "$PULSE_DIR/edge-core/"
  cp    "$REPO_ROOT/edge-core/library.json" "$PULSE_DIR/edge-core/"

  # Remove generated/secret files from the copy
  find "$PULSE_DIR" -name "config.h" -not -name "config.h.example" -delete
  find "$PULSE_DIR" -name "*.o" -o -name "*.a" -o -name "*.elf" -o -name "*.bin" | xargs rm -f 2>/dev/null || true
  find "$PULSE_DIR" -name "zscore_test" -o -name "drift_test" -o -name "mad_test" | xargs rm -f 2>/dev/null || true
  find "$PULSE_DIR" -name "fovet_zscore_config.h" -delete 2>/dev/null || true
  find "$PULSE_DIR" -type d -name ".pio" | xargs rm -rf 2>/dev/null || true

  # Onboarding README
  cp "$REPO_ROOT/docs/gumroad/README_START_HERE_pulse.md" "$PULSE_DIR/README_START_HERE.md"

  # Quick Start Guide (PDF if exists, otherwise Markdown)
  if [ -f "$REPO_ROOT/docs/quick_start_guide.pdf" ]; then
    cp "$REPO_ROOT/docs/quick_start_guide.pdf" "$PULSE_DIR/Quick_Start_Guide.pdf"
  else
    cp "$REPO_ROOT/docs/quick_start_guide.md" "$PULSE_DIR/Quick_Start_Guide.md"
    echo "  [INFO] PDF not found — Quick_Start_Guide.md included instead."
    echo "         To generate PDF: pandoc docs/quick_start_guide.md -o docs/quick_start_guide.pdf"
  fi

  # License
  copy_license "$PULSE_DIR"

  # Zip
  cd "$DIST"
  rm -f "$ZIP"
  zip -r "ardent-pulse-sdk-v$VERSION.zip" "ardent-pulse-sdk-v$VERSION/" -x "*.DS_Store" -x "*/__pycache__/*"
  rm -rf "$PULSE_DIR"

  local SIZE
  SIZE=$(du -sh "$ZIP" 2>/dev/null | cut -f1)
  echo "  ✓ $ZIP ($SIZE)"
}

# ─── Full Stack ───────────────────────────────────────────────────────────────

build_full() {
  local ZIP="$DIST/ardent-full-stack-v$VERSION.zip"

  echo "► Building Full Stack package..."

  # Clean
  rm -rf "$FULL_DIR"
  mkdir -p "$FULL_DIR"

  # edge-core (same as Pulse)
  mkdir -p "$FULL_DIR/edge-core"
  cp -r "$REPO_ROOT/edge-core/include"   "$FULL_DIR/edge-core/"
  cp -r "$REPO_ROOT/edge-core/src"       "$FULL_DIR/edge-core/"
  cp -r "$REPO_ROOT/edge-core/tests"     "$FULL_DIR/edge-core/"
  cp -r "$REPO_ROOT/edge-core/examples"  "$FULL_DIR/edge-core/"
  cp    "$REPO_ROOT/edge-core/library.json" "$FULL_DIR/edge-core/"

  # automl-pipeline (exclude venv, caches, outputs)
  mkdir -p "$FULL_DIR/automl-pipeline"
  rsync -a --exclude='.venv' --exclude='__pycache__' \
            --exclude='*.pyc' --exclude='*.egg-info' \
            --exclude='outputs/' --exclude='.pytest_cache' \
            "$REPO_ROOT/automl-pipeline/" "$FULL_DIR/automl-pipeline/" 2>/dev/null \
  || cp -r "$REPO_ROOT/automl-pipeline/" "$FULL_DIR/automl-pipeline/"

  # platform-dashboard (exclude node_modules, .next, .env files)
  mkdir -p "$FULL_DIR/platform-dashboard"
  rsync -a --exclude='node_modules' --exclude='.next' \
            --exclude='.env' --exclude='.env.local' \
            --exclude='.env.production' --exclude='*.tsbuildinfo' \
            "$REPO_ROOT/platform-dashboard/" "$FULL_DIR/platform-dashboard/" 2>/dev/null \
  || { mkdir -p "$FULL_DIR/platform-dashboard"
       cp -r "$REPO_ROOT/platform-dashboard/src"    "$FULL_DIR/platform-dashboard/" 2>/dev/null || true
       cp -r "$REPO_ROOT/platform-dashboard/prisma" "$FULL_DIR/platform-dashboard/" 2>/dev/null || true
       cp    "$REPO_ROOT/platform-dashboard/package.json" "$FULL_DIR/platform-dashboard/" 2>/dev/null || true
       cp    "$REPO_ROOT/platform-dashboard/.env.example" "$FULL_DIR/platform-dashboard/" 2>/dev/null || true
       cp    "$REPO_ROOT/platform-dashboard/tsconfig.json" "$FULL_DIR/platform-dashboard/" 2>/dev/null || true; }

  # mosquitto config (without passwd file)
  if [ -d "$REPO_ROOT/mosquitto" ]; then
    mkdir -p "$FULL_DIR/mosquitto"
    cp "$REPO_ROOT/mosquitto/mosquitto.conf" "$FULL_DIR/mosquitto/" 2>/dev/null || true
    echo "# Populate with: mosquitto_passwd -c passwd ardent-watch" \
      > "$FULL_DIR/mosquitto/passwd.example"
  fi

  # scripts
  if [ -d "$REPO_ROOT/scripts" ]; then
    mkdir -p "$FULL_DIR/scripts"
    cp "$REPO_ROOT/scripts/demo_mqtt.py" "$FULL_DIR/scripts/" 2>/dev/null || true
  fi

  # Root files
  cp "$REPO_ROOT/docker-compose.yml"  "$FULL_DIR/" 2>/dev/null || true
  cp "$REPO_ROOT/Makefile"            "$FULL_DIR/" 2>/dev/null || true

  # Remove secrets
  find "$FULL_DIR" -name "config.h" -not -name "config.h.example" -delete
  find "$FULL_DIR" -name ".env" -not -name ".env.example" -delete
  find "$FULL_DIR" -name "passwd" -not -name "passwd.example" -delete
  find "$FULL_DIR" -type d -name ".pio" | xargs rm -rf 2>/dev/null || true

  # Onboarding README
  cp "$REPO_ROOT/docs/gumroad/README_START_HERE_full.md" "$FULL_DIR/README_START_HERE.md"

  # Quick Start Guide
  if [ -f "$REPO_ROOT/docs/quick_start_guide.pdf" ]; then
    cp "$REPO_ROOT/docs/quick_start_guide.pdf" "$FULL_DIR/Quick_Start_Guide.pdf"
  else
    cp "$REPO_ROOT/docs/quick_start_guide.md" "$FULL_DIR/Quick_Start_Guide.md"
  fi

  # License
  copy_license "$FULL_DIR"

  # Zip
  cd "$DIST"
  rm -f "$ZIP"
  zip -r "ardent-full-stack-v$VERSION.zip" "ardent-full-stack-v$VERSION/" \
      -x "*.DS_Store" -x "*/__pycache__/*" -x "*/node_modules/*" -x "*/.next/*"
  rm -rf "$FULL_DIR"

  local SIZE
  SIZE=$(du -sh "$ZIP" 2>/dev/null | cut -f1)
  echo "  ✓ $ZIP ($SIZE)"
}

# ─── Main ─────────────────────────────────────────────────────────────────────

case "$TARGET" in
  pulse) build_pulse ;;
  full)  build_full ;;
  all)   build_pulse; build_full ;;
  *)
    echo "Usage: $0 [pulse|full|all]"
    exit 1
    ;;
esac

echo ""
echo "═══════════════════════════════════════════"
echo "  Done — packages in dist/gumroad/"
ls -lh "$DIST"/*.zip 2>/dev/null || true
echo "═══════════════════════════════════════════"
echo ""
