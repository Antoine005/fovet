/*
 * Fovet SDK — Sentinelle
 * Copyright (C) 2026 Antoine Porte. All rights reserved.
 * LGPL v3 for non-commercial use.
 * Commercial licensing: contact@fovet.eu
 *
 * -------------------------------------------------------------------------
 * fatigue_profile.h — HRV-based fatigue classification profile (H2.3)
 *
 * Runs at ~25 Hz consuming the FOVET_SOURCE_HR biosignal (MAX30102).
 * Classifies worker fatigue into three levels:
 *
 *   FOVET_FATIGUE_LEVEL_OK       BPM < hr_ok   AND SpO2 ≥ spo2_critical
 *   FOVET_FATIGUE_LEVEL_ALERT    hr_ok ≤ BPM ≤ hr_alert
 *   FOVET_FATIGUE_LEVEL_CRITICAL BPM > hr_alert OR SpO2 < spo2_critical
 *
 * BPM is tracked through an Exponential Moving Average (alpha = 0.05).
 * SpO2 check takes priority — it fires CRITICAL regardless of BPM.
 *
 * Design:
 *   - C99 pure, zero malloc — state lives in fovet_fatigue_ctx_t.
 *   - Hardware access through injected callbacks (LED, sleep).
 *   - HR data read via fovet_hal_biosignal_read(FOVET_SOURCE_HR).
 *   - Alert callback fired only when level changes (no flood).
 *   - LED callback fired every tick (keeps LED lit; impl may blink in CRITICAL).
 *   - Default thresholds compatible with FatigueHRVPipeline export (H2.2):
 *       hr_ok   = 72.0 bpm, hr_alert = 82.0 bpm, spo2_critical = 94.0 %
 *
 * Typical integration:
 *   1. Initialize MAX30102:  fovet_max30102_init() — registers FOVET_SOURCE_HR.
 *   2. Initialize profile:   fovet_fatigue_init(&ctx, NULL, alert_fn, led_fn, NULL, NULL).
 *   3. Main loop at 25 Hz:  fovet_fatigue_tick(&ctx).
 * -------------------------------------------------------------------------
 */

#ifndef FOVET_FATIGUE_PROFILE_H
#define FOVET_FATIGUE_PROFILE_H

#include <stdint.h>
#include "fovet/hal/fovet_biosignal_hal.h"

#ifdef __cplusplus
extern "C" {
#endif

/* -------------------------------------------------------------------------
 * Default threshold constants
 * These match the expected output of FatigueHRVPipeline.export() (H2.2).
 * Override via fovet_fatigue_config_t if using custom thresholds.
 * ------------------------------------------------------------------------- */

/** BPM below this → OK. */
#define FOVET_FATIGUE_DEFAULT_HR_OK          72.0f

/** BPM above this → CRITICAL. */
#define FOVET_FATIGUE_DEFAULT_HR_ALERT       82.0f

/** SpO₂ below this → CRITICAL (priority check). */
#define FOVET_FATIGUE_DEFAULT_SPO2_CRITICAL  94.0f

/** EMA smoothing factor (α = 0.05 ≈ 20-sample memory). */
#define FOVET_FATIGUE_DEFAULT_EMA_ALPHA      0.05f

/** Samples before first classification (1 s at 25 Hz). */
#define FOVET_FATIGUE_DEFAULT_WARMUP         25U

/** Tick period for 25 Hz loop (ms). */
#define FOVET_FATIGUE_DEFAULT_SLEEP_MS       40U

/* -------------------------------------------------------------------------
 * Fatigue levels
 * ------------------------------------------------------------------------- */

/**
 * @brief Three-level fatigue classification.
 */
typedef enum {
    FOVET_FATIGUE_LEVEL_UNKNOWN  = 0, /**< Warm-up — no classification yet  */
    FOVET_FATIGUE_LEVEL_OK       = 1, /**< Normal — green LED                */
    FOVET_FATIGUE_LEVEL_ALERT    = 2, /**< Elevated HR — amber LED           */
    FOVET_FATIGUE_LEVEL_CRITICAL = 3  /**< High HR or low SpO₂ — red LED    */
} fovet_fatigue_level_t;

/* -------------------------------------------------------------------------
 * Callback types
 * ------------------------------------------------------------------------- */

/**
 * @brief Alert notification callback.
 *
 * Fired when fatigue level changes.  Must be fast and non-blocking.
 *
 * @param level      New fatigue level.
 * @param user_data  Opaque pointer from fovet_fatigue_init().
 */
typedef void (*fovet_fatigue_alert_fn_t)(fovet_fatigue_level_t level, void *user_data);

/**
 * @brief RGB LED update callback.
 *
 * Called on every tick when level != UNKNOWN.
 * Typical mapping: OK→green, ALERT→amber, CRITICAL→red.
 *
 * @param level  Current fatigue level.
 */
typedef void (*fovet_fatigue_led_fn_t)(fovet_fatigue_level_t level);

/**
 * @brief Light-sleep callback (optional).
 *
 * Called at the end of each tick.  NULL = no sleep.
 *
 * @param ms  Requested sleep duration in milliseconds.
 */
typedef void (*fovet_fatigue_sleep_fn_t)(uint32_t ms);

/* -------------------------------------------------------------------------
 * Configuration
 * ------------------------------------------------------------------------- */

/**
 * @brief Fatigue profile configuration.
 *
 * Use fovet_fatigue_default_config() to get sensible defaults.
 * Override individual fields to apply exported thresholds from H2.2.
 */
typedef struct {
    float    hr_ok;                  /**< BPM < this → OK              (default 72.0) */
    float    hr_alert;               /**< BPM > this → CRITICAL         (default 82.0) */
    float    spo2_critical;          /**< SpO₂ < this → CRITICAL        (default 94.0) */
    float    ema_alpha;              /**< EMA smoothing factor           (default 0.05) */
    uint32_t warmup_samples;         /**< Samples before classifying     (default 25)   */
    uint32_t sleep_between_ticks_ms; /**< Tick sleep duration (ms)       (default 40)   */
} fovet_fatigue_config_t;

/* -------------------------------------------------------------------------
 * Context (opaque — do not access fields directly)
 * ------------------------------------------------------------------------- */

/**
 * @brief Fatigue profile runtime context.
 *
 * Zero-initialise before calling fovet_fatigue_init().
 * Size: ≈ 40 bytes on 32-bit platforms.
 */
typedef struct {
    fovet_fatigue_config_t   config;
    fovet_fatigue_alert_fn_t alert_fn;
    fovet_fatigue_led_fn_t   led_fn;
    fovet_fatigue_sleep_fn_t sleep_fn;
    void                    *user_data;

    float                 ema_bpm;      /**< Exponential moving average of BPM */
    uint32_t              sample_count; /**< Total valid HR samples received    */
    fovet_fatigue_level_t last_level;   /**< Level at end of previous tick      */
} fovet_fatigue_ctx_t;

/* -------------------------------------------------------------------------
 * Public API
 * ------------------------------------------------------------------------- */

/**
 * @brief Return a fovet_fatigue_config_t pre-filled with sensible defaults.
 *
 * Defaults:
 *   hr_ok   = 72.0 bpm, hr_alert = 82.0 bpm, spo2_critical = 94.0 %
 *   ema_alpha = 0.05, warmup_samples = 25, sleep = 40 ms
 */
fovet_fatigue_config_t fovet_fatigue_default_config(void);

/**
 * @brief Initialise a fatigue profile context.
 *
 * Must be called before fovet_fatigue_tick().
 * FOVET_SOURCE_HR must already be registered in the biosignal HAL
 * (call fovet_max30102_init() first on hardware).
 *
 * @param ctx       Context to initialise.  Must not be NULL.
 * @param cfg       Configuration.  NULL → fovet_fatigue_default_config().
 * @param alert_fn  Level-change callback.  NULL = silent.
 * @param led_fn    LED update callback.    NULL = no LED.
 * @param sleep_fn  Light-sleep callback.   NULL = no sleep.
 * @param user_data Passed through to alert_fn.
 */
void fovet_fatigue_init(fovet_fatigue_ctx_t           *ctx,
                        const fovet_fatigue_config_t  *cfg,
                        fovet_fatigue_alert_fn_t       alert_fn,
                        fovet_fatigue_led_fn_t         led_fn,
                        fovet_fatigue_sleep_fn_t       sleep_fn,
                        void                          *user_data);

/**
 * @brief Run one fatigue detection cycle.
 *
 * Sequence:
 *   1. Read HR via fovet_hal_biosignal_read(FOVET_SOURCE_HR, &sample).
 *   2. If NODATA (sensor warming up): sleep and return FOVET_HAL_OK.
 *   3. Update EMA BPM.
 *   4. Increment sample_count.
 *   5. Classify: UNKNOWN (< warmup) / OK / ALERT / CRITICAL.
 *   6. If SpO₂ < spo2_critical → CRITICAL (overrides step 5).
 *   7. If level changed: call alert_fn if not NULL.
 *   8. If level != UNKNOWN: call led_fn if not NULL.
 *   9. If sleep_fn != NULL: call sleep_fn(sleep_between_ticks_ms).
 *
 * @param ctx  Initialised context.  Must not be NULL.
 *
 * @return FOVET_HAL_OK on success or NODATA.
 *         Negative error code on HR I2C failure.
 */
int fovet_fatigue_tick(fovet_fatigue_ctx_t *ctx);

/**
 * @brief Return the current fatigue level.
 *
 * @param ctx  Initialised context.
 * @return Current fovet_fatigue_level_t.  UNKNOWN before first classification.
 */
fovet_fatigue_level_t fovet_fatigue_get_level(const fovet_fatigue_ctx_t *ctx);

#ifdef __cplusplus
}
#endif

#endif /* FOVET_FATIGUE_PROFILE_H */
