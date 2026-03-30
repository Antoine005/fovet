/*
 * Ardent SDK — Pulse
 * Copyright (C) 2026 Antoine Porte. All rights reserved.
 * LGPL v3 for non-commercial use.
 * Commercial licensing: contact@ardent.io
 */

#ifndef ARD_DRIFT_H
#define ARD_DRIFT_H

#include <stdint.h>
#include <stdbool.h>

#ifdef __cplusplus
extern "C" {
#endif

/**
 * @brief EWMA-based drift detector context.
 *
 * Detects slow drift by comparing a fast Exponential Weighted Moving Average
 * (short memory) against a slow EWMA (long memory). When the gap between the
 * two exceeds the threshold, a drift is signalled.
 *
 * The Z-Score detector catches sudden spikes; this detector catches gradual
 * shifts that would otherwise be absorbed by Welford's running mean.
 *
 * No dynamic allocation — stack or static only.
 *
 * RAM usage: sizeof(ArdentDrift) = 24 bytes.
 *
 * Typical parameters:
 *   alpha_fast = 0.10f  → ~10 sample memory
 *   alpha_slow = 0.01f  → ~100 sample memory
 *   threshold  = 3.0f   → alert when fast deviates 3 units from slow
 *                          (set in the signal's natural units)
 */
typedef struct {
    float    ewma_fast;   /**< Fast exponential moving average */
    float    ewma_slow;   /**< Slow exponential moving average (baseline) */
    float    alpha_fast;  /**< Fast smoothing factor (0 < alpha_fast <= 1) */
    float    alpha_slow;  /**< Slow smoothing factor (0 < alpha_slow < alpha_fast) */
    float    threshold;   /**< Drift alert threshold (signal units) */
    uint32_t count;       /**< Sample count — first sample seeds both EMAs */
} ArdentDrift;

/**
 * @brief Initialize a drift detector.
 * @param ctx        Pointer to detector context (must not be NULL)
 * @param alpha_fast Fast smoothing factor (e.g. 0.1f — ~10 sample memory)
 * @param alpha_slow Slow smoothing factor (e.g. 0.01f — ~100 sample memory)
 * @param threshold  Alert threshold in signal units (e.g. 3.0f)
 *
 * Constraint: alpha_slow < alpha_fast. If violated, values are swapped.
 */
void ard_drift_init(ArdentDrift *ctx,
                      float alpha_fast,
                      float alpha_slow,
                      float threshold);

/**
 * @brief Feed a new sample and check for drift.
 *
 * On the first call, both EMAs are seeded with the sample value (no alert).
 * Drift is signalled when |ewma_fast - ewma_slow| > threshold.
 *
 * @param ctx    Pointer to detector context
 * @param sample New measurement
 * @return true  if drift is detected, false otherwise
 */
bool ard_drift_update(ArdentDrift *ctx, float sample);

/**
 * @brief Get current fast EWMA value.
 * @param ctx Pointer to detector context (const)
 * @return Fast EMA value
 */
float ard_drift_get_fast(const ArdentDrift *ctx);

/**
 * @brief Get current slow EWMA value (baseline).
 * @param ctx Pointer to detector context (const)
 * @return Slow EMA value
 */
float ard_drift_get_slow(const ArdentDrift *ctx);

/**
 * @brief Get current drift magnitude (|fast - slow|).
 * @param ctx Pointer to detector context (const)
 * @return Absolute difference between fast and slow EMAs
 */
float ard_drift_get_magnitude(const ArdentDrift *ctx);

/**
 * @brief Reset detector to initial state (preserves parameters).
 * @param ctx Pointer to detector context
 */
void ard_drift_reset(ArdentDrift *ctx);

#ifdef __cplusplus
}
#endif

#endif /* ARD_DRIFT_H */
