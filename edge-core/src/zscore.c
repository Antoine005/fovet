/*
 * Fovet SDK — Sentinelle
 * Copyright (C) 2026 Antoine Porte. All rights reserved.
 * LGPL v3 for non-commercial use.
 * Commercial licensing: contact@fovet.eu
 */

#include "fovet/zscore.h"

#include <math.h>    /* sqrtf, fabsf */
#include <stdint.h>  /* UINT32_MAX   */

/* -------------------------------------------------------------------------
 * Welford's online algorithm — single-pass, zero malloc, numerically stable
 *
 *   mean_n = mean_{n-1} + (x - mean_{n-1}) / n
 *   M2_n   = M2_{n-1}  + (x - mean_{n-1}) * (x - mean_n)
 *   var_n  = M2_n / (n - 1)   (sample variance, unbiased)
 * ------------------------------------------------------------------------- */

void fovet_zscore_init(FovetZScore *ctx, float threshold_sigma, uint32_t min_samples)
{
    ctx->count           = 0U;
    ctx->mean            = 0.0f;
    ctx->M2              = 0.0f;
    ctx->threshold_sigma = threshold_sigma;
    /* Enforce minimum of 2: variance is undefined with fewer than 2 samples */
    ctx->min_samples     = (min_samples >= 2U) ? min_samples : 2U;
    ctx->window_size     = 0U; /* disabled by default — infinite window */
}

bool fovet_zscore_update(FovetZScore *ctx, float sample)
{
    /* Saturate count at UINT32_MAX to avoid overflow on very long sessions */
    if (ctx->count < UINT32_MAX) {
        ctx->count++;

        /* Welford update */
        float delta  = sample - ctx->mean;
        ctx->mean   += delta / (float)ctx->count;
        float delta2 = sample - ctx->mean;
        ctx->M2     += delta * delta2;
    }

    /* Warm-up guard: suppress detection until enough samples seen */
    if (ctx->count < ctx->min_samples) {
        return false;
    }

    /* Need at least 2 samples for a meaningful variance */
    if (ctx->count < 2U) {
        return false;
    }

    float variance = ctx->M2 / (float)(ctx->count - 1U);
    float stddev   = sqrtf(variance);

    if (stddev < 1e-10f) {
        /* Signal is flat — only flag exact non-zero deviations */
        return (fabsf(sample - ctx->mean) > 1e-10f);
    }

    float z      = fabsf(sample - ctx->mean) / stddev;
    bool  result = (z > ctx->threshold_sigma);

    /* Windowed mode: auto-reset stats after every window_size samples so
     * the baseline tracks the most recent signal regime.
     * Reset fires AFTER the anomaly check — the boundary sample is evaluated
     * against the current window's statistics before the stats are discarded. */
    if (ctx->window_size > 0U && ctx->count >= ctx->window_size) {
        fovet_zscore_reset(ctx);
    }

    return result;
}

float fovet_zscore_get_mean(const FovetZScore *ctx)
{
    return ctx->mean;
}

float fovet_zscore_get_stddev(const FovetZScore *ctx)
{
    if (ctx->count < 2U) {
        return 0.0f;
    }
    float variance = ctx->M2 / (float)(ctx->count - 1U);
    return sqrtf(variance);
}

uint32_t fovet_zscore_get_count(const FovetZScore *ctx)
{
    return ctx->count;
}

void fovet_zscore_reset(FovetZScore *ctx)
{
    float    saved_threshold   = ctx->threshold_sigma;
    uint32_t saved_min_samples = ctx->min_samples;
    uint32_t saved_window_size = ctx->window_size;
    fovet_zscore_init(ctx, saved_threshold, saved_min_samples);
    ctx->window_size = saved_window_size;
}

bool fovet_zscore_set_window(FovetZScore *ctx, uint32_t window_size)
{
    /* 0 always accepted — disables windowing */
    if (window_size == 0U) {
        ctx->window_size = 0U;
        return true;
    }
    /* Non-zero window must be >= min_samples, otherwise detection would never
     * trigger before the window resets (permanent warm-up). */
    if (window_size < ctx->min_samples) {
        return false;
    }
    ctx->window_size = window_size;
    return true;
}
