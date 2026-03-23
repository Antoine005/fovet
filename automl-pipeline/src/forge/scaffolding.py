"""
Fovet Forge — scaffolding.py

Generate a complete use-case skeleton from a single command:
  - configs/<name>.yaml          (Forge pipeline config)
  - edge-core/examples/esp32/<name>/platformio.ini
  - edge-core/examples/esp32/<name>/src/main.cpp
  - edge-core/examples/esp32/<name>/src/config.h.example
  - edge-core/examples/esp32/<name>/src/fovet_model_manifest.h  (default, replaced by deploy-manifest)

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

# unit, value_min, value_max for the MQTT payload / Vigie chart
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
        # Fovet Forge — pipeline config
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
        ; Fovet SDK — Sentinelle
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
            -DFOVET_PLATFORM_ESP32
            -DCORE_DEBUG_LEVEL=0

        monitor_speed = 115200
        upload_speed  = 115200
        upload_port   = {port}
        monitor_port  = {port}

        lib_extra_dirs =
            ${{PROJECT_DIR}}/../../../../

        lib_deps =
            fovet-sentinelle
            knolleary/PubSubClient@^2.8
    """)


# ---------------------------------------------------------------------------
# config.h.example template
# ---------------------------------------------------------------------------

def _config_h_example(device_id: str) -> str:
    return dedent(f"""\
        /*
         * Fovet SDK — Sentinelle
         * Copyright (C) 2026 Antoine Porte. All rights reserved.
         * LGPL v3 for non-commercial use.
         * Commercial licensing: contact@fovet.eu
         *
         * config.h.example — copy to config.h and fill in your credentials.
         * config.h is gitignored and must never be committed.
         */

        #ifndef FOVET_CONFIG_H
        #define FOVET_CONFIG_H

        /* WiFi credentials */
        #define WIFI_SSID      "your_wifi_ssid"
        #define WIFI_PASSWORD  "your_wifi_password"

        /* MQTT broker — Mosquitto running on your local machine or Scaleway VPS */
        #define MQTT_BROKER    "192.168.1.x"   /* IP of the machine running Mosquitto */
        #define MQTT_PORT      1883
        #define MQTT_USER      "fovet-device"
        #define MQTT_PASSWORD  "change_me"

        /* Device identity — must match the mqttClientId registered in Vigie */
        #define DEVICE_ID      "{device_id}"

        #endif /* FOVET_CONFIG_H */
    """)


# ---------------------------------------------------------------------------
# fovet_model_manifest.h default template (overwritten by forge deploy-manifest)
# ---------------------------------------------------------------------------

def _manifest_h_default(name: str, sensor: str, detector: str) -> str:
    slug = name.replace(" ", "-").lower()
    m = _MANIFEST_DEFAULTS.get(detector, _MANIFEST_DEFAULTS["zscore"])
    vmin = m["value_min"] if m["value_min"] is not None else -6.0
    vmax = m["value_max"] if m["value_max"] is not None else 6.0

    return dedent(f"""\
        /*
         * Fovet SDK — Sentinelle
         * Default manifest for use case: {name}
         * THIS FILE IS OVERWRITTEN by: forge deploy-manifest --config configs/{slug}.yaml
         * Run forge first to get calibrated value_min/value_max from your dataset.
         */
        #ifndef FOVET_MODEL_MANIFEST_H
        #define FOVET_MODEL_MANIFEST_H

        #define FOVET_MODEL_ID          "{slug}"
        #define FOVET_MODEL_SENSOR      "{sensor}"
        #define FOVET_MODEL_UNIT        "{m['unit']}"
        #define FOVET_MODEL_VALUE_MIN   ({vmin}f)
        #define FOVET_MODEL_VALUE_MAX   ({vmax}f)
        #define FOVET_MODEL_LABEL_NORMAL  "normal"
        #define FOVET_MODEL_LABEL_ANOMALY "anomaly"

        #endif /* FOVET_MODEL_MANIFEST_H */
    """)


# ---------------------------------------------------------------------------
# main.cpp templates
# ---------------------------------------------------------------------------

_MAIN_CPP_HEADER = """\
/*
 * Fovet SDK — Sentinelle
 * Copyright (C) 2026 Antoine Porte. All rights reserved.
 * LGPL v3 for non-commercial use.
 * Commercial licensing: contact@fovet.eu
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
 * MQTT topic : fovet/devices/<DEVICE_ID>/readings
 * Baud rate  : 115200
 */

#include "config.h"               /* WiFi/MQTT credentials — DO NOT COMMIT */
#include "fovet_model_manifest.h" /* Forge-generated model metadata        */
"""

_MAIN_CPP_ZSCORE = (
    _MAIN_CPP_HEADER
    + """
extern "C" {{
#include "fovet/zscore.h"
#include "fovet/hal/hal_uart.h"
#include "fovet/hal/hal_time.h"
#include "fovet/hal/hal_gpio.h"
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

static FovetZScore  g_zscore;
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
    fovet_zscore_init(&g_zscore, ZSCORE_THRESHOLD, ZSCORE_MIN_SAMPLES);
    hal_uart_print("\\r\\n=== Fovet Sentinelle — {name} ===\\r\\n");
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
    bool  anomaly = fovet_zscore_update(&g_zscore, sample);
    float zscore  = fovet_zscore_get_mean(&g_zscore) != 0.0f
                    ? (sample - fovet_zscore_get_mean(&g_zscore)) / (fovet_zscore_get_stddev(&g_zscore) + 1e-9f)
                    : 0.0f;

    hal_gpio_write(LED_PIN, anomaly ? HAL_GPIO_LOW : HAL_GPIO_HIGH);

    if (g_sample_index % MQTT_PUBLISH_EVERY == 0 && g_mqtt.connected()) {{
        int n = snprintf(g_buf, sizeof(g_buf),
            "{{\\"device_id\\":\\"%s\\",\\"model_id\\":\\"" FOVET_MODEL_ID "\\","
            "\\"sensor\\":\\"" FOVET_MODEL_SENSOR "\\",\\"value\\":%.4f,"
            "\\"value_min\\":%.4f,\\"value_max\\":%.4f,"
            "\\"unit\\":\\"" FOVET_MODEL_UNIT "\\",\\"label\\":\\"%s\\","
            "\\"anomaly\\":%s,\\"ts\\":%lu}}",
            DEVICE_ID, zscore,
            (double)FOVET_MODEL_VALUE_MIN, (double)FOVET_MODEL_VALUE_MAX,
            anomaly ? FOVET_MODEL_LABEL_ANOMALY : FOVET_MODEL_LABEL_NORMAL,
            anomaly ? "true" : "false",
            (unsigned long)hal_time_ms());
        char topic[64];
        snprintf(topic, sizeof(topic), "fovet/devices/%s/readings", DEVICE_ID);
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
#include "fovet/mad.h"
#include "fovet/hal/hal_uart.h"
#include "fovet/hal/hal_time.h"
#include "fovet/hal/hal_gpio.h"
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

static FovetMAD     g_mad;
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
    fovet_mad_init(&g_mad, MAD_THRESHOLD, MAD_WINDOW_SIZE);
    hal_uart_print("\\r\\n=== Fovet Sentinelle — {name} ===\\r\\n");
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
    float mad_score = fovet_mad_score(&g_mad, sample);
    bool  anomaly   = fovet_mad_update(&g_mad, sample);

    hal_gpio_write(LED_PIN, anomaly ? HAL_GPIO_LOW : HAL_GPIO_HIGH);

    if (g_sample_index % MQTT_PUBLISH_EVERY == 0 && g_mqtt.connected()) {{
        int n = snprintf(g_buf, sizeof(g_buf),
            "{{\\"device_id\\":\\"%s\\",\\"model_id\\":\\"" FOVET_MODEL_ID "\\","
            "\\"sensor\\":\\"" FOVET_MODEL_SENSOR "\\",\\"value\\":%.4f,"
            "\\"value_min\\":%.4f,\\"value_max\\":%.4f,"
            "\\"unit\\":\\"" FOVET_MODEL_UNIT "\\",\\"label\\":\\"%s\\","
            "\\"anomaly\\":%s,\\"ts\\":%lu}}",
            DEVICE_ID, mad_score,
            (double)FOVET_MODEL_VALUE_MIN, (double)FOVET_MODEL_VALUE_MAX,
            anomaly ? FOVET_MODEL_LABEL_ANOMALY : FOVET_MODEL_LABEL_NORMAL,
            anomaly ? "true" : "false",
            (unsigned long)hal_time_ms());
        char topic[64];
        snprintf(topic, sizeof(topic), "fovet/devices/%s/readings", DEVICE_ID);
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
#include "fovet/drift.h"
#include "fovet/hal/hal_uart.h"
#include "fovet/hal/hal_time.h"
#include "fovet/hal/hal_gpio.h"
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

static FovetDrift   g_drift;
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
    fovet_drift_init(&g_drift, DRIFT_ALPHA_FAST, DRIFT_ALPHA_SLOW, DRIFT_THRESHOLD);
    hal_uart_print("\\r\\n=== Fovet Sentinelle — {name} ===\\r\\n");
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
    bool  anomaly    = fovet_drift_update(&g_drift, sample);
    float drift_mag  = fovet_drift_get_magnitude(&g_drift);

    hal_gpio_write(LED_PIN, anomaly ? HAL_GPIO_LOW : HAL_GPIO_HIGH);

    if (g_sample_index % MQTT_PUBLISH_EVERY == 0 && g_mqtt.connected()) {{
        int n = snprintf(g_buf, sizeof(g_buf),
            "{{\\"device_id\\":\\"%s\\",\\"model_id\\":\\"" FOVET_MODEL_ID "\\","
            "\\"sensor\\":\\"" FOVET_MODEL_SENSOR "\\",\\"value\\":%.4f,"
            "\\"value_min\\":%.4f,\\"value_max\\":%.4f,"
            "\\"unit\\":\\"" FOVET_MODEL_UNIT "\\",\\"label\\":\\"%s\\","
            "\\"anomaly\\":%s,\\"ts\\":%lu}}",
            DEVICE_ID, drift_mag,
            (double)FOVET_MODEL_VALUE_MIN, (double)FOVET_MODEL_VALUE_MAX,
            anomaly ? FOVET_MODEL_LABEL_ANOMALY : FOVET_MODEL_LABEL_NORMAL,
            anomaly ? "true" : "false",
            (unsigned long)hal_time_ms());
        char topic[64];
        snprintf(topic, sizeof(topic), "fovet/devices/%s/readings", DEVICE_ID);
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
/* TFLite Micro — autoencoder / lstm_autoencoder
 *
 * TODO: This template requires TFLite Micro.
 * After running forge deploy-full, model_data.h is generated in src/.
 * Include it and run inference in loop() to compute reconstruction error.
 *
 * Reference: edge-core/examples/esp32/person_detection/src/main.cpp
 */

extern "C" {{
#include "fovet/zscore.h"
#include "fovet/hal/hal_uart.h"
#include "fovet/hal/hal_time.h"
#include "fovet/hal/hal_gpio.h"
}}

#include <Arduino.h>
#include <WiFi.h>
#include <PubSubClient.h>
#include <stdio.h>

/* Placeholder — implement inference loop using TFLite Micro */
void setup(void) {{
    Serial.begin(115200);
    Serial.println("=== Fovet Sentinelle — {name} (ML placeholder) ===");
    Serial.println("TODO: implement TFLite Micro inference");
}}

void loop(void) {{
    delay(1000);
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

    Returns:
        ScaffoldResult with paths to generated config + project dir
    """
    slug = name.replace(" ", "-").lower()
    device_id = f"esp32-{slug[:16]}"

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

    # 2. platformio.ini
    ini_path = project_dir / "platformio.ini"
    ini_path.write_text(_platformio_ini(name, port), encoding="utf-8")
    files.append(ini_path)

    # 3. src/main.cpp
    template = _MAIN_TEMPLATES.get(detector, _MAIN_TEMPLATES["zscore"])
    main_cpp = template.format(name=name, slug=slug, sensor=sensor, detector=detector)
    main_cpp_path = project_dir / "src" / "main.cpp"
    main_cpp_path.write_text(main_cpp, encoding="utf-8")
    files.append(main_cpp_path)

    # 4. src/config.h.example
    config_h_path = project_dir / "src" / "config.h.example"
    config_h_path.write_text(_config_h_example(device_id), encoding="utf-8")
    files.append(config_h_path)

    # 5. src/fovet_model_manifest.h (default, replaced by deploy-manifest)
    manifest_h_path = project_dir / "src" / "fovet_model_manifest.h"
    manifest_h_path.write_text(_manifest_h_default(name, sensor, detector), encoding="utf-8")
    files.append(manifest_h_path)

    return ScaffoldResult(
        config_path=config_path,
        project_dir=project_dir,
        files_created=files,
    )
