"""
Ardent Forge — scaffolding.py

Generate a complete use-case skeleton from a single command:
  - configs/<name>.yaml          (Cast pipeline config)
  - edge-core/examples/esp32/<name>/platformio.ini
  - edge-core/examples/esp32/<name>/src/main.cpp
  - edge-core/examples/esp32/<name>/src/config.h.example
  - edge-core/examples/esp32/<name>/src/ard_model_manifest.h  (default, replaced by deploy-manifest)

Supported detectors: zscore | mad | drift | autoencoder | lstm_autoencoder
Supported sensors:   synthetic | imu | temperature | hr | camera | custom
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from textwrap import dedent


# ---------------------------------------------------------------------------
# Metadata defaults per (detector, sensor)
# ---------------------------------------------------------------------------

# unit, value_min, value_max for the MQTT payload / Watch chart
_MANIFEST_DEFAULTS: dict[str, dict[str, object]] = {
    "zscore":           {"unit": "z_score",    "value_min": -6.0,  "value_max": 6.0},
    "mad":              {"unit": "mad_score",   "value_min":  0.0,  "value_max": 10.0},
    "drift":            {"unit": "drift_mag",   "value_min":  0.0,  "value_max": 1.0},
    "autoencoder":      {"unit": "recon_error", "value_min":  None, "value_max": None},
    "lstm_autoencoder": {"unit": "recon_error", "value_min":  None, "value_max": None},
}

_DETECTOR_IS_ML = {"autoencoder", "lstm_autoencoder"}
_DETECTOR_IS_STATS = {"zscore", "mad", "drift"}


# ---------------------------------------------------------------------------
# YAML template
# ---------------------------------------------------------------------------

def _yaml_template(
    name: str,
    sensor: str,
    detector: str,
    data_path: str | None,
    column: str,
    threshold_sigma: float,
) -> str:
    slug = name.replace(" ", "-").lower()

    # Data section
    if data_path:
        data_block = dedent(f"""\
            data:
              source: csv
              path: {data_path}
              columns: [{column}]
        """)
    else:
        data_block = dedent("""\
            data:
              source: synthetic
              signal: sine
              n_samples: 2000
              frequency: 1.0
              noise_std: 0.1
              anomaly_rate: 0.05
              anomaly_magnitude: 5.0
        """)

    # Detector section
    if detector == "zscore":
        det_block = dedent(f"""\
            detectors:
              - type: zscore
                threshold_sigma: {threshold_sigma}
                min_samples: 30
        """)
    elif detector == "mad":
        det_block = dedent(f"""\
            detectors:
              - type: mad
                threshold_mad: {threshold_sigma}
                window_size: 50
        """)
    elif detector == "drift":
        det_block = dedent("""\
            detectors:
              - type: ewma_drift
                alpha_fast: 0.10
                alpha_slow: 0.01
                threshold_percentile: 99.0
        """)
    elif detector == "autoencoder":
        det_block = dedent("""\
            detectors:
              - type: autoencoder
                latent_dim: 8
                epochs: 50
                batch_size: 32
                threshold_percentile: 95.0
        """)
    elif detector == "lstm_autoencoder":
        det_block = dedent("""\
            detectors:
              - type: lstm_autoencoder
                sequence_length: 30
                latent_dim: 16
                epochs: 50
                batch_size: 32
                threshold_percentile: 95.0
        """)
    else:
        det_block = dedent(f"""\
            detectors:
              - type: zscore
                threshold_sigma: {threshold_sigma}
                min_samples: 30
        """)

    # Export section
    if detector in _DETECTOR_IS_ML:
        export_targets = "[c_header, tflite_micro, json_config]"
        quantization_line = "  quantization: float32"
    else:
        export_targets = "[c_header, json_config]"
        quantization_line = ""

    export_block = f"export:\n  targets: {export_targets}\n  output_dir: models/{slug}"
    if quantization_line:
        export_block += f"\n{quantization_line}"

    # Manifest section
    m = _MANIFEST_DEFAULTS.get(detector, _MANIFEST_DEFAULTS["zscore"])
    vmin = m["value_min"]
    vmax = m["value_max"]
    vmin_str = f"{vmin}" if vmin is not None else "null  # auto-computed from training data"
    vmax_str = f"{vmax}" if vmax is not None else "null  # auto-computed from training data"

    manifest_block = dedent(f"""\
        manifest:
          sensor: {sensor}
          unit: {m['unit']}
          value_min: {vmin_str}
          value_max: {vmax_str}
          label_normal: normal
          label_anomaly: anomaly
    """)

    header = dedent(f"""\
        # Ardent Forge — pipeline config
        # Use case : {name}
        # Sensor   : {sensor}
        # Detector : {detector}
        #
        # Generated by: forge new-usecase
        # Run with    : uv run forge run --config configs/{slug}.yaml
        # Deploy with : uv run forge deploy-full --config configs/{slug}.yaml \\
        #                   --project-dir edge-core/examples/esp32/{slug}
        #
        # To use your own CSV dataset, replace the data section with:
        #   data:
        #     source: csv
        #     path: data/your_file.csv
        #     columns: [your_column]

        name: {slug}

    """)

    return (
        header
        + data_block
        + "\n"
        + det_block
        + "\n"
        + export_block
        + "\n\n"
        + manifest_block
        + "\nreport:\n  enabled: true\n  format: html\n"
    )


# ---------------------------------------------------------------------------
# platformio.ini template
# ---------------------------------------------------------------------------

def _platformio_ini(name: str, port: str) -> str:
    return dedent(f"""\
        ; Ardent SDK — Pulse
        ; Use case: {name}
        ;
        ; Flash:   pio run --target upload
        ; Monitor: pio device monitor
        ;
        ; IMPORTANT: board=esp32dev (NOT esp32cam)
        ;   board=esp32cam crashes silently on PSRAM init before setup()
        ;   with CH340 adapter. See edge-core/CLAUDE.md "Hardware gotchas".

        [env:esp32cam]
        platform  = espressif32
        board     = esp32dev
        framework = arduino

        build_flags =
            -std=c++17
            -DARD_PLATFORM_ESP32
            -DCORE_DEBUG_LEVEL=0

        monitor_speed = 115200
        upload_speed  = 115200
        upload_port   = {port}
        monitor_port  = {port}

        lib_extra_dirs =
            ${{PROJECT_DIR}}/../../../../

        lib_deps =
            ardent-pulse
            knolleary/PubSubClient@^2.8
    """)


# ---------------------------------------------------------------------------
# config.h.example template
# ---------------------------------------------------------------------------

def _config_h_example(device_id: str) -> str:
    return dedent(f"""\
        /*
         * Ardent SDK — Pulse
         * Copyright (C) 2026 Antoine Porte. All rights reserved.
         * LGPL v3 for non-commercial use.
         * Commercial licensing: contact@ardent.io
         *
         * config.h.example — copy to config.h and fill in your credentials.
         * config.h is gitignored and must never be committed.
         */

        #ifndef ARD_CONFIG_H
        #define ARD_CONFIG_H

        /* WiFi credentials */
        #define WIFI_SSID      "your_wifi_ssid"
        #define WIFI_PASSWORD  "your_wifi_password"

        /* MQTT broker — Mosquitto running on your local machine or Scaleway VPS */
        #define MQTT_BROKER    "192.168.1.x"   /* IP of the machine running Mosquitto */
        #define MQTT_PORT      1883
        #define MQTT_USER      "ardent-device"
        #define MQTT_PASSWORD  "change_me"

        /* Device identity — must match the mqttClientId registered in Watch */
        #define DEVICE_ID      "{device_id}"

        #endif /* ARD_CONFIG_H */
    """)


# ---------------------------------------------------------------------------
# ard_model_manifest.h default template (overwritten by forge deploy-manifest)
# ---------------------------------------------------------------------------

def _manifest_h_default(name: str, sensor: str, detector: str) -> str:
    slug = name.replace(" ", "-").lower()
    m = _MANIFEST_DEFAULTS.get(detector, _MANIFEST_DEFAULTS["zscore"])
    vmin = m["value_min"] if m["value_min"] is not None else -6.0
    vmax = m["value_max"] if m["value_max"] is not None else 6.0

    return dedent(f"""\
        /*
         * Ardent SDK — Pulse
         * Default manifest for use case: {name}
         * THIS FILE IS OVERWRITTEN by: forge deploy-manifest --config configs/{slug}.yaml
         * Run forge first to get calibrated value_min/value_max from your dataset.
         */
        #ifndef ARD_MODEL_MANIFEST_H
        #define ARD_MODEL_MANIFEST_H

        #define ARD_MODEL_ID          "{slug}"
        #define ARD_MODEL_SENSOR      "{sensor}"
        #define ARD_MODEL_UNIT        "{m['unit']}"
        #define ARD_MODEL_VALUE_MIN   ({vmin}f)
        #define ARD_MODEL_VALUE_MAX   ({vmax}f)
        #define ARD_MODEL_LABEL_NORMAL  "normal"
        #define ARD_MODEL_LABEL_ANOMALY "anomaly"

        #endif /* ARD_MODEL_MANIFEST_H */
    """)


# ---------------------------------------------------------------------------
# platformio.ini ML template (TFLite Micro — adds huge_app + TFLite lib)
# ---------------------------------------------------------------------------

def _platformio_ini_ml(name: str, port: str) -> str:
    """PlatformIO config for TFLite Micro ML use-cases.

    Differences from the stats template:
    - ``board_build.partitions = huge_app.csv``  (TFLite model > 1 MB app partition)
    - ``tanakamasayuki/TensorFlowLite_ESP32``     (TFLite Micro port for ESP32)
    - ``-O2 -DNDEBUG``                            (required for TFLite performance)
    - ``upload_speed = 460800``                   (faster flash for large binary)
    """
    slug = name.replace(" ", "-").lower()
    return dedent(f"""\
        ; Ardent SDK — Pulse
        ; Use case: {name}  [TFLite Micro — autoencoder / lstm_autoencoder]
        ;
        ; Flash:   pio run --target upload
        ; Monitor: pio device monitor
        ;
        ; IMPORTANT: board=esp32dev (NOT esp32cam)
        ;   board=esp32cam crashes silently on PSRAM init before setup()
        ;   with CH340 adapter. See edge-core/CLAUDE.md "Hardware gotchas".
        ;
        ; Prerequisites:
        ;   1. Copy src/config.h.example -> src/config.h and fill in credentials.
        ;   2. Run: forge deploy-full --config configs/{slug}.yaml \\
        ;                             --project-dir edge-core/examples/esp32/{slug}
        ;      This trains the model, generates src/model_data.cpp, and flashes.

        [env:esp32cam]
        platform  = espressif32
        board     = esp32dev
        framework = arduino

        ; huge_app partition: TFLite model binary does not fit in the default 1 MB partition
        board_build.partitions = huge_app.csv

        build_flags =
            -std=c++17
            -DARD_PLATFORM_ESP32
            -DCORE_DEBUG_LEVEL=0
            -DNDEBUG
            -O2

        monitor_speed = 115200
        upload_speed  = 460800
        upload_port   = {port}
        monitor_port  = {port}

        lib_extra_dirs =
            ${{PROJECT_DIR}}/../../../../

        lib_deps =
            ardent-pulse
            knolleary/PubSubClient@^2.8
            tanakamasayuki/TensorFlowLite_ESP32@^1.0.0
    """)


# ---------------------------------------------------------------------------
# model_data.h template (ML use-cases — extern declarations for g_model_data)
# ---------------------------------------------------------------------------

def _model_data_h_ml(name: str, slug: str) -> str:
    """Extern declarations for the Forge-generated TFLite model byte array.

    The matching model_data.cpp (with the actual byte array) is written by:
        forge deploy-full --config configs/<slug>.yaml \\
                          --project-dir edge-core/examples/esp32/<slug>

    Typical sizes after training:
        Dense autoencoder  (latent_dim=8,  n_features=1)  →   ~5 KB
        LSTM autoencoder   (latent_dim=16, seq_len=30)    →  ~50 KB
    """
    return dedent(f"""\
        /*
         * Ardent SDK — Pulse
         * Copyright (C) 2026 Antoine Porte. All rights reserved.
         * LGPL v3 for non-commercial use.
         * Commercial licensing: contact@ardent.io
         *
         * model_data.h — TFLite model extern declarations for use case: {name}
         *
         * model_data.cpp (byte array ~5–50 KB) is generated by Forge and placed
         * in src/ automatically when you run:
         *
         *   forge deploy-full --config configs/{slug}.yaml \\
         *                     --project-dir edge-core/examples/esp32/{slug}
         *
         * Until model_data.cpp exists, the project will not link.
         * Do NOT edit model_data.cpp manually — it is regenerated on each deploy.
         */
        #pragma once

        #include <stdint.h>

        /* Forge-generated TFLite autoencoder model — defined in model_data.cpp */
        extern const unsigned char g_model_data[];
        extern const int           g_model_data_len;
    """)


# ---------------------------------------------------------------------------
# main.cpp templates
# ---------------------------------------------------------------------------

_MAIN_CPP_HEADER = """\
/*
 * Ardent SDK — Pulse
 * Copyright (C) 2026 Antoine Porte. All rights reserved.
 * LGPL v3 for non-commercial use.
 * Commercial licensing: contact@ardent.io
 *
 * Use case : {name}
 * Sensor   : {sensor}
 * Detector : {detector}
 *
 * Prerequisites:
 *   1. Copy src/config.h.example to src/config.h and fill in credentials.
 *   2. Register the device: POST /api/devices {{ "mqttClientId": "esp32-cam-001" }}
 *   3. Mosquitto must bind 0.0.0.0 for LAN access.
 *   4. Run: forge deploy-full --config configs/{slug}.yaml \\
 *                             --project-dir edge-core/examples/esp32/{slug}
 *
 * MQTT topic : ardent/devices/<DEVICE_ID>/readings
 * Baud rate  : 115200
 */

#include "config.h"               /* WiFi/MQTT credentials — DO NOT COMMIT */
#include "ard_model_manifest.h" /* Forge-generated model metadata        */
"""

_MAIN_CPP_ZSCORE = (
    _MAIN_CPP_HEADER
    + """
extern "C" {{
#include "ardent/zscore.h"
#include "ardent/hal/hal_uart.h"
#include "ardent/hal/hal_time.h"
#include "ardent/hal/hal_gpio.h"
}}

#include <Arduino.h>
#include <WiFi.h>
#include <PubSubClient.h>
#include <math.h>
#include <stdio.h>

#define LED_PIN            4       /* ESP32-CAM onboard LED (active LOW) */
#define SAMPLE_PERIOD_MS   10U     /* 100 Hz                              */
#define ZSCORE_THRESHOLD   3.0f
#define ZSCORE_MIN_SAMPLES 30U
#define MQTT_PUBLISH_EVERY 10U     /* Publish every 10 samples (10 Hz)   */
#define MQTT_RECONNECT_MS  5000U

static ArdentZScore  g_zscore;
static uint32_t     g_sample_index = 0;
static char         g_buf[384];
static WiFiClient   g_wifi;
static PubSubClient g_mqtt(g_wifi);

/* TODO: replace synthetic signal with your real sensor read */
static float read_sensor(void) {{
    float t = (float)g_sample_index / 100.0f;
    return sinf(2.0f * (float)M_PI * t) + ((float)rand() / RAND_MAX - 0.5f) * 0.2f;
}}

static void wifi_connect(void) {{
    hal_uart_print("[WiFi] Connecting...\\r\\n");
    WiFi.mode(WIFI_STA);
    WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
    uint32_t t0 = hal_time_ms();
    while (WiFi.status() != WL_CONNECTED) {{
        if (hal_time_ms() - t0 > 15000U) {{ hal_uart_print("[WiFi] Timeout\\r\\n"); return; }}
        hal_delay_ms(500);
    }}
    hal_uart_print("[WiFi] Connected\\r\\n");
}}

static void mqtt_loop(void) {{
    static uint32_t last_ms = 0;
    if (g_mqtt.connected()) {{ g_mqtt.loop(); return; }}
    if (WiFi.status() != WL_CONNECTED) return;
    if (hal_time_ms() - last_ms < MQTT_RECONNECT_MS) return;
    last_ms = hal_time_ms();
    if (g_mqtt.connect(DEVICE_ID, MQTT_USER, MQTT_PASSWORD))
        hal_uart_print("[MQTT] Connected\\r\\n");
}}

void setup(void) {{
    hal_uart_init(115200);
    hal_gpio_set_mode(LED_PIN, HAL_GPIO_MODE_OUTPUT);
    hal_gpio_write(LED_PIN, HAL_GPIO_HIGH);
    ard_zscore_init(&g_zscore, ZSCORE_THRESHOLD, ZSCORE_MIN_SAMPLES);
    hal_uart_print("\\r\\n=== Ardent Pulse — {name} ===\\r\\n");
    wifi_connect();
    g_mqtt.setServer(MQTT_BROKER, MQTT_PORT);
    g_mqtt.setKeepAlive(30);
    mqtt_loop();
}}

void loop(void) {{
    static uint32_t last_sample_ms = 0;
    if (hal_time_ms() - last_sample_ms < SAMPLE_PERIOD_MS) {{ mqtt_loop(); return; }}
    last_sample_ms = hal_time_ms();

    float sample  = read_sensor();
    bool  anomaly = ard_zscore_update(&g_zscore, sample);
    float zscore  = ard_zscore_get_mean(&g_zscore) != 0.0f
                    ? (sample - ard_zscore_get_mean(&g_zscore)) / (ard_zscore_get_stddev(&g_zscore) + 1e-9f)
                    : 0.0f;

    hal_gpio_write(LED_PIN, anomaly ? HAL_GPIO_LOW : HAL_GPIO_HIGH);

    if (g_sample_index % MQTT_PUBLISH_EVERY == 0 && g_mqtt.connected()) {{
        int n = snprintf(g_buf, sizeof(g_buf),
            "{{\\"device_id\\":\\"%s\\",\\"model_id\\":\\"" ARD_MODEL_ID "\\","
            "\\"sensor\\":\\"" ARD_MODEL_SENSOR "\\",\\"value\\":%.4f,"
            "\\"value_min\\":%.4f,\\"value_max\\":%.4f,"
            "\\"unit\\":\\"" ARD_MODEL_UNIT "\\",\\"label\\":\\"%s\\","
            "\\"anomaly\\":%s,\\"ts\\":%lu}}",
            DEVICE_ID, zscore,
            (double)ARD_MODEL_VALUE_MIN, (double)ARD_MODEL_VALUE_MAX,
            anomaly ? ARD_MODEL_LABEL_ANOMALY : ARD_MODEL_LABEL_NORMAL,
            anomaly ? "true" : "false",
            (unsigned long)hal_time_ms());
        char topic[64];
        snprintf(topic, sizeof(topic), "ardent/devices/%s/readings", DEVICE_ID);
        g_mqtt.publish(topic, g_buf, (unsigned int)n);
    }}
    g_sample_index++;
    mqtt_loop();
}}
"""
)

_MAIN_CPP_MAD = (
    _MAIN_CPP_HEADER
    + """
extern "C" {{
#include "ardent/mad.h"
#include "ardent/hal/hal_uart.h"
#include "ardent/hal/hal_time.h"
#include "ardent/hal/hal_gpio.h"
}}

#include <Arduino.h>
#include <WiFi.h>
#include <PubSubClient.h>
#include <math.h>
#include <stdio.h>

#define LED_PIN            4
#define SAMPLE_PERIOD_MS   10U
#define MAD_THRESHOLD      3.0f
#define MAD_WINDOW_SIZE    50U
#define MQTT_PUBLISH_EVERY 10U
#define MQTT_RECONNECT_MS  5000U

static ArdentMAD     g_mad;
static uint32_t     g_sample_index = 0;
static char         g_buf[384];
static WiFiClient   g_wifi;
static PubSubClient g_mqtt(g_wifi);

/* TODO: replace with your real sensor read */
static float read_sensor(void) {{
    float t = (float)g_sample_index / 100.0f;
    return sinf(2.0f * (float)M_PI * t) + ((float)rand() / RAND_MAX - 0.5f) * 0.2f;
}}

static void wifi_connect(void) {{
    hal_uart_print("[WiFi] Connecting...\\r\\n");
    WiFi.mode(WIFI_STA);
    WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
    uint32_t t0 = hal_time_ms();
    while (WiFi.status() != WL_CONNECTED) {{
        if (hal_time_ms() - t0 > 15000U) {{ hal_uart_print("[WiFi] Timeout\\r\\n"); return; }}
        hal_delay_ms(500);
    }}
    hal_uart_print("[WiFi] Connected\\r\\n");
}}

static void mqtt_loop(void) {{
    static uint32_t last_ms = 0;
    if (g_mqtt.connected()) {{ g_mqtt.loop(); return; }}
    if (WiFi.status() != WL_CONNECTED) return;
    if (hal_time_ms() - last_ms < MQTT_RECONNECT_MS) return;
    last_ms = hal_time_ms();
    if (g_mqtt.connect(DEVICE_ID, MQTT_USER, MQTT_PASSWORD))
        hal_uart_print("[MQTT] Connected\\r\\n");
}}

void setup(void) {{
    hal_uart_init(115200);
    hal_gpio_set_mode(LED_PIN, HAL_GPIO_MODE_OUTPUT);
    hal_gpio_write(LED_PIN, HAL_GPIO_HIGH);
    ard_mad_init(&g_mad, MAD_THRESHOLD, MAD_WINDOW_SIZE);
    hal_uart_print("\\r\\n=== Ardent Pulse — {name} ===\\r\\n");
    wifi_connect();
    g_mqtt.setServer(MQTT_BROKER, MQTT_PORT);
    g_mqtt.setKeepAlive(30);
    mqtt_loop();
}}

void loop(void) {{
    static uint32_t last_sample_ms = 0;
    if (hal_time_ms() - last_sample_ms < SAMPLE_PERIOD_MS) {{ mqtt_loop(); return; }}
    last_sample_ms = hal_time_ms();

    float sample    = read_sensor();
    float mad_score = ard_mad_score(&g_mad, sample);
    bool  anomaly   = ard_mad_update(&g_mad, sample);

    hal_gpio_write(LED_PIN, anomaly ? HAL_GPIO_LOW : HAL_GPIO_HIGH);

    if (g_sample_index % MQTT_PUBLISH_EVERY == 0 && g_mqtt.connected()) {{
        int n = snprintf(g_buf, sizeof(g_buf),
            "{{\\"device_id\\":\\"%s\\",\\"model_id\\":\\"" ARD_MODEL_ID "\\","
            "\\"sensor\\":\\"" ARD_MODEL_SENSOR "\\",\\"value\\":%.4f,"
            "\\"value_min\\":%.4f,\\"value_max\\":%.4f,"
            "\\"unit\\":\\"" ARD_MODEL_UNIT "\\",\\"label\\":\\"%s\\","
            "\\"anomaly\\":%s,\\"ts\\":%lu}}",
            DEVICE_ID, mad_score,
            (double)ARD_MODEL_VALUE_MIN, (double)ARD_MODEL_VALUE_MAX,
            anomaly ? ARD_MODEL_LABEL_ANOMALY : ARD_MODEL_LABEL_NORMAL,
            anomaly ? "true" : "false",
            (unsigned long)hal_time_ms());
        char topic[64];
        snprintf(topic, sizeof(topic), "ardent/devices/%s/readings", DEVICE_ID);
        g_mqtt.publish(topic, g_buf, (unsigned int)n);
    }}
    g_sample_index++;
    mqtt_loop();
}}
"""
)

_MAIN_CPP_DRIFT = (
    _MAIN_CPP_HEADER
    + """
extern "C" {{
#include "ardent/drift.h"
#include "ardent/hal/hal_uart.h"
#include "ardent/hal/hal_time.h"
#include "ardent/hal/hal_gpio.h"
}}

#include <Arduino.h>
#include <WiFi.h>
#include <PubSubClient.h>
#include <math.h>
#include <stdio.h>

#define LED_PIN            4
#define SAMPLE_PERIOD_MS   10U
#define DRIFT_ALPHA_FAST   0.10f
#define DRIFT_ALPHA_SLOW   0.01f
#define DRIFT_THRESHOLD    0.30f
#define MQTT_PUBLISH_EVERY 10U
#define MQTT_RECONNECT_MS  5000U

static ArdentDrift   g_drift;
static uint32_t     g_sample_index = 0;
static char         g_buf[384];
static WiFiClient   g_wifi;
static PubSubClient g_mqtt(g_wifi);

/* TODO: replace with your real sensor read */
static float read_sensor(void) {{
    float t = (float)g_sample_index / 100.0f;
    return sinf(2.0f * (float)M_PI * t) + ((float)rand() / RAND_MAX - 0.5f) * 0.2f;
}}

static void wifi_connect(void) {{
    hal_uart_print("[WiFi] Connecting...\\r\\n");
    WiFi.mode(WIFI_STA);
    WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
    uint32_t t0 = hal_time_ms();
    while (WiFi.status() != WL_CONNECTED) {{
        if (hal_time_ms() - t0 > 15000U) {{ hal_uart_print("[WiFi] Timeout\\r\\n"); return; }}
        hal_delay_ms(500);
    }}
    hal_uart_print("[WiFi] Connected\\r\\n");
}}

static void mqtt_loop(void) {{
    static uint32_t last_ms = 0;
    if (g_mqtt.connected()) {{ g_mqtt.loop(); return; }}
    if (WiFi.status() != WL_CONNECTED) return;
    if (hal_time_ms() - last_ms < MQTT_RECONNECT_MS) return;
    last_ms = hal_time_ms();
    if (g_mqtt.connect(DEVICE_ID, MQTT_USER, MQTT_PASSWORD))
        hal_uart_print("[MQTT] Connected\\r\\n");
}}

void setup(void) {{
    hal_uart_init(115200);
    hal_gpio_set_mode(LED_PIN, HAL_GPIO_MODE_OUTPUT);
    hal_gpio_write(LED_PIN, HAL_GPIO_HIGH);
    ard_drift_init(&g_drift, DRIFT_ALPHA_FAST, DRIFT_ALPHA_SLOW, DRIFT_THRESHOLD);
    hal_uart_print("\\r\\n=== Ardent Pulse — {name} ===\\r\\n");
    wifi_connect();
    g_mqtt.setServer(MQTT_BROKER, MQTT_PORT);
    g_mqtt.setKeepAlive(30);
    mqtt_loop();
}}

void loop(void) {{
    static uint32_t last_sample_ms = 0;
    if (hal_time_ms() - last_sample_ms < SAMPLE_PERIOD_MS) {{ mqtt_loop(); return; }}
    last_sample_ms = hal_time_ms();

    float sample     = read_sensor();
    bool  anomaly    = ard_drift_update(&g_drift, sample);
    float drift_mag  = ard_drift_get_magnitude(&g_drift);

    hal_gpio_write(LED_PIN, anomaly ? HAL_GPIO_LOW : HAL_GPIO_HIGH);

    if (g_sample_index % MQTT_PUBLISH_EVERY == 0 && g_mqtt.connected()) {{
        int n = snprintf(g_buf, sizeof(g_buf),
            "{{\\"device_id\\":\\"%s\\",\\"model_id\\":\\"" ARD_MODEL_ID "\\","
            "\\"sensor\\":\\"" ARD_MODEL_SENSOR "\\",\\"value\\":%.4f,"
            "\\"value_min\\":%.4f,\\"value_max\\":%.4f,"
            "\\"unit\\":\\"" ARD_MODEL_UNIT "\\",\\"label\\":\\"%s\\","
            "\\"anomaly\\":%s,\\"ts\\":%lu}}",
            DEVICE_ID, drift_mag,
            (double)ARD_MODEL_VALUE_MIN, (double)ARD_MODEL_VALUE_MAX,
            anomaly ? ARD_MODEL_LABEL_ANOMALY : ARD_MODEL_LABEL_NORMAL,
            anomaly ? "true" : "false",
            (unsigned long)hal_time_ms());
        char topic[64];
        snprintf(topic, sizeof(topic), "ardent/devices/%s/readings", DEVICE_ID);
        g_mqtt.publish(topic, g_buf, (unsigned int)n);
    }}
    g_sample_index++;
    mqtt_loop();
}}
"""
)

_MAIN_CPP_ML = (
    _MAIN_CPP_HEADER
    + """
/* TFLite Micro — {detector}
 *
 * Model    : Forge-trained autoencoder exported as float32 TFLite
 * Input    : float32 vector [1 × {n_features}]  — feature window
 * Output   : float32 vector [1 × {n_features}]  — reconstruction
 * Score    : MSE(input, reconstruction) — higher = more anomalous
 * Arena    : {arena_size} bytes on internal DRAM heap
 *
 * Pipeline :
 *   Sensor ──► features[{n_features}] ──► TFLite Micro ──► MSE (recon error)
 *                                                               │
 *                                                         ArdentZScore ──► MQTT → Watch
 *
 * IMPORTANT — model_data.cpp must exist before compilation:
 *   Run: forge deploy-full --config configs/{slug}.yaml \\
 *                          --project-dir edge-core/examples/esp32/{slug}
 *   This trains the model, generates src/model_data.cpp, and flashes.
 *
 * If arena is too small, AllocateTensors() will fail at startup.
 * Increase kTensorArenaSize and re-flash.
 *
 * For LSTM autoencoder: input shape is [1, sequence_length, n_input_features].
 * Set N_FEATURES = sequence_length * n_input_features (flattened), or adapt
 * tflite_infer() to use input_tensor->dims directly.
 */

/* Forge-generated TFLite model byte array — defined in model_data.cpp */
#include "model_data.h"

/* TFLite Micro (ESP32 port — tanakamasayuki/TensorFlowLite_ESP32) */
#include <TensorFlowLite_ESP32.h>
#include "tensorflow/lite/micro/all_ops_resolver.h"
#include "tensorflow/lite/micro/micro_error_reporter.h"
#include "tensorflow/lite/micro/micro_interpreter.h"
#include "tensorflow/lite/schema/schema_generated.h"

/* ESP32 heap allocator — for arena allocation on internal DRAM */
#include "esp_heap_caps.h"

extern "C" {{
#include "ardent/zscore.h"
#include "ardent/hal/hal_uart.h"
#include "ardent/hal/hal_time.h"
#include "ardent/hal/hal_gpio.h"
}}

#include <Arduino.h>
#include <WiFi.h>
#include <PubSubClient.h>
#include <math.h>
#include <string.h>
#include <stdio.h>

/* =========================================================================
 * Constants
 * ========================================================================= */

#define LED_PIN              4       /* ESP32-CAM onboard LED (active LOW) */
#define N_FEATURES           {n_features}   /* must match model input dim[1] — update after training */
#define SAMPLE_PERIOD_MS     10U     /* 100 Hz sampling                     */
#define ZSCORE_THRESHOLD     3.0f   /* sigma threshold for anomaly flag     */
#define ZSCORE_WARMUP        30U    /* samples before Z-Score activates     */
#define MQTT_PUBLISH_EVERY   10U    /* publish 1 in every N samples (10 Hz) */
#define MQTT_RECONNECT_MS    5000U

/* Tensor arena — allocated on DRAM heap in tflite_init().
 * WiFi stack needs ~100 KB; starting WiFi before TFLite avoids contention.
 * Increase kTensorArenaSize if AllocateTensors() fails at startup. */
static constexpr int kTensorArenaSize = {arena_size};

/* =========================================================================
 * Globals
 * ========================================================================= */

static uint8_t                  *g_tensor_arena  = nullptr; /* heap_caps_malloc */
static tflite::MicroErrorReporter g_error_reporter;
static tflite::AllOpsResolver      g_resolver;
static tflite::MicroInterpreter   *g_interpreter   = nullptr;
static TfLiteTensor               *g_input_tensor  = nullptr;
static TfLiteTensor               *g_output_tensor = nullptr;

static ArdentZScore  g_zscore;
static uint32_t     g_sample_index = 0;
static char         g_buf[384];
static WiFiClient   g_wifi;
static PubSubClient g_mqtt(g_wifi);

/* =========================================================================
 * Sensor read — TODO: replace with your real sensor
 *
 * Fill features[N_FEATURES] with the current sensor reading(s).
 * For a single-channel sensor (e.g. accelerometer X-axis), N_FEATURES = 1.
 * For a multi-channel / windowed input, fill all N_FEATURES values.
 * ========================================================================= */
static void read_sensor(float *features) {{
    float t = (float)g_sample_index / 100.0f;
    for (int i = 0; i < N_FEATURES; i++) {{
        features[i] = sinf(2.0f * (float)M_PI * t + (float)i)
                      + ((float)rand() / RAND_MAX - 0.5f) * 0.2f;
    }}
}}

/* =========================================================================
 * TFLite Micro — initialisation
 * Returns true on success, false on any error (check UART for details).
 * ========================================================================= */
static bool tflite_init(void) {{
    /* Allocate arena on internal DRAM heap (avoids BSS overflow at link time).
     * WiFi must be initialised before this call — it reserves ~100 KB of DRAM
     * first, ensuring TFLite gets the remaining contiguous block. */
    g_tensor_arena = (uint8_t *)heap_caps_malloc(
        kTensorArenaSize, MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT);
    if (!g_tensor_arena) {{
        hal_uart_print("[TFL] heap_caps_malloc failed — insufficient DRAM\\r\\n");
        return false;
    }}

    const tflite::Model *model = tflite::GetModel(g_model_data);
    if (model->version() != TFLITE_SCHEMA_VERSION) {{
        snprintf(g_buf, sizeof(g_buf),
                 "[TFL] Schema version mismatch: got %lu, expected %d\\r\\n",
                 (unsigned long)model->version(), TFLITE_SCHEMA_VERSION);
        hal_uart_print(g_buf);
        return false;
    }}

    static tflite::MicroInterpreter static_interpreter(
        model, g_resolver, g_tensor_arena, kTensorArenaSize, &g_error_reporter);
    g_interpreter = &static_interpreter;

    if (g_interpreter->AllocateTensors() != kTfLiteOk) {{
        snprintf(g_buf, sizeof(g_buf),
                 "[TFL] AllocateTensors() failed (arena used: %u / %u bytes)\\r\\n",
                 (unsigned)g_interpreter->arena_used_bytes(), kTensorArenaSize);
        hal_uart_print(g_buf);
        return false;
    }}

    g_input_tensor  = g_interpreter->input(0);
    g_output_tensor = g_interpreter->output(0);

    /* Validate input shape: expect [1, N_FEATURES] */
    if (g_input_tensor->dims->size < 2 ||
        g_input_tensor->dims->data[1] != N_FEATURES) {{
        snprintf(g_buf, sizeof(g_buf),
                 "[TFL] Input shape mismatch: model expects dim[1]=%d, N_FEATURES=%d\\r\\n"
                 "      Update N_FEATURES in main.cpp to match your trained model.\\r\\n",
                 g_input_tensor->dims->size >= 2 ? g_input_tensor->dims->data[1] : -1,
                 N_FEATURES);
        hal_uart_print(g_buf);
        return false;
    }}

    snprintf(g_buf, sizeof(g_buf),
             "[TFL] OK — arena used: %u / %u bytes\\r\\n",
             (unsigned)g_interpreter->arena_used_bytes(), kTensorArenaSize);
    hal_uart_print(g_buf);
    return true;
}}

/* =========================================================================
 * TFLite inference — returns MSE reconstruction error.
 *
 * Copies features into the input tensor, runs Invoke(), then computes
 * mean squared error between input and reconstruction across all features.
 * A higher MSE means the model struggled to reconstruct the input —
 * i.e., the sample looks anomalous relative to the training distribution.
 *
 * Returns 0.0f on Invoke() failure (UART error is printed).
 * ========================================================================= */
static float tflite_infer(const float *features) {{
    memcpy(g_input_tensor->data.f, features, N_FEATURES * sizeof(float));

    if (g_interpreter->Invoke() != kTfLiteOk) {{
        hal_uart_print("[INF] Invoke() failed\\r\\n");
        return 0.0f;
    }}

    /* MSE = mean((input - reconstruction)^2) over all N_FEATURES */
    float mse = 0.0f;
    const float *recon = g_output_tensor->data.f;
    for (int i = 0; i < N_FEATURES; i++) {{
        float diff = features[i] - recon[i];
        mse += diff * diff;
    }}
    return mse / (float)N_FEATURES;
}}

/* =========================================================================
 * WiFi / MQTT helpers
 * ========================================================================= */

static void wifi_connect(void) {{
    WiFi.mode(WIFI_STA);
    WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
    hal_uart_print("[WiFi] Connecting");
    uint32_t t0 = hal_time_ms();
    while (WiFi.status() != WL_CONNECTED) {{
        if (hal_time_ms() - t0 > 30000U) {{
            hal_uart_print("\\r\\n[WiFi] Timeout — UART-only mode\\r\\n");
            return;
        }}
        hal_delay_ms(500);
        hal_uart_print(".");
    }}
    snprintf(g_buf, sizeof(g_buf), "\\r\\n[WiFi] Connected — IP: %s\\r\\n",
             WiFi.localIP().toString().c_str());
    hal_uart_print(g_buf);
}}

static void mqtt_loop(void) {{
    static uint32_t last_ms = 0;
    if (g_mqtt.connected()) {{ g_mqtt.loop(); return; }}
    if (WiFi.status() != WL_CONNECTED) return;
    if (hal_time_ms() - last_ms < MQTT_RECONNECT_MS) return;
    last_ms = hal_time_ms();
    if (g_mqtt.connect(DEVICE_ID, MQTT_USER, MQTT_PASSWORD))
        hal_uart_print("[MQTT] Connected\\r\\n");
}}

/* =========================================================================
 * setup()
 * ========================================================================= */

void setup(void) {{
    hal_uart_init(115200);
    hal_delay_ms(500);
    hal_gpio_set_mode(LED_PIN, HAL_GPIO_MODE_OUTPUT);
    hal_gpio_write(LED_PIN, HAL_GPIO_HIGH);

    hal_uart_print("\\r\\n=== Ardent Pulse — {name} ({detector}) ===\\r\\n");

    /* Start WiFi BEFORE TFLite arena allocation to avoid DRAM contention. */
    wifi_connect();
    g_mqtt.setServer(MQTT_BROKER, MQTT_PORT);
    g_mqtt.setKeepAlive(30);
    mqtt_loop();

    if (!tflite_init()) {{
        hal_uart_print("[FATAL] TFLite init failed — halted\\r\\n");
        while (true) {{ hal_delay_ms(1000); }}
    }}

    ard_zscore_init(&g_zscore, ZSCORE_THRESHOLD, ZSCORE_WARMUP);

    hal_uart_print("[READY] Warmup in progress...\\r\\n");
    hal_uart_print("CSV: sample_id,recon_error,z_score,anomaly\\r\\n\\r\\n");
}}

/* =========================================================================
 * loop()
 * ========================================================================= */

void loop(void) {{
    static uint32_t last_sample_ms = 0;
    if (hal_time_ms() - last_sample_ms < SAMPLE_PERIOD_MS) {{ mqtt_loop(); return; }}
    last_sample_ms = hal_time_ms();

    float features[N_FEATURES];
    read_sensor(features);

    float recon_error = tflite_infer(features);
    bool  anomaly     = ard_zscore_update(&g_zscore, recon_error);
    float mean        = ard_zscore_get_mean  (&g_zscore);
    float stddev      = ard_zscore_get_stddev(&g_zscore);
    float z_score     = (stddev > 1e-6f) ? (recon_error - mean) / stddev : 0.0f;

    hal_gpio_write(LED_PIN, anomaly ? HAL_GPIO_LOW : HAL_GPIO_HIGH);

    /* CSV log */
    snprintf(g_buf, sizeof(g_buf), "%lu,%.4f,%.4f,%d%s\\r\\n",
             (unsigned long)g_sample_index, recon_error, z_score, (int)anomaly,
             anomaly ? "  <ANOMALY>" : "");
    hal_uart_print(g_buf);

    /* MQTT — canonical payload (same format as zscore / mad / drift templates) */
    if (g_sample_index % MQTT_PUBLISH_EVERY == 0 && g_mqtt.connected()) {{
        int n = snprintf(g_buf, sizeof(g_buf),
            "{{\\"device_id\\":\\"%s\\",\\"model_id\\":\\"" ARD_MODEL_ID "\\","
            "\\"sensor\\":\\"" ARD_MODEL_SENSOR "\\",\\"value\\":%.4f,"
            "\\"value_min\\":%.4f,\\"value_max\\":%.4f,"
            "\\"unit\\":\\"" ARD_MODEL_UNIT "\\",\\"label\\":\\"%s\\","
            "\\"anomaly\\":%s,\\"ts\\":%lu}}",
            DEVICE_ID, recon_error,
            (double)ARD_MODEL_VALUE_MIN, (double)ARD_MODEL_VALUE_MAX,
            anomaly ? ARD_MODEL_LABEL_ANOMALY : ARD_MODEL_LABEL_NORMAL,
            anomaly ? "true" : "false",
            (unsigned long)hal_time_ms());
        char topic[64];
        snprintf(topic, sizeof(topic), "ardent/devices/%s/readings", DEVICE_ID);
        g_mqtt.publish(topic, g_buf, (unsigned int)n);
    }}
    g_sample_index++;
    mqtt_loop();
}}
"""
)

_MAIN_TEMPLATES = {
    "zscore":           _MAIN_CPP_ZSCORE,
    "mad":              _MAIN_CPP_MAD,
    "drift":            _MAIN_CPP_DRIFT,
    "autoencoder":      _MAIN_CPP_ML,
    "lstm_autoencoder": _MAIN_CPP_ML,
}


# ---------------------------------------------------------------------------
# ScaffoldResult
# ---------------------------------------------------------------------------

@dataclass
class ScaffoldResult:
    config_path: Path
    project_dir: Path
    files_created: list[Path] = field(default_factory=list)


# ---------------------------------------------------------------------------
# Main entry point
# ---------------------------------------------------------------------------

def scaffold_usecase(
    name: str,
    sensor: str,
    detector: str,
    data_path: str | None,
    column: str,
    port: str,
    threshold_sigma: float,
    root_dir: Path,
    n_features: int = 1,
    arena_size: int = 65536,
) -> ScaffoldResult:
    """Generate a complete use-case skeleton.

    Args:
        name:            Use-case slug (e.g. "vibration-monitor")
        sensor:          Sensor type (synthetic | imu | temperature | hr | camera | custom)
        detector:        Detector type (zscore | mad | drift | autoencoder | lstm_autoencoder)
        data_path:       Path to CSV file, or None for synthetic data
        column:          CSV column name (only used if data_path is set)
        port:            Serial port for PlatformIO (e.g. "COM4")
        threshold_sigma: Detection threshold (sigma for zscore/mad)
        root_dir:        Repo root (usually Path.cwd() or auto-detected)
        n_features:      [ML only] Number of model input features — must match
                         the trained TFLite model's input dim[1].  Default: 1
                         (single-channel synthetic data).  Update N_FEATURES in
                         the generated main.cpp after inspecting the trained model.
        arena_size:      [ML only] TFLite Micro tensor arena size in bytes.
                         Default: 65536 (64 KB).  Increase if AllocateTensors()
                         fails at startup (the UART log reports actual usage).

    Returns:
        ScaffoldResult with paths to generated config + project dir
    """
    slug = name.replace(" ", "-").lower()
    device_id = f"esp32-{slug[:16]}"
    is_ml = detector in _DETECTOR_IS_ML

    configs_dir = root_dir / "automl-pipeline" / "configs"
    project_dir = root_dir / "edge-core" / "examples" / "esp32" / slug

    configs_dir.mkdir(parents=True, exist_ok=True)
    project_dir.mkdir(parents=True, exist_ok=True)
    (project_dir / "src").mkdir(exist_ok=True)

    files: list[Path] = []

    # 1. YAML config
    config_path = configs_dir / f"{slug}.yaml"
    config_path.write_text(
        _yaml_template(name, sensor, detector, data_path, column, threshold_sigma),
        encoding="utf-8",
    )
    files.append(config_path)

    # 2. platformio.ini — ML use-cases need TFLite lib + huge_app partition
    ini_path = project_dir / "platformio.ini"
    ini_content = _platformio_ini_ml(name, port) if is_ml else _platformio_ini(name, port)
    ini_path.write_text(ini_content, encoding="utf-8")
    files.append(ini_path)

    # 3. src/main.cpp
    template = _MAIN_TEMPLATES.get(detector, _MAIN_TEMPLATES["zscore"])
    main_cpp = template.format(
        name=name,
        slug=slug,
        sensor=sensor,
        detector=detector,
        n_features=n_features,
        arena_size=arena_size,
    )
    main_cpp_path = project_dir / "src" / "main.cpp"
    main_cpp_path.write_text(main_cpp, encoding="utf-8")
    files.append(main_cpp_path)

    # 4. src/config.h.example
    config_h_path = project_dir / "src" / "config.h.example"
    config_h_path.write_text(_config_h_example(device_id), encoding="utf-8")
    files.append(config_h_path)

    # 5. src/ard_model_manifest.h (default, replaced by deploy-manifest)
    manifest_h_path = project_dir / "src" / "ard_model_manifest.h"
    manifest_h_path.write_text(_manifest_h_default(name, sensor, detector), encoding="utf-8")
    files.append(manifest_h_path)

    # 6. src/model_data.h (ML only) — extern declarations satisfied by model_data.cpp
    #    model_data.cpp is generated by: forge deploy-full --config ... --project-dir ...
    if is_ml:
        model_data_h_path = project_dir / "src" / "model_data.h"
        model_data_h_path.write_text(_model_data_h_ml(name, slug), encoding="utf-8")
        files.append(model_data_h_path)

    return ScaffoldResult(
        config_path=config_path,
        project_dir=project_dir,
        files_created=files,
    )
