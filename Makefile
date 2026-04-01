# Ardent SDK — Root Makefile
# Requires MSYS2 in PATH for edge-core tests:
#   export PATH="/c/msys64/usr/bin:/c/msys64/mingw64/bin:$PATH"
#
# Targets:
#   make dev          → lance le stack complet (PowerShell)
#   make test         → lance les 3 suites de tests
#   make test-edge    → tests C99 gcc (edge-core)
#   make test-watch   → tests TypeScript vitest (platform-dashboard)
#   make test-forge   → tests Python pytest (automl-pipeline)
#   make clean        → supprime les artefacts de compilation

SHELL := /bin/bash
MSYS2_PATH := /c/msys64/usr/bin:/c/msys64/mingw64/bin

.PHONY: dev test test-edge test-watch test-forge clean

# ── Dev ───────────────────────────────────────────────────────────────────────
dev:
	powershell.exe -ExecutionPolicy Bypass -File dev.ps1

# ── Tests — toutes les suites ─────────────────────────────────────────────────
test: test-edge test-watch test-forge
	@echo ""
	@echo "✓ Toutes les suites de tests sont passées"

# ── Tests — edge-core (C99 / gcc) ────────────────────────────────────────────
test-edge:
	@echo ""
	@echo "═══ edge-core (gcc natif) ═══════════════════"
	@export PATH="$(MSYS2_PATH):$$PATH" TEMP=/tmp TMP=/tmp && \
	 cd edge-core/tests && $(MAKE) --no-print-directory clean all

# ── Tests — platform-dashboard (vitest) ──────────────────────────────────────
test-watch:
	@echo ""
	@echo "═══ platform-dashboard (vitest) ═════════════"
	@cd platform-dashboard && pnpm test

# ── Tests — automl-pipeline (pytest) ─────────────────────────────────────────
test-forge:
	@echo ""
	@echo "═══ automl-pipeline (pytest) ════════════════"
	@cd automl-pipeline && uv run pytest -v

# ── Clean ─────────────────────────────────────────────────────────────────────
clean:
	@export PATH="$(MSYS2_PATH):$$PATH" TEMP=/tmp TMP=/tmp && \
	 cd edge-core/tests && $(MAKE) --no-print-directory clean
	@echo "✓ Artefacts supprimés"
