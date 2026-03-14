/**
 * Fovet Vigie — MQTT Ingestion Service
 *
 * Subscribes to fovet/devices/+/readings and persists incoming
 * sensor data from Fovet Sentinelle nodes into PostgreSQL.
 *
 * MQTT message format (JSON):
 * {
 *   "value":   1.2345,
 *   "mean":    0.0012,
 *   "stddev":  0.5432,
 *   "zScore":  2.275,
 *   "anomaly": false,
 *   "ts":      1704067200000   // Unix ms (optional, defaults to server time)
 * }
 *
 * Topic pattern: fovet/devices/<mqttClientId>/readings
 */

import mqtt from "mqtt";
import { prisma } from "./prisma";
import { emitReading } from "./event-bus";

const BROKER_URL = process.env.MQTT_BROKER_URL ?? "mqtt://localhost:1883";
const TOPIC = `${process.env.MQTT_TOPIC_PREFIX ?? "fovet/devices"}/+/readings`;

interface SensorPayload {
  value: number;
  mean: number;
  stddev: number;
  zScore: number;
  anomaly: boolean;
  ts?: number;
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
        select: { id: true, active: true },
      });
      if (!device || !device.active) return;

      // Persist reading
      const reading = await prisma.reading.create({
        data: {
          deviceId: device.id,
          timestamp,
          value: data.value,
          mean: data.mean,
          stddev: data.stddev,
          zScore: data.zScore,
          isAnomaly: data.anomaly,
        },
      });

      // Broadcast to SSE clients
      emitReading(device.id, { ...reading, id: String(reading.id) });

      // If anomaly, create alert
      if (data.anomaly) {
        await prisma.alert.create({
          data: {
            deviceId: device.id,
            timestamp,
            value: data.value,
            zScore: data.zScore,
            threshold: 3.0, // TODO: make per-device configurable
          },
        });
        console.log(`[MQTT] Anomaly detected on ${mqttClientId} z=${data.zScore.toFixed(2)}`);
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
