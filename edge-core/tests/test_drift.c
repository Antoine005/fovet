/*
 * Fovet SDK — Sentinelle
 * Copyright (C) 2026 Antoine Porte. All rights reserved.
 * LGPL v3 for non-commercial use.
 * Commercial licensing: contact@fovet.eu
 */

/*
 * Native unit tests for fovet_drift — compile with gcc, no hardware needed.
 *
 *   make -C edge-core/tests
 *   ./edge-core/tests/test_drift
 */

#include <stdio.h>
#include <stdlib.h>
#include <math.h>
#include <stdbool.h>
#include <stdint.h>

#include "../include/fovet/drift.h"
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
    FovetDrift ctx;
    fovet_drift_init(&ctx, 0.1f, 0.01f, 3.0f);

    ASSERT(ctx.count == 0U,                                "init: count == 0");
    ASSERT_FLOAT_EQ(ctx.alpha_fast, 0.1f,  1e-6f,         "init: alpha_fast == 0.1");
    ASSERT_FLOAT_EQ(ctx.alpha_slow, 0.01f, 1e-6f,         "init: alpha_slow == 0.01");
    ASSERT_FLOAT_EQ(ctx.threshold,  3.0f,  1e-6f,         "init: threshold == 3.0");
    ASSERT_FLOAT_EQ(ctx.ewma_fast,  0.0f,  1e-6f,         "init: ewma_fast == 0");
    ASSERT_FLOAT_EQ(ctx.ewma_slow,  0.0f,  1e-6f,         "init: ewma_slow == 0");
}

static void test_alpha_swap_enforced(void)
{
    FovetDrift ctx;
    /* Pass alpha_slow > alpha_fast — must be swapped */
    fovet_drift_init(&ctx, 0.01f, 0.1f, 3.0f);

    ASSERT(ctx.alpha_fast > ctx.alpha_slow, "alpha_fast > alpha_slow after swap");
    ASSERT_FLOAT_EQ(ctx.alpha_fast, 0.1f,  1e-6f, "alpha_fast corrected to 0.1");
    ASSERT_FLOAT_EQ(ctx.alpha_slow, 0.01f, 1e-6f, "alpha_slow corrected to 0.01");
}

static void test_no_alert_on_first_sample(void)
{
    FovetDrift ctx;
    fovet_drift_init(&ctx, 0.1f, 0.01f, 0.001f); /* very tight threshold */

    bool result = fovet_drift_update(&ctx, 1000.0f);
    ASSERT(!result,           "first sample never triggers alert (seeds EMAs)");
    ASSERT(ctx.count == 1U,   "count == 1 after first sample");
    ASSERT_FLOAT_EQ(ctx.ewma_fast, 1000.0f, 1e-3f, "ewma_fast seeded to first sample");
    ASSERT_FLOAT_EQ(ctx.ewma_slow, 1000.0f, 1e-3f, "ewma_slow seeded to first sample");
}

static void test_stable_signal_no_drift(void)
{
    FovetDrift ctx;
    fovet_drift_init(&ctx, 0.1f, 0.01f, 1.0f);

    /* Constant signal — both EMAs converge to same value, gap stays near 0 */
    int alert_count = 0;
    for (int i = 0; i < 200; i++) {
        if (fovet_drift_update(&ctx, 10.0f)) {
            alert_count++;
        }
    }
    ASSERT(alert_count == 0, "constant signal: no drift alert");
    ASSERT_FLOAT_EQ(fovet_drift_get_magnitude(&ctx), 0.0f, 1e-3f, "constant signal: magnitude ~= 0");
}

static void test_step_drift_detected(void)
{
    FovetDrift ctx;
    fovet_drift_init(&ctx, 0.1f, 0.01f, 1.0f);

    /* Phase 1: stable at 0.0 for 100 samples */
    for (int i = 0; i < 100; i++) {
        fovet_drift_update(&ctx, 0.0f);
    }
    ASSERT(fovet_drift_get_magnitude(&ctx) < 1.0f, "step: no alert before step");

    /* Phase 2: signal jumps to 20.0 — fast EMA reacts, slow EMA lags */
    int alert_count = 0;
    for (int i = 0; i < 100; i++) {
        if (fovet_drift_update(&ctx, 20.0f)) {
            alert_count++;
        }
    }
    ASSERT(alert_count > 0, "step: drift detected after step change");
}

static void test_slow_ramp_detected(void)
{
    FovetDrift ctx;
    /* Tight threshold: 0.5 units */
    fovet_drift_init(&ctx, 0.1f, 0.01f, 0.5f);

    /* Seed with stable signal */
    for (int i = 0; i < 50; i++) {
        fovet_drift_update(&ctx, 0.0f);
    }

    /* Slow linear ramp: +0.01 per sample over 200 samples = +2.0 total */
    int alert_count = 0;
    for (int i = 0; i < 200; i++) {
        float sample = (float)i * 0.01f;
        if (fovet_drift_update(&ctx, sample)) {
            alert_count++;
        }
    }
    ASSERT(alert_count > 0, "slow ramp: drift detected on gradual increase");
}

static void test_zscore_misses_drift_but_ewma_catches(void)
{
    /*
     * Z-Score absorbs slow drift (mean follows the signal), EWMA does not.
     * This test confirms the two detectors are complementary.
     */
    FovetDrift drift_ctx;
    FovetZScore zscore_ctx;

    fovet_drift_init(&drift_ctx,   0.1f, 0.01f, 0.5f);
    fovet_zscore_init(&zscore_ctx, 3.0f, 10U);

    /* Seed both detectors */
    for (int i = 0; i < 50; i++) {
        fovet_drift_update(&drift_ctx, 0.0f);
        fovet_zscore_update(&zscore_ctx, 0.0f);
    }

    /* Slow linear ramp — Z-Score should not fire, EWMA should */
    int zscore_alerts = 0;
    int drift_alerts  = 0;
    for (int i = 0; i < 300; i++) {
        float sample = (float)i * 0.01f; /* ramp: 0 → 3.0 */
        if (fovet_zscore_update(&zscore_ctx, sample)) zscore_alerts++;
        if (fovet_drift_update(&drift_ctx,   sample)) drift_alerts++;
    }

    ASSERT(drift_alerts  > 0, "complementarity: EWMA catches slow ramp");
    ASSERT(zscore_alerts == 0 || drift_alerts > zscore_alerts,
           "complementarity: EWMA catches drift that Z-Score misses or fires earlier");
}

static void test_reset_preserves_parameters(void)
{
    FovetDrift ctx;
    fovet_drift_init(&ctx, 0.1f, 0.01f, 5.0f);

    for (int i = 0; i < 10; i++) {
        fovet_drift_update(&ctx, (float)i);
    }
    fovet_drift_reset(&ctx);

    ASSERT(ctx.count == 0U,                         "reset: count == 0");
    ASSERT_FLOAT_EQ(ctx.ewma_fast,  0.0f, 1e-6f,   "reset: ewma_fast == 0");
    ASSERT_FLOAT_EQ(ctx.ewma_slow,  0.0f, 1e-6f,   "reset: ewma_slow == 0");
    ASSERT_FLOAT_EQ(ctx.alpha_fast, 0.1f, 1e-6f,   "reset: alpha_fast preserved");
    ASSERT_FLOAT_EQ(ctx.alpha_slow, 0.01f, 1e-6f,  "reset: alpha_slow preserved");
    ASSERT_FLOAT_EQ(ctx.threshold,  5.0f, 1e-6f,   "reset: threshold preserved");
}

static void test_magnitude_accessor(void)
{
    FovetDrift ctx;
    fovet_drift_init(&ctx, 0.1f, 0.01f, 99.0f);

    fovet_drift_update(&ctx, 0.0f);   /* seed */
    for (int i = 0; i < 100; i++) {
        fovet_drift_update(&ctx, 10.0f);
    }

    float mag = fovet_drift_get_magnitude(&ctx);
    ASSERT(mag > 0.0f, "magnitude > 0 after step change");
    ASSERT_FLOAT_EQ(mag, fabsf(fovet_drift_get_fast(&ctx) - fovet_drift_get_slow(&ctx)),
                    1e-5f, "magnitude == |fast - slow|");
}

/* -------------------------------------------------------------------------
 * Entry point
 * ------------------------------------------------------------------------- */

int main(void)
{
    printf("=== Fovet Drift Unit Tests ===\n\n");

    test_init();
    test_alpha_swap_enforced();
    test_no_alert_on_first_sample();
    test_stable_signal_no_drift();
    test_step_drift_detected();
    test_slow_ramp_detected();
    test_zscore_misses_drift_but_ewma_catches();
    test_reset_preserves_parameters();
    test_magnitude_accessor();

    printf("\n=== Results: %d passed, %d failed ===\n", g_pass, g_fail);
    return (g_fail == 0) ? EXIT_SUCCESS : EXIT_FAILURE;
}
