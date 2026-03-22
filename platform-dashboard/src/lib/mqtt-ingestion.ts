/**
 * Fovet Vigie — MQTT Ingestion Service
 *
 * Subscribes to fovet/devices/+/readings and persists incoming
 * sensor data from Fovet Sentinelle nodes into PostgreSQL.
 *
 * Canonical MQTT message format (JSON) — all ESP32 firmwares:
 * {
 *   "device_id":  "esp32cam_001",          // optional (also in topic)
 *   "firmware":   "person_detection",      // canonical: identifies the firmware
 *   "sensor":     "camera",                // canonical: "camera" | "synthetic"
 *   "value":      0.87,                    // required: primary numeric value
 *   "label":      "person",               // optional: human-readable category
 *   "unit":       "score",                // optional: value unit
 *   "anomaly":    true,                   // optional: anomaly flag
 *   "ts":         1704067200000,          // optional: Unix ms (defaults to server time)
 * }
 *
 * Legacy format (monitoring/human branch — still supported):
 * {
 *   "value":      1.2345,
 *   "mean":       0.0012,
 *   "stddev":     0.5432,
 *   "zScore":     2.275,
 *   "anomaly":    false,
 *   "ts":         1704067200000,
 *   "sensorType": "TEMP",          // "IMU" | "HR" | "TEMP"
 *   "level":      "WARN",          // "SAFE" | "WARN" | "DANGER" | "COLD" | "CRITICAL"
 *   "value2":     65.0             // secondary value (e.g. humidity % for TEMP)
 * }
 *
 * Topic pattern: fovet/devices/<mqttClientId>/readings
 */

import mqtt from "mqtt";
import { prisma } from "./prisma";
import { emitReading } from "./event-bus";

const BROKER_URL   = process.env.MQTT_BROKER_URL ?? "mqtt://localhost:1883";
const TOPIC        = `${process.env.MQTT_TOPIC_PREFIX ?? "fovet/devices"}/+/readings`;
const WEBHOOK_URL  = process.env.ALERT_WEBHOOK_URL ?? "";
const WEBHOOK_MIN  = (process.env.ALERT_WEBHOOK_MIN_LEVEL ?? "DANGER").toUpperCase();

// Severity rank — higher = more severe. Used to filter by WEBHOOK_MIN.
const LEVEL_RANK: Record<string, number> = { INFO: 0, WARN: 1, COLD: 1, DANGER: 2, CRITICAL: 3 };
const WEBHOOK_MIN_RANK = WEBHOOK_MIN === "ALL" ? 0 : (LEVEL_RANK[WEBHOOK_MIN] ?? 2);

// Modules that produce alerts beyond z-score anomalies
const ALERT_MODULES: Record<string, string> = {
  IMU:  "PTI",
  HR:   "FATIGUE",
  TEMP: "THERMAL",
};

// Levels that trigger an Alert record (in addition to z-score anomalies)
const ALERT_LEVELS = new Set(["WARN", "DANGER", "COLD", "CRITICAL"]);

// Per-device alert throttle: deviceId → timestamp of last alert (ms).
// Prevents alert storms — at most 1 alert per ALERT_THROTTLE_MS per device.
const ALERT_THROTTLE_MS = 60_000;
const alertThrottle = new Map<string, number>();

// Camera-specific score threshold for raising an alert.
const CAMERA_ALERT_THRESHOLD = 0.75;

interface SensorPayload {
  value: number;
  // Canonical fields
  firmware?: string;     // "person_detection" | "fire_detection" | "zscore_demo" | "smoke_test"
  sensor?: string;       // "camera" | "synthetic"
  label?: string;        // "person" | "fire" | "anomaly" | "normal" | ...
  unit?: string;         // "score" | "z_score" | "r_mean"
  // Fields present in both canonical and legacy
  anomaly?: boolean;
  ts?: number;
  // Legacy fields (monitoring/human branch)
  mean?: number;
  stddev?: number;
  zScore?: number;
  sensorType?: string;   // "IMU" | "HR" | "TEMP"
  level?: string;        // "SAFE" | "WARN" | "DANGER" | "COLD" | "CRITICAL"
  ptiType?: string;      // "FALL" | "MOTIONLESS" | "SOS" — IMU module only
  value2?: number;       // secondary value (e.g. humidity %)
}

/**
 * Normalise any incoming MQTT payload into a SensorPayload.
 *
 * Handles three formats:
 *   1. Canonical (firmware field present) — all ESP32 Sentinelle firmwares
 *   2. Legacy camera (score + label fields) — pre-canonical ESP32-CAM
 *   3. Standard legacy — monitoring/human branch (mean/stddev/zScore required)
 *
 * Returns null if the payload cannot be normalised (missing required fields).
 */
function normalisePayload(raw: Record<string, unknown>): SensorPayload | null {
  // --- 1. Canonical format: firmware field is present ---
  if (typeof raw.firmware === "string") {
    if (typeof raw.value !== "number" || !isFinite(raw.value as number)) return null;
    return {
      firmware: raw.firmware as string,
      sensor:   typeof raw.sensor  === "string"  ? raw.sensor  as string  : undefined,
      label:    typeof raw.label   === "string"  ? raw.label   as string  : undefined,
      unit:     typeof raw.unit    === "string"  ? raw.unit    as string  : undefined,
      value:    raw.value as number,
      anomaly:  typeof raw.anomaly === "boolean" ? raw.anomaly as boolean : false,
      ts:       typeof raw.ts      === "number"  ? raw.ts      as number  : undefined,
      // Defaults for DB fields that require a value
      mean:   0,
      stddev: 0,
      zScore: 0,
    };
  }

  // --- 2. Legacy camera format: score + label (pre-canonical) ---
  if (typeof raw.score === "number" && typeof raw.label === "string") {
    return {
      value:   raw.score as number,
      label:   raw.label as string,
      mean:    0,
      stddev:  1,
      zScore:  0,
      anomaly: (raw.label as string) === "person",
    };
  }

  // --- 3. Standard legacy format: value required, mean/stddev/zScore optional ---
  if (typeof raw.value !== "number" || !isFinite(raw.value as number)) return null;
  return raw as unknown as SensorPayload;
}

interface WebhookPayload {
  deviceId:    string;
  deviceName:  string;
  alertModule: string | null;
  alertLevel:  string | null;
  ptiType:     string | null;
  value:       number;
  zScore:      number;
  timestamp:   string;
}

/**
 * POST the alert to ALERT_WEBHOOK_URL (fire-and-forget, non-blocking).
 * Skips if URL is not configured or level is below the minimum threshold.
 */
function fireWebhook(payload: WebhookPayload): void {
  if (!WEBHOOK_URL) return;

  // Apply minimum level filter
  const rank = payload.alertLevel ? (LEVEL_RANK[payload.alertLevel] ?? 1) : 0;
  if (rank < WEBHOOK_MIN_RANK) return;

  fetch(WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  }).catch((err: unknown) => {
    console.error("[Webhook] POST failed:", err instanceof Error ? err.message : err);
  });
}

let client: mqtt.MqttClient | null = null;

export function startMqttIngestion(): void {
  if (client) return; // already running

  client = mqtt.connect(BROKER_URL, {
    clientId: `fovet-vigie-ingestion-${process.pid}`,
    clean: true,
    reconnectPeriod: 5000,
    ...(process.env.MQTT_USERNAME && {
      username: process.env.MQTT_USERNAME,
      password: process.env.MQTT_PASSWORD,
    }),
  });

  client.on("connect", () => {
    console.log(`[MQTT] Connected to ${BROKER_URL}`);
    client!.subscribe(TOPIC, { qos: 1 }, (err) => {
      if (err) console.error("[MQTT] Subscribe error:", err);
      else console.log(`[MQTT] Subscribed to ${TOPIC}`);
    });
  });

  client.on("message", async (topic, payload) => {
    try {
      // Extract mqttClientId from topic: fovet/devices/<id>/readings
      const parts = topic.split("/");
      const mqttClientId = parts[2];
      if (!mqttClientId || parts.length !== 4) return;

      // Parse and validate payload
      let raw: Record<string, unknown>;
      try {
        raw = JSON.parse(payload.toString());
      } catch {
        console.warn(`[MQTT] Invalid JSON from ${mqttClientId}`);
        return;
      }

      // Normalise payload to SensorPayload (canonical, legacy camera, or legacy standard)
      const norm = normalisePayload(raw);
      if (!norm) {
        console.warn(`[MQTT] Invalid payload fields from ${mqttClientId}`, raw);
        return;
      }
      let data: SensorPayload = norm;

      // Validate primary value
      if (!isFinite(data.value)) {
        console.warn(`[MQTT] Non-finite value from ${mqttClientId}`);
        return;
      }

      // Validate optional legacy numeric fields if present
      if (data.mean   !== undefined && (typeof data.mean   !== "number" || !isFinite(data.mean)))   { data.mean   = 0; }
      if (data.stddev !== undefined && (typeof data.stddev !== "number" || !isFinite(data.stddev) || data.stddev < 0)) { data.stddev = 0; }
      if (data.zScore !== undefined && (typeof data.zScore !== "number" || !isFinite(data.zScore))) { data.zScore  = 0; }

      // Determine if this is a canonical firmware payload (vs legacy)
      const isCanonical = typeof data.firmware === "string";

      // Timestamp: use server time if field is absent or looks like device uptime
      // (device uptime ms is tiny — Unix ms timestamps are > 1 trillion)
      const UNIX_MS_MIN = 1_000_000_000_000;
      const now = Date.now();
      const FIVE_MIN = 5 * 60 * 1000;
      let timestamp: Date;
      if (data.ts !== undefined && typeof data.ts === "number" && data.ts > UNIX_MS_MIN) {
        if (!isFinite(data.ts) || data.ts < now - FIVE_MIN || data.ts > now + FIVE_MIN) {
          // Timestamp looks like a valid Unix ms but is out of range — use server time
          console.warn(`[MQTT] Ignoring out-of-range timestamp from ${mqttClientId}: ${data.ts}, using server time`);
          timestamp = new Date();
        } else {
          timestamp = new Date(data.ts);
        }
      } else {
        // Small value (device uptime) or missing — always use server time
        timestamp = new Date();
      }

      // Lookup device — auto-create if first time seen
      let device = await prisma.device.findUnique({
        where: { mqttClientId },
        select: { id: true, name: true, active: true },
      });
      if (!device) {
        console.log(`[MQTT] Auto-registering new device: ${mqttClientId}`);
        device = await prisma.device.create({
          data: {
            name: mqttClientId,
            mqttClientId,
            active: true,
          },
          select: { id: true, name: true, active: true },
        });
      }
      if (!device.active) return;

      // Validate optional enum fields — reject unknown values to prevent DB pollution
      const VALID_SENSOR_TYPES = new Set(["IMU", "HR", "TEMP"]);
      const VALID_LEVELS        = new Set(["SAFE", "WARN", "DANGER", "COLD", "CRITICAL"]);
      const VALID_PTI_TYPES     = new Set(["FALL", "MOTIONLESS", "SOS"]);

      if (data.sensorType !== undefined && !VALID_SENSOR_TYPES.has(data.sensorType)) {
        console.warn(`[MQTT] Unknown sensorType "${data.sensorType}" from ${mqttClientId} — ignored`);
        data.sensorType = undefined;
      }
      if (data.level !== undefined && !VALID_LEVELS.has(data.level)) {
        console.warn(`[MQTT] Unknown level "${data.level}" from ${mqttClientId} — ignored`);
        data.level = undefined;
      }
      if (data.ptiType !== undefined && !VALID_PTI_TYPES.has(data.ptiType)) {
        console.warn(`[MQTT] Unknown ptiType "${data.ptiType}" from ${mqttClientId} — ignored`);
        data.ptiType = undefined;
      }

      // Validate optional numeric fields
      if (data.value2 !== undefined && (typeof data.value2 !== "number" || !isFinite(data.value2))) {
        console.warn(`[MQTT] Invalid value2 from ${mqttClientId}`);
        return;
      }

      // Persist reading
      const reading = await prisma.reading.create({
        data: {
          deviceId: device.id,
          timestamp,
          value: data.value,
          ...(data.value2 !== undefined && { value2: data.value2 }),
          mean:      data.mean   ?? 0,
          stddev:    data.stddev ?? 0,
          zScore:    data.zScore ?? 0,
          isAnomaly: data.anomaly ?? false,
          ...(data.sensorType && { sensorType: data.sensorType }),
          ...(data.firmware   && { firmware:   data.firmware }),
        },
      });

      // Broadcast to SSE clients
      emitReading(device.id, { ...reading, id: String(reading.id) });

      // Determine whether to create an alert and at what severity:
      //   a) Canonical firmware payload: anomaly=true → WARN (or CRITICAL if value thresholds)
      //   b) Sentinelle profile level (PTI/FATIGUE/THERMAL): WARN/DANGER/COLD/CRITICAL from payload
      //   c) Generic z-score anomaly: derive severity from |zScore|
      let shouldAlert = false;
      let alertLevel: string | null = null;

      if (isCanonical) {
        if (data.anomaly) {
          shouldAlert = true;
          alertLevel  = "WARN";
        }
      } else if (data.level !== undefined && ALERT_LEVELS.has(data.level)) {
        shouldAlert = true;
        alertLevel  = data.level;
      } else if (data.anomaly) {
        shouldAlert = true;
        alertLevel  = Math.abs(data.zScore ?? 0) >= 5 ? "CRITICAL" : "WARN";
      }

      // Throttle: skip if another alert was emitted for this device in the last 60 s
      if (shouldAlert) {
        const lastAlert = alertThrottle.get(device.id) ?? 0;
        if (now - lastAlert < ALERT_THROTTLE_MS) {
          shouldAlert = false;
          console.log(`[MQTT] Alert throttled for ${mqttClientId} (last: ${Math.round((now - lastAlert) / 1000)}s ago)`);
        }
      }

      if (shouldAlert) {
        alertThrottle.set(device.id, now);
        const alertModule = data.sensorType ? ALERT_MODULES[data.sensorType] ?? null : null;
        await prisma.alert.create({
          data: {
            deviceId: device.id,
            timestamp,
            value: data.value,
            zScore: data.zScore ?? 0,
            threshold: isCanonical ? CAMERA_ALERT_THRESHOLD : 3.0,
            ...(alertModule  && { alertModule }),
            ...(alertLevel   && { alertLevel }),
            ...(data.ptiType && { ptiType: data.ptiType }),
          },
        });
        const zStr = (data.zScore ?? 0).toFixed(2);
        console.log(
          `[MQTT] Alert on ${mqttClientId}` +
          (alertModule  ? ` [${alertModule}]`          : "") +
          (data.firmware ? ` fw=${data.firmware}`       : "") +
          ` level=${alertLevel ?? "—"} z=${zStr}`
        );

        fireWebhook({
          deviceId:    device.id,
          deviceName:  device.name,
          alertModule: alertModule,
          alertLevel:  alertLevel,
          ptiType:     data.ptiType ?? null,
          value:       data.value,
          zScore:      data.zScore ?? 0,
          timestamp:   timestamp.toISOString(),
        });
      }
    } catch (err) {
      console.error("[MQTT] Processing error:", err);
    }
  });

  client.on("error", (err) => console.error("[MQTT] Error:", err));
  client.on("disconnect", () => console.warn("[MQTT] Disconnected"));
}

export function stopMqttIngestion(): void {
  client?.end();
  client = null;
}
