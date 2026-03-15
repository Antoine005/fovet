/*
 * Fovet SDK — Sentinelle
 * Copyright (C) 2026 Antoine Porte. All rights reserved.
 * LGPL v3 for non-commercial use.
 * Commercial licensing: contact@fovet.eu
 */

#ifndef FOVET_ZSCORE_H
#define FOVET_ZSCORE_H

#include <stdint.h>
#include <stdbool.h>

#ifdef __cplusplus
extern "C" {
#endif

/**
 * @brief Z-Score anomaly detector context.
 *
 * Uses Welford's online algorithm for numerically stable mean/variance
 * computation in a single pass. No dynamic allocation — stack or static only.
 *
 * Windowed mode (window_size > 0):
 *   Stats automatically reset every window_size samples so the detector
 *   adapts its baseline to the most recent regime. Useful for long-running
 *   sensors where slow drift would otherwise corrupt the running mean.
 *   Set window_size = 0 (default) to disable (infinite window).
 *
 * RAM usage: sizeof(FovetZScore) = 24 bytes.
 */
typedef struct {
    uint32_t count;           /**< Number of samples processed (saturates at UINT32_MAX) */
    float    mean;            /**< Running mean */
    float    M2;              /**< Running sum of squared deviations */
    float    threshold_sigma; /**< Anomaly threshold (e.g. 3.0f = 3σ) */
    uint32_t min_samples;     /**< Warm-up: detection suppressed until count >= min_samples */
    uint32_t window_size;     /**< Auto-reset period: 0 = disabled (infinite window) */
} FovetZScore;

/**
 * @brief Initialize a Z-Score detector.
 * @param ctx             Pointer to detector context (must not be NULL)
 * @param threshold_sigma Anomaly threshold in standard deviations (e.g. 3.0f)
 * @param min_samples     Warm-up period — no anomaly flagged before this many samples.
 *                        Minimum enforced to 2 (variance requires at least 2 samples).
 *                        Pass 0 for a pre-calibrated struct (Forge-exported header).
 */
void fovet_zscore_init(FovetZScore *ctx, float threshold_sigma, uint32_t min_samples);

/**
 * @brief Feed a new sample and check for anomaly.
 *
 * Updates the running statistics and returns true if the sample deviates
 * more than threshold_sigma from the current mean AND count >= min_samples.
 * count saturates at UINT32_MAX — stats stop updating beyond that point.
 *
 * @param ctx    Pointer to detector context
 * @param sample New measurement
 * @return true  if sample is an anomaly, false otherwise
 */
bool fovet_zscore_update(FovetZScore *ctx, float sample);

/**
 * @brief Get current running mean.
 * @param ctx Pointer to detector context (const)
 * @return Current mean value
 */
float fovet_zscore_get_mean(const FovetZScore *ctx);

/**
 * @brief Get current standard deviation.
 * @param ctx Pointer to detector context (const)
 * @return Current standard deviation (0.0f if count < 2)
 */
float fovet_zscore_get_stddev(const FovetZScore *ctx);

/**
 * @brief Get current sample count.
 * @param ctx Pointer to detector context (const)
 * @return Number of samples processed so far
 */
uint32_t fovet_zscore_get_count(const FovetZScore *ctx);

/**
 * @brief Reset detector stats to initial state.
 *        Preserves threshold_sigma, min_samples, and window_size.
 * @param ctx Pointer to detector context
 */
void fovet_zscore_reset(FovetZScore *ctx);

/**
 * @brief Configure windowed (adaptive) mode.
 *
 * When window_size > 0, stats automatically reset every window_size samples
 * so the baseline tracks the most recent signal regime. This prevents slow
 * drift from being absorbed by the running mean.
 *
 * The reset fires AFTER the window_size-th sample is evaluated (no missed
 * detection at the boundary). After a reset there is a brief warm-up gap
 * of min_samples before detection resumes.
 *
 * @param ctx         Pointer to detector context
 * @param window_size Samples per window. Must be 0 (disable) or >= min_samples.
 * @return true  on success
 * @return false if window_size > 0 and window_size < min_samples (invalid)
 */
bool fovet_zscore_set_window(FovetZScore *ctx, uint32_t window_size);

#ifdef __cplusplus
}
#endif

#endif /* FOVET_ZSCORE_H */
