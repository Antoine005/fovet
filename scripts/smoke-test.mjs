#!/usr/bin/env node
/**
 * Fovet Vigie — Docker Compose smoke test
 *
 * Flow tested:
 *   1. GET  /api/health               → 200 { status: "ok" }
 *   2. POST /api/auth/token           → 200 + cookie fovet_token
 *   3. POST /api/devices              → 201 { id, mqttClientId }
 *   4. Publish MQTT reading           → via mqtt package
 *   5. Wait 2s for ingestion
 *   6. GET  /api/devices/:id/readings → envelope { data, pagination }
 *   7. GET  /api/devices/:id/alerts   → if anomaly was injected
 *
 * Exit 0 = all assertions passed
 * Exit 1 = at least one assertion failed
 */

import { createRequire } from "module";
const require = createRequire(import.meta.url);

const BASE_URL = process.env.DASHBOARD_URL ?? "http://localhost:3000";
const MQTT_URL = process.env.MQTT_URL ?? "mqtt://localhost:1883";
const PASSWORD = process.env.DASHBOARD_PASSWORD ?? "smoke-password";
const DEVICE_MQTT_ID = `smoke-esp32-${Date.now()}`;

let passed = 0;
let failed = 0;

function assert(label, condition, detail = "") {
  if (condition) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
    failed++;
  }
}

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// Step 1 — health
// ---------------------------------------------------------------------------
console.log("\n[1] GET /api/health");
{
  const res = await fetch(`${BASE_URL}/api/health`);
  const body = await res.json();
  assert("status 200", res.status === 200, `got ${res.status}`);
  assert('body.status === "ok"', body.status === "ok", JSON.stringify(body));
}

// ---------------------------------------------------------------------------
// Step 2 — auth
// ---------------------------------------------------------------------------
console.log("\n[2] POST /api/auth/token");
let cookie = "";
{
  const res = await fetch(`${BASE_URL}/api/auth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password: PASSWORD }),
  });
  assert("status 200", res.status === 200, `got ${res.status}`);
  cookie = res.headers.get("set-cookie") ?? "";
  assert("fovet_token cookie set", cookie.includes("fovet_token="), cookie);
  // Extract just the token=value part for subsequent requests
  cookie = cookie.split(";")[0];
}

// ---------------------------------------------------------------------------
// Step 3 — register device
// ---------------------------------------------------------------------------
console.log("\n[3] POST /api/devices");
let deviceId = "";
{
  const res = await fetch(`${BASE_URL}/api/devices`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({ name: "Smoke ESP32", mqttClientId: DEVICE_MQTT_ID }),
  });
  const body = await res.json();
  assert("status 201", res.status === 201, `got ${res.status}`);
  assert("body.id present", typeof body.id === "string", JSON.stringify(body));
  assert("body.mqttClientId matches", body.mqttClientId === DEVICE_MQTT_ID);
  deviceId = body.id;
}

// ---------------------------------------------------------------------------
// Step 4 — publish MQTT reading
// ---------------------------------------------------------------------------
console.log("\n[4] Publish MQTT reading");
{
  // Dynamically require mqtt (available in node:20-alpine via npm install)
  let mqtt;
  try {
    mqtt = require("mqtt");
  } catch {
    // Install mqtt package at runtime if missing
    const { execSync } = require("child_process");
    execSync("npm install --no-save mqtt", { stdio: "inherit" });
    mqtt = require("mqtt");
  }

  await new Promise((resolve, reject) => {
    const client = mqtt.connect(MQTT_URL, { connectTimeout: 5000 });
    client.on("connect", () => {
      const payload = JSON.stringify({
        value: 42.0,
        mean: 23.5,
        stddev: 0.5,
        zScore: 0.8,
        anomaly: false,
      });
      client.publish(
        `fovet/devices/${DEVICE_MQTT_ID}/readings`,
        payload,
        { qos: 1 },
        (err) => {
          client.end();
          if (err) reject(err);
          else resolve();
        }
      );
    });
    client.on("error", reject);
  });
  assert("MQTT publish succeeded", true);

  // Also publish an anomaly to test alert creation
  await new Promise((resolve, reject) => {
    const client = mqtt.connect(MQTT_URL, { connectTimeout: 5000 });
    client.on("connect", () => {
      const payload = JSON.stringify({
        value: 100.0,
        mean: 23.5,
        stddev: 0.5,
        zScore: 153.0,
        anomaly: true,
      });
      client.publish(
        `fovet/devices/${DEVICE_MQTT_ID}/readings`,
        payload,
        { qos: 1 },
        (err) => {
          client.end();
          if (err) reject(err);
          else resolve();
        }
      );
    });
    client.on("error", reject);
  });
  assert("MQTT anomaly publish succeeded", true);
}

// ---------------------------------------------------------------------------
// Step 5 — wait for ingestion
// ---------------------------------------------------------------------------
console.log("\n[5] Wait 2s for MQTT ingestion...");
await sleep(2000);

// ---------------------------------------------------------------------------
// Step 6 — check readings via REST
// ---------------------------------------------------------------------------
console.log("\n[6] GET /api/devices/:id/readings");
{
  const res = await fetch(`${BASE_URL}/api/devices/${deviceId}/readings`, {
    headers: { Cookie: cookie },
  });
  assert("status 200", res.status === 200, `got ${res.status}`);
  const body = await res.json();
  assert("envelope.data is array", Array.isArray(body.data), JSON.stringify(body));
  assert("at least 2 readings ingested", body.data.length >= 2, `got ${body.data.length}`);
  assert("pagination object present", typeof body.pagination === "object");
  assert("ids serialized as strings", typeof body.data[0]?.id === "string");

  const anomalyReading = body.data.find((r) => r.isAnomaly);
  assert("anomaly reading present", Boolean(anomalyReading));
}

// ---------------------------------------------------------------------------
// Step 7 — check alerts
// ---------------------------------------------------------------------------
console.log("\n[7] GET /api/devices/:id/alerts");
{
  const res = await fetch(`${BASE_URL}/api/devices/${deviceId}/alerts`, {
    headers: { Cookie: cookie },
  });
  assert("status 200", res.status === 200, `got ${res.status}`);
  const body = await res.json();
  assert("at least 1 alert created", Array.isArray(body) && body.length >= 1, JSON.stringify(body));
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log(`\n${"─".repeat(50)}`);
console.log(`Smoke test: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
