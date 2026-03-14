/*
 * Fovet SDK — Sentinelle
 * Copyright (C) 2026 Antoine Porte. All rights reserved.
 * LGPL v3 for non-commercial use.
 * Commercial licensing: contact@fovet.eu
 */

#include "fovet/drift.h"

#include <math.h>   /* fabsf */

/* -------------------------------------------------------------------------
 * EWMA drift detector
 *
 * Two exponential moving averages track the signal at different speeds:
 *
 *   ewma_fast_n = alpha_fast * x  +  (1 - alpha_fast) * ewma_fast_{n-1}
 *   ewma_slow_n = alpha_slow * x  +  (1 - alpha_slow) * ewma_slow_{n-1}
 *
 * A slow drift shows up as a growing gap between the two:
 *
 *   drift = |ewma_fast - ewma_slow| > threshold  →  alert
 *
 * First sample seeds both EMAs to x — prevents a spurious alert on startup.
 * ------------------------------------------------------------------------- */

void fovet_drift_init(FovetDrift *ctx,
                      float alpha_fast,
                      float alpha_slow,
                      float threshold)
{
    /* Enforce alpha_slow < alpha_fast */
    if (alpha_slow >= alpha_fast) {
        float tmp  = alpha_fast;
        alpha_fast = alpha_slow;
        alpha_slow = tmp;
    }

    ctx->alpha_fast = alpha_fast;
    ctx->alpha_slow = alpha_slow;
    ctx->threshold  = threshold;
    ctx->ewma_fast  = 0.0f;
    ctx->ewma_slow  = 0.0f;
    ctx->count      = 0U;
}

bool fovet_drift_update(FovetDrift *ctx, float sample)
{
    if (ctx->count == 0U) {
        /* Seed both EMAs on the first sample — no alert */
        ctx->ewma_fast = sample;
        ctx->ewma_slow = sample;
        ctx->count     = 1U;
        return false;
    }

    if (ctx->count < UINT32_MAX) {
        ctx->count++;
    }

    ctx->ewma_fast = ctx->alpha_fast * sample + (1.0f - ctx->alpha_fast) * ctx->ewma_fast;
    ctx->ewma_slow = ctx->alpha_slow * sample + (1.0f - ctx->alpha_slow) * ctx->ewma_slow;

    return (fabsf(ctx->ewma_fast - ctx->ewma_slow) > ctx->threshold);
}

float fovet_drift_get_fast(const FovetDrift *ctx)
{
    return ctx->ewma_fast;
}

float fovet_drift_get_slow(const FovetDrift *ctx)
{
    return ctx->ewma_slow;
}

float fovet_drift_get_magnitude(const FovetDrift *ctx)
{
    return fabsf(ctx->ewma_fast - ctx->ewma_slow);
}

void fovet_drift_reset(FovetDrift *ctx)
{
    float    saved_alpha_fast = ctx->alpha_fast;
    float    saved_alpha_slow = ctx->alpha_slow;
    float    saved_threshold  = ctx->threshold;
    fovet_drift_init(ctx, saved_alpha_fast, saved_alpha_slow, saved_threshold);
}
