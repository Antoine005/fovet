/*
 * Fovet SDK — Sentinelle
 * Copyright (C) 2026 Antoine Porte. All rights reserved.
 * LGPL v3 for non-commercial use.
 * Commercial licensing: contact@fovet.eu
 *
 * test_mad.c — Unit tests for fovet_mad (MAD anomaly detector)
 *
 * Compile & run:
 *   gcc -std=c99 -Wall -I../include -DFOVET_NATIVE_TEST -o test_mad \
 *       ../src/mad.c test_mad.c -lm && ./test_mad
 */

#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "fovet/mad.h"

/* -------------------------------------------------------------------------
 * Minimal test harness
 * ---------------------------------------------------------------------- */

static int _passed = 0;
static int _failed = 0;

#define ASSERT(label, cond)                                             \
    do {                                                                \
        if (cond) {                                                     \
            printf("  PASS  %s\n", label);                             \
            _passed++;                                                  \
        } else {                                                        \
            printf("  FAIL  %s  [%s:%d]\n", label, __FILE__, __LINE__);\
            _failed++;                                                  \
        }                                                               \
    } while (0)

#define ASSERT_FLOAT_EQ(label, a, b, eps)                              \
    ASSERT(label, fabsf((float)(a) - (float)(b)) < (float)(eps))

/* -------------------------------------------------------------------------
 * Helpers
 * ---------------------------------------------------------------------- */

/* Feed n identical values into ctx */
static void feed_constant(FovetMAD *ctx, float value, int n)
{
    for (int i = 0; i < n; i++) {
        fovet_mad_update(ctx, value);
    }
}

/* Feed an alternating sequence: value, value+delta, value, value+delta, … */
static void feed_alternating(FovetMAD *ctx, float base, float delta, int n)
{
    for (int i = 0; i < n; i++) {
        fovet_mad_update(ctx, base + (i % 2 == 0 ? 0.0f : delta));
    }
}

/* -------------------------------------------------------------------------
 * Test groups
 * ---------------------------------------------------------------------- */

/* ---------- 1. Initialisation ----------------------------------------- */

static void test_init_sets_zero_count(void)
{
    FovetMAD ctx;
    fovet_mad_init(&ctx, 16, 3.5f);
    ASSERT("init: count == 0", ctx.count == 0);
}

static void test_init_sets_win_size(void)
{
    FovetMAD ctx;
    fovet_mad_init(&ctx, 20, 3.5f);
    ASSERT("init: win_size == 20", ctx.win_size == 20);
}

static void test_init_clamps_win_size(void)
{
    FovetMAD ctx;
    fovet_mad_init(&ctx, 9999, 3.5f);
    ASSERT("init: win_size clamped to FOVET_MAD_MAX_WINDOW",
           ctx.win_size == FOVET_MAD_MAX_WINDOW);
}

static void test_init_threshold(void)
{
    FovetMAD ctx;
    fovet_mad_init(&ctx, 16, 4.0f);
    ASSERT_FLOAT_EQ("init: threshold_mad == 4.0", ctx.threshold_mad, 4.0f, 1e-6f);
}

/* ---------- 2. Warm-up ------------------------------------------------- */

static void test_no_anomaly_during_warmup(void)
{
    FovetMAD ctx;
    fovet_mad_init(&ctx, 8, 3.5f);
    int any = 0;
    for (int i = 0; i < 7; i++) {
        if (fovet_mad_update(&ctx, (float)i * 100.0f)) any = 1;
    }
    ASSERT("warmup: no anomaly before window full", any == 0);
}

static void test_warmup_count_increments(void)
{
    FovetMAD ctx;
    fovet_mad_init(&ctx, 16, 3.5f);
    for (int i = 0; i < 5; i++) fovet_mad_update(&ctx, 1.0f);
    ASSERT("warmup: count increments correctly", ctx.count == 5);
}

static void test_count_caps_at_win_size(void)
{
    FovetMAD ctx;
    fovet_mad_init(&ctx, 8, 3.5f);
    for (int i = 0; i < 20; i++) fovet_mad_update(&ctx, 1.0f);
    ASSERT("warmup: count caps at win_size", ctx.count == 8);
}

/* ---------- 3. Median -------------------------------------------------- */

static void test_median_constant_signal(void)
{
    FovetMAD ctx;
    fovet_mad_init(&ctx, 8, 3.5f);
    feed_constant(&ctx, 5.0f, 8);
    ASSERT_FLOAT_EQ("median: constant signal → median == value",
                    fovet_mad_get_median(&ctx), 5.0f, 1e-4f);
}

static void test_median_odd_window(void)
{
    /* Window of 5 with values 1,2,3,4,5 → median == 3 */
    FovetMAD ctx;
    fovet_mad_init(&ctx, 5, 3.5f);
    for (int i = 1; i <= 5; i++) fovet_mad_update(&ctx, (float)i);
    ASSERT_FLOAT_EQ("median: 1..5 → 3.0", fovet_mad_get_median(&ctx), 3.0f, 1e-4f);
}

static void test_median_even_window(void)
{
    /* Window of 4 with values 1,2,3,4 → median == 2.5 */
    FovetMAD ctx;
    fovet_mad_init(&ctx, 4, 3.5f);
    for (int i = 1; i <= 4; i++) fovet_mad_update(&ctx, (float)i);
    ASSERT_FLOAT_EQ("median: 1..4 → 2.5", fovet_mad_get_median(&ctx), 2.5f, 1e-4f);
}

static void test_median_ring_buffer_wraps(void)
{
    /* Fill window of 4 with 1..4, then overwrite with 10,10 → window is 3,4,10,10
     * sorted: 3,4,10,10 → median = (4+10)/2 = 7.0 */
    FovetMAD ctx;
    fovet_mad_init(&ctx, 4, 3.5f);
    for (int i = 1; i <= 4; i++) fovet_mad_update(&ctx, (float)i);
    fovet_mad_update(&ctx, 10.0f);
    fovet_mad_update(&ctx, 10.0f);
    /* Window now holds [3, 4, 10, 10] */
    ASSERT_FLOAT_EQ("median: ring wrap → 7.0", fovet_mad_get_median(&ctx), 7.0f, 1e-4f);
}

/* ---------- 4. MAD ----------------------------------------------------- */

static void test_mad_constant_signal_is_zero(void)
{
    FovetMAD ctx;
    fovet_mad_init(&ctx, 8, 3.5f);
    feed_constant(&ctx, 3.0f, 8);
    ASSERT_FLOAT_EQ("mad: constant signal → MAD == 0",
                    fovet_mad_get_mad(&ctx), 0.0f, 1e-6f);
}

static void test_mad_known_value(void)
{
    /* Values: 1,1,2,2,4,6,9  → sorted: 1,1,2,2,4,6,9, median=2
     * abs deviations: 1,1,0,0,2,4,7 → sorted: 0,0,1,1,2,4,7 → MAD=1 */
    FovetMAD ctx;
    fovet_mad_init(&ctx, 7, 3.5f);
    float v[] = {1,1,2,2,4,6,9};
    for (int i = 0; i < 7; i++) fovet_mad_update(&ctx, v[i]);
    ASSERT_FLOAT_EQ("mad: known value → 1.0", fovet_mad_get_mad(&ctx), 1.0f, 1e-3f);
}

static void test_mad_symmetric_is_positive(void)
{
    FovetMAD ctx;
    fovet_mad_init(&ctx, 8, 3.5f);
    feed_alternating(&ctx, 0.0f, 2.0f, 8);
    float mad = fovet_mad_get_mad(&ctx);
    ASSERT("mad: symmetric signal → MAD > 0", mad > 0.0f);
}

/* ---------- 5. Score --------------------------------------------------- */

static void test_score_at_median_is_zero(void)
{
    FovetMAD ctx;
    fovet_mad_init(&ctx, 8, 3.5f);
    feed_constant(&ctx, 7.0f, 8);
    /* Constant window: MAD=0, value=median → score=0 */
    ASSERT_FLOAT_EQ("score: value == median (const) → 0",
                    fovet_mad_score(&ctx, 7.0f), 0.0f, 1e-6f);
}

static void test_score_deviation_from_constant_is_sentinel(void)
{
    FovetMAD ctx;
    fovet_mad_init(&ctx, 8, 3.5f);
    feed_constant(&ctx, 7.0f, 8);
    /* MAD=0, value≠median → sentinel 1e9 */
    float score = fovet_mad_score(&ctx, 8.0f);
    ASSERT("score: deviation from constant → large sentinel", score > 1e8f);
}

static void test_score_formula(void)
{
    /* Use known MAD=1, median=2 (from test_mad_known_value).
     * score(10) = |10-2| / (1.4826 * 1) = 8 / 1.4826 ≈ 5.396 */
    FovetMAD ctx;
    fovet_mad_init(&ctx, 7, 3.5f);
    float v[] = {1,1,2,2,4,6,9};
    for (int i = 0; i < 7; i++) fovet_mad_update(&ctx, v[i]);
    float expected = 8.0f / 1.4826f;
    ASSERT_FLOAT_EQ("score: formula correct", fovet_mad_score(&ctx, 10.0f), expected, 0.01f);
}

/* ---------- 6. Anomaly detection --------------------------------------- */

static void test_no_anomaly_on_normal_signal(void)
{
    FovetMAD ctx;
    fovet_mad_init(&ctx, 16, 3.5f);
    int anomalies = 0;
    /* Small-amplitude sine-like signal */
    for (int i = 0; i < 64; i++) {
        float v = 10.0f + 0.5f * (float)(i % 8 - 4);
        if (fovet_mad_update(&ctx, v)) anomalies++;
    }
    ASSERT("detect: no anomaly on normal signal", anomalies == 0);
}

static void test_detects_spike(void)
{
    FovetMAD ctx;
    fovet_mad_init(&ctx, 16, 3.5f);
    /* Fill with steady baseline */
    feed_constant(&ctx, 5.0f, 16);
    /* Inject large spike */
    bool anomaly = fovet_mad_update(&ctx, 500.0f);
    ASSERT("detect: large spike detected", anomaly == true);
}

static void test_detects_negative_spike(void)
{
    FovetMAD ctx;
    fovet_mad_init(&ctx, 16, 3.5f);
    feed_constant(&ctx, 5.0f, 16);
    bool anomaly = fovet_mad_update(&ctx, -500.0f);
    ASSERT("detect: large negative spike detected", anomaly == true);
}

static void test_higher_threshold_fewer_anomalies(void)
{
    /* Threshold 1.0 → more sensitive than 10.0 */
    FovetMAD ctx_lo, ctx_hi;
    fovet_mad_init(&ctx_lo, 16, 1.0f);
    fovet_mad_init(&ctx_hi, 16, 10.0f);
    float signal[] = {5,5,5,5,5,5,5,5,5,5,5,5,5,5,5,5,
                      5,5,5,5,5,5,5,5,5,5,5,5,5,5,5,5,
                      8,8,8,8,8}; /* mild deviation */
    int count_lo = 0, count_hi = 0;
    for (int i = 0; i < 37; i++) {
        if (fovet_mad_update(&ctx_lo, signal[i])) count_lo++;
        if (fovet_mad_update(&ctx_hi, signal[i])) count_hi++;
    }
    ASSERT("detect: higher threshold → fewer anomalies", count_hi <= count_lo);
}

static void test_window_size_8_detects_spike(void)
{
    FovetMAD ctx;
    fovet_mad_init(&ctx, 8, 3.5f);
    feed_constant(&ctx, 10.0f, 8);
    bool anomaly = fovet_mad_update(&ctx, 1000.0f);
    ASSERT("detect: win=8 detects spike", anomaly == true);
}

/* ---------- 7. Edge cases ---------------------------------------------- */

static void test_window_size_1_no_anomaly_after_warmup(void)
{
    /* Window of 1: after warm-up, median == value, MAD == 0, score == 0 → no anomaly */
    FovetMAD ctx;
    fovet_mad_init(&ctx, 1, 3.5f);
    /* First sample fills the window */
    fovet_mad_update(&ctx, 5.0f);
    /* Second sample: window=[5.0], new value=5.0 → score=0 → no anomaly */
    bool a1 = fovet_mad_update(&ctx, 5.0f);
    /* Third sample: window=[5.0], new value=999.0 → sentinel */
    bool a2 = fovet_mad_update(&ctx, 999.0f);
    ASSERT("edge: win=1, same value → no anomaly", a1 == false);
    ASSERT("edge: win=1, different value → anomaly", a2 == true);
}

static void test_median_zero_before_warmup(void)
{
    FovetMAD ctx;
    fovet_mad_init(&ctx, 16, 3.5f);
    /* No samples yet */
    ASSERT_FLOAT_EQ("edge: median before warmup == 0", fovet_mad_get_median(&ctx), 0.0f, 1e-6f);
    ASSERT_FLOAT_EQ("edge: mad before warmup == 0",    fovet_mad_get_mad(&ctx),    0.0f, 1e-6f);
}

static void test_complementary_to_zscore(void)
{
    /* MAD is more robust to outliers than Z-score.
     * A contaminated window (many outliers) should still identify
     * a small deviation as normal.  We test that MAD score is finite. */
    FovetMAD ctx;
    fovet_mad_init(&ctx, 16, 3.5f);
    /* Normal values interspersed with a few big outliers */
    for (int i = 0; i < 12; i++) fovet_mad_update(&ctx, 5.0f);
    fovet_mad_update(&ctx, 1000.0f);
    fovet_mad_update(&ctx, -1000.0f);
    fovet_mad_update(&ctx, 5.0f);
    fovet_mad_update(&ctx, 5.0f);
    float score_normal = fovet_mad_score(&ctx, 5.0f);
    float score_spike  = fovet_mad_score(&ctx, 500.0f);
    ASSERT("robust: normal value has low score",   score_normal < 1.0f);
    ASSERT("robust: spike value has higher score", score_spike > score_normal);
}

/* -------------------------------------------------------------------------
 * Main
 * ---------------------------------------------------------------------- */

int main(void)
{
    printf("=== test_mad ===\n\n");

    /* 1. Initialisation */
    printf("-- Initialisation --\n");
    test_init_sets_zero_count();
    test_init_sets_win_size();
    test_init_clamps_win_size();
    test_init_threshold();

    /* 2. Warm-up */
    printf("\n-- Warm-up --\n");
    test_no_anomaly_during_warmup();
    test_warmup_count_increments();
    test_count_caps_at_win_size();

    /* 3. Median */
    printf("\n-- Median --\n");
    test_median_constant_signal();
    test_median_odd_window();
    test_median_even_window();
    test_median_ring_buffer_wraps();

    /* 4. MAD */
    printf("\n-- MAD --\n");
    test_mad_constant_signal_is_zero();
    test_mad_known_value();
    test_mad_symmetric_is_positive();

    /* 5. Score */
    printf("\n-- Score --\n");
    test_score_at_median_is_zero();
    test_score_deviation_from_constant_is_sentinel();
    test_score_formula();

    /* 6. Anomaly detection */
    printf("\n-- Anomaly detection --\n");
    test_no_anomaly_on_normal_signal();
    test_detects_spike();
    test_detects_negative_spike();
    test_higher_threshold_fewer_anomalies();
    test_window_size_8_detects_spike();

    /* 7. Edge cases */
    printf("\n-- Edge cases --\n");
    test_window_size_1_no_anomaly_after_warmup();
    test_median_zero_before_warmup();
    test_complementary_to_zscore();

    /* Summary */
    printf("\n=== %d passed, %d failed ===\n", _passed, _failed);
    return _failed > 0 ? 1 : 0;
}
