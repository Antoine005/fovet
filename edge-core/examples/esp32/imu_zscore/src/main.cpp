/*
 * Fovet SDK — Sentinelle
 * Copyright (C) 2026 Antoine Porte. All rights reserved.
 * LGPL v3 for non-commercial use.
 * Commercial licensing: contact@fovet.eu
 *
 * IMU Z-Score Demo — MPU-6050 → ESP32-CAM → MQTT → Vigie
 *
 * Reads accelerometer magnitude (|a| = sqrt(x²+y²+z²)) from an MPU-6050
 * via I2C and runs a Z-Score anomaly detector on the signal.
 *
 * At rest on a flat surface: magnitude ≈ 1.0g (gravity).
 * A fall, shake, or impact produces a spike above the threshold.
 *
 * Wiring (ESP32-CAM external sensor header):
 *   MPU-6050 VCC → 3.3V
 *   MPU-6050 GND → GND
 *   MPU-6050 SDA → GPIO13
 *   MPU-6050 SCL → GPIO14
 *   MPU-6050 AD0 → GND  (I2C address = 0x68)
 *
 * Prerequisites:
 *   1. Copy src/config.h.example to src/config.h and fill in credentials.
 *   2. Register the device: POST /api/devices { mqttClientId: "esp32-cam-001" }
 *   3. Mosquitto listener must bind 0.0.0.0 for LAN access.
 *
 * MQTT topic : fovet/devices/<DEVICE_ID>/readings
 * Serial     : 115200 baud — CSV: index,x,y,z,magnitude,zscore,anomaly
 */

#include "config.h"               /* WiFi/MQTT credentials — DO NOT COMMIT */
#include "fovet_model_manifest.h" /* Forge-generated model metadata         */

extern "C" {
#include "fovet/zscore.h"
#include "fovet/hal/hal_uart.h"
#include "fovet/hal/hal_time.h"
#include "fovet/hal/hal_gpio.h"
#include "fovet/hal/hal_i2c.h"
#include "fovet/drivers/mpu6050.h"
}

#include <Arduino.h>
#include <WiFi.h>
#include <PubSubClient.h>
#include <math.h>
#include <stdio.h>

/* -------------------------------------------------------------------------
 * Constants
 * ------------------------------------------------------------------------- */

#define LED_PIN               4        /* ESP32-CAM onboard LED (active LOW) */

/* I2C bus — ESP32-CAM external sensor header */
#define I2C_SDA_PIN           13
#define I2C_SCL_PIN           14
#define I2C_FREQ_HZ           400000U  /* Fast-mode I2C */

/* MPU-6050 */
#define IMU_ADDR              MPU6050_ADDR_DEFAULT   /* AD0=GND → 0x68 */
#define IMU_RANGE             MPU6050_RANGE_4G       /* ±4g for motion/fall */
#define SAMPLE_PERIOD_MS      20U                    /* 50 Hz sampling      */

/* Z-Score detector */
#define ZSCORE_THRESHOLD      3.0f    /* sigma threshold */
#define ZSCORE_MIN_SAMPLES    30U     /* warm-up before detecting */

/* MQTT */
#define MQTT_PUBLISH_EVERY    5U      /* publish every N samples (50Hz → 10Hz) */
#define MQTT_RECONNECT_MS     5000U

/* -------------------------------------------------------------------------
 * Globals
 * ------------------------------------------------------------------------- */

static FovetZScore  g_zscore;
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

static void mqtt_publish_reading(float magnitude, float zscore_val, bool anomaly)
{
    if (!g_mqtt.connected()) return;

    const char *label = anomaly
        ? FOVET_MODEL_LABEL_ANOMALY
        : FOVET_MODEL_LABEL_NORMAL;

    int len = snprintf(g_log_buf, sizeof(g_log_buf),
        "{"
        "\"device_id\":\"%s\","
        "\"model_id\":\"" FOVET_MODEL_ID "\","
        "\"firmware\":\"imu_zscore\","
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
        magnitude,
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

    /* I2C bus */
    hal_i2c_init(I2C_SDA_PIN, I2C_SCL_PIN, I2C_FREQ_HZ);
    hal_delay_ms(100); /* allow MPU-6050 to stabilise after power-on */

    /* MPU-6050 */
    hal_uart_print("[IMU] Initialising MPU-6050...\r\n");
    if (!mpu6050_init(IMU_ADDR, IMU_RANGE)) {
        hal_uart_print("[IMU] ERROR — MPU-6050 not found on I2C bus.\r\n");
        hal_uart_print("      Check wiring: SDA=GPIO13, SCL=GPIO14, VCC=3.3V, AD0=GND\r\n");
        /* Continue without IMU — will send zeroes */
    } else {
        hal_uart_print("[IMU] MPU-6050 OK — range ±4g\r\n");
    }

    /* Z-Score detector on acceleration magnitude */
    fovet_zscore_init(&g_zscore, ZSCORE_THRESHOLD, ZSCORE_MIN_SAMPLES);

    hal_uart_print("\r\n=== Fovet Sentinelle — IMU Z-Score Demo ===\r\n");
    hal_uart_print("Device : " DEVICE_ID "\r\n");
    hal_uart_print("Sensor : MPU-6050 ±4g @ 50 Hz — SDA=GPIO13 SCL=GPIO14\r\n");
    hal_uart_print("Signal : acceleration magnitude |a| in g\r\n");
    hal_uart_print("At rest: magnitude ≈ 1.0g (gravity)\r\n");
    hal_uart_print("Anomaly: spike detected when |z| > 3σ\r\n");
    hal_uart_print("CSV    : index,x,y,z,magnitude,zscore,anomaly\r\n\r\n");

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
    uint32_t        now            = hal_time_ms();

    g_mqtt.loop();
    mqtt_ensure_connected();

    if ((now - last_sample_ms) < SAMPLE_PERIOD_MS) return;
    last_sample_ms = now;

    /* --- Read accelerometer ------------------------------------------------ */

    mpu6050_accel_t accel = {0};
    (void)mpu6050_read_accel(IMU_ADDR, &accel);

    /* Use magnitude as the anomaly detection signal.
     * At rest on a flat surface: magnitude ≈ 1.0g (gravity).
     * A shake, fall, or impact produces a spike well above 1.0g. */
    float magnitude = accel.magnitude;

    /* --- Run Z-Score detector --------------------------------------------- */

    bool  anomaly    = fovet_zscore_update(&g_zscore, magnitude);
    float mean       = fovet_zscore_get_mean(&g_zscore);
    float stddev     = fovet_zscore_get_stddev(&g_zscore);
    float zscore_val = (stddev > 0.0f) ? ((magnitude - mean) / stddev) : 0.0f;

    /* --- LED feedback ----------------------------------------------------- */

    hal_gpio_write(LED_PIN, anomaly ? HAL_GPIO_LOW : HAL_GPIO_HIGH);

    /* --- Serial log (CSV) ------------------------------------------------- */

    snprintf(g_log_buf, sizeof(g_log_buf),
             "%lu,%.3f,%.3f,%.3f,%.3f,%.3f,%d\r\n",
             (unsigned long)g_sample_index,
             accel.x, accel.y, accel.z, magnitude, zscore_val,
             (int)anomaly);
    hal_uart_print(g_log_buf);

    /* --- MQTT publish at reduced rate ------------------------------------- */

    if ((g_sample_index % MQTT_PUBLISH_EVERY) == 0U) {
        mqtt_publish_reading(magnitude, zscore_val, anomaly);
    }

    g_sample_index++;
}
