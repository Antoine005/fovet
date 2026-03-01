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
 * RAM usage: sizeof(FovetZScore) = 16 bytes.
 */
typedef struct {
    uint32_t count;           /**< Number of samples processed */
    float    mean;            /**< Running mean */
    float    M2;              /**< Running sum of squared deviations */
    float    threshold_sigma; /**< Anomaly threshold (e.g. 3.0f = 3σ) */
} FovetZScore;

/**
 * @brief Initialize a Z-Score detector.
 * @param ctx             Pointer to detector context (must not be NULL)
 * @param threshold_sigma Anomaly threshold in standard deviations (e.g. 3.0f)
 */
void fovet_zscore_init(FovetZScore *ctx, float threshold_sigma);

/**
 * @brief Feed a new sample and check for anomaly.
 *
 * Updates the running statistics and returns true if the sample deviates
 * more than threshold_sigma from the current mean.
 * The first two samples are never flagged as anomalies (variance undefined).
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
 * @brief Reset detector to initial state (preserves threshold).
 * @param ctx Pointer to detector context
 */
void fovet_zscore_reset(FovetZScore *ctx);

#ifdef __cplusplus
}
#endif

#endif /* FOVET_ZSCORE_H */
