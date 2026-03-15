/**
 * Fovet Vigie — MQTT Ingestion Service
 *
 * Subscribes to fovet/devices/+/readings and persists incoming
 * sensor data from Fovet Sentinelle nodes into PostgreSQL.
 *
 * MQTT message format (JSON):
 * {
 *   "value":      1.2345,
 *   "mean":       0.0012,
 *   "stddev":     0.5432,
 *   "zScore":     2.275,
 *   "anomaly":    false,
 *   "ts":         1704067200000,   // Unix ms (optional, defaults to server time)
 *   "sensorType": "TEMP",          // optional: "IMU" | "HR" | "TEMP"
 *   "level":      "WARN",          // optional: "SAFE" | "WARN" | "DANGER" | "COLD" | "CRITICAL"
 *   "value2":     65.0             // optional: secondary value (e.g. humidity % for TEMP)
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
const LEVEL_RANK: Record<string, number> = { WARN: 1, COLD: 1, DANGER: 2, CRITICAL: 3 };
const WEBHOOK_MIN_RANK = WEBHOOK_MIN === "ALL" ? 0 : (LEVEL_RANK[WEBHOOK_MIN] ?? 2);

// Modules that produce alerts beyond z-score anomalies
const ALERT_MODULES: Record<string, string> = {
  IMU:  "PTI",
  HR:   "FATIGUE",
  TEMP: "THERMAL",
};

// Levels that trigger an Alert record (in addition to z-score anomalies)
const ALERT_LEVELS = new Set(["WARN", "DANGER", "COLD", "CRITICAL"]);

interface SensorPayload {
  value: number;
  mean: number;
  stddev: number;
  zScore: number;
  anomaly: boolean;
  ts?: number;
  sensorType?: string;   // "IMU" | "HR" | "TEMP"
  level?: string;        // "SAFE" | "WARN" | "DANGER" | "COLD" | "CRITICAL"
  ptiType?: string;      // "FALL" | "MOTIONLESS" | "SOS" — IMU module only
  value2?: number;       // secondary value (e.g. humidity %)
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
      let data: SensorPayload;
      try {
        data = JSON.parse(payload.toString());
      } catch {
        console.warn(`[MQTT] Invalid JSON from ${mqttClientId}`);
        return;
      }

      if (
        typeof data.value !== "number" || !isFinite(data.value) ||
        typeof data.mean !== "number" || !isFinite(data.mean) ||
        typeof data.stddev !== "number" || !isFinite(data.stddev) || data.stddev < 0 ||
        typeof data.zScore !== "number" || !isFinite(data.zScore) ||
        typeof data.anomaly !== "boolean"
      ) {
        console.warn(`[MQTT] Invalid payload fields from ${mqttClientId}`);
        return;
      }

      // Constrain timestamp to ±5 minutes from server time
      const now = Date.now();
      const FIVE_MIN = 5 * 60 * 1000;
      let timestamp: Date;
      if (data.ts !== undefined) {
        if (typeof data.ts !== "number" || !isFinite(data.ts) ||
            data.ts < now - FIVE_MIN || data.ts > now + FIVE_MIN) {
          console.warn(`[MQTT] Rejected timestamp from ${mqttClientId}: ${data.ts}`);
          return;
        }
        timestamp = new Date(data.ts);
      } else {
        timestamp = new Date();
      }

      // Lookup device
      const device = await prisma.device.findUnique({
        where: { mqttClientId },
        select: { id: true, name: true, active: true },
      });
      if (!device || !device.active) return;

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
          mean: data.mean,
          stddev: data.stddev,
          zScore: data.zScore,
          isAnomaly: data.anomaly,
          ...(data.sensorType && { sensorType: data.sensorType }),
        },
      });

      // Broadcast to SSE clients
      emitReading(device.id, { ...reading, id: String(reading.id) });

      // Create alert when:
      //   a) legacy z-score anomaly (anomaly: true), OR
      //   b) Sentinelle profile level requires attention (WARN/DANGER/COLD/CRITICAL)
      const shouldAlert =
        data.anomaly ||
        (data.level !== undefined && ALERT_LEVELS.has(data.level));

      if (shouldAlert) {
        const alertModule = data.sensorType ? ALERT_MODULES[data.sensorType] ?? null : null;
        await prisma.alert.create({
          data: {
            deviceId: device.id,
            timestamp,
            value: data.value,
            zScore: data.zScore,
            threshold: 3.0,
            ...(alertModule && { alertModule }),
            ...(data.level   && { alertLevel: data.level }),
            ...(data.ptiType && { ptiType: data.ptiType }),
          },
        });
        console.log(
          `[MQTT] Alert on ${mqttClientId}` +
          (alertModule ? ` [${alertModule}]` : "") +
          (data.level ? ` level=${data.level}` : ` z=${data.zScore.toFixed(2)}`)
        );

        fireWebhook({
          deviceId:    device.id,
          deviceName:  device.name,
          alertModule: alertModule,
          alertLevel:  data.level   ?? null,
          ptiType:     data.ptiType ?? null,
          value:       data.value,
          zScore:      data.zScore,
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
