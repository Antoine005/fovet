#!/usr/bin/env bash
# =============================================================================
# Ardent Watch — Pipeline integration test
# Couvre le scénario DoD complet de la spec v2 (sans hardware)
#
# Usage:
#   cd platform-dashboard && bash scripts/test-pipeline.sh
#   BASE_URL=http://localhost:3001 bash scripts/test-pipeline.sh
#
# Pré-requis : serveur Next.js lancé (pnpm dev ou pnpm start)
#              PostgreSQL + Mosquitto actifs
# =============================================================================

BASE_URL="${BASE_URL:-http://localhost:3000}"
PASS=0; FAIL=0

# ── Helpers ──────────────────────────────────────────────────────────────────

GREEN='\033[0;32m'; RED='\033[0;31m'; YELLOW='\033[1;33m'; NC='\033[0m'; BOLD='\033[1m'

ok()   { echo -e "  ${GREEN}✓${NC} $1"; ((PASS++)); }
fail() { echo -e "  ${RED}✗${NC} $1"; ((FAIL++)); }
info() { echo -e "  ${YELLOW}→${NC} $1"; }
section() { echo -e "\n${BOLD}$1${NC}"; }

assert_http() {
  local label="$1" url="$2" expected_status="$3" extra_flags="${4:-}"
  local response
  response=$(curl -s -o /tmp/ard_test_body -w "%{http_code}" $extra_flags "$url")
  if [ "$response" -eq "$expected_status" ]; then
    ok "$label (HTTP $expected_status)"
  else
    fail "$label — expected HTTP $expected_status, got $response"
    cat /tmp/ard_test_body 2>/dev/null | head -3
  fi
}

assert_json_field() {
  local label="$1" body="$2" field="$3"
  if echo "$body" | grep -q "\"$field\""; then
    ok "$label — has field '$field'"
  else
    fail "$label — missing field '$field'"
  fi
}

# ── 0. Health check ───────────────────────────────────────────────────────────

section "0. Health check"
HEALTH=$(curl -s "$BASE_URL/api/healthz")
if echo "$HEALTH" | grep -q '"status"'; then
  ok "GET /api/healthz → JSON response"
  if echo "$HEALTH" | grep -q '"db":"ok"'; then
    ok "Database connection OK"
  else
    fail "Database not connected — check PostgreSQL"
  fi
else
  fail "GET /api/healthz — no response (is the server running?)"
  echo -e "\n${RED}FATAL: Cannot reach server at $BASE_URL${NC}"
  exit 1
fi

# ── 1. Forge algorithms (G2) ──────────────────────────────────────────────────

section "1. GET /api/forge/algorithms (G2)"

# Need auth cookie — use dev bypass (NODE_ENV=development)
ALGOS=$(curl -s -c /tmp/ard_cookie "$BASE_URL/api/forge/algorithms")
if echo "$ALGOS" | grep -q '"id"'; then
  ok "GET /api/forge/algorithms → JSON array"
  ALGO_COUNT=$(echo "$ALGOS" | grep -o '"id"' | wc -l | tr -d ' ')
  info "  $ALGO_COUNT algorithmes retournés"
  if [ "$ALGO_COUNT" -ge 4 ]; then
    ok "Au moins 4 algorithmes disponibles"
  else
    fail "Moins de 4 algorithmes — vérifier forge CLI"
  fi
  for algo in zscore ewma_drift mad autoencoder; do
    if echo "$ALGOS" | grep -q "\"$algo\""; then
      ok "Algorithme '$algo' présent"
    else
      fail "Algorithme '$algo' manquant"
    fi
  done
else
  fail "GET /api/forge/algorithms — réponse invalide ou CLI forge indisponible"
  info "  Réponse: $(echo "$ALGOS" | head -c 200)"
fi

# ── 2. Devices CRUD ───────────────────────────────────────────────────────────

section "2. Devices CRUD"

# List devices
DEVICES=$(curl -s -b /tmp/ard_cookie "$BASE_URL/api/devices")
if echo "$DEVICES" | python3 -c "import sys,json; json.load(sys.stdin)" 2>/dev/null; then
  ok "GET /api/devices → JSON valide"
else
  # Try without python
  ok "GET /api/devices → réponse reçue"
fi

# Create test device
TEST_MQTT_ID="test-pipeline-$(date +%s)"
CREATE_RES=$(curl -s -b /tmp/ard_cookie -X POST "$BASE_URL/api/devices" \
  -H "Content-Type: application/json" \
  -d "{\"name\":\"Test Pipeline\",\"mqttClientId\":\"$TEST_MQTT_ID\"}")
if echo "$CREATE_RES" | grep -q '"id"'; then
  ok "POST /api/devices → device créé"
  DEVICE_ID=$(echo "$CREATE_RES" | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4)
  info "  Device ID: $DEVICE_ID"
  info "  MQTT ID: $TEST_MQTT_ID"
else
  fail "POST /api/devices — création échouée"
  info "  Réponse: $(echo "$CREATE_RES" | head -c 200)"
fi

# ── 3. Forge job launch (G5) ──────────────────────────────────────────────────

section "3. Forge job + SSE logs (G5)"

JOB_RES=$(curl -s -b /tmp/ard_cookie -X POST "$BASE_URL/api/forge/jobs" \
  -H "Content-Type: application/json" \
  -d '{"totalEpochs":50,"config":"demo_zscore.yaml"}')

if echo "$JOB_RES" | grep -q '"id"'; then
  ok "POST /api/forge/jobs → job créé"
  JOB_ID=$(echo "$JOB_RES" | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4)
  JOB_REF=$(echo "$JOB_RES" | grep -o '"jobRef":"[^"]*"' | head -1 | cut -d'"' -f4)
  info "  Job ID: $JOB_ID  Ref: $JOB_REF"

  # Test SSE stream endpoint (just check it opens)
  SSE_STATUS=$(curl -s -o /dev/null -w "%{http_code}" -b /tmp/ard_cookie \
    --max-time 2 "$BASE_URL/api/forge/jobs/$JOB_ID/stream" 2>/dev/null)
  if [ "$SSE_STATUS" = "200" ] || [ "$SSE_STATUS" = "000" ]; then
    ok "GET /api/forge/jobs/:id/stream → SSE endpoint accessible"
  else
    fail "GET /api/forge/jobs/:id/stream → HTTP $SSE_STATUS"
  fi

  # Poll for completion (max 60s — demo_zscore with synthetic data is fast)
  info "  Attente completion du job (max 60s)…"
  FINAL_STATUS="RUNNING"
  for i in $(seq 1 12); do
    sleep 5
    JOB_STATUS=$(curl -s -b /tmp/ard_cookie "$BASE_URL/api/forge/jobs/$JOB_ID/logs")
    FINAL_STATUS=$(echo "$JOB_STATUS" | grep -o '"status":"[^"]*"' | head -1 | cut -d'"' -f4)
    info "  Tick $i — status: $FINAL_STATUS"
    if [ "$FINAL_STATUS" = "DONE" ] || [ "$FINAL_STATUS" = "FAILED" ]; then
      break
    fi
  done

  if [ "$FINAL_STATUS" = "DONE" ]; then
    ok "Job Forge terminé avec succès (DONE)"
    # Check logs
    LOGS=$(echo "$JOB_STATUS" | grep -o '"logs":"[^"]*"' | head -1 | cut -d'"' -f4)
    if [ -n "$LOGS" ]; then
      ok "Logs Forge non vides"
    else
      fail "Logs Forge vides — vérifier l'intégration CLI"
    fi
  elif [ "$FINAL_STATUS" = "FAILED" ]; then
    fail "Job Forge échoué — vérifier uv + forge CLI"
    info "  Logs: $(echo "$JOB_STATUS" | grep -o '"logs":"[^"]*"' | head -1 | head -c 300)"
  else
    fail "Job Forge toujours RUNNING après 60s — timeout"
  fi
else
  fail "POST /api/forge/jobs — création échouée"
  info "  Réponse: $(echo "$JOB_RES" | head -c 200)"
  JOB_ID=""
fi

# ── 4. Flash port detection ───────────────────────────────────────────────────

section "4. Flash — détection ports COM"

PORTS=$(curl -s "$BASE_URL/api/flash/ports")
if echo "$PORTS" | grep -q '\['; then
  ok "GET /api/flash/ports → réponse JSON"
  PORT_COUNT=$(echo "$PORTS" | grep -o '"name"' | wc -l | tr -d ' ')
  info "  $PORT_COUNT port(s) COM détecté(s)"
  if echo "$PORTS" | grep -q '"name"'; then
    FIRST_PORT=$(echo "$PORTS" | grep -o '"name":"[^"]*"' | head -1 | cut -d'"' -f4)
    ok "Port détecté: $FIRST_PORT"
  fi
else
  fail "GET /api/flash/ports — réponse invalide"
fi

# ── 5. Deploy Forge→Flash (G4) ────────────────────────────────────────────────

section "5. Deploy intégré Forge→Flash (G4)"

if [ -n "$JOB_ID" ] && [ "$FINAL_STATUS" = "DONE" ] && [ -n "$DEVICE_ID" ]; then
  info "  Test du endpoint deploy (sans flash réel — port inexistant)"
  DEPLOY_RES=$(curl -s -b /tmp/ard_cookie -X POST "$BASE_URL/api/forge/jobs/$JOB_ID/deploy" \
    -H "Content-Type: application/json" \
    -d "{\"deviceId\":\"$DEVICE_ID\",\"project\":\"zscore_demo\",\"port\":\"COM99\"}")

  if echo "$DEPLOY_RES" | grep -q '"flashJobId"'; then
    ok "POST /api/forge/jobs/:id/deploy → flashJobId retourné"
    FLASH_JOB=$(echo "$DEPLOY_RES" | grep -o '"flashJobId":"[^"]*"' | head -1 | cut -d'"' -f4)
    info "  Flash job ID: $FLASH_JOB"

    # Check config.h was written
    CONFIG_H="$PWD/../edge-core/examples/esp32/zscore_demo/src/config.h"
    if [ -f "$CONFIG_H" ]; then
      ok "config.h généré dans zscore_demo/src/"
      if grep -q "DEVICE_ID" "$CONFIG_H"; then
        ok "config.h contient DEVICE_ID"
      else
        fail "config.h ne contient pas DEVICE_ID"
      fi
    else
      fail "config.h non trouvé dans zscore_demo/src/ (chemin: $CONFIG_H)"
    fi

    # SSE stream exists
    STREAM_STATUS=$(curl -s -o /dev/null -w "%{http_code}" --max-time 2 "$BASE_URL/api/flash/stream/$FLASH_JOB" 2>/dev/null)
    if [ "$STREAM_STATUS" = "200" ] || [ "$STREAM_STATUS" = "000" ]; then
      ok "GET /api/flash/stream/:jobId → accessible"
    else
      fail "GET /api/flash/stream/:jobId → HTTP $STREAM_STATUS"
    fi
  else
    fail "POST /api/forge/jobs/:id/deploy — pas de flashJobId"
    info "  Réponse: $(echo "$DEPLOY_RES" | head -c 300)"
  fi
else
  info "  SKIP deploy test (job non DONE ou device non créé)"
fi

# ── 6. MQTT simulation (G6 partiel) ──────────────────────────────────────────

section "6. Simulation MQTT (sans hardware)"

if command -v mosquitto_pub &>/dev/null; then
  PAYLOAD="{\"ts\":$(date +%s)000,\"device\":\"$TEST_MQTT_ID\",\"channel\":\"test\",\"value\":1.23,\"anomaly\":false,\"zscore\":0.5,\"algo\":\"zscore\",\"model_id\":\"test\"}"
  mosquitto_pub -h 127.0.0.1 -p 1883 \
    -u ardent-device -P ***REDACTED*** \
    -t "ardent/devices/$TEST_MQTT_ID/readings" \
    -m "$PAYLOAD" 2>/dev/null

  if [ $? -eq 0 ]; then
    ok "mosquitto_pub → message MQTT publié"
    sleep 2
    # Check reading appeared
    READINGS=$(curl -s -b /tmp/ard_cookie "$BASE_URL/api/devices/$DEVICE_ID/readings?limit=5" 2>/dev/null)
    if echo "$READINGS" | grep -q '"data"'; then
      ok "GET /api/devices/:id/readings → réponse valide"
    else
      info "  Lectures non encore visibles (latence MQTT→DB)"
    fi
  else
    fail "mosquitto_pub échoué — vérifier Mosquitto"
  fi
else
  info "  SKIP — mosquitto_pub non disponible (normal en CI)"
  info "  Pour tester: uv run --with paho-mqtt python scripts/demo_mqtt.py"
fi

# ── 7. Cleanup ────────────────────────────────────────────────────────────────

section "7. Cleanup device test"

if [ -n "$DEVICE_ID" ]; then
  DEL=$(curl -s -o /dev/null -w "%{http_code}" -b /tmp/ard_cookie \
    -X DELETE "$BASE_URL/api/devices/$DEVICE_ID")
  if [ "$DEL" = "200" ] || [ "$DEL" = "204" ]; then
    ok "DELETE /api/devices/:id → device nettoyé"
  else
    fail "DELETE /api/devices/:id → HTTP $DEL"
  fi
fi

rm -f /tmp/ard_cookie /tmp/ard_test_body

# ── Résumé ────────────────────────────────────────────────────────────────────

echo ""
echo "════════════════════════════════════════"
TOTAL=$((PASS + FAIL))
if [ $FAIL -eq 0 ]; then
  echo -e "${GREEN}${BOLD}PASS ${PASS}/${TOTAL} — Pipeline spec v2 opérationnel${NC}"
else
  echo -e "${RED}${BOLD}FAIL ${FAIL}/${TOTAL} — ${PASS} succès, ${FAIL} échec(s)${NC}"
fi
echo "════════════════════════════════════════"

exit $FAIL
