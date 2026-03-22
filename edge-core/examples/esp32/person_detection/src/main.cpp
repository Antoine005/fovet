/*
 * Fovet SDK — Sentinelle
 * Copyright (C) 2026 Antoine Porte. All rights reserved.
 * LGPL v3 for non-commercial use.
 * Commercial licensing: contact@fovet.eu
 *
 * person_detection/src/main.cpp
 * Visual Wake Words — détection de personne via TFLite Micro + OV2640 + Z-Score.
 *
 * Modèle : person_detect (MobileNetV1 0.25×, Visual Wake Words)
 *   Input  : 96×96×1 grayscale, int8 [-128, 127]
 *   Output : 2 scores int8 — index 0 = no_person, index 1 = person
 *   Taille : ~300 KB stockés en flash
 *
 * Pipeline :
 *   OV2640 GRAYSCALE 96×96 ──► TFLite Micro ──► person_score
 *                                                     │
 *                                               FovetZScore ──► MQTT → Vigie
 *
 * Le FovetZScore modélise le score "personne" sur les WARMUP_FRAMES premières
 * inférences (scène vide) et signale une anomalie lorsque le score dépasse
 * ZSCORE_THRESHOLD sigmas — i.e., une personne entre dans le champ.
 *
 * MQTT topic : fovet/devices/<DEVICE_ID>/readings
 * Payload (format canonique multi-modèle) :
 *   { "device_id": "esp32cam_001", "firmware": "person_detection",
 *     "sensor": "camera", "value": 0.87, "label": "person",
 *     "unit": "score", "anomaly": true, "ts": 1700000000000 }
 *
 * CSV UART (115200) :
 *   frame_id, person_score, no_person_score, z_score, anomaly, mean, stddev
 *
 * Prérequis :
 *   1. Copier config.h.example → config.h et remplir credentials
 *   2. cp .pio/libdeps/person_detection/TensorFlowLite_ESP32/examples/person_detection/person_detect_model_data.cpp src/model_data.cpp
 *   3. pio run -e person_detection --target upload
 *
 * Hardware : ESP32-CAM AI-Thinker, board=esp32dev, CH340 COM4
 */

#include "config.h"
#include "fovet_model_manifest.h" /* Forge-generated model metadata */

/* --- TFLite Micro (ESP32 port) ------------------------------------------- */
#include <TensorFlowLite_ESP32.h>
#include "tensorflow/lite/micro/all_ops_resolver.h"
#include "tensorflow/lite/micro/micro_error_reporter.h"
#include "tensorflow/lite/micro/micro_interpreter.h"
#include "tensorflow/lite/schema/schema_generated.h"

/* --- ESP32 heap (pour heap_caps_malloc) ----------------------------------- */
#include "esp_heap_caps.h"

/* --- Fovet SDK ----------------------------------------------------------- */
extern "C" {
#include "fovet/zscore.h"
#include "fovet/hal/hal_uart.h"
#include "fovet/hal/hal_gpio.h"
#include "fovet/hal/hal_time.h"
}

/* --- Modèle bundlé (copié depuis TensorFlowLite_ESP32 lib) ---------------- */
#include "model_data.h"

/* --- ESP32 / Arduino ----------------------------------------------------- */
#include "esp_camera.h"
#include <Arduino.h>
#include <WiFi.h>
#include <PubSubClient.h>

/* =========================================================================
 * Pinout AI-Thinker ESP32-CAM
 * ========================================================================= */

#define CAM_PIN_PWDN   32
#define CAM_PIN_RESET  -1
#define CAM_PIN_XCLK    0
#define CAM_PIN_SIOD   26
#define CAM_PIN_SIOC   27
#define CAM_PIN_D7     35
#define CAM_PIN_D6     34
#define CAM_PIN_D5     39
#define CAM_PIN_D4     36
#define CAM_PIN_D3     21
#define CAM_PIN_D2     19
#define CAM_PIN_D1     18
#define CAM_PIN_D0      5
#define CAM_PIN_VSYNC  25
#define CAM_PIN_HREF   23
#define CAM_PIN_PCLK   22

/* LED flash GPIO4, active LOW (transistor inverseur sur ESP32-CAM) */
#define LED_PIN  4U

/* =========================================================================
 * Paramètres de détection
 * ========================================================================= */

/* Indices de sortie du modèle */
static constexpr int kNoPersonIndex = 0;
static constexpr int kPersonIndex   = 1;

/* Warmup : nombre d'inférences pour calibrer le Z-Score (scène vide) */
static constexpr uint32_t WARMUP_FRAMES   = 30U;

/* Seuil Z-Score pour déclencher l'anomalie "personne détectée" */
static constexpr float ZSCORE_THRESHOLD   = 3.0f;

/* Intervalle d'inférence en ms (~5 fps) */
static constexpr uint32_t INFERENCE_MS    = 200U;

/* =========================================================================
 * TFLite Micro — arena allouée sur le heap interne au démarrage.
 *
 * Une allocation statique tensor_arena[100KB] en BSS ferait déborder le
 * segment DRAM à l'édition de liens (DRAM 320 KB - WiFi/BT ~150 KB ≈ 170 KB
 * disponibles, mais le linker rejette si BSS dépasse la réservation statique).
 * La solution est heap_caps_malloc avec MALLOC_CAP_INTERNAL au setup(),
 * identique à l'exemple officiel TensorFlowLite_ESP32.
 * ========================================================================= */
static constexpr int kTensorArenaSize = 100 * 1024;
static uint8_t      *tensor_arena     = nullptr;  /* alloué dans tflite_init() */

/* =========================================================================
 * Globals
 * ========================================================================= */

static tflite::MicroErrorReporter  micro_error_reporter;
static tflite::AllOpsResolver       resolver;
static tflite::MicroInterpreter    *interpreter   = nullptr;
static TfLiteTensor                *input_tensor  = nullptr;
static TfLiteTensor                *output_tensor = nullptr;

static FovetZScore  g_zs_person;   /* suivi temporel du score "personne" */

static WiFiClient   wifi_client;
static PubSubClient mqtt_client(wifi_client);

static uint32_t g_frame_id = 0U;
static char     g_buf[384];

/* =========================================================================
 * Caméra : OV2640, GRAYSCALE, 96×96 — DRAM uniquement
 * ========================================================================= */

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
    cfg.pin_sccb_sda = CAM_PIN_SIOD;
    cfg.pin_sccb_scl = CAM_PIN_SIOC;
    cfg.pin_pwdn     = CAM_PIN_PWDN;
    cfg.pin_reset    = CAM_PIN_RESET;

    cfg.xclk_freq_hz = 20000000;
    cfg.pixel_format = PIXFORMAT_GRAYSCALE;
    cfg.frame_size   = FRAMESIZE_96X96;
    cfg.jpeg_quality = 12;
    cfg.fb_count     = 1;
    cfg.fb_location  = CAMERA_FB_IN_DRAM;
    cfg.grab_mode    = CAMERA_GRAB_WHEN_EMPTY;

    esp_err_t err = esp_camera_init(&cfg);
    if (err != ESP_OK) {
        snprintf(g_buf, sizeof(g_buf),
                 "[CAM] esp_camera_init failed: 0x%04x\r\n", (unsigned)err);
        hal_uart_print(g_buf);
        return false;
    }

    sensor_t *s = esp_camera_sensor_get();
    if (s) {
        s->set_exposure_ctrl(s, 1);
        s->set_awb_gain(s, 1);
        s->set_brightness(s, 0);
        s->set_contrast(s, 0);
    }

    hal_uart_print("[CAM] OV2640 GRAYSCALE 96x96 OK\r\n");
    return true;
}

/* =========================================================================
 * TFLite Micro : chargement du modèle et allocation des tenseurs
 * ========================================================================= */

static bool tflite_init(void)
{
    /* Allocation de l'arena sur le heap interne (évite le débordement BSS). */
    tensor_arena = (uint8_t *)heap_caps_malloc(
        kTensorArenaSize, MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT);
    if (!tensor_arena) {
        hal_uart_print("[TFL] heap_caps_malloc failed — DRAM insuffisante\r\n");
        return false;
    }

    const tflite::Model *model = tflite::GetModel(g_person_detect_model_data);
    if (model->version() != TFLITE_SCHEMA_VERSION) {
        snprintf(g_buf, sizeof(g_buf),
                 "[TFL] Schema version mismatch: got %lu, expected %d\r\n",
                 (unsigned long)model->version(), TFLITE_SCHEMA_VERSION);
        hal_uart_print(g_buf);
        return false;
    }

    static tflite::MicroInterpreter static_interpreter(
        model, resolver, tensor_arena, kTensorArenaSize, &micro_error_reporter);
    interpreter = &static_interpreter;

    TfLiteStatus status = interpreter->AllocateTensors();
    if (status != kTfLiteOk) {
        snprintf(g_buf, sizeof(g_buf),
                 "[TFL] AllocateTensors() failed (arena trop petit ? actual=%u)\r\n",
                 (unsigned)interpreter->arena_used_bytes());
        hal_uart_print(g_buf);
        return false;
    }

    input_tensor  = interpreter->input(0);
    output_tensor = interpreter->output(0);

    snprintf(g_buf, sizeof(g_buf),
             "[TFL] OK — arena utilisee: %u / %u octets\r\n",
             (unsigned)interpreter->arena_used_bytes(), kTensorArenaSize);
    hal_uart_print(g_buf);

    if (input_tensor->dims->size != 4 ||
        input_tensor->dims->data[1] != 96 ||
        input_tensor->dims->data[2] != 96 ||
        input_tensor->dims->data[3] != 1) {
        hal_uart_print("[TFL] Dimensions d'entree inattendues (attendu 1x96x96x1)\r\n");
        return false;
    }
    if (input_tensor->type != kTfLiteInt8) {
        hal_uart_print("[TFL] Type d'entree inattendu (attendu int8)\r\n");
        return false;
    }

    return true;
}

/* =========================================================================
 * WiFi
 * ========================================================================= */

static bool wifi_connect(void)
{
    WiFi.mode(WIFI_STA);
    WiFi.disconnect(true);
    hal_delay_ms(100);

    WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
    hal_uart_print("[WiFi] Connexion");

    uint32_t t0 = hal_time_ms();
    while (WiFi.status() != WL_CONNECTED) {
        if ((hal_time_ms() - t0) > 30000U) {
            hal_uart_print("\r\n[WiFi] TIMEOUT — mode UART seul\r\n");
            return false;
        }
        hal_delay_ms(500);
        hal_uart_print(".");
    }

    snprintf(g_buf, sizeof(g_buf),
             "\r\n[WiFi] Connecte — IP : %s\r\n",
             WiFi.localIP().toString().c_str());
    hal_uart_print(g_buf);
    return true;
}

/* =========================================================================
 * MQTT
 * ========================================================================= */

static bool mqtt_connect(void)
{
    mqtt_client.setServer(MQTT_BROKER, MQTT_PORT);
    mqtt_client.setKeepAlive(30);

    snprintf(g_buf, sizeof(g_buf), "[MQTT] Connexion a %s:%d...\r\n",
             MQTT_BROKER, MQTT_PORT);
    hal_uart_print(g_buf);

    if (mqtt_client.connect(DEVICE_ID, MQTT_USER, MQTT_PASSWORD)) {
        hal_uart_print("[MQTT] Connecte\r\n");
        return true;
    }

    snprintf(g_buf, sizeof(g_buf),
             "[MQTT] Echec (state=%d) — mode UART seul\r\n",
             mqtt_client.state());
    hal_uart_print(g_buf);
    return false;
}

static void mqtt_ensure_connected(void)
{
    if (!mqtt_client.connected()) {
        uint32_t t0 = hal_time_ms();
        while (!mqtt_client.connected() && (hal_time_ms() - t0) < 5000U) {
            if (mqtt_client.connect(DEVICE_ID, MQTT_USER, MQTT_PASSWORD)) {
                hal_uart_print("[MQTT] Reconnecte\r\n");
            } else {
                hal_delay_ms(1000);
            }
        }
    }
}

/* =========================================================================
 * Publication MQTT → Vigie
 * ========================================================================= */

static void mqtt_publish(float person_score)
{
    if (!mqtt_client.connected()) return;

    bool        anomaly = person_score > 0.75f;
    const char *label   = anomaly ? "person" : "no_person";

    snprintf(g_buf, sizeof(g_buf),
             "{"
             "\"device_id\":\"%s\","
             "\"model_id\":\"" FOVET_MODEL_ID "\","
             "\"firmware\":\"person_detection\","
             "\"sensor\":\"" FOVET_MODEL_SENSOR "\","
             "\"value\":%.3f,"
             "\"value_min\":%.3f,"
             "\"value_max\":%.3f,"
             "\"label\":\"%s\","
             "\"unit\":\"" FOVET_MODEL_UNIT "\","
             "\"anomaly\":%s,"
             "\"ts\":%lu"
             "}",
             DEVICE_ID,
             person_score,
             (double)FOVET_MODEL_VALUE_MIN,
             (double)FOVET_MODEL_VALUE_MAX,
             label,
             anomaly ? "true" : "false",
             (unsigned long)hal_time_ms());

    char topic[64];
    snprintf(topic, sizeof(topic), "fovet/devices/%s/readings", DEVICE_ID);
    mqtt_client.publish(topic, g_buf);
}

/* =========================================================================
 * Inférence TFLite
 * ========================================================================= */

static bool run_inference(const uint8_t *frame_buf, size_t len,
                          float *out_person, float *out_no_person)
{
    if (len < 96U * 96U) {
        hal_uart_print("[INF] Frame trop courte\r\n");
        return false;
    }

    int8_t *dst = input_tensor->data.int8;
    for (int i = 0; i < 96 * 96; i++) {
        dst[i] = (int8_t)((int16_t)frame_buf[i] - 128);
    }

    TfLiteStatus status = interpreter->Invoke();
    if (status != kTfLiteOk) {
        hal_uart_print("[INF] Invoke() failed\r\n");
        return false;
    }

    const float scale      = output_tensor->params.scale;
    const int   zero_point = output_tensor->params.zero_point;
    int8_t *out = output_tensor->data.int8;

    *out_no_person = (out[kNoPersonIndex] - zero_point) * scale;
    *out_person    = (out[kPersonIndex]   - zero_point) * scale;

    if (*out_person    < 0.0f) *out_person    = 0.0f;
    if (*out_person    > 1.0f) *out_person    = 1.0f;
    if (*out_no_person < 0.0f) *out_no_person = 0.0f;
    if (*out_no_person > 1.0f) *out_no_person = 1.0f;

    return true;
}

/* =========================================================================
 * setup()
 * ========================================================================= */

void setup(void)
{
    hal_uart_init(115200);
    hal_delay_ms(2000);

    hal_gpio_set_mode(LED_PIN, HAL_GPIO_MODE_OUTPUT);
    hal_gpio_write(LED_PIN, HAL_GPIO_HIGH);

    hal_uart_print("\r\n");
    hal_uart_print("[Fovet] Person Detection — TFLite Micro + Z-Score\r\n\r\n");

    /* WiFi must connect before TFLite allocates its 100 KB arena from DRAM.
     * The WiFi stack needs ~60-100 KB of DRAM; starting it first guarantees
     * it can allocate that memory before TFLite competes for the same pool. */
    if (wifi_connect()) {
        mqtt_connect();
    }

    if (!camera_init()) {
        hal_uart_print("[FATAL] Camera non initialisee\r\n");
        while (true) { hal_delay_ms(1000); }
    }

    if (!tflite_init()) {
        hal_uart_print("[FATAL] TFLite non initialise\r\n");
        while (true) { hal_delay_ms(1000); }
    }

    fovet_zscore_init(&g_zs_person, ZSCORE_THRESHOLD, WARMUP_FRAMES);

    hal_uart_print("[CAM] Stabilisation AEC/AWB (5 frames)...\r\n");
    for (int i = 0; i < 5; i++) {
        camera_fb_t *fb = esp_camera_fb_get();
        if (fb) esp_camera_fb_return(fb);
        hal_delay_ms(150);
    }

    snprintf(g_buf, sizeof(g_buf),
             "Warmup  : %u frames | Seuil Z-Score : %.1f sigma\r\n"
             "MQTT    : %s\r\n"
             "CSV     : frame_id,person_score,no_person_score,z_score,anomaly,mean,stddev\r\n\r\n",
             WARMUP_FRAMES, ZSCORE_THRESHOLD,
             mqtt_client.connected() ? "connecte -> Vigie" : "desactive (UART only)");
    hal_uart_print(g_buf);
    hal_uart_print("[PRET] Calibration en cours sur scene vide...\r\n\r\n");
}

/* =========================================================================
 * loop()
 * ========================================================================= */

void loop(void)
{
    static uint32_t last_ms = 0U;
    uint32_t now = hal_time_ms();
    if ((now - last_ms) < INFERENCE_MS) {
        mqtt_client.loop();
        return;
    }
    last_ms = now;

    camera_fb_t *fb = esp_camera_fb_get();
    if (!fb) {
        hal_uart_print("[CAM] Capture echouee\r\n");
        return;
    }

    float person_score = 0.0f, no_person_score = 0.0f;
    bool ok = run_inference(fb->buf, fb->len, &person_score, &no_person_score);
    esp_camera_fb_return(fb);

    if (!ok) return;

    bool anomaly = fovet_zscore_update(&g_zs_person, person_score);

    float mean   = fovet_zscore_get_mean  (&g_zs_person);
    float stddev = fovet_zscore_get_stddev(&g_zs_person);
    float z_score = (stddev > 1e-6f)
                    ? (person_score - mean) / stddev
                    : 0.0f;

    hal_gpio_write(LED_PIN, anomaly ? HAL_GPIO_LOW : HAL_GPIO_HIGH);

    snprintf(g_buf, sizeof(g_buf),
             "%lu,%.3f,%.3f,%.3f,%d,%.3f,%.3f%s\r\n",
             (unsigned long)g_frame_id,
             person_score, no_person_score,
             z_score, (int)anomaly,
             mean, stddev,
             anomaly ? "  <PERSON DETECTED>" : "");
    hal_uart_print(g_buf);

    if (mqtt_client.connected()) {
        mqtt_ensure_connected();
        mqtt_publish(person_score);
    }

    g_frame_id++;
}
