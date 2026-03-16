/*
 * Fovet SDK — Sentinelle
 * Copyright (C) 2026 Antoine Porte. All rights reserved.
 * LGPL v3 for non-commercial use.
 * Commercial licensing: contact@fovet.eu
 *
 * fovet_mad.c — Streaming MAD anomaly detector implementation
 */

#include "fovet/mad.h"

#include <math.h>   /* fabsf */
#include <string.h> /* memcpy */

/* -------------------------------------------------------------------------
 * Internal helpers
 * ---------------------------------------------------------------------- */

/**
 * Insertion sort of n floats in arr[] (ascending, in-place).
 * O(n²) — acceptable for n ≤ 128 at embedded clock rates.
 */
static void _isort(float *arr, uint16_t n)
{
    for (uint16_t i = 1; i < n; i++) {
        float key = arr[i];
        int16_t j = (int16_t)i - 1;
        while (j >= 0 && arr[j] > key) {
            arr[j + 1] = arr[j];
            j--;
        }
        arr[j + 1] = key;
    }
}

/**
 * Copy the logical window contents into dst[] and sort them.
 * Returns the number of valid elements copied (ctx->count).
 */
static uint16_t _sorted_window(const FovetMAD *ctx, float *dst)
{
    uint16_t n = ctx->count;
    if (n == 0) return 0;

    /* Copy ring buffer contents into a contiguous scratch area */
    if (n < ctx->win_size) {
        /* Buffer not yet full: elements are in [0 .. n-1] */
        memcpy(dst, ctx->window, (size_t)n * sizeof(float));
    } else {
        /* Buffer is full: oldest element is at ctx->head */
        uint16_t tail_len = ctx->win_size - ctx->head;
        memcpy(dst,            ctx->window + ctx->head, (size_t)tail_len * sizeof(float));
        memcpy(dst + tail_len, ctx->window,             (size_t)ctx->head * sizeof(float));
    }

    _isort(dst, n);
    return n;
}

/**
 * Compute the median of a SORTED array of n elements.
 */
static float _median_sorted(const float *sorted, uint16_t n)
{
    if (n == 0) return 0.0f;
    if (n % 2 == 1) {
        return sorted[n / 2];
    } else {
        return (sorted[n / 2 - 1] + sorted[n / 2]) * 0.5f;
    }
}

/* -------------------------------------------------------------------------
 * Public API
 * ---------------------------------------------------------------------- */

void fovet_mad_init(FovetMAD *ctx, uint16_t win_size, float threshold_mad)
{
    if (win_size == 0 || win_size > FOVET_MAD_MAX_WINDOW) {
        win_size = FOVET_MAD_MAX_WINDOW;
    }
    ctx->win_size       = win_size;
    ctx->threshold_mad  = threshold_mad;
    ctx->head           = 0;
    ctx->count          = 0;
    /* Zero the buffers for determinism */
    memset(ctx->window,  0, sizeof(ctx->window));
    memset(ctx->scratch, 0, sizeof(ctx->scratch));
}

bool fovet_mad_update(FovetMAD *ctx, float sample)
{
    /* Score against the CURRENT window (before adding the new sample).
     * This avoids the trivial case where a single-element window always
     * contains the value being tested. */
    bool is_anomaly = false;
    if (ctx->count >= ctx->win_size) {
        float score = fovet_mad_score(ctx, sample);
        is_anomaly = score > ctx->threshold_mad;
    }

    /* Write sample into ring buffer */
    ctx->window[ctx->head] = sample;
    ctx->head = (uint16_t)((ctx->head + 1) % ctx->win_size);
    if (ctx->count < ctx->win_size) {
        ctx->count++;
    }

    return is_anomaly;
}

float fovet_mad_get_median(const FovetMAD *ctx)
{
    /* _sorted_window writes into ctx->scratch — cast away const for scratch only */
    FovetMAD *mctx = (FovetMAD *)(uintptr_t)ctx;
    uint16_t n = _sorted_window(mctx, mctx->scratch);
    return _median_sorted(mctx->scratch, n);
}

float fovet_mad_get_mad(const FovetMAD *ctx)
{
    FovetMAD *mctx = (FovetMAD *)(uintptr_t)ctx;
    uint16_t n = _sorted_window(mctx, mctx->scratch);
    if (n == 0) return 0.0f;

    float med = _median_sorted(mctx->scratch, n);

    /* Compute absolute deviations and sort them */
    float abs_dev[FOVET_MAD_MAX_WINDOW];
    for (uint16_t i = 0; i < n; i++) {
        abs_dev[i] = fabsf(mctx->scratch[i] - med);
    }
    _isort(abs_dev, n);
    return _median_sorted(abs_dev, n);
}

float fovet_mad_score(const FovetMAD *ctx, float value)
{
    float med = fovet_mad_get_median(ctx);
    float mad = fovet_mad_get_mad(ctx);

    float deviation = fabsf(value - med);

    if (mad < 1e-9f) {
        /* Constant signal: any deviation is infinite, exact match is 0 */
        return (deviation < 1e-9f) ? 0.0f : 1e9f;
    }

    /* 1.4826 is the consistency constant: MAD * 1.4826 ≈ σ for Gaussian data */
    return deviation / (1.4826f * mad);
}
