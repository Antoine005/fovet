/*
 * Fovet SDK — Sentinelle
 * Copyright (C) 2026 Antoine Porte. All rights reserved.
 * LGPL v3 for non-commercial use.
 * Commercial licensing: contact@fovet.eu
 *
 * fovet_mad.h — Streaming Median Absolute Deviation (MAD) anomaly detector
 *
 * Uses a fixed-size circular ring buffer (FOVET_MAD_WINDOW samples).
 * On each update, the window is copied and insertion-sorted to derive
 * median and MAD.  Score = |x - median| / (1.4826 * MAD).
 *
 * Constraints:
 *   - Zero dynamic allocation (ring buffer on stack / static)
 *   - RAM: 2 * FOVET_MAD_WINDOW * sizeof(float)  (window + sort scratch)
 *     Default window = 32 → 256 bytes per detector
 *   - Warm-up: first FOVET_MAD_WINDOW samples fill the buffer; no anomaly
 *     detection until the buffer is full
 *
 * Usage:
 *   FovetMAD ctx;
 *   fovet_mad_init(&ctx, 32, 3.5f);
 *   bool anomaly = fovet_mad_update(&ctx, sample);
 */

#ifndef FOVET_MAD_H
#define FOVET_MAD_H

#include <stdbool.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/* Maximum supported window size (compile-time cap to bound stack usage).
 * Override by defining FOVET_MAD_MAX_WINDOW before including this header. */
#ifndef FOVET_MAD_MAX_WINDOW
#define FOVET_MAD_MAX_WINDOW 128
#endif

/**
 * MAD detector context.
 *
 * Fields are public for static initialisation but should only be written
 * through fovet_mad_init().
 */
typedef struct {
    float    window[FOVET_MAD_MAX_WINDOW]; /**< ring buffer of recent samples */
    float    scratch[FOVET_MAD_MAX_WINDOW];/**< sort scratch — do not use directly */
    uint16_t head;                          /**< next write position in ring buffer */
    uint16_t count;                         /**< samples seen so far (caps at win_size) */
    uint16_t win_size;                      /**< effective window size (≤ FOVET_MAD_MAX_WINDOW) */
    float    threshold_mad;                 /**< anomaly threshold in MAD units (e.g. 3.5) */
} FovetMAD;

/**
 * Initialise a MAD detector context.
 *
 * @param ctx            Pointer to an uninitialised FovetMAD struct.
 * @param win_size       Window size in samples (1 … FOVET_MAD_MAX_WINDOW).
 *                       Clamped to FOVET_MAD_MAX_WINDOW if larger.
 * @param threshold_mad  Anomaly threshold in MAD units.  3.5 is a common
 *                       choice (roughly equivalent to 3σ for Gaussian data).
 */
void fovet_mad_init(FovetMAD *ctx, uint16_t win_size, float threshold_mad);

/**
 * Feed a new sample and check for anomaly.
 *
 * During warm-up (fewer than win_size samples seen) always returns false.
 *
 * @param ctx    Pointer to an initialised FovetMAD struct.
 * @param sample New measurement value.
 * @return       true if the sample is an anomaly, false otherwise.
 */
bool fovet_mad_update(FovetMAD *ctx, float sample);

/**
 * Compute the current median of the window.
 *
 * Returns 0.0f if the buffer is empty.
 */
float fovet_mad_get_median(const FovetMAD *ctx);

/**
 * Compute the current MAD of the window.
 *
 * MAD = median(|x_i - median(x)|).
 * Returns 0.0f if the buffer is empty.
 */
float fovet_mad_get_mad(const FovetMAD *ctx);

/**
 * Compute the MAD-based anomaly score for a value against the current window.
 *
 * score = |value - median| / (1.4826 * MAD)
 *
 * When MAD == 0 (constant signal), returns 0.0f for values equal to the
 * median and a large sentinel (1e9f) for any deviation.
 *
 * @param ctx   Pointer to an initialised FovetMAD struct.
 * @param value Value to score.
 * @return      Normalised distance from median in MAD units.
 */
float fovet_mad_score(const FovetMAD *ctx, float value);

#ifdef __cplusplus
}
#endif

#endif /* FOVET_MAD_H */
