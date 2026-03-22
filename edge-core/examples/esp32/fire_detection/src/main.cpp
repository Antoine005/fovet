/*
 * Fovet SDK — Sentinelle
 * Copyright (C) 2026 Antoine Porte. All rights reserved.
 * LGPL v3 for non-commercial use.
 * Commercial licensing: contact@fovet.eu
 *
 * fire_detection/main.cpp
 * Détection visuelle de feu/fumée via OV2640 + Z-Score temporel.
 *
 * Principe :
 *   Chaque frame RGB565 (QQVGA 160×120) est réduite à 3 scalaires :
 *
 *   R_mean   — canal rouge moyen normalisé [0–255]
 *              Augmente significativement en présence de flamme.
 *
 *   ratio_rb — total_R / (total_G + total_B)   [frame aggregate]
 *              Discrimine flamme (chaud/rouge) vs lumière blanche ambiante.
 *
 *   variance — variance de luminance intra-frame (algorithme de Welford)
 *              La fumée augmente le flou et modifie la texture pixel-à-pixel.
 *
 *   Chaque scalaire est passé dans un FovetZScore indépendant qui modélise
 *   le comportement "normal" de la scène sur les WARMUP_FRAMES premières frames.
 *   Anomalie si au moins un des 3 détecteurs dépasse son seuil.
 *
 * Byte order RGB565 (OV2640 big-endian, high byte first) :
 *   buf[i]   = RRRRRGGG (bits 15-8 du pixel)
 *   buf[i+1] = GGGBBBBB (bits  7-0 du pixel)
 *   pixel = (buf[i]<<8)|buf[i+1]
 *   R = (pixel>>11)&0x1F,  G = (pixel>>5)&0x3F,  B = pixel&0x1F
 *   Si R_mean ne monte pas sur une flamme → swap : pixel = buf[i]|(buf[i+1]<<8)
 *
 * CSV :
 *   frame_id, R_mean, ratio_rb, variance, z_r, z_ratio, z_var, anomaly, event
 *
 * Hardware : ESP32-CAM AI-Thinker, board=esp32dev, CH340 COM4
 * Flash    : pio run -e fire_detection --target upload
 * Monitor  : pio device monitor -e fire_detection  (ouvrir avant RST)
 */

#include "config.h"     /* WiFi/MQTT credentials — DO NOT COMMIT */

extern "C" {
#include "fovet/zscore.h"
#include "fovet/hal/hal_uart.h"
#include "fovet/hal/hal_time.h"
#include "fovet/hal/hal_gpio.h"
}

#include "esp_camera.h"
#include <Arduino.h>
#include <WiFi.h>
#include <PubSubClient.h>
#include <math.h>
#include <stdio.h>

/* -------------------------------------------------------------------------
 * AI-Thinker ESP32-CAM pinout
 * ------------------------------------------------------------------------- */

#define CAM_PIN_PWDN     32
#define CAM_PIN_RESET    -1
#define CAM_PIN_XCLK      0
#define CAM_PIN_SIOD     26
#define CAM_PIN_SIOC     27
#define CAM_PIN_D7       35
#define CAM_PIN_D6       34
#define CAM_PIN_D5       39
#define CAM_PIN_D4       36
#define CAM_PIN_D3       21
#define CAM_PIN_D2       19
#define CAM_PIN_D1       18
#define CAM_PIN_D0        5
#define CAM_PIN_VSYNC    25
#define CAM_PIN_HREF     23
#define CAM_PIN_PCLK     22

/* LED flash GPIO4 active LOW (transistor entre GPIO4 et la LED) */
#define LED_PIN           4U

/* -------------------------------------------------------------------------
 * Paramètres de détection
 * ------------------------------------------------------------------------- */

#define ZSCORE_THRESHOLD  3.0f   /* seuil en sigmas */
#define WARMUP_FRAMES    30U     /* frames de calibration */
#define CAPTURE_MS       200U    /* 5 fps */

/* -------------------------------------------------------------------------
 * Globals
 * ------------------------------------------------------------------------- */

static FovetZScore g_zs_r;       /* suivi R_mean   inter-frames */
static FovetZScore g_zs_ratio;   /* suivi ratio_rb inter-frames */
static FovetZScore g_zs_var;     /* suivi variance inter-frames */

static uint32_t    g_frame_id = 0;
static char        g_buf[256];

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

static void mqtt_ensure_connected(void)
{
    static uint32_t last_attempt_ms = 0;
    if (g_mqtt.connected()) return;
    if (WiFi.status() != WL_CONNECTED) return;

    uint32_t now = hal_time_ms();
    if ((now - last_attempt_ms) < 5000U) return;
    last_attempt_ms = now;

    if (g_mqtt.connect(DEVICE_ID, MQTT_USER, MQTT_PASSWORD)) {
        hal_uart_print("[MQTT] Connected\r\n");
    } else {
        snprintf(g_buf, sizeof(g_buf),
                 "[MQTT] Failed, rc=%d — will retry\r\n", g_mqtt.state());
        hal_uart_print(g_buf);
    }
}

static void mqtt_publish(float r_mean, bool anomaly)
{
    if (!g_mqtt.connected()) return;

    const char *label = anomaly ? "fire" : "normal";

    snprintf(g_buf, sizeof(g_buf),
             "{"
             "\"device_id\":\"%s\","
             "\"firmware\":\"fire_detection\","
             "\"sensor\":\"camera\","
             "\"value\":%.2f,"
             "\"label\":\"%s\","
             "\"unit\":\"r_mean\","
             "\"anomaly\":%s,"
             "\"ts\":%lu"
             "}",
             DEVICE_ID,
             r_mean,
             label,
             anomaly ? "true" : "false",
             (unsigned long)hal_time_ms());

    char topic[64];
    snprintf(topic, sizeof(topic), "fovet/devices/%s/readings", DEVICE_ID);
    g_mqtt.publish(topic, g_buf);
}

/* -------------------------------------------------------------------------
 * Initialisation caméra
 * ------------------------------------------------------------------------- */

static bool camera_init(void)
{
    camera_config_t cfg = {};

    cfg.ledc_channel = LEDC_CHANNEL_0;
    cfg.ledc_timer   = LEDC_TIMER_0;
    cfg.pin_d0       = CAM_PIN_D0;
    cfg.pin_d1       = CAM_PIN_D1;
    cfg.pin_d2       = CAM_PIN_D2;
    cfg.pin_d3       = CAM_PIN_D3;
    cfg.pin_d4       = CAM_PIN_D4;
    cfg.pin_d5       = CAM_PIN_D5;
    cfg.pin_d6       = CAM_PIN_D6;
    cfg.pin_d7       = CAM_PIN_D7;
    cfg.pin_xclk     = CAM_PIN_XCLK;
    cfg.pin_pclk     = CAM_PIN_PCLK;
    cfg.pin_vsync    = CAM_PIN_VSYNC;
    cfg.pin_href     = CAM_PIN_HREF;
    cfg.pin_sccb_sda = CAM_PIN_SIOD;   /* SCCB = Serial Camera Control Bus (I2C-like) */
    cfg.pin_sccb_scl = CAM_PIN_SIOC;
    cfg.pin_pwdn     = CAM_PIN_PWDN;
    cfg.pin_reset    = CAM_PIN_RESET;

    cfg.xclk_freq_hz = 20000000;
    cfg.pixel_format = PIXFORMAT_RGB565;

    /* QQVGA = 160×120 = 19 200 pixels = 38 400 octets en RGB565.
     * Tient dans la DRAM interne (320 KB) sans PSRAM. */
    cfg.frame_size   = FRAMESIZE_QQVGA;
    cfg.jpeg_quality = 12;
    cfg.fb_count     = 1;

    /* Alloue le frame buffer en DRAM (pas PSRAM) — compatible board=esp32dev.
     * Si le champ fb_location n'existe pas (esp32-camera < v2), retirer ces
     * deux lignes : sans PSRAM initialisée, la lib alloue en DRAM par défaut. */
    cfg.fb_location  = CAMERA_FB_IN_DRAM;
    cfg.grab_mode    = CAMERA_GRAB_WHEN_EMPTY;

    esp_err_t err = esp_camera_init(&cfg);
    if (err != ESP_OK) {
        snprintf(g_buf, sizeof(g_buf),
                 "[CAM] esp_camera_init failed: 0x%04x\r\n", (unsigned)err);
        hal_uart_print(g_buf);
        return false;
    }

    /* AEC + AWB auto : adapte l'exposition à la luminosité de la scène */
    sensor_t *s = esp_camera_sensor_get();
    if (s) {
        s->set_exposure_ctrl(s, 1);
        s->set_awb_gain(s, 1);
        s->set_brightness(s, 0);
        s->set_contrast(s, 0);
        s->set_saturation(s, 0);
    }

    hal_uart_print("[CAM] OV2640 init OK — QQVGA RGB565 @ 5 fps\r\n");
    return true;
}

/* -------------------------------------------------------------------------
 * Extraction des 3 métriques depuis un frame RGB565
 *
 * Layout big-endian OV2640 :  buf[i]=RRRRRGGG, buf[i+1]=GGGBBBBB
 * pixel = (buf[i]<<8)|buf[i+1]
 * R = (pixel>>11)&0x1F  [0–31]  → normalisé [0–255] : R*255/31
 * G = (pixel>> 5)&0x3F  [0–63]  → normalisé [0–255] : G*255/63
 * B =  pixel    &0x1F   [0–31]  → normalisé [0–255] : B*255/31
 * ------------------------------------------------------------------------- */

static void extract_metrics(const uint8_t *buf, size_t len,
                             float *out_r_mean,
                             float *out_ratio_rb,
                             float *out_variance)
{
    float sum_R = 0.0f, sum_GB = 0.0f;

    /* Welford en ligne pour la variance de luminance intra-frame */
    float wf_mean = 0.0f, wf_M2 = 0.0f;
    uint32_t n = 0;

    for (size_t i = 0; i + 1 < len; i += 2) {
        uint16_t pixel = ((uint16_t)buf[i] << 8) | buf[i + 1];

        float R = (float)((pixel >> 11) & 0x1F) * (255.0f / 31.0f);
        float G = (float)((pixel >>  5) & 0x3F) * (255.0f / 63.0f);
        float B = (float)( pixel        & 0x1F) * (255.0f / 31.0f);

        sum_R  += R;
        sum_GB += G + B;

        /* Luminance BT.601 pour la variance */
        float lum    = 0.299f * R + 0.587f * G + 0.114f * B;
        n++;
        float delta  = lum - wf_mean;
        wf_mean     += delta / (float)n;
        wf_M2       += delta * (lum - wf_mean);
    }

    if (n == 0) {
        *out_r_mean = *out_ratio_rb = *out_variance = 0.0f;
        return;
    }

    *out_r_mean   = sum_R / (float)n;
    *out_ratio_rb = sum_R / (sum_GB + 1.0f);           /* +1 : évite /0 */
    *out_variance = (n > 1) ? (wf_M2 / (float)(n - 1)) : 0.0f;
}

/* -------------------------------------------------------------------------
 * Arduino entry points
 * ------------------------------------------------------------------------- */

void setup(void)
{
    hal_uart_init(115200);
    hal_delay_ms(2000);   /* CH340 enumération + moniteur ready */

    hal_gpio_set_mode(LED_PIN, HAL_GPIO_MODE_OUTPUT);
    hal_gpio_write(LED_PIN, HAL_GPIO_HIGH);  /* LED off (active LOW) */

    /* Tentative d'init PSRAM sous notre contrôle (pas dans le bootloader).
     * Si ça échoue, le programme continue en DRAM uniquement — pas de crash. */
    if (psramFound()) {
        hal_uart_print("[PSRAM] détectée et initialisée\r\n");
    } else {
        hal_uart_print("[PSRAM] non détectée — frame buffer en DRAM (QQVGA OK)\r\n");
    }

    /* 3 détecteurs indépendants, warm-up WARMUP_FRAMES frames chacun */
    fovet_zscore_init(&g_zs_r,     ZSCORE_THRESHOLD, WARMUP_FRAMES);
    fovet_zscore_init(&g_zs_ratio, ZSCORE_THRESHOLD, WARMUP_FRAMES);
    fovet_zscore_init(&g_zs_var,   ZSCORE_THRESHOLD, WARMUP_FRAMES);

    hal_uart_print("\r\n=== Fovet Sentinelle — Fire/Smoke Detection ===\r\n");
    hal_uart_print("Camera  : OV2640 QQVGA RGB565 @ 5 fps\r\n");
    hal_uart_print("Metrics : R_mean, ratio_R/(G+B), luminance variance\r\n");
    snprintf(g_buf, sizeof(g_buf),
             "Warmup  : %u frames | Threshold : %.1f sigma\r\n",
             WARMUP_FRAMES, ZSCORE_THRESHOLD);
    hal_uart_print(g_buf);
    hal_uart_print("Events  : <FLAME>=R+ratio | <HIGH_RED>=R seul | "
                   "<RED_RATIO>=ratio seul | <SMOKE>=variance\r\n");
    hal_uart_print("CSV     : frame_id,R_mean,ratio_rb,variance,"
                   "z_r,z_ratio,z_var,anomaly,event\r\n\r\n");

    if (!camera_init()) {
        hal_uart_print("[FATAL] Camera init failed — halting.\r\n");
        while (1) { hal_delay_ms(1000); }
    }

    /* Drainer 5 frames : laisser AEC/AWB converger avant la calibration */
    wifi_connect();
    g_mqtt.setServer(MQTT_BROKER, MQTT_PORT);
    g_mqtt.setKeepAlive(30);
    mqtt_ensure_connected();

    hal_uart_print("[CAM] AEC/AWB stabilisation (5 frames)...\r\n");
    for (int i = 0; i < 5; i++) {
        camera_fb_t *fb = esp_camera_fb_get();
        if (fb) esp_camera_fb_return(fb);
        hal_delay_ms(150);
    }
    hal_uart_print("[CAM] Pret. Calibration en cours...\r\n\r\n");
}

void loop(void)
{
    static uint32_t last_ms = 0;
    uint32_t now = hal_time_ms();

    g_mqtt.loop();
    mqtt_ensure_connected();

    if ((now - last_ms) < CAPTURE_MS) return;
    last_ms = now;

    /* --- Capture ---------------------------------------------------------- */

    camera_fb_t *fb = esp_camera_fb_get();
    if (!fb) {
        hal_uart_print("[CAM] Capture failed\r\n");
        return;
    }

    /* --- Extraction des métriques ----------------------------------------- */

    float r_mean, ratio_rb, variance;
    extract_metrics(fb->buf, fb->len, &r_mean, &ratio_rb, &variance);
    esp_camera_fb_return(fb);

    /* --- Détection Z-Score ------------------------------------------------ */

    bool anom_r     = fovet_zscore_update(&g_zs_r,     r_mean);
    bool anom_ratio = fovet_zscore_update(&g_zs_ratio, ratio_rb);
    bool anom_var   = fovet_zscore_update(&g_zs_var,   variance);
    bool anomaly    = anom_r || anom_ratio || anom_var;

    /* Z-scores pour affichage (post-update — valeurs cohérentes avec le détecteur) */
    float sd_r     = fovet_zscore_get_stddev(&g_zs_r);
    float sd_ratio = fovet_zscore_get_stddev(&g_zs_ratio);
    float sd_var   = fovet_zscore_get_stddev(&g_zs_var);

    float z_r     = (sd_r     > 1e-6f) ? (r_mean   - fovet_zscore_get_mean(&g_zs_r))     / sd_r     : 0.0f;
    float z_ratio = (sd_ratio > 1e-6f) ? (ratio_rb - fovet_zscore_get_mean(&g_zs_ratio)) / sd_ratio : 0.0f;
    float z_var   = (sd_var   > 1e-6f) ? (variance - fovet_zscore_get_mean(&g_zs_var))   / sd_var   : 0.0f;

    /* --- LED -------------------------------------------------------------- */

    hal_gpio_write(LED_PIN, anomaly ? HAL_GPIO_LOW : HAL_GPIO_HIGH);

    /* --- Label d'événement ------------------------------------------------ */

    const char *event = "";
    if      (anom_r && anom_ratio) event = "<FLAME>";
    else if (anom_r)               event = "<HIGH_RED>";
    else if (anom_ratio)           event = "<RED_RATIO>";
    else if (anom_var)             event = "<SMOKE/BLUR>";

    /* --- CSV -------------------------------------------------------------- */

    snprintf(g_buf, sizeof(g_buf),
             "%lu,%.2f,%.4f,%.2f,%.3f,%.3f,%.3f,%d,%s\r\n",
             (unsigned long)g_frame_id,
             r_mean, ratio_rb, variance,
             z_r, z_ratio, z_var,
             (int)anomaly, event);
    hal_uart_print(g_buf);

    mqtt_publish(r_mean, anomaly);

    g_frame_id++;
}
