/*
 * Ardent SDK — Pulse
 * Copyright (C) 2026 Antoine Porte. All rights reserved.
 * LGPL v3 for non-commercial use.
 * Commercial licensing: contact@ardent-ai.fr
 *
 * Demo: Z-Score + EWMA Drift detection on ESP32-CAM with MQTT publishing.
 *
 * Two complementary detectors run in parallel:
 *
 *   ArdentZScore — catches sudden spikes (5-sigma, injected every 200 samples)
 *   ArdentDrift  — catches slow baseline shifts (ramp +0.05/sample injected
 *                  every 600 samples over 100 samples) that Welford absorbs
 *
 * Prerequisites:
 *   1. Copy src/config.h.example to src/config.h and fill in credentials.
 *   2. Register the device: POST /api/devices { mqttClientId: "esp32-cam-001" }
 *   3. Mosquitto listener must bind 0.0.0.0 (not localhost) for LAN access.
 *
 * MQTT topic: ardent/devices/<DEVICE_ID>/readings
 * Serial monitor: 115200 baud
 * Serial format: index,value,mean,stddev,drift_mag,spike,drift,event
 */

#include "config.h"              /* WiFi/MQTT credentials — DO NOT COMMIT */
#include "ard_model_manifest.h" /* Forge-generated model metadata       */

extern "C" {
#include "ardent/zscore.h"
#include "ardent/drift.h"
#include "ardent/hal/hal_uart.h"
#include "ardent/hal/hal_time.h"
}

#include <Arduino.h>
#include <WiFi.h>
#include <PubSubClient.h>
#include <math.h>
#include <stdio.h>

/* -------------------------------------------------------------------------
 * Constants
 * ------------------------------------------------------------------------- */

#define SAMPLE_PERIOD_MS      10U      /* 100 Hz sampling                       */

/* Z-Score detector */
#define ZSCORE_THRESHOLD      3.0f
#define ZSCORE_MIN_SAMPLES    30U
#define SPIKE_EVERY           200U     /* Inject sudden spike every N samples   */

/* EWMA Drift detector */
#define DRIFT_ALPHA_FAST      0.10f    /* ~10 sample memory                     */
#define DRIFT_ALPHA_SLOW      0.01f    /* ~100 sample memory (baseline)         */
#define DRIFT_THRESHOLD       0.30f    /* Alert when |fast - slow| > 0.30 units */
#define RAMP_EVERY            600U     /* Inject slow ramp every N samples      */
#define RAMP_DURATION         100U     /* Ramp lasts this many samples          */
#define RAMP_STEP             0.05f    /* Signal shift per sample during ramp   */

/* MQTT */
#define MQTT_PUBLISH_EVERY    10U      /* Publish every N samples (10 Hz → 1 Hz)*/
#define MQTT_RECONNECT_MS     5000U
#define WIFI_RECONNECT_MS     10000U  /* Try WiFi reconnect every 10s if lost   */

/* -------------------------------------------------------------------------
 * Globals
 * ------------------------------------------------------------------------- */

static ArdentZScore g_zscore;
static ArdentDrift  g_drift;
static uint32_t     g_sample_index = 0;
static char         g_log_buf[384];

static WiFiClient   g_wifi_client;
static PubSubClient g_mqtt(g_wifi_client);

/* -------------------------------------------------------------------------
 * WiFi helpers
 * ------------------------------------------------------------------------- */

static void wifi_connect(void)
{
    hal_uart_print("[WiFi] Connecting to " WIFI_SSID " ...\r\n");
    WiFi.mode(WIFI_STA);
    WiFi.setAutoReconnect(true);   /* kernel-level reconnect on drop */
    WiFi.begin(WIFI_SSID, WIFI_PASSWORD);

    uint32_t start = hal_time_ms();
    while (WiFi.status() != WL_CONNECTED) {
        if ((hal_time_ms() - start) > 15000U) {
            hal_uart_print("[WiFi] Timeout — will retry in loop\r\n");
            return;
        }
        hal_delay_ms(500);
        hal_uart_print(".");
    }
    hal_uart_print("\r\n[WiFi] Connected, IP: ");
    hal_uart_print(WiFi.localIP().toString().c_str());
    hal_uart_print("\r\n");
}

static void wifi_ensure_connected(void)
{
    static uint32_t last_wifi_attempt_ms = 0;
    if (WiFi.status() == WL_CONNECTED) return;

    uint32_t now = hal_time_ms();
    if ((now - last_wifi_attempt_ms) < WIFI_RECONNECT_MS) return;
    last_wifi_attempt_ms = now;

    hal_uart_print("[WiFi] Reconnecting...\r\n");
    WiFi.disconnect(false);
    WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
}

/* -------------------------------------------------------------------------
 * MQTT helpers
 * ------------------------------------------------------------------------- */

static void mqtt_ensure_connected(void)
{
    static uint32_t last_attempt_ms = 0;
    if (g_mqtt.connected()) return;
    if (WiFi.status() != WL_CONNECTED) return;

    uint32_t now = hal_time_ms();
    if ((now - last_attempt_ms) < MQTT_RECONNECT_MS) return;
    last_attempt_ms = now;

    hal_uart_print("[MQTT] Connecting to broker...\r\n");
    if (g_mqtt.connect(DEVICE_ID, MQTT_USER, MQTT_PASSWORD)) {
        hal_uart_print("[MQTT] Connected\r\n");
    } else {
        snprintf(g_log_buf, sizeof(g_log_buf),
                 "[MQTT] Failed, rc=%d — will retry\r\n", g_mqtt.state());
        hal_uart_print(g_log_buf);
    }
}

static void mqtt_publish_reading(float value, float mean, float stddev,
                                  float zscore_val, float drift_mag,
                                  bool spike, bool drift_alert)
{
    if (!g_mqtt.connected()) return;

    bool anomaly = spike || drift_alert;
    const char *label = anomaly ? ARD_MODEL_LABEL_ANOMALY : ARD_MODEL_LABEL_NORMAL;

    int len = snprintf(g_log_buf, sizeof(g_log_buf),
        "{"
        "\"device_id\":\"%s\","
        "\"model_id\":\"" ARD_MODEL_ID "\","
        "\"firmware\":\"zscore_demo\","
        "\"sensor\":\"" ARD_MODEL_SENSOR "\","
        "\"value\":%.4f,"
        "\"value_min\":%.4f,"
        "\"value_max\":%.4f,"
        "\"label\":\"%s\","
        "\"unit\":\"" ARD_MODEL_UNIT "\","
        "\"anomaly\":%s,"
        "\"ts\":%lu"
        "}",
        DEVICE_ID,
        (double)zscore_val,
        (double)ARD_MODEL_VALUE_MIN,
        (double)ARD_MODEL_VALUE_MAX,
        label,
        anomaly ? "true" : "false",
        (unsigned long)hal_time_ms());

    char topic[64];
    snprintf(topic, sizeof(topic), "ardent/devices/%s/readings", DEVICE_ID);

    if (!g_mqtt.publish(topic, g_log_buf, (unsigned int)len)) {
        hal_uart_print("[MQTT] Publish failed\r\n");
    }

    (void)value; (void)mean; (void)stddev; (void)drift_mag;
}

/* -------------------------------------------------------------------------
 * Setup
 * ------------------------------------------------------------------------- */

void setup(void)
{
    hal_uart_init(115200);

    ard_zscore_init(&g_zscore, ZSCORE_THRESHOLD, ZSCORE_MIN_SAMPLES);
    ard_drift_init(&g_drift, DRIFT_ALPHA_FAST, DRIFT_ALPHA_SLOW, DRIFT_THRESHOLD);

    hal_uart_print("\r\n=== Ardent Pulse — Z-Score + Drift Demo ===\r\n");
    hal_uart_print("Device: " DEVICE_ID "\r\n");
    hal_uart_print("Signal : sine 1 Hz @ 100 Hz\r\n");
    hal_uart_print("Spikes : 5-sigma every 200 samples  → Z-Score detects\r\n");
    hal_uart_print("Ramps  : +0.05/sample over 100s every 600 samples → Drift detects\r\n");
    hal_uart_print("CSV    : index,value,mean,stddev,drift_mag,spike,drift,event\r\n\r\n");

    wifi_connect();
    g_mqtt.setServer(MQTT_BROKER, MQTT_PORT);
    g_mqtt.setKeepAlive(60);       /* 60s keep-alive — more robust on flaky WiFi */
    g_mqtt.setSocketTimeout(15);   /* 15s socket timeout                         */
    g_mqtt.setBufferSize(512);     /* default 256 too small for canonical payload */
    mqtt_ensure_connected();
}

/* -------------------------------------------------------------------------
 * Loop
 * ------------------------------------------------------------------------- */

void loop(void)
{
    static uint32_t last_sample_ms  = 0;
    static float    ramp_offset     = 0.0f;
    uint32_t        now             = hal_time_ms();

    wifi_ensure_connected();
    g_mqtt.loop();
    mqtt_ensure_connected();

    if ((now - last_sample_ms) < SAMPLE_PERIOD_MS) return;
    last_sample_ms = now;

    /* --- Signal synthesis ------------------------------------------------ */

    float t      = (float)g_sample_index * 0.01f;
    float signal = sinf(2.0f * (float)M_PI * 1.0f * t);
    signal += ramp_offset;

    const char *event_tag = "";

    bool spike_injected = false;
    if (g_sample_index > ZSCORE_MIN_SAMPLES
        && (g_sample_index % SPIKE_EVERY) == 0U) {
        float spike_amp = ard_zscore_get_mean(&g_zscore)
                        + 5.0f * ard_zscore_get_stddev(&g_zscore)
                        + 1.0f;
        signal        += spike_amp;
        spike_injected = true;
        event_tag      = " <SPIKE>";
    }

    uint32_t phase = g_sample_index % RAMP_EVERY;
    if (phase < RAMP_DURATION && g_sample_index >= RAMP_EVERY) {
        ramp_offset += RAMP_STEP;
        if (event_tag[0] == '\0') event_tag = " <RAMP>";
    } else if (phase == RAMP_DURATION) {
        ramp_offset = 0.0f;
    }

    /* --- Run detectors --------------------------------------------------- */

    bool  spike_detected = ard_zscore_update(&g_zscore, signal);
    bool  drift_detected = ard_drift_update(&g_drift, signal);

    float mean       = ard_zscore_get_mean(&g_zscore);
    float stddev     = ard_zscore_get_stddev(&g_zscore);
    float zscore_val = (stddev > 0.0f) ? ((signal - mean) / stddev) : 0.0f;
    float drift_mag  = ard_drift_get_magnitude(&g_drift);

    /* --- Serial log (CSV) ------------------------------------------------ */

    snprintf(g_log_buf, sizeof(g_log_buf),
             "%lu,%.4f,%.4f,%.4f,%.4f,%d,%d%s\r\n",
             (unsigned long)g_sample_index,
             signal, mean, stddev, drift_mag,
             (int)spike_detected, (int)drift_detected,
             event_tag);
    hal_uart_print(g_log_buf);

    /* --- MQTT publish at reduced rate ------------------------------------ */

    if ((g_sample_index % MQTT_PUBLISH_EVERY) == 0U) {
        mqtt_publish_reading(signal, mean, stddev, zscore_val,
                             drift_mag, spike_detected, drift_detected);
    }

    g_sample_index++;
    (void)spike_injected;
}
