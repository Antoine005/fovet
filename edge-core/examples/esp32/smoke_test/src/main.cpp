/*
 * Fovet SDK — Sentinelle
 * Copyright (C) 2026 Antoine Porte. All rights reserved.
 * LGPL v3 for non-commercial use.
 * Commercial licensing: contact@fovet.eu
 *
 * smoke_test/main.cpp — SDK smoke test : Z-Score sur sinus synthétique.
 *
 * Validé sur ESP32-CAM (AI-Thinker) avec adaptateur CH340 (COM4).
 * Compilé avec board=esp32dev — voir CLAUDE.md "Hardware gotchas".
 *
 * Comportement :
 *   - 100 Hz : lit un sinus 1 Hz synthétique, passe dans fovet_zscore_update()
 *   - Toutes les 200 samples : injection alternée ±5σ → détection + LED
 *   - Warm-up 30 samples : pas de détection pendant la calibration
 *   - CSV sur UART : idx,value,mean,stddev,zscore,anomaly,event
 *
 * Résultat attendu (extrait) :
 *   0,0.0000,0.0000,0.0000,0.0000,0,
 *   ...
 *   200,<spike>,<mean>,<stddev>,<z>,1,<+5SIGMA>
 *   ...
 *
 * Flash:   pio run -e smoke --target upload
 * Monitor: pio device monitor -e smoke   (ouvrir avant RST)
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
 * Hardware — board=esp32dev physiquement sur ESP32-CAM AI-Thinker
 * LED flash (GPIO4) : transistor entre GPIO4 et la LED, active LOW.
 * ------------------------------------------------------------------------- */

#define LED_PIN           4U

/* -------------------------------------------------------------------------
 * Detector
 * ------------------------------------------------------------------------- */

#define ZSCORE_THRESHOLD  3.0f
#define ZSCORE_MIN_SAMP   30U
#define SAMPLE_PERIOD_MS  10U   /* 100 Hz */
#define SPIKE_EVERY       200U

/* -------------------------------------------------------------------------
 * Globals
 * ------------------------------------------------------------------------- */

static FovetZScore  g_zscore;
static uint32_t     g_idx = 0;
static char         g_buf[192];

static WiFiClient   g_wifi_client;
static PubSubClient g_mqtt(g_wifi_client);

/* -------------------------------------------------------------------------
 * WiFi + MQTT helpers
 * ------------------------------------------------------------------------- */

static void wifi_connect(void)
{
    hal_uart_print("[WiFi] Connecting to " WIFI_SSID " ...\r\n");
    WiFi.mode(WIFI_STA);
    WiFi.begin(WIFI_SSID, WIFI_PASSWORD);

    uint32_t start = hal_time_ms();
    while (WiFi.status() != WL_CONNECTED) {
        if ((hal_time_ms() - start) > 15000U) {
            hal_uart_print("[WiFi] Timeout — UART only\r\n");
            return;
        }
        hal_delay_ms(500);
        hal_uart_print(".");
    }
    hal_uart_print("\r\n[WiFi] Connected\r\n");
}

static void mqtt_ensure_connected(void)
{
    static uint32_t last_ms = 0;
    if (g_mqtt.connected()) return;
    if (WiFi.status() != WL_CONNECTED) return;
    if ((hal_time_ms() - last_ms) < 5000U) return;
    last_ms = hal_time_ms();
    g_mqtt.connect(DEVICE_ID, MQTT_USER, MQTT_PASSWORD);
}

static void mqtt_publish(float z_score)
{
    if (!g_mqtt.connected()) return;

    snprintf(g_buf, sizeof(g_buf),
             "{"
             "\"device_id\":\"%s\","
             "\"firmware\":\"smoke_test\","
             "\"sensor\":\"synthetic\","
             "\"value\":%.4f,"
             "\"ts\":%lu"
             "}",
             DEVICE_ID,
             z_score,
             (unsigned long)hal_time_ms());

    char topic[64];
    snprintf(topic, sizeof(topic), "fovet/devices/%s/readings", DEVICE_ID);
    g_mqtt.publish(topic, g_buf);
}

/* -------------------------------------------------------------------------
 * Arduino entry points
 * ------------------------------------------------------------------------- */

void setup(void)
{
    hal_uart_init(115200);

    /* 2 s : CH340 enumeration + moniteur ready avant le premier print.
     * Avec monitor_rts=0/dtr=0 dans platformio.ini, le moniteur n'envoie
     * pas de reset — ouvrir le moniteur AVANT de presser RST. */
    hal_delay_ms(2000);

    hal_gpio_set_mode(LED_PIN, HAL_GPIO_MODE_OUTPUT);
    hal_gpio_write(LED_PIN, HAL_GPIO_HIGH); /* LED off (active LOW) */

    fovet_zscore_init(&g_zscore, ZSCORE_THRESHOLD, ZSCORE_MIN_SAMP);

    wifi_connect();
    g_mqtt.setServer(MQTT_BROKER, MQTT_PORT);
    g_mqtt.setKeepAlive(30);
    mqtt_ensure_connected();

    hal_uart_print("\r\n=== Fovet Sentinelle — Smoke Test ===\r\n");
    hal_uart_print("board  : esp32dev (CH340 COM4 115200)\r\n");
    hal_uart_print("signal : sinus 1 Hz @ 100 Hz\r\n");
    hal_uart_print("spikes : +-5sigma toutes les 200 samples\r\n");
    hal_uart_print("CSV    : idx,value,mean,stddev,zscore,anomaly,event\r\n\r\n");
}

void loop(void)
{
    static uint32_t last_ms = 0;
    uint32_t now = hal_time_ms();

    g_mqtt.loop();
    mqtt_ensure_connected();

    if ((now - last_ms) < SAMPLE_PERIOD_MS) return;
    last_ms = now;

    /* --- Signal synthétique : sinus 1 Hz --------------------------------- */

    float t      = (float)g_idx * (SAMPLE_PERIOD_MS * 0.001f);
    float sample = sinf(2.0f * (float)M_PI * 1.0f * t);

    const char *event = "";

    /* Injection ±5σ alternée après warm-up */
    if (g_idx >= ZSCORE_MIN_SAMP && (g_idx % SPIKE_EVERY) == 0U) {
        float mean   = fovet_zscore_get_mean(&g_zscore);
        float stddev = fovet_zscore_get_stddev(&g_zscore);
        float amp    = 5.0f * stddev + 0.1f;
        bool  pos    = (g_idx / SPIKE_EVERY % 2U) == 0U;
        sample += pos ? amp : -amp;
        event   = pos ? "<+5SIGMA>" : "<-5SIGMA>";
    }

    /* --- Détecteur -------------------------------------------------------- */

    bool anomaly = fovet_zscore_update(&g_zscore, sample);
    float mean   = fovet_zscore_get_mean(&g_zscore);
    float stddev = fovet_zscore_get_stddev(&g_zscore);
    float z      = (stddev > 1e-6f) ? ((sample - mean) / stddev) : 0.0f;

    /* --- LED -------------------------------------------------------------- */

    hal_gpio_write(LED_PIN, anomaly ? HAL_GPIO_LOW : HAL_GPIO_HIGH);

    /* --- CSV sur UART ----------------------------------------------------- */

    snprintf(g_buf, sizeof(g_buf),
             "%lu,%.4f,%.4f,%.4f,%.4f,%d,%s\r\n",
             (unsigned long)g_idx,
             sample, mean, stddev, z,
             (int)anomaly, event);
    hal_uart_print(g_buf);

    mqtt_publish(z);

    g_idx++;
}
