/*
 * Fovet SDK — Sentinelle
 * Copyright (C) 2026 Antoine Porte. All rights reserved.
 * LGPL v3 for non-commercial use.
 * Commercial licensing: contact@fovet.eu
 *
 * Demo: Z-Score anomaly detection on ESP32-CAM with MQTT publishing.
 *
 * Generates a synthetic sine wave sampled at ~100 Hz, injects a 5-sigma
 * spike every 200 samples to validate the detector, and publishes readings
 * to the Fovet Vigie dashboard via MQTT.
 *
 * Prerequisites:
 *   1. Copy src/config.h.example to src/config.h and fill in credentials.
 *   2. Register the device: POST /api/devices { mqttClientId: "esp32-cam-001" }
 *   3. Mosquitto listener must bind 0.0.0.0 (not localhost) for LAN access.
 *
 * MQTT topic: fovet/devices/<DEVICE_ID>/readings
 * Serial monitor: 115200 baud
 */

#include "config.h"     /* WiFi/MQTT credentials — DO NOT COMMIT */

extern "C" {
#include "fovet/zscore.h"
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

#define LED_PIN           4       /* ESP32-CAM onboard LED (active LOW) */
#define SAMPLE_PERIOD_MS  10U    /* 100 Hz sampling */
#define ANOMALY_EVERY     200U   /* Inject spike every N samples */
#define ZSCORE_THRESHOLD  3.0f
#define MQTT_PUBLISH_EVERY 10U   /* Publish every N samples (10 Hz → 1 Hz MQTT) */
#define MQTT_RECONNECT_MS 5000U  /* Retry interval for WiFi/MQTT reconnects */

/* -------------------------------------------------------------------------
 * Globals
 * ------------------------------------------------------------------------- */

static FovetZScore g_detector;
static uint32_t    g_sample_index = 0;
static char        g_log_buf[192];

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

static void mqtt_publish_reading(float value, float mean, float stddev,
                                  float zscore, bool anomaly)
{
    if (!g_mqtt.connected()) return;

    /* JSON payload — format expected by mqtt-ingestion.ts */
    int len = snprintf(g_log_buf, sizeof(g_log_buf),
        "{\"value\":%.4f,\"mean\":%.4f,\"stddev\":%.4f,"
        "\"zScore\":%.4f,\"anomaly\":%s}",
        value, mean, stddev, zscore, anomaly ? "true" : "false");

    char topic[64];
    snprintf(topic, sizeof(topic), "fovet/devices/%s/readings", DEVICE_ID);

    if (g_mqtt.publish(topic, g_log_buf, (unsigned int)len)) {
        /* success — silent to avoid flooding serial */
    } else {
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

    fovet_zscore_init(&g_detector, ZSCORE_THRESHOLD);

    hal_uart_print("\r\n=== Fovet Sentinelle — Z-Score + MQTT Demo ===\r\n");
    hal_uart_print("Device: " DEVICE_ID "\r\n");
    hal_uart_print("Signal: sine wave 1 Hz @ 100 Hz, anomaly every 200 samples\r\n");
    hal_uart_print("Serial format: index,value,mean,stddev,anomaly\r\n\r\n");

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
    static uint32_t last_sample_ms = 0;
    uint32_t now = hal_time_ms();

    /* Keep MQTT alive */
    g_mqtt.loop();
    mqtt_ensure_connected();

    if ((now - last_sample_ms) < SAMPLE_PERIOD_MS) {
        return;
    }
    last_sample_ms = now;

    /* Generate synthetic signal (1 Hz sine) */
    float t      = (float)g_sample_index * 0.01f;
    float signal = sinf(2.0f * (float)M_PI * 1.0f * t);

    /* Inject 5-sigma spike every ANOMALY_EVERY samples (after warm-up) */
    bool injected = false;
    if (g_sample_index > 50U && (g_sample_index % ANOMALY_EVERY) == 0U) {
        float spike = fovet_zscore_get_mean(&g_detector)
                    + 5.0f * fovet_zscore_get_stddev(&g_detector)
                    + 1.0f;
        signal  += spike;
        injected = true;
    }

    /* Run detector */
    bool anomaly = fovet_zscore_update(&g_detector, signal);
    float mean   = fovet_zscore_get_mean(&g_detector);
    float stddev = fovet_zscore_get_stddev(&g_detector);
    float zscore = (stddev > 0.0f) ? ((signal - mean) / stddev) : 0.0f;

    /* Blink LED on anomaly (active LOW) */
    hal_gpio_write(LED_PIN, anomaly ? HAL_GPIO_LOW : HAL_GPIO_HIGH);

    /* Serial log (CSV) */
    snprintf(g_log_buf, sizeof(g_log_buf),
             "%lu,%.4f,%.4f,%.4f,%d%s\r\n",
             (unsigned long)g_sample_index,
             signal, mean, stddev, (int)anomaly,
             injected ? " <-- INJECTED" : "");
    hal_uart_print(g_log_buf);

    /* MQTT publish at reduced rate */
    if ((g_sample_index % MQTT_PUBLISH_EVERY) == 0U) {
        mqtt_publish_reading(signal, mean, stddev, zscore, anomaly);
    }

    g_sample_index++;
}
