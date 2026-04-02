/*
 * Ardent SDK — Pulse
 * Copyright (C) 2026 Antoine Porte. All rights reserved.
 * LGPL v3 for non-commercial use.
 * Commercial licensing: contact@fovet.eu
 *
 * -------------------------------------------------------------------------
 * test_fatigue_profile.c — Unit tests for ardent/profiles/fatigue_profile.h
 *
 * All I2C / HR hardware is replaced by a mock registered into the
 * biosignal HAL via ard_hal_biosignal_register().
 * -------------------------------------------------------------------------
 */

#include <stdio.h>
#include <stdint.h>
#include <string.h>
#include <math.h>

#include "ardent/hal/ard_biosignal_hal.h"
#include "ardent/hal/max30102_hal.h"    /* ARD_HR_ERR_NODATA */
#include "ardent/profiles/fatigue_profile.h"

/* hal_time_ms stub — not used by fatigue_profile but required by max30102_hal.c */
uint32_t hal_time_ms(void) { return 0U; }

/* -------------------------------------------------------------------------
 * Test framework (same as other test files)
 * ------------------------------------------------------------------------- */

static int s_pass = 0;
static int s_fail = 0;

#define ASSERT(cond, msg) \
    do { \
        if (cond) { \
            printf("[PASS] %s\n", msg); \
            s_pass++; \
        } else { \
            printf("[FAIL] %s\n", msg); \
            s_fail++; \
        } \
    } while (0)

#define ASSERT_EQ_F(a, b, tol, msg) \
    ASSERT(fabsf((a) - (b)) <= (tol), msg)

/* -------------------------------------------------------------------------
 * Mock HR reader
 * ------------------------------------------------------------------------- */

static float   s_mock_bpm      = 60.0f;
static float   s_mock_spo2     = 98.0f;
static int     s_mock_rc       = 0; /* ARD_HAL_OK */

static int mock_hr_read(ard_biosignal_sample_t *out)
{
    if (s_mock_rc != ARD_HAL_OK)
        return s_mock_rc;

    out->source            = ARD_SOURCE_HR;
    out->timestamp_ms      = 0U;
    out->value.hr.bpm      = s_mock_bpm;
    out->value.hr.spo2     = s_mock_spo2;
    out->value.hr.rmssd    = (s_mock_bpm > 0.0f) ? 60000.0f / s_mock_bpm : 0.0f;
    return ARD_HAL_OK;
}

/* -------------------------------------------------------------------------
 * Alert / LED / Sleep mock state
 * ------------------------------------------------------------------------- */

static int                  s_alert_count;
static ard_fatigue_level_t s_last_alert_level;
static int                  s_led_count;
static ard_fatigue_level_t s_last_led_level;
static int                  s_sleep_count;

static void mock_alert(ard_fatigue_level_t level, void *user_data)
{
    (void)user_data;
    s_alert_count++;
    s_last_alert_level = level;
}

static void mock_led(ard_fatigue_level_t level)
{
    s_led_count++;
    s_last_led_level = level;
}

static void mock_sleep(uint32_t ms)
{
    (void)ms;
    s_sleep_count++;
}

/* -------------------------------------------------------------------------
 * Helpers
 * ------------------------------------------------------------------------- */

static void setup(void)
{
    ard_hal_biosignal_reset();
    ard_hal_biosignal_register(ARD_SOURCE_HR, mock_hr_read);

    s_mock_bpm   = 60.0f;
    s_mock_spo2  = 98.0f;
    s_mock_rc    = ARD_HAL_OK;

    s_alert_count      = 0;
    s_last_alert_level = ARD_FATIGUE_LEVEL_UNKNOWN;
    s_led_count        = 0;
    s_last_led_level   = ARD_FATIGUE_LEVEL_UNKNOWN;
    s_sleep_count      = 0;
}

/**
 * Run exactly warmup_samples ticks with s_mock_bpm already set.
 * After this the EMA is seeded and the profile is past warmup.
 */
static void run_warmup(ard_fatigue_ctx_t *ctx, float bpm)
{
    uint32_t i;
    s_mock_bpm = bpm;
    for (i = 0; i < ctx->config.warmup_samples; i++)
        ard_fatigue_tick(ctx);
}

/* -------------------------------------------------------------------------
 * Tests — default config
 * ------------------------------------------------------------------------- */

static void test_default_config_hr_ok(void)
{
    ard_fatigue_config_t cfg = ard_fatigue_default_config();
    ASSERT_EQ_F(cfg.hr_ok, ARD_FATIGUE_DEFAULT_HR_OK, 1e-4f,
                "default hr_ok == " "ARD_FATIGUE_DEFAULT_HR_OK");
}

static void test_default_config_hr_alert(void)
{
    ard_fatigue_config_t cfg = ard_fatigue_default_config();
    ASSERT_EQ_F(cfg.hr_alert, ARD_FATIGUE_DEFAULT_HR_ALERT, 1e-4f,
                "default hr_alert == ARD_FATIGUE_DEFAULT_HR_ALERT");
}

static void test_default_config_spo2_critical(void)
{
    ard_fatigue_config_t cfg = ard_fatigue_default_config();
    ASSERT_EQ_F(cfg.spo2_critical, ARD_FATIGUE_DEFAULT_SPO2_CRITICAL, 1e-4f,
                "default spo2_critical == ARD_FATIGUE_DEFAULT_SPO2_CRITICAL");
}

static void test_default_config_ema_alpha(void)
{
    ard_fatigue_config_t cfg = ard_fatigue_default_config();
    ASSERT_EQ_F(cfg.ema_alpha, ARD_FATIGUE_DEFAULT_EMA_ALPHA, 1e-6f,
                "default ema_alpha == ARD_FATIGUE_DEFAULT_EMA_ALPHA");
}

static void test_default_config_warmup_samples(void)
{
    ard_fatigue_config_t cfg = ard_fatigue_default_config();
    ASSERT(cfg.warmup_samples == ARD_FATIGUE_DEFAULT_WARMUP,
           "default warmup_samples == ARD_FATIGUE_DEFAULT_WARMUP");
}

static void test_default_config_sleep_ms(void)
{
    ard_fatigue_config_t cfg = ard_fatigue_default_config();
    ASSERT(cfg.sleep_between_ticks_ms == ARD_FATIGUE_DEFAULT_SLEEP_MS,
           "default sleep_between_ticks_ms == 40");
}

/* -------------------------------------------------------------------------
 * Tests — init
 * ------------------------------------------------------------------------- */

static void test_init_null_ctx_does_not_crash(void)
{
    ard_fatigue_init(NULL, NULL, NULL, NULL, NULL, NULL);
    ASSERT(1, "init NULL ctx does not crash");
}

/* -------------------------------------------------------------------------
 * Tests — tick NODATA
 * ------------------------------------------------------------------------- */

static void test_tick_nodata_returns_ok(void)
{
    ard_fatigue_ctx_t ctx;
    int rc;
    setup();
    s_mock_rc = ARD_HR_ERR_NODATA;
    ard_fatigue_init(&ctx, NULL, mock_alert, mock_led, NULL, NULL);
    rc = ard_fatigue_tick(&ctx);
    ASSERT(rc == ARD_HAL_OK, "tick NODATA returns ARD_HAL_OK");
}

static void test_tick_nodata_level_stays_unknown(void)
{
    ard_fatigue_ctx_t ctx;
    setup();
    s_mock_rc = ARD_HR_ERR_NODATA;
    ard_fatigue_init(&ctx, NULL, mock_alert, mock_led, NULL, NULL);
    ard_fatigue_tick(&ctx);
    ASSERT(ard_fatigue_get_level(&ctx) == ARD_FATIGUE_LEVEL_UNKNOWN,
           "tick NODATA keeps level UNKNOWN");
}

/* -------------------------------------------------------------------------
 * Tests — warmup period
 * ------------------------------------------------------------------------- */

static void test_level_unknown_before_warmup(void)
{
    ard_fatigue_ctx_t    ctx;
    ard_fatigue_config_t cfg;
    uint32_t i;
    setup();
    cfg = ard_fatigue_default_config();
    ard_fatigue_init(&ctx, &cfg, mock_alert, mock_led, NULL, NULL);

    /* Run warmup_samples - 1 ticks — still UNKNOWN */
    for (i = 0; i < cfg.warmup_samples - 1U; i++)
        ard_fatigue_tick(&ctx);

    ASSERT(ard_fatigue_get_level(&ctx) == ARD_FATIGUE_LEVEL_UNKNOWN,
           "level UNKNOWN during warmup");
}

/* -------------------------------------------------------------------------
 * Tests — BPM classification
 * ------------------------------------------------------------------------- */

static void test_level_ok_after_warmup_low_bpm(void)
{
    ard_fatigue_ctx_t ctx;
    setup();
    ard_fatigue_init(&ctx, NULL, mock_alert, mock_led, NULL, NULL);
    run_warmup(&ctx, 55.0f);  /* BPM 55 < hr_ok 72 */
    ASSERT(ard_fatigue_get_level(&ctx) == ARD_FATIGUE_LEVEL_OK,
           "level OK for BPM=55 (< hr_ok=72)");
}

static void test_level_critical_after_warmup_high_bpm(void)
{
    ard_fatigue_ctx_t ctx;
    setup();
    ard_fatigue_init(&ctx, NULL, mock_alert, mock_led, NULL, NULL);
    run_warmup(&ctx, 90.0f);  /* BPM 90 > hr_alert 82 */
    ASSERT(ard_fatigue_get_level(&ctx) == ARD_FATIGUE_LEVEL_CRITICAL,
           "level CRITICAL for BPM=90 (> hr_alert=82)");
}

static void test_level_alert_for_mid_bpm(void)
{
    ard_fatigue_ctx_t ctx;
    setup();
    ard_fatigue_init(&ctx, NULL, mock_alert, mock_led, NULL, NULL);
    run_warmup(&ctx, 77.0f);  /* 72 <= BPM=77 <= 82 */
    ASSERT(ard_fatigue_get_level(&ctx) == ARD_FATIGUE_LEVEL_ALERT,
           "level ALERT for BPM=77 (hr_ok <= bpm <= hr_alert)");
}

/* -------------------------------------------------------------------------
 * Tests — SpO2 check
 * ------------------------------------------------------------------------- */

static void test_spo2_critical_overrides_low_bpm(void)
{
    ard_fatigue_ctx_t ctx;
    setup();
    s_mock_spo2 = 90.0f; /* below spo2_critical=94 */
    ard_fatigue_init(&ctx, NULL, mock_alert, mock_led, NULL, NULL);
    run_warmup(&ctx, 55.0f);  /* BPM would be OK, but SpO2 is low */
    ASSERT(ard_fatigue_get_level(&ctx) == ARD_FATIGUE_LEVEL_CRITICAL,
           "SpO2=90 forces CRITICAL even with low BPM");
}

/* -------------------------------------------------------------------------
 * Tests — EMA smoothing
 * ------------------------------------------------------------------------- */

static void test_ema_smoothing_prevents_immediate_switch(void)
{
    ard_fatigue_ctx_t ctx;
    setup();
    ard_fatigue_init(&ctx, NULL, mock_alert, mock_led, NULL, NULL);

    /* Warmup at low BPM → OK */
    run_warmup(&ctx, 60.0f);
    ASSERT(ard_fatigue_get_level(&ctx) == ARD_FATIGUE_LEVEL_OK,
           "EMA test: baseline OK after warmup at 60 bpm");

    /* Single spike — EMA barely moves */
    s_mock_bpm = 100.0f;
    ard_fatigue_tick(&ctx);

    /* ema after 1 spike: 0.05*100 + 0.95*60 = 62 → still < 72 → OK */
    ASSERT(ard_fatigue_get_level(&ctx) == ARD_FATIGUE_LEVEL_OK,
           "EMA smoothing: single BPM spike does not immediately switch level");
}

/* -------------------------------------------------------------------------
 * Tests — alert callback
 * ------------------------------------------------------------------------- */

static void test_alert_fn_called_on_level_change(void)
{
    ard_fatigue_ctx_t ctx;
    setup();
    ard_fatigue_init(&ctx, NULL, mock_alert, mock_led, NULL, NULL);

    /* Warmup at low BPM → transition UNKNOWN→OK fires alert */
    run_warmup(&ctx, 55.0f);

    ASSERT(s_alert_count >= 1, "alert fired at least once on level change");
    ASSERT(s_last_alert_level == ARD_FATIGUE_LEVEL_OK,
           "alert level is OK for BPM=55");
}

static void test_alert_fn_not_called_if_level_unchanged(void)
{
    ard_fatigue_ctx_t ctx;
    int count_after_warmup;
    setup();
    ard_fatigue_init(&ctx, NULL, mock_alert, mock_led, NULL, NULL);
    run_warmup(&ctx, 55.0f);
    count_after_warmup = s_alert_count;

    /* Same BPM — level stays OK, no new alert */
    ard_fatigue_tick(&ctx);
    ard_fatigue_tick(&ctx);

    ASSERT(s_alert_count == count_after_warmup,
           "alert not re-fired when level stays unchanged");
}

/* -------------------------------------------------------------------------
 * Tests — LED callback
 * ------------------------------------------------------------------------- */

static void test_led_fn_called_every_tick_when_known(void)
{
    ard_fatigue_ctx_t ctx;
    setup();
    ard_fatigue_init(&ctx, NULL, mock_alert, mock_led, NULL, NULL);
    run_warmup(&ctx, 55.0f);

    /* Count LED calls for 5 more ticks */
    int base = s_led_count;
    ard_fatigue_tick(&ctx);
    ard_fatigue_tick(&ctx);
    ard_fatigue_tick(&ctx);
    ard_fatigue_tick(&ctx);
    ard_fatigue_tick(&ctx);

    ASSERT(s_led_count == base + 5,
           "led_fn called once per tick when level is known");
}

static void test_led_fn_not_called_during_warmup(void)
{
    ard_fatigue_ctx_t    ctx;
    ard_fatigue_config_t cfg;
    uint32_t i;
    setup();
    cfg = ard_fatigue_default_config();
    ard_fatigue_init(&ctx, &cfg, mock_alert, mock_led, NULL, NULL);

    for (i = 0; i < cfg.warmup_samples - 1U; i++)
        ard_fatigue_tick(&ctx);

    ASSERT(s_led_count == 0, "led_fn not called during warmup");
}

/* -------------------------------------------------------------------------
 * Tests — sleep callback
 * ------------------------------------------------------------------------- */

static void test_sleep_fn_called_each_tick(void)
{
    ard_fatigue_ctx_t ctx;
    setup();
    ard_fatigue_init(&ctx, NULL, mock_alert, NULL, mock_sleep, NULL);
    ard_fatigue_tick(&ctx);
    ard_fatigue_tick(&ctx);
    ard_fatigue_tick(&ctx);
    ASSERT(s_sleep_count == 3, "sleep_fn called once per tick");
}

/* -------------------------------------------------------------------------
 * Tests — get_level accessor
 * ------------------------------------------------------------------------- */

static void test_get_level_returns_current_level(void)
{
    ard_fatigue_ctx_t ctx;
    setup();
    ard_fatigue_init(&ctx, NULL, mock_alert, mock_led, NULL, NULL);
    run_warmup(&ctx, 55.0f);
    ASSERT(ard_fatigue_get_level(&ctx) == ARD_FATIGUE_LEVEL_OK,
           "get_level returns OK after warmup at low BPM");
}

static void test_get_level_null_ctx_returns_unknown(void)
{
    ASSERT(ard_fatigue_get_level(NULL) == ARD_FATIGUE_LEVEL_UNKNOWN,
           "get_level(NULL) returns UNKNOWN");
}

/* -------------------------------------------------------------------------
 * Tests — I2C error propagation
 * ------------------------------------------------------------------------- */

static void test_i2c_error_propagated(void)
{
    ard_fatigue_ctx_t ctx;
    int rc;
    setup();
    ard_fatigue_init(&ctx, NULL, mock_alert, mock_led, NULL, NULL);
    s_mock_rc = ARD_HR_ERR_I2C;
    rc = ard_fatigue_tick(&ctx);
    ASSERT(rc == ARD_HR_ERR_I2C, "I2C error propagated from ard_fatigue_tick");
}

/* -------------------------------------------------------------------------
 * Tests — NULL callbacks safe
 * ------------------------------------------------------------------------- */

static void test_null_led_fn_safe(void)
{
    ard_fatigue_ctx_t ctx;
    setup();
    ard_fatigue_init(&ctx, NULL, mock_alert, NULL /* no LED */, NULL, NULL);
    run_warmup(&ctx, 55.0f);
    ASSERT(ard_fatigue_get_level(&ctx) == ARD_FATIGUE_LEVEL_OK,
           "NULL led_fn does not crash");
}

static void test_null_alert_fn_safe(void)
{
    ard_fatigue_ctx_t ctx;
    setup();
    ard_fatigue_init(&ctx, NULL, NULL /* no alert */, mock_led, NULL, NULL);
    run_warmup(&ctx, 55.0f);
    ASSERT(ard_fatigue_get_level(&ctx) == ARD_FATIGUE_LEVEL_OK,
           "NULL alert_fn does not crash");
}

/* -------------------------------------------------------------------------
 * main
 * ------------------------------------------------------------------------- */

int main(void)
{
    printf("=== test_fatigue_profile ===\n\n");

    test_default_config_hr_ok();
    test_default_config_hr_alert();
    test_default_config_spo2_critical();
    test_default_config_ema_alpha();
    test_default_config_warmup_samples();
    test_default_config_sleep_ms();

    test_init_null_ctx_does_not_crash();

    test_tick_nodata_returns_ok();
    test_tick_nodata_level_stays_unknown();

    test_level_unknown_before_warmup();
    test_level_ok_after_warmup_low_bpm();
    test_level_critical_after_warmup_high_bpm();
    test_level_alert_for_mid_bpm();

    test_spo2_critical_overrides_low_bpm();

    test_ema_smoothing_prevents_immediate_switch();

    test_alert_fn_called_on_level_change();
    test_alert_fn_not_called_if_level_unchanged();

    test_led_fn_called_every_tick_when_known();
    test_led_fn_not_called_during_warmup();

    test_sleep_fn_called_each_tick();

    test_get_level_returns_current_level();
    test_get_level_null_ctx_returns_unknown();

    test_i2c_error_propagated();

    test_null_led_fn_safe();
    test_null_alert_fn_safe();

    printf("\n=== Results: %d passed, %d failed ===\n", s_pass, s_fail);
    return s_fail > 0 ? 1 : 0;
}
