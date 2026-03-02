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
      if (!mqttClientId) return;

      const data: SensorPayload = JSON.parse(payload.toString());

      // Lookup device
      const device = await prisma.device.findUnique({
        where: { mqttClientId },
        select: { id: true, active: true },
      });
      if (!device || !device.active) return;

      const timestamp = data.ts ? new Date(data.ts) : new Date();

      // Persist reading
      await prisma.reading.create({
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
