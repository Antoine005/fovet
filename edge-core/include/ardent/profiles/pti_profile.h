/*
 * Fovet SDK — Sentinelle
 * Copyright (C) 2026 Antoine Porte. All rights reserved.
 * LGPL v3 for non-commercial use.
 * Commercial licensing: contact@fovet.eu
 *
 * -------------------------------------------------------------------------
 * pti_profile.h — Protection du Travailleur Isolé (PTI) profile
 *
 * Implements three detection modes via fovet_pti_tick(), designed to be
 * called from the main loop at ~25 Hz:
 *
 *   1. FALL       — fall-detection model score exceeds fall_threshold
 *   2. MOTIONLESS — acceleration magnitude < motion_threshold_g for
 *                   more than motionless_timeout_ms consecutively
 *   3. SOS        — GPIO button held (active-low pull-up)
 *
 * Design:
 *   - C99 pure, zero malloc, zero global state (state lives in fovet_pti_ctx_t)
 *   - Hardware access through injected callbacks (HAL biosignal + GPIO)
 *   - Fall score through an injected function pointer — swap in a TFLite
 *     Micro inference on target, or a mock in unit tests
 *   - Light sleep between samples: injected via fovet_pti_sleep_fn_t
 * -------------------------------------------------------------------------
 */

#ifndef FOVET_PTI_PROFILE_H
#define FOVET_PTI_PROFILE_H

#include <stdint.h>
#include "fovet/hal/fovet_biosignal_hal.h"

#ifdef __cplusplus
extern "C" {
#endif

/* -------------------------------------------------------------------------
 * Constants
 * ------------------------------------------------------------------------- */

/** Number of magnitude samples in the sliding window (default: 50 = 2 s @ 25 Hz). */
#define FOVET_PTI_WINDOW_SIZE   50U

/* -------------------------------------------------------------------------
 * Alert types
 * ------------------------------------------------------------------------- */

/**
 * @brief PTI alert event types.
 */
typedef enum {
    FOVET_ALERT_FALL       = 0, /**< Fall detected by model score     */
    FOVET_ALERT_MOTIONLESS = 1, /**< Worker motionless beyond timeout */
    FOVET_ALERT_SOS        = 2  /**< SOS button pressed (active-low)  */
} fovet_pti_alert_t;

/* -------------------------------------------------------------------------
 * Callback types
 * ------------------------------------------------------------------------- */

/**
 * @brief Alert notification callback.
 *
 * Called by fovet_pti_tick() when an alert condition is detected.
 * Must be fast and non-blocking (called from the main loop context).
 *
 * @param alert      Type of alert.
 * @param user_data  Opaque pointer passed to fovet_pti_init().
 */
typedef void (*fovet_pti_alert_fn_t)(fovet_pti_alert_t alert, void *user_data);

/**
 * @brief Fall detection score function.
 *
 * On target hardware: wraps TFLite Micro inference on the magnitude window.
 * In unit tests: mock returning a configurable score.
 *
 * @param magnitudes  Circular window of |a| values, length FOVET_PTI_WINDOW_SIZE,
 *                    ordered oldest-first.
 * @param n           Number of valid samples (< FOVET_PTI_WINDOW_SIZE during warm-up).
 * @return Score in [0.0, 1.0].  Values > fall_threshold trigger FOVET_ALERT_FALL.
 */
typedef float (*fovet_pti_fall_score_fn_t)(const float *magnitudes, uint32_t n);

/**
 * @brief GPIO digital read function.
 *
 * On target hardware: wraps digitalRead() or gpio_get_level().
 * In unit tests: mock returning 0 (pressed) or 1 (released).
 *
 * @param pin  GPIO pin number.
 * @return 0 if active (button pressed, active-low), non-zero otherwise.
 */
typedef int (*fovet_pti_gpio_read_fn_t)(uint8_t pin);

/**
 * @brief Sleep / light-sleep function (optional).
 *
 * Called at the end of each tick to yield the CPU.
 * On ESP32: can wrap esp_light_sleep_start() + esp_sleep_enable_timer_wakeup().
 * Set to NULL to skip sleeping.
 *
 * @param ms  Requested sleep duration in milliseconds.
 */
typedef void (*fovet_pti_sleep_fn_t)(uint32_t ms);

/* -------------------------------------------------------------------------
 * Configuration
 * ------------------------------------------------------------------------- */

/**
 * @brief PTI profile configuration.
 *
 * Use fovet_pti_default_config() to get sensible defaults, then override
 * individual fields as needed.
 */
typedef struct {
    float    fall_threshold;        /**< Model score threshold (default 0.85)         */
    float    motion_threshold_g;    /**< Immobility magnitude threshold (default 0.1) */
    uint32_t motionless_timeout_ms; /**< Duration before MOTIONLESS alert (default 30000) */
    uint8_t  sos_gpio_pin;          /**< GPIO pin for SOS button (active-low)         */
    uint32_t sleep_between_ticks_ms;/**< Sleep duration at end of tick (default 40)   */
} fovet_pti_config_t;

/* -------------------------------------------------------------------------
 * Context (opaque state — do not access fields directly)
 * ------------------------------------------------------------------------- */

/**
 * @brief PTI profile runtime context.
 *
 * Zero-initialise before calling fovet_pti_init().
 * Size: 4 + 50*4 + 4*3 + 3 = ~223 bytes on 32-bit platforms.
 */
typedef struct {
    fovet_pti_config_t        config;
    fovet_pti_alert_fn_t      alert_fn;
    fovet_pti_fall_score_fn_t fall_score_fn;
    fovet_pti_gpio_read_fn_t  gpio_read_fn;
    fovet_pti_sleep_fn_t      sleep_fn;
    void                     *user_data;

    /* Sliding magnitude window (circular buffer, oldest-first order) */
    float    mag_window[FOVET_PTI_WINDOW_SIZE];
    uint32_t window_head;   /**< Index of next write position */
    uint32_t window_count;  /**< Number of valid samples (< WINDOW_SIZE during warm-up) */

    /* Immobility tracking */
    uint32_t last_motion_ms;         /**< hal_time_ms() of last sample above threshold */
    uint8_t  motionless_alert_sent;  /**< 1 after MOTIONLESS fired; cleared on motion  */

    /* SOS tracking */
    uint8_t  sos_alert_sent;         /**< 1 after SOS fired; cleared on release        */
} fovet_pti_ctx_t;

/* -------------------------------------------------------------------------
 * Public API
 * ------------------------------------------------------------------------- */

/**
 * @brief Return a fovet_pti_config_t pre-filled with sensible defaults.
 *
 * Defaults:
 *   fall_threshold        = 0.85
 *   motion_threshold_g    = 0.1
 *   motionless_timeout_ms = 30000
 *   sos_gpio_pin          = 0
 *   sleep_between_ticks_ms = 40  (25 Hz → 40 ms/tick)
 */
fovet_pti_config_t fovet_pti_default_config(void);

/**
 * @brief Initialise a PTI context.
 *
 * Must be called before fovet_pti_tick().
 * All callbacks except sleep_fn are mandatory.
 *
 * @param ctx            Context to initialise.  Must not be NULL.
 * @param cfg            Configuration.  NULL → fovet_pti_default_config().
 * @param alert_fn       Alert notification callback.  Must not be NULL.
 * @param fall_score_fn  Fall score function.  Must not be NULL.
 * @param gpio_read_fn   GPIO read function.  Must not be NULL.
 * @param sleep_fn       Light-sleep function.  NULL = no sleep.
 * @param user_data      Passed through to alert_fn.
 */
void fovet_pti_init(fovet_pti_ctx_t          *ctx,
                    const fovet_pti_config_t  *cfg,
                    fovet_pti_alert_fn_t       alert_fn,
                    fovet_pti_fall_score_fn_t  fall_score_fn,
                    fovet_pti_gpio_read_fn_t   gpio_read_fn,
                    fovet_pti_sleep_fn_t       sleep_fn,
                    void                      *user_data);

/**
 * @brief Run one PTI detection cycle.
 *
 * Sequence:
 *   1. Read IMU via fovet_hal_biosignal_read(FOVET_SOURCE_IMU).
 *   2. Compute |a| = sqrt(ax²+ay²+az²).
 *   3. Push |a| to sliding window.
 *   4. If window full: compute fall score; if > threshold → FOVET_ALERT_FALL.
 *   5. If |a| < motion_threshold_g: check timeout → FOVET_ALERT_MOTIONLESS.
 *      Else: clear motionless state.
 *   6. If gpio_read_fn(sos_gpio_pin) == 0 → FOVET_ALERT_SOS.
 *   7. If sleep_fn != NULL: call sleep_fn(sleep_between_ticks_ms).
 *
 * @param ctx  Initialised context.  Must not be NULL.
 *
 * @return FOVET_HAL_OK on success, FOVET_MPU_ERR_I2C if IMU read fails.
 */
int fovet_pti_tick(fovet_pti_ctx_t *ctx);

/**
 * @brief Reset alert debounce flags (e.g. after alert was acknowledged).
 *
 * Clears motionless_alert_sent and sos_alert_sent so the same condition
 * can fire again.
 *
 * @param ctx  Context to reset.  Must not be NULL.
 */
void fovet_pti_reset_alerts(fovet_pti_ctx_t *ctx);

#ifdef __cplusplus
}
#endif

#endif /* FOVET_PTI_PROFILE_H */
