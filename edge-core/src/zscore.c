/*
 * Fovet SDK — Sentinelle
 * Copyright (C) 2026 Antoine Porte. All rights reserved.
 * LGPL v3 for non-commercial use.
 * Commercial licensing: contact@fovet.eu
 */

#include "fovet/zscore.h"

#include <math.h>   /* sqrtf, fabsf */

/* -------------------------------------------------------------------------
 * Welford's online algorithm — single-pass, zero malloc, numerically stable
 *
 *   mean_n = mean_{n-1} + (x - mean_{n-1}) / n
 *   M2_n   = M2_{n-1}  + (x - mean_{n-1}) * (x - mean_n)
 *   var_n  = M2_n / (n - 1)   (sample variance, unbiased)
 * ------------------------------------------------------------------------- */

void fovet_zscore_init(FovetZScore *ctx, float threshold_sigma)
{
    ctx->count           = 0U;
    ctx->mean            = 0.0f;
    ctx->M2              = 0.0f;
    ctx->threshold_sigma = threshold_sigma;
}

bool fovet_zscore_update(FovetZScore *ctx, float sample)
{
    ctx->count++;

    /* Welford update */
    float delta  = sample - ctx->mean;
    ctx->mean   += delta / (float)ctx->count;
    float delta2 = sample - ctx->mean;
    ctx->M2     += delta * delta2;

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

    float z = fabsf(sample - ctx->mean) / stddev;
    return (z > ctx->threshold_sigma);
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
    float saved_threshold = ctx->threshold_sigma;
    fovet_zscore_init(ctx, saved_threshold);
}
