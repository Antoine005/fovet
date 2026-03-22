/*
 * Fovet SDK — Sentinelle
 * Copyright (C) 2026 Antoine Porte. All rights reserved.
 * LGPL v3 for non-commercial use.
 * Commercial licensing: contact@fovet.eu
 *
 * Demo: Z-Score + EWMA Drift detection on ESP32-CAM with MQTT publishing.
 *
 * Two complementary detectors run in parallel:
 *
 *   FovetZScore  — catches sudden spikes (5-sigma, injected every 200 samples)
 *   FovetDrift   — catches slow baseline shifts (ramp +0.05/sample injected
 *                  every 600 samples over 100 samples) that Welford absorbs
 *
 * This demonstrates why both detectors are needed:
 *   - Z-Score misses gradual drift absorbed by the running mean
 *   - Drift misses isolated spikes that don't move the EWMAs
 *
 * Prerequisites:
 *   1. Copy src/config.h.example to src/config.h and fill in credentials.
 *   2. Register the device: POST /api/devices { mqttClientId: "esp32-cam-001" }
 *   3. Mosquitto listener must bind 0.0.0.0 (not localhost) for LAN access.
 *
 * MQTT topic: fovet/devices/<DEVICE_ID>/readings
 * Serial monitor: 115200 baud
 * Serial format: index,value,mean,stddev,drift_mag,spike,drift,event
 */

#include "config.h"              /* WiFi/MQTT credentials — DO NOT COMMIT */
#include "fovet_model_manifest.h" /* Forge-generated model metadata       */

extern "C" {
#include "fovet/zscore.h"
#include "fovet/drift.h"
#include "fovet/hal/hal_uart.h"
#include "fovet/hal/hal_time.h"
#include "fovet/hal/hal_gpio.h"
}

#include <Arduino.h>
#include <WiFi.h>
#include <PubSubClient.h>
#include <math.h>
#include <stdio.h>

/* -------------------------------------------------------------------------
 * Constants
 * ------------------------------------------------------------------------- */

#define LED_PIN               4        /* ESP32-CAM onboard LED (active LOW)   */
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

/* -------------------------------------------------------------------------
 * Globals
 * ------------------------------------------------------------------------- */

static FovetZScore  g_zscore;
static FovetDrift   g_drift;
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
    WiFi.begin(WIFI_SSID, WIFI_PASSWORD);

    uint32_t start = hal_time_ms();
    while (WiFi.status() != WL_CONNECTED) {
        if ((hal_time_ms() - start) > 15000U) {
            hal_uart_print("[WiFi] Timeout — continuing without network\r\n");
            return;
        }
        hal_delay_ms(500);
        hal_uart_print(".");
    }
    hal_uart_print("\r\n[WiFi] Connected, IP: ");
    hal_uart_print(WiFi.localIP().toString().c_str());
    hal_uart_print("\r\n");
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

static void mqtt_publish_reading(float zscore_val, bool spike, bool drift_alert)
{
    if (!g_mqtt.connected()) return;

    bool        anomaly = spike || drift_alert;
    const char *label   = anomaly ? "anomaly" : "normal";

    int len = snprintf(g_log_buf, sizeof(g_log_buf),
        "{"
        "\"device_id\":\"%s\","
        "\"model_id\":\"" FOVET_MODEL_ID "\","
        "\"firmware\":\"zscore_demo\","
        "\"sensor\":\"" FOVET_MODEL_SENSOR "\","
        "\"value\":%.4f,"
        "\"value_min\":%.4f,"
        "\"value_max\":%.4f,"
        "\"label\":\"%s\","
        "\"unit\":\"" FOVET_MODEL_UNIT "\","
        "\"anomaly\":%s,"
        "\"ts\":%lu"
        "}",
        DEVICE_ID,
        zscore_val,
        (double)FOVET_MODEL_VALUE_MIN,
        (double)FOVET_MODEL_VALUE_MAX,
        label,
        anomaly ? "true" : "false",
        (unsigned long)hal_time_ms());

    char topic[64];
    snprintf(topic, sizeof(topic), "fovet/devices/%s/readings", DEVICE_ID);

    if (!g_mqtt.publish(topic, g_log_buf, (unsigned int)len)) {
        hal_uart_print("[MQTT] Publish failed\r\n");
    }
}

/* -------------------------------------------------------------------------
 * Setup
 * ------------------------------------------------------------------------- */

void setup(void)
{
    hal_uart_init(115200);
    hal_gpio_set_mode(LED_PIN, HAL_GPIO_MODE_OUTPUT);
    hal_gpio_write(LED_PIN, HAL_GPIO_HIGH); /* LED off (active LOW) */

    /* Z-Score: 3-sigma threshold, warm-up 30 samples */
    fovet_zscore_init(&g_zscore, ZSCORE_THRESHOLD, ZSCORE_MIN_SAMPLES);

    /* EWMA Drift: fast/slow EWMA, alert when gap exceeds DRIFT_THRESHOLD */
    fovet_drift_init(&g_drift, DRIFT_ALPHA_FAST, DRIFT_ALPHA_SLOW, DRIFT_THRESHOLD);

    hal_uart_print("\r\n=== Fovet Sentinelle — Z-Score + Drift Demo ===\r\n");
    hal_uart_print("Device: " DEVICE_ID "\r\n");
    hal_uart_print("Signal : sine 1 Hz @ 100 Hz\r\n");
    hal_uart_print("Spikes : 5-sigma every 200 samples  → Z-Score detects\r\n");
    hal_uart_print("Ramps  : +0.05/sample over 100s every 600 samples → Drift detects\r\n");
    hal_uart_print("CSV    : index,value,mean,stddev,drift_mag,spike,drift,event\r\n\r\n");

    wifi_connect();
    g_mqtt.setServer(MQTT_BROKER, MQTT_PORT);
    g_mqtt.setKeepAlive(30);
    mqtt_ensure_connected();
}

/* -------------------------------------------------------------------------
 * Loop
 * ------------------------------------------------------------------------- */

void loop(void)
{
    static uint32_t last_sample_ms  = 0;
    static float    ramp_offset     = 0.0f; /* accumulates slow drift */
    uint32_t        now             = hal_time_ms();

    g_mqtt.loop();
    mqtt_ensure_connected();

    if ((now - last_sample_ms) < SAMPLE_PERIOD_MS) return;
    last_sample_ms = now;

    /* --- Signal synthesis ------------------------------------------------ */

    float t      = (float)g_sample_index * 0.01f;         /* time (seconds)  */
    float signal = sinf(2.0f * (float)M_PI * 1.0f * t);   /* 1 Hz sine       */
    signal += ramp_offset;

    const char *event_tag = "";

    /* Inject sudden spike: Z-Score should catch, Drift should NOT */
    bool spike_injected = false;
    if (g_sample_index > ZSCORE_MIN_SAMPLES
        && (g_sample_index % SPIKE_EVERY) == 0U) {
        float spike_amp = fovet_zscore_get_mean(&g_zscore)
                        + 5.0f * fovet_zscore_get_stddev(&g_zscore)
                        + 1.0f;
        signal        += spike_amp;
        spike_injected = true;
        event_tag      = " <SPIKE>";
    }

    /* Inject slow ramp: Drift should catch, Z-Score will absorb */
    uint32_t phase = g_sample_index % RAMP_EVERY;
    if (phase < RAMP_DURATION && g_sample_index >= RAMP_EVERY) {
        ramp_offset += RAMP_STEP;
        if (event_tag[0] == '\0') event_tag = " <RAMP>";
    } else if (phase == RAMP_DURATION) {
        /* Reset ramp_offset so the next window starts from baseline */
        ramp_offset = 0.0f;
    }

    /* --- Run detectors --------------------------------------------------- */

    bool  spike_detected = fovet_zscore_update(&g_zscore, signal);
    bool  drift_detected = fovet_drift_update(&g_drift, signal);

    float mean       = fovet_zscore_get_mean(&g_zscore);
    float stddev     = fovet_zscore_get_stddev(&g_zscore);
    float zscore_val = (stddev > 0.0f)
                     ? ((signal - mean) / stddev)
                     : 0.0f;
    float drift_mag  = fovet_drift_get_magnitude(&g_drift);

    /* --- LED feedback ---------------------------------------------------- */

    /* Blink on any detection (active LOW) */
    bool alert = spike_detected || drift_detected;
    hal_gpio_write(LED_PIN, alert ? HAL_GPIO_LOW : HAL_GPIO_HIGH);

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
        mqtt_publish_reading(zscore_val, spike_detected, drift_detected);
    }

    g_sample_index++;
}
