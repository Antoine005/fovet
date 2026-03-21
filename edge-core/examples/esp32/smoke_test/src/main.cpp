/*
 * Fovet SDK — Sentinelle
 * Copyright (C) 2026 Antoine Porte. All rights reserved.
 * LGPL v3 for non-commercial use.
 * Commercial licensing: contact@fovet.eu
 *
 * smoke_test/main.cpp — minimal first-flash SDK smoke test.
 *
 * No WiFi. No MQTT. No credentials.
 *
 * What it does:
 *   - Synthesises a 1 Hz sine wave at 100 Hz (sample every 10 ms)
 *   - Feeds each sample into fovet_zscore_update()
 *   - Every 200 samples injects a ±5σ spike (alternating + and −)
 *   - Blinks the onboard LED (pin 4, active LOW) on every detection
 *   - Prints one CSV line per sample on Serial at 115200 baud
 *
 * Serial output columns:
 *   idx, value, mean, stddev, zscore, anomaly, event
 *
 * Expected behaviour:
 *   - Samples 0–29: warm-up (no detections)
 *   - Every 200th sample after warm-up: detection printed + LED blink
 *   - All other samples: no false positives on a clean sine wave
 *
 * Flash:   pio run -e smoke --target upload
 * Monitor: pio device monitor -e smoke
 */

extern "C" {
#include "fovet/zscore.h"
#include "fovet/hal/hal_uart.h"
#include "fovet/hal/hal_time.h"
#include "fovet/hal/hal_gpio.h"
}

#include <Arduino.h>
#include <math.h>
#include <stdio.h>

/* -------------------------------------------------------------------------
 * Hardware
 * ------------------------------------------------------------------------- */

#define LED_PIN           4U      /* ESP32-CAM onboard LED, active LOW */

/* -------------------------------------------------------------------------
 * Detector configuration
 * ------------------------------------------------------------------------- */

#define ZSCORE_THRESHOLD  3.0f
#define ZSCORE_MIN_SAMP   30U

/* Sampling */
#define SAMPLE_PERIOD_MS  10U    /* 100 Hz */
#define SPIKE_EVERY       200U   /* Inject a ±5σ spike every N samples */

/* -------------------------------------------------------------------------
 * Globals
 * ------------------------------------------------------------------------- */

static FovetZScore g_zscore;
static uint32_t   g_idx         = 0;
static char       g_buf[128];

/* -------------------------------------------------------------------------
 * Arduino entry points
 * ------------------------------------------------------------------------- */

void setup(void)
{
    hal_uart_init(115200);
    /* 2-second window for the CH340 to enumerate and the monitor to connect
     * before printing the header — without this, the first lines are lost. */
    hal_delay_ms(2000);

    hal_gpio_set_mode(LED_PIN, HAL_GPIO_MODE_OUTPUT);
    hal_gpio_write(LED_PIN, HAL_GPIO_HIGH); /* LED off (active LOW) */

    fovet_zscore_init(&g_zscore, ZSCORE_THRESHOLD, ZSCORE_MIN_SAMP);

    hal_uart_print("\r\n=== Fovet Sentinelle — Smoke Test ===\r\n");
    hal_uart_print("Signal : 1 Hz sine @ 100 Hz sample rate\r\n");
    hal_uart_print("Spikes : alternating ±5σ every 200 samples\r\n");
    hal_uart_print("LED    : blinks on detection (pin 4, active LOW)\r\n");
    hal_uart_print("CSV    : idx,value,mean,stddev,zscore,anomaly,event\r\n\r\n");
}

void loop(void)
{
    static uint32_t last_ms = 0;
    uint32_t now = hal_time_ms();

    if ((now - last_ms) < SAMPLE_PERIOD_MS) return;
    last_ms = now;

    /* --- Synthesise signal ------------------------------------------------ */

    float t      = (float)g_idx * (SAMPLE_PERIOD_MS * 0.001f); /* time in s */
    float sample = sinf(2.0f * (float)M_PI * 1.0f * t);         /* 1 Hz     */

    const char *event = "";
    bool        spike_injected = false;

    /* Inject alternating ±5σ spike after warm-up */
    if (g_idx >= ZSCORE_MIN_SAMP && (g_idx % SPIKE_EVERY) == 0U) {
        float mean   = fovet_zscore_get_mean(&g_zscore);
        float stddev = fovet_zscore_get_stddev(&g_zscore);
        float amp    = 5.0f * stddev + 0.1f; /* +0.1 ensures above threshold even if stddev is tiny */
        sample += (g_idx / SPIKE_EVERY % 2U == 0U) ? amp : -amp;
        spike_injected = true;
        event = (g_idx / SPIKE_EVERY % 2U == 0U) ? "<+5SIGMA>" : "<-5SIGMA>";
    }

    /* --- Run detector ----------------------------------------------------- */

    bool anomaly = fovet_zscore_update(&g_zscore, sample);

    float mean    = fovet_zscore_get_mean(&g_zscore);
    float stddev  = fovet_zscore_get_stddev(&g_zscore);
    float zscore  = (stddev > 1e-6f) ? ((sample - mean) / stddev) : 0.0f;

    /* --- LED feedback ----------------------------------------------------- */

    hal_gpio_write(LED_PIN, anomaly ? HAL_GPIO_LOW : HAL_GPIO_HIGH);

    /* --- Serial CSV ------------------------------------------------------- */

    snprintf(g_buf, sizeof(g_buf),
             "%lu,%.4f,%.4f,%.4f,%.4f,%d,%s\r\n",
             (unsigned long)g_idx,
             sample, mean, stddev, zscore,
             (int)anomaly, event);
    hal_uart_print(g_buf);

    (void)spike_injected; /* suppress unused warning */
    g_idx++;
}
