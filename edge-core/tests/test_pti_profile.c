/*
 * Ardent SDK — Pulse
 * Copyright (C) 2026 Antoine Porte. All rights reserved.
 * LGPL v3 for non-commercial use.
 * Commercial licensing: contact@fovet.eu
 */

/*
 * Native unit tests for ard_pti_profile — compile with gcc, no hardware needed.
 *
 *   make -C edge-core/tests test_pti_profile
 *   ./edge-core/tests/test_pti_profile
 *
 * Mock strategy:
 *   - IMU: registered via biosignal HAL; s_mock_imu controls the sample values
 *   - Fall score: function pointer returning s_mock_score
 *   - GPIO: function pointer returning s_mock_gpio (0 = pressed)
 *   - Time: hal_time_ms() returns s_mock_time_ms (incrementable from tests)
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <math.h>
#include <stdint.h>

#include "../include/ardent/profiles/pti_profile.h"
#include "../include/ardent/hal/ard_biosignal_hal.h"
#include "../include/ardent/hal/mpu6050_hal.h"  /* for ARD_MPU_ERR_I2C */

/* -------------------------------------------------------------------------
 * Controllable stubs
 * ------------------------------------------------------------------------- */

/* Mock time — advance from tests */
static uint32_t s_mock_time_ms = 0;

uint32_t hal_time_ms(void)
{
    return s_mock_time_ms;
}

/* Mock IMU sample values */
static float s_imu_ax = 0.0f;
static float s_imu_ay = 0.0f;
static float s_imu_az = 1.0f;    /* standing still, ~1g */
static int   s_imu_fail = 0;     /* 1 = simulate I2C error */

static int mock_imu_read(ard_biosignal_sample_t *out)
{
    if (s_imu_fail)
        return ARD_MPU_ERR_I2C;
    out->source          = ARD_SOURCE_IMU;
    out->timestamp_ms    = s_mock_time_ms;
    out->value.imu.ax    = s_imu_ax;
    out->value.imu.ay    = s_imu_ay;
    out->value.imu.az    = s_imu_az;
    out->value.imu.gx    = 0.0f;
    out->value.imu.gy    = 0.0f;
    out->value.imu.gz    = 0.0f;
    return ARD_HAL_OK;
}

/* Mock fall score */
static float s_mock_score = 0.0f;

static float mock_fall_score(const float *magnitudes, uint32_t n)
{
    (void)magnitudes;
    (void)n;
    return s_mock_score;
}

/* Mock GPIO */
static int s_mock_gpio = 1;  /* 1 = released (pull-up), 0 = pressed */

static int mock_gpio_read(uint8_t pin)
{
    (void)pin;
    return s_mock_gpio;
}

/* Alert capture */
static ard_pti_alert_t s_last_alert;
static int               s_alert_count   = 0;
static int               s_fall_count    = 0;
static int               s_motionless_count = 0;
static int               s_sos_count     = 0;

static void capture_alert(ard_pti_alert_t alert, void *user_data)
{
    (void)user_data;
    s_last_alert = alert;
    s_alert_count++;
    if (alert == ARD_ALERT_FALL)       s_fall_count++;
    if (alert == ARD_ALERT_MOTIONLESS) s_motionless_count++;
    if (alert == ARD_ALERT_SOS)        s_sos_count++;
}

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

#define ASSERT_INT_EQ(a, b, msg)                                        \
    do {                                                                \
        if ((a) == (b)) {                                               \
            printf("[PASS] %s\n", msg);                                 \
            g_pass++;                                                   \
        } else {                                                        \
            printf("[FAIL] %s  (expected %d, got %d, line %d)\n",      \
                   msg, (int)(b), (int)(a), __LINE__);                  \
            g_fail++;                                                   \
        }                                                               \
    } while (0)

/* -------------------------------------------------------------------------
 * Setup helper
 * ------------------------------------------------------------------------- */

static ard_pti_ctx_t   g_ctx;
static ard_pti_config_t g_cfg;

static void setup(void)
{
    s_mock_time_ms      = 0;
    s_imu_ax            = 0.0f;
    s_imu_ay            = 0.0f;
    s_imu_az            = 1.0f;
    s_imu_fail          = 0;
    s_mock_score        = 0.0f;
    s_mock_gpio         = 1;  /* released */
    s_alert_count       = 0;
    s_fall_count        = 0;
    s_motionless_count  = 0;
    s_sos_count         = 0;

    ard_hal_biosignal_reset();
    ard_hal_biosignal_register(ARD_SOURCE_IMU, mock_imu_read);

    g_cfg = ard_pti_default_config();
    ard_pti_init(&g_ctx, &g_cfg,
                   capture_alert, mock_fall_score, mock_gpio_read,
                   NULL, /* no sleep */
                   NULL);
}

/* Run n ticks advancing time by dt_ms per tick */
static void run_ticks(ard_pti_ctx_t *ctx, uint32_t n, uint32_t dt_ms)
{
    uint32_t i;
    for (i = 0; i < n; i++)
    {
        ard_pti_tick(ctx);
        s_mock_time_ms += dt_ms;
    }
}

/* -------------------------------------------------------------------------
 * Tests — default config
 * ------------------------------------------------------------------------- */

static void test_default_config_values(void)
{
    ard_pti_config_t cfg = ard_pti_default_config();
    ASSERT(cfg.fall_threshold == 0.85f,            "default fall_threshold == 0.85");
    ASSERT(cfg.motion_threshold_g == 0.1f,         "default motion_threshold_g == 0.1");
    ASSERT(cfg.motionless_timeout_ms == 30000U,    "default motionless_timeout_ms == 30000");
    ASSERT(cfg.sleep_between_ticks_ms == 40U,      "default sleep_between_ticks_ms == 40");
}

/* -------------------------------------------------------------------------
 * Tests — init
 * ------------------------------------------------------------------------- */

static void test_init_null_cfg_uses_defaults(void)
{
    ard_pti_ctx_t ctx;
    ard_pti_init(&ctx, NULL, capture_alert, mock_fall_score, mock_gpio_read, NULL, NULL);
    ASSERT(ctx.config.fall_threshold == 0.85f,  "init NULL cfg → default fall_threshold");
}

static void test_init_null_ctx_no_crash(void)
{
    /* Must not crash */
    ard_pti_init(NULL, NULL, capture_alert, mock_fall_score, mock_gpio_read, NULL, NULL);
    ASSERT(1, "init NULL ctx does not crash");
}

/* -------------------------------------------------------------------------
 * Tests — normal tick (no alert)
 * ------------------------------------------------------------------------- */

static void test_tick_returns_ok(void)
{
    setup();
    ASSERT_INT_EQ(ard_pti_tick(&g_ctx), ARD_HAL_OK,
                  "tick returns ARD_HAL_OK on success");
}

static void test_tick_no_alert_at_rest(void)
{
    setup();
    /* Normal gravity, no fall, no SOS, short duration */
    run_ticks(&g_ctx, 10, 40);
    ASSERT_INT_EQ(s_alert_count, 0, "no alert during normal rest (10 ticks)");
}

static void test_tick_imu_failure_returns_error(void)
{
    setup();
    s_imu_fail = 1;
    ASSERT_INT_EQ(ard_pti_tick(&g_ctx), ARD_MPU_ERR_I2C,
                  "tick returns error when IMU read fails");
}

/* -------------------------------------------------------------------------
 * Tests — fall detection
 * ------------------------------------------------------------------------- */

static void test_no_fall_alert_before_window_full(void)
{
    setup();
    s_mock_score = 1.0f;  /* would trigger, but window not yet full */
    /* Run fewer ticks than ARD_PTI_WINDOW_SIZE - 1 */
    run_ticks(&g_ctx, ARD_PTI_WINDOW_SIZE - 1, 40);
    ASSERT_INT_EQ(s_fall_count, 0,
                  "no fall alert before window is full");
}

static void test_fall_alert_when_score_high(void)
{
    setup();
    /* Fill the window first with benign data */
    s_mock_score = 0.0f;
    run_ticks(&g_ctx, ARD_PTI_WINDOW_SIZE, 40);

    /* Now raise score above threshold */
    s_mock_score = 0.90f;
    ard_pti_tick(&g_ctx);

    ASSERT_INT_EQ(s_fall_count, 1, "fall alert fires when score > threshold");
}

static void test_no_fall_alert_when_score_below_threshold(void)
{
    setup();
    s_mock_score = 0.84f;  /* just below 0.85 */
    run_ticks(&g_ctx, ARD_PTI_WINDOW_SIZE + 5, 40);
    ASSERT_INT_EQ(s_fall_count, 0,
                  "no fall alert when score < threshold");
}

static void test_fall_alert_fires_every_tick_while_score_high(void)
{
    setup();
    s_mock_score = 0.95f;
    /* Window fills on tick ARD_PTI_WINDOW_SIZE, then each subsequent tick fires */
    run_ticks(&g_ctx, ARD_PTI_WINDOW_SIZE + 3, 40);
    ASSERT(s_fall_count >= 3, "fall alert fires on every tick while score is high");
}

/* -------------------------------------------------------------------------
 * Tests — motionless detection
 * ------------------------------------------------------------------------- */

static void test_motionless_alert_after_timeout(void)
{
    setup();
    g_cfg.motionless_timeout_ms = 1000U;
    g_cfg.motion_threshold_g    = 0.5f;  /* easy to be below */
    ard_pti_init(&g_ctx, &g_cfg, capture_alert, mock_fall_score, mock_gpio_read, NULL, NULL);

    /* Magnitude = sqrt(0² + 0² + 0.1²) = 0.1 < 0.5 → motionless */
    s_imu_ax = 0.0f; s_imu_ay = 0.0f; s_imu_az = 0.1f;

    /* Advance time beyond timeout */
    ard_pti_tick(&g_ctx);            /* t=0 → last_motion set at init */
    s_mock_time_ms = 1001U;
    ard_pti_tick(&g_ctx);            /* elapsed > 1000 → alert */

    ASSERT_INT_EQ(s_motionless_count, 1,
                  "MOTIONLESS alert fires after timeout");
}

static void test_no_motionless_alert_before_timeout(void)
{
    setup();
    g_cfg.motionless_timeout_ms = 5000U;
    g_cfg.motion_threshold_g    = 0.5f;
    ard_pti_init(&g_ctx, &g_cfg, capture_alert, mock_fall_score, mock_gpio_read, NULL, NULL);

    s_imu_ax = 0.0f; s_imu_ay = 0.0f; s_imu_az = 0.1f;

    ard_pti_tick(&g_ctx);
    s_mock_time_ms = 4999U;
    ard_pti_tick(&g_ctx);

    ASSERT_INT_EQ(s_motionless_count, 0,
                  "no MOTIONLESS alert before timeout expires");
}

static void test_motionless_alert_sent_only_once(void)
{
    setup();
    g_cfg.motionless_timeout_ms = 100U;
    g_cfg.motion_threshold_g    = 2.0f;  /* always below (since |a| ≈ 1g) */
    ard_pti_init(&g_ctx, &g_cfg, capture_alert, mock_fall_score, mock_gpio_read, NULL, NULL);

    ard_pti_tick(&g_ctx);
    s_mock_time_ms = 200U;
    ard_pti_tick(&g_ctx);  /* fires alert */
    s_mock_time_ms = 300U;
    ard_pti_tick(&g_ctx);  /* debounce — should NOT fire again */

    ASSERT_INT_EQ(s_motionless_count, 1,
                  "MOTIONLESS alert fires only once (debounce)");
}

static void test_motionless_clears_on_motion(void)
{
    setup();
    g_cfg.motionless_timeout_ms = 100U;
    g_cfg.motion_threshold_g    = 0.5f;
    ard_pti_init(&g_ctx, &g_cfg, capture_alert, mock_fall_score, mock_gpio_read, NULL, NULL);

    /* Phase 1: motionless */
    s_imu_ax = 0.0f; s_imu_ay = 0.0f; s_imu_az = 0.1f;
    ard_pti_tick(&g_ctx);
    s_mock_time_ms = 200U;
    ard_pti_tick(&g_ctx);  /* fires MOTIONLESS */
    ASSERT_INT_EQ(s_motionless_count, 1, "MOTIONLESS fired");

    /* Phase 2: motion resumes */
    s_imu_ax = 0.0f; s_imu_ay = 0.0f; s_imu_az = 1.0f;  /* normal gravity > 0.5 */
    ard_pti_tick(&g_ctx);  /* clears motionless_alert_sent */

    /* Phase 3: motionless again after new timeout */
    s_imu_ax = 0.0f; s_imu_ay = 0.0f; s_imu_az = 0.1f;
    ard_pti_tick(&g_ctx);
    s_mock_time_ms += 200U;
    ard_pti_tick(&g_ctx);  /* should fire again */

    ASSERT_INT_EQ(s_motionless_count, 2,
                  "MOTIONLESS can re-trigger after motion clears it");
}

/* -------------------------------------------------------------------------
 * Tests — SOS
 * ------------------------------------------------------------------------- */

static void test_sos_alert_when_gpio_low(void)
{
    setup();
    s_mock_gpio = 0;  /* button pressed */
    ard_pti_tick(&g_ctx);
    ASSERT_INT_EQ(s_sos_count, 1, "SOS alert fires when GPIO is low");
}

static void test_sos_alert_not_while_gpio_high(void)
{
    setup();
    s_mock_gpio = 1;  /* released */
    run_ticks(&g_ctx, 5, 40);
    ASSERT_INT_EQ(s_sos_count, 0, "no SOS alert when GPIO is high");
}

static void test_sos_debounce_held(void)
{
    setup();
    s_mock_gpio = 0;  /* held down */
    run_ticks(&g_ctx, 5, 40);
    ASSERT_INT_EQ(s_sos_count, 1, "SOS held fires only once (debounce)");
}

static void test_sos_re_fires_after_release(void)
{
    setup();
    s_mock_gpio = 0;
    ard_pti_tick(&g_ctx);   /* fires */
    s_mock_gpio = 1;
    ard_pti_tick(&g_ctx);   /* release */
    s_mock_gpio = 0;
    ard_pti_tick(&g_ctx);   /* press again → fires */
    ASSERT_INT_EQ(s_sos_count, 2, "SOS re-fires after release and press");
}

/* -------------------------------------------------------------------------
 * Tests — alert reset
 * ------------------------------------------------------------------------- */

static void test_reset_alerts_clears_motionless_sent(void)
{
    setup();
    g_cfg.motionless_timeout_ms = 100U;
    g_cfg.motion_threshold_g    = 2.0f;
    ard_pti_init(&g_ctx, &g_cfg, capture_alert, mock_fall_score, mock_gpio_read, NULL, NULL);

    ard_pti_tick(&g_ctx);
    s_mock_time_ms = 200U;
    ard_pti_tick(&g_ctx);  /* fires MOTIONLESS, sets debounce */

    ard_pti_reset_alerts(&g_ctx);  /* clears debounce */

    s_mock_time_ms = 400U;
    ard_pti_tick(&g_ctx);  /* should fire again */

    ASSERT_INT_EQ(s_motionless_count, 2,
                  "reset_alerts allows MOTIONLESS to re-fire");
}

/* -------------------------------------------------------------------------
 * Tests — sleep callback
 * ------------------------------------------------------------------------- */

static uint32_t s_slept_ms = 0;

static void mock_sleep(uint32_t ms)
{
    s_slept_ms += ms;
}

static void test_sleep_fn_called_per_tick(void)
{
    setup();
    s_slept_ms = 0;
    ard_pti_init(&g_ctx, &g_cfg, capture_alert, mock_fall_score, mock_gpio_read,
                   mock_sleep, NULL);
    run_ticks(&g_ctx, 3, 0);
    ASSERT_INT_EQ((int)s_slept_ms, 3 * (int)g_cfg.sleep_between_ticks_ms,
                  "sleep_fn called once per tick");
}

/* -------------------------------------------------------------------------
 * main
 * ------------------------------------------------------------------------- */

int main(void)
{
    printf("=== test_pti_profile ===\n\n");

    test_default_config_values();
    test_init_null_cfg_uses_defaults();
    test_init_null_ctx_no_crash();
    test_tick_returns_ok();
    test_tick_no_alert_at_rest();
    test_tick_imu_failure_returns_error();
    test_no_fall_alert_before_window_full();
    test_fall_alert_when_score_high();
    test_no_fall_alert_when_score_below_threshold();
    test_fall_alert_fires_every_tick_while_score_high();
    test_motionless_alert_after_timeout();
    test_no_motionless_alert_before_timeout();
    test_motionless_alert_sent_only_once();
    test_motionless_clears_on_motion();
    test_sos_alert_when_gpio_low();
    test_sos_alert_not_while_gpio_high();
    test_sos_debounce_held();
    test_sos_re_fires_after_release();
    test_reset_alerts_clears_motionless_sent();
    test_sleep_fn_called_per_tick();

    printf("\n=== Results: %d passed, %d failed ===\n", g_pass, g_fail);
    return g_fail == 0 ? 0 : 1;
}
