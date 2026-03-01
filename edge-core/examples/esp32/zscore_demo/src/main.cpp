/*
 * Fovet SDK — Sentinelle
 * Copyright (C) 2026 Antoine Porte. All rights reserved.
 * LGPL v3 for non-commercial use.
 * Commercial licensing: contact@fovet.eu
 *
 * Demo: Z-Score anomaly detection on ESP32-CAM
 *
 * Generates a synthetic sine wave sampled at ~100 Hz and injects a
 * 5-sigma spike every 200 samples to validate the detector.
 *
 * Wiring:
 *   ESP32-CAM GPIO1 (TX) → FTDI RX
 *   ESP32-CAM GPIO3 (RX) → FTDI TX
 *   GND ↔ GND
 *
 * Open serial monitor at 115200 baud.
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

/* ESP32-CAM onboard LED (active LOW) */
#define LED_PIN  4

/* Sampling period */
#define SAMPLE_PERIOD_MS  10U   /* 100 Hz */

/* Inject anomaly every N samples */
#define ANOMALY_EVERY     200U

/* Z-score threshold */
#define ZSCORE_THRESHOLD  3.0f

static FovetZScore g_detector;
static uint32_t    g_sample_index = 0;
static char        g_log_buf[128];

/* -------------------------------------------------------------------------
 * Setup
 * ------------------------------------------------------------------------- */

void setup(void)
{
    hal_uart_init(115200);
    hal_gpio_set_mode(LED_PIN, HAL_GPIO_MODE_OUTPUT);
    hal_gpio_write(LED_PIN, HAL_GPIO_HIGH); /* LED off (active LOW) */

    fovet_zscore_init(&g_detector, ZSCORE_THRESHOLD);

    hal_uart_print("\r\n=== Fovet Sentinelle — Z-Score Demo ===\r\n");
    hal_uart_print("Signal: sine wave, 100 Hz, anomaly injected every 200 samples\r\n");
    hal_uart_print("Format: index,sample,mean,stddev,anomaly\r\n\r\n");
}

/* -------------------------------------------------------------------------
 * Loop
 * ------------------------------------------------------------------------- */

void loop(void)
{
    static uint32_t last_sample_ms = 0;
    uint32_t now = hal_time_ms();

    if ((now - last_sample_ms) < SAMPLE_PERIOD_MS) {
        return;
    }
    last_sample_ms = now;

    /* Generate synthetic signal */
    float t      = (float)g_sample_index * 0.01f; /* seconds at 100 Hz */
    float signal = sinf(2.0f * (float)M_PI * 1.0f * t); /* 1 Hz sine */

    /* Inject spike every ANOMALY_EVERY samples */
    bool injected = false;
    if (g_sample_index > 50U && (g_sample_index % ANOMALY_EVERY) == 0U) {
        /* After warm-up, add 5σ above current mean */
        float spike_amplitude = fovet_zscore_get_mean(&g_detector)
                              + 5.0f * fovet_zscore_get_stddev(&g_detector)
                              + 1.0f; /* ensure non-zero spike even at start */
        signal  += spike_amplitude;
        injected = true;
    }

    /* Run detector */
    bool anomaly = fovet_zscore_update(&g_detector, signal);

    /* Blink LED on anomaly (active LOW on ESP32-CAM) */
    if (anomaly) {
        hal_gpio_write(LED_PIN, HAL_GPIO_LOW);
    } else {
        hal_gpio_write(LED_PIN, HAL_GPIO_HIGH);
    }

    /* Log CSV line */
    snprintf(g_log_buf, sizeof(g_log_buf),
             "%lu,%.4f,%.4f,%.4f,%d%s\r\n",
             (unsigned long)g_sample_index,
             signal,
             fovet_zscore_get_mean(&g_detector),
             fovet_zscore_get_stddev(&g_detector),
             (int)anomaly,
             injected ? " <-- INJECTED" : "");
    hal_uart_print(g_log_buf);

    g_sample_index++;
}
