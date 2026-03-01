/*
 * Fovet SDK — Sentinelle
 * Copyright (C) 2026 Antoine Porte. All rights reserved.
 * LGPL v3 for non-commercial use.
 * Commercial licensing: contact@fovet.eu
 */

/*
 * Native unit tests for fovet_zscore — compile with gcc, no hardware needed.
 *
 *   make -C edge-core/tests
 *   ./edge-core/tests/test_zscore
 */

#include <stdio.h>
#include <stdlib.h>
#include <math.h>
#include <stdbool.h>

#include "../include/fovet/zscore.h"

/* -------------------------------------------------------------------------
 * Minimal test framework
 * ------------------------------------------------------------------------- */

static int g_pass = 0;
static int g_fail = 0;

#define ASSERT(cond, msg)                                               \
    do {                                                                \
        if (cond) {                                                     \
            printf("[PASS] %s\n", msg);                                 \
            g_pass++;                                                   \
        } else {                                                        \
            printf("[FAIL] %s  (line %d)\n", msg, __LINE__);           \
            g_fail++;                                                   \
        }                                                               \
    } while (0)

#define ASSERT_FLOAT_EQ(a, b, tol, msg)                                \
    ASSERT(fabsf((a) - (b)) < (tol), msg)

/* -------------------------------------------------------------------------
 * Test cases
 * ------------------------------------------------------------------------- */

static void test_init(void)
{
    FovetZScore ctx;
    fovet_zscore_init(&ctx, 3.0f);

    ASSERT(ctx.count == 0,           "init: count == 0");
    ASSERT_FLOAT_EQ(ctx.mean,  0.0f, 1e-6f, "init: mean == 0");
    ASSERT_FLOAT_EQ(ctx.M2,   0.0f,  1e-6f, "init: M2 == 0");
    ASSERT_FLOAT_EQ(ctx.threshold_sigma, 3.0f, 1e-6f, "init: threshold == 3");
}

static void test_no_anomaly_on_first_sample(void)
{
    FovetZScore ctx;
    fovet_zscore_init(&ctx, 3.0f);

    bool result = fovet_zscore_update(&ctx, 1000.0f);
    ASSERT(!result, "first sample must never be flagged as anomaly");
    ASSERT(ctx.count == 1, "count == 1 after first sample");
}

static void test_no_anomaly_on_second_sample(void)
{
    FovetZScore ctx;
    fovet_zscore_init(&ctx, 3.0f);

    fovet_zscore_update(&ctx, 1.0f);
    bool result = fovet_zscore_update(&ctx, 2.0f);
    ASSERT(!result, "second sample must never be flagged (variance undefined)");
}

static void test_normal_signal_no_anomaly(void)
{
    FovetZScore ctx;
    fovet_zscore_init(&ctx, 3.0f);

    /* Feed 100 samples of a clean sinusoidal signal */
    int anomaly_count = 0;
    for (int i = 0; i < 100; i++) {
        float sample = sinf((float)i * 0.1f);
        if (fovet_zscore_update(&ctx, sample)) {
            anomaly_count++;
        }
    }
    ASSERT(anomaly_count == 0, "no anomalies on clean sine wave");
}

static void test_anomaly_detected_5sigma(void)
{
    FovetZScore ctx;
    fovet_zscore_init(&ctx, 3.0f);

    /* Warm up with 50 stable samples around 0 */
    for (int i = 0; i < 50; i++) {
        fovet_zscore_update(&ctx, 0.0f + (float)(i % 2) * 0.001f);
    }

    float stddev = fovet_zscore_get_stddev(&ctx);
    float mean   = fovet_zscore_get_mean(&ctx);

    /* Inject a spike at +5σ */
    float spike  = mean + 5.0f * stddev;
    bool  result = fovet_zscore_update(&ctx, spike);

    ASSERT(result, "5-sigma spike must be detected as anomaly");
}

static void test_stddev_convergence(void)
{
    FovetZScore ctx;
    fovet_zscore_init(&ctx, 3.0f);

    /* Known signal: constant 5.0 + uniform noise ±0.5 */
    /* We just check stddev is positive and mean ~5.0 */
    for (int i = 0; i < 1000; i++) {
        float noise  = ((float)(i % 11) - 5.0f) * 0.1f; /* deterministic pseudo-noise */
        fovet_zscore_update(&ctx, 5.0f + noise);
    }

    float mean   = fovet_zscore_get_mean(&ctx);
    float stddev = fovet_zscore_get_stddev(&ctx);

    ASSERT_FLOAT_EQ(mean, 5.0f, 0.1f, "mean converges to ~5.0");
    ASSERT(stddev > 0.0f, "stddev is positive after 1000 samples");
    ASSERT(fovet_zscore_get_count(&ctx) == 1000, "count == 1000");
}

static void test_reset_preserves_threshold(void)
{
    FovetZScore ctx;
    fovet_zscore_init(&ctx, 5.0f);

    fovet_zscore_update(&ctx, 1.0f);
    fovet_zscore_update(&ctx, 2.0f);
    fovet_zscore_reset(&ctx);

    ASSERT(ctx.count == 0,                                    "reset: count == 0");
    ASSERT_FLOAT_EQ(ctx.mean, 0.0f, 1e-6f,                   "reset: mean == 0");
    ASSERT_FLOAT_EQ(ctx.threshold_sigma, 5.0f, 1e-6f,        "reset: threshold preserved");
}

static void test_flat_signal_no_false_positive(void)
{
    FovetZScore ctx;
    fovet_zscore_init(&ctx, 3.0f);

    int anomaly_count = 0;
    for (int i = 0; i < 50; i++) {
        if (fovet_zscore_update(&ctx, 42.0f)) {
            anomaly_count++;
        }
    }
    ASSERT(anomaly_count == 0, "constant signal produces no false positives");
}

/* -------------------------------------------------------------------------
 * Entry point
 * ------------------------------------------------------------------------- */

int main(void)
{
    printf("=== Fovet Z-Score Unit Tests ===\n\n");

    test_init();
    test_no_anomaly_on_first_sample();
    test_no_anomaly_on_second_sample();
    test_normal_signal_no_anomaly();
    test_anomaly_detected_5sigma();
    test_stddev_convergence();
    test_reset_preserves_threshold();
    test_flat_signal_no_false_positive();

    printf("\n=== Results: %d passed, %d failed ===\n", g_pass, g_fail);
    return (g_fail == 0) ? EXIT_SUCCESS : EXIT_FAILURE;
}
