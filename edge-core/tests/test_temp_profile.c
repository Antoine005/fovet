/*
 * Fovet SDK — Sentinelle
 * Copyright (C) 2026 Antoine Porte. All rights reserved.
 * LGPL v3 for non-commercial use.
 * Commercial licensing: contact@fovet.eu
 *
 * -------------------------------------------------------------------------
 * test_temp_profile.c — Unit tests for fovet/profiles/temp_profile.h
 *
 * All DHT22 / TEMP hardware is replaced by a mock registered directly into
 * the biosignal HAL via fovet_hal_biosignal_register().
 * -------------------------------------------------------------------------
 */

#include <stdio.h>
#include <stdint.h>
#include <string.h>
#include <math.h>

#include "fovet/hal/fovet_biosignal_hal.h"
#include "fovet/hal/dht22_hal.h"         /* FOVET_DHT22_ERR_* */
#include "fovet/profiles/temp_profile.h"

/* -------------------------------------------------------------------------
 * Test framework
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
 * Mock TEMP reader
 * ------------------------------------------------------------------------- */

static float s_mock_celsius  = 22.0f;
static float s_mock_humidity = 50.0f;
static int   s_mock_rc       = FOVET_HAL_OK;

static int mock_temp_read(fovet_biosignal_sample_t *out)
{
    if (s_mock_rc != FOVET_HAL_OK)
        return s_mock_rc;

    out->source                    = FOVET_SOURCE_TEMP;
    out->timestamp_ms              = 0U;
    out->value.temp.celsius        = s_mock_celsius;
    out->value.temp.humidity_pct   = s_mock_humidity;
    return FOVET_HAL_OK;
}

/* -------------------------------------------------------------------------
 * Alert / LED / Sleep mock state
 * ------------------------------------------------------------------------- */

static int                s_alert_count;
static fovet_temp_level_t s_last_alert_level;
static int                s_led_count;
static fovet_temp_level_t s_last_led_level;
static int                s_sleep_count;

static void mock_alert(fovet_temp_level_t level, void *user_data)
{
    (void)user_data;
    s_alert_count++;
    s_last_alert_level = level;
}

static void mock_led(fovet_temp_level_t level)
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
    fovet_hal_biosignal_reset();
    fovet_hal_biosignal_register(FOVET_SOURCE_TEMP, mock_temp_read);

    s_mock_celsius  = 22.0f;
    s_mock_humidity = 50.0f;
    s_mock_rc       = FOVET_HAL_OK;

    s_alert_count      = 0;
    s_last_alert_level = FOVET_TEMP_LEVEL_UNKNOWN;
    s_led_count        = 0;
    s_last_led_level   = FOVET_TEMP_LEVEL_UNKNOWN;
    s_sleep_count      = 0;
}

/**
 * Run exactly warmup_samples ticks with s_mock_celsius/humidity already set.
 * After this the EMA is seeded and the profile is past warmup.
 */
static void run_warmup(fovet_temp_ctx_t *ctx, float celsius, float humidity)
{
    uint32_t i;
    s_mock_celsius  = celsius;
    s_mock_humidity = humidity;
    for (i = 0; i < ctx->config.warmup_samples; i++)
        fovet_temp_tick(ctx);
}

/* -------------------------------------------------------------------------
 * Tests — default config
 * ------------------------------------------------------------------------- */

static void test_default_config_wbgt_warn(void)
{
    fovet_temp_config_t cfg = fovet_temp_default_config();
    ASSERT_EQ_F(cfg.wbgt_warn_c, FOVET_TEMP_DEFAULT_WBGT_WARN_C, 1e-4f,
                "default wbgt_warn_c == FOVET_TEMP_DEFAULT_WBGT_WARN_C");
}

static void test_default_config_wbgt_danger(void)
{
    fovet_temp_config_t cfg = fovet_temp_default_config();
    ASSERT_EQ_F(cfg.wbgt_danger_c, FOVET_TEMP_DEFAULT_WBGT_DANGER_C, 1e-4f,
                "default wbgt_danger_c == FOVET_TEMP_DEFAULT_WBGT_DANGER_C");
}

static void test_default_config_cold_alert(void)
{
    fovet_temp_config_t cfg = fovet_temp_default_config();
    ASSERT_EQ_F(cfg.cold_alert_c, FOVET_TEMP_DEFAULT_COLD_ALERT_C, 1e-4f,
                "default cold_alert_c == FOVET_TEMP_DEFAULT_COLD_ALERT_C");
}

static void test_default_config_ema_alpha(void)
{
    fovet_temp_config_t cfg = fovet_temp_default_config();
    ASSERT_EQ_F(cfg.ema_alpha, FOVET_TEMP_DEFAULT_EMA_ALPHA, 1e-6f,
                "default ema_alpha == FOVET_TEMP_DEFAULT_EMA_ALPHA");
}

static void test_default_config_warmup_samples(void)
{
    fovet_temp_config_t cfg = fovet_temp_default_config();
    ASSERT(cfg.warmup_samples == FOVET_TEMP_DEFAULT_WARMUP,
           "default warmup_samples == FOVET_TEMP_DEFAULT_WARMUP");
}

static void test_default_config_sleep_ms(void)
{
    fovet_temp_config_t cfg = fovet_temp_default_config();
    ASSERT(cfg.sleep_between_ticks_ms == FOVET_TEMP_DEFAULT_SLEEP_MS,
           "default sleep_between_ticks_ms == 2000");
}

/* -------------------------------------------------------------------------
 * Tests — compute_wbgt
 * Normal  (22°C, 50%) → WBGT ≈ 17.4 → SAFE
 * Warm    (35°C, 72%) → WBGT ≈ 31.9 → DANGER
 * Moderate(30°C, 65%) → WBGT ≈ 26.4 → WARN
 * Cold    ( 4°C, 80%) → WBGT << 25   (cold check takes priority)
 * ------------------------------------------------------------------------- */

static void test_wbgt_normal_scenario_below_25(void)
{
    float wbgt = fovet_temp_compute_wbgt(22.0f, 50.0f);
    ASSERT(wbgt < FOVET_TEMP_DEFAULT_WBGT_WARN_C,
           "WBGT(22°C, 50%) < 25 (normal scenario → SAFE)");
}

static void test_wbgt_warm_scenario_above_28(void)
{
    float wbgt = fovet_temp_compute_wbgt(35.0f, 72.0f);
    ASSERT(wbgt >= FOVET_TEMP_DEFAULT_WBGT_DANGER_C,
           "WBGT(35°C, 72%) >= 28 (heat stress → DANGER)");
}

static void test_wbgt_moderate_scenario_in_warn_range(void)
{
    /* 30°C, 65% → WBGT ≈ 26.4 → between 25 and 28 */
    float wbgt = fovet_temp_compute_wbgt(30.0f, 65.0f);
    ASSERT(wbgt >= FOVET_TEMP_DEFAULT_WBGT_WARN_C &&
           wbgt <  FOVET_TEMP_DEFAULT_WBGT_DANGER_C,
           "WBGT(30°C, 65%) in [25, 28) (moderate heat → WARN)");
}

static void test_wbgt_increases_with_temperature(void)
{
    float wbgt_low  = fovet_temp_compute_wbgt(20.0f, 50.0f);
    float wbgt_high = fovet_temp_compute_wbgt(35.0f, 50.0f);
    ASSERT(wbgt_high > wbgt_low,
           "WBGT increases with temperature");
}

static void test_wbgt_increases_with_humidity(void)
{
    float wbgt_dry = fovet_temp_compute_wbgt(30.0f, 30.0f);
    float wbgt_wet = fovet_temp_compute_wbgt(30.0f, 80.0f);
    ASSERT(wbgt_wet > wbgt_dry,
           "WBGT increases with humidity");
}

/* -------------------------------------------------------------------------
 * Tests — init
 * ------------------------------------------------------------------------- */

static void test_init_null_ctx_does_not_crash(void)
{
    fovet_temp_init(NULL, NULL, NULL, NULL, NULL, NULL);
    ASSERT(1, "init NULL ctx does not crash");
}

static void test_init_with_null_cfg_uses_defaults(void)
{
    fovet_temp_ctx_t ctx;
    fovet_temp_init(&ctx, NULL, NULL, NULL, NULL, NULL);
    ASSERT_EQ_F(ctx.config.wbgt_warn_c, FOVET_TEMP_DEFAULT_WBGT_WARN_C, 1e-4f,
                "NULL cfg → default wbgt_warn_c applied");
}

/* -------------------------------------------------------------------------
 * Tests — transient errors (TIMEOUT / CHECKSUM / RANGE)
 * ------------------------------------------------------------------------- */

static void test_tick_timeout_returns_ok(void)
{
    fovet_temp_ctx_t ctx;
    int rc;
    setup();
    s_mock_rc = FOVET_DHT22_ERR_TIMEOUT;
    fovet_temp_init(&ctx, NULL, mock_alert, mock_led, NULL, NULL);
    rc = fovet_temp_tick(&ctx);
    ASSERT(rc == FOVET_HAL_OK, "tick TIMEOUT returns FOVET_HAL_OK (transient)");
}

static void test_tick_checksum_returns_ok(void)
{
    fovet_temp_ctx_t ctx;
    int rc;
    setup();
    s_mock_rc = FOVET_DHT22_ERR_CHECKSUM;
    fovet_temp_init(&ctx, NULL, mock_alert, mock_led, NULL, NULL);
    rc = fovet_temp_tick(&ctx);
    ASSERT(rc == FOVET_HAL_OK, "tick CHECKSUM returns FOVET_HAL_OK (transient)");
}

static void test_tick_range_returns_ok(void)
{
    fovet_temp_ctx_t ctx;
    int rc;
    setup();
    s_mock_rc = FOVET_DHT22_ERR_RANGE;
    fovet_temp_init(&ctx, NULL, mock_alert, mock_led, NULL, NULL);
    rc = fovet_temp_tick(&ctx);
    ASSERT(rc == FOVET_HAL_OK, "tick RANGE returns FOVET_HAL_OK (transient)");
}

static void test_tick_transient_level_stays_unknown(void)
{
    fovet_temp_ctx_t ctx;
    setup();
    s_mock_rc = FOVET_DHT22_ERR_TIMEOUT;
    fovet_temp_init(&ctx, NULL, mock_alert, mock_led, NULL, NULL);
    fovet_temp_tick(&ctx);
    ASSERT(fovet_temp_get_level(&ctx) == FOVET_TEMP_LEVEL_UNKNOWN,
           "transient error keeps level UNKNOWN");
}

static void test_tick_io_error_propagated(void)
{
    fovet_temp_ctx_t ctx;
    int rc;
    setup();
    s_mock_rc = FOVET_DHT22_ERR_IO;
    fovet_temp_init(&ctx, NULL, mock_alert, mock_led, NULL, NULL);
    rc = fovet_temp_tick(&ctx);
    ASSERT(rc == FOVET_DHT22_ERR_IO, "ERR_IO propagated from fovet_temp_tick");
}

/* -------------------------------------------------------------------------
 * Tests — warmup period
 * ------------------------------------------------------------------------- */

static void test_level_unknown_before_warmup(void)
{
    fovet_temp_ctx_t    ctx;
    fovet_temp_config_t cfg;
    uint32_t i;
    setup();
    cfg = fovet_temp_default_config();
    fovet_temp_init(&ctx, &cfg, mock_alert, mock_led, NULL, NULL);

    for (i = 0; i < cfg.warmup_samples - 1U; i++)
        fovet_temp_tick(&ctx);

    ASSERT(fovet_temp_get_level(&ctx) == FOVET_TEMP_LEVEL_UNKNOWN,
           "level UNKNOWN during warmup");
}

/* -------------------------------------------------------------------------
 * Tests — classification after warmup
 * ------------------------------------------------------------------------- */

static void test_level_safe_at_normal_temperature(void)
{
    fovet_temp_ctx_t ctx;
    setup();
    fovet_temp_init(&ctx, NULL, mock_alert, mock_led, NULL, NULL);
    run_warmup(&ctx, 22.0f, 50.0f);  /* WBGT ≈ 17.4 → SAFE */
    ASSERT(fovet_temp_get_level(&ctx) == FOVET_TEMP_LEVEL_SAFE,
           "level SAFE at 22°C / 50% (WBGT ~ 17°C)");
}

static void test_level_danger_at_heat_stress(void)
{
    fovet_temp_ctx_t ctx;
    setup();
    fovet_temp_init(&ctx, NULL, mock_alert, mock_led, NULL, NULL);
    run_warmup(&ctx, 35.0f, 72.0f);  /* WBGT ≈ 31.9 → DANGER */
    ASSERT(fovet_temp_get_level(&ctx) == FOVET_TEMP_LEVEL_DANGER,
           "level DANGER at 35°C / 72% (WBGT ~ 32°C)");
}

static void test_level_warn_at_moderate_heat(void)
{
    fovet_temp_ctx_t ctx;
    setup();
    fovet_temp_init(&ctx, NULL, mock_alert, mock_led, NULL, NULL);
    run_warmup(&ctx, 30.0f, 65.0f);  /* WBGT ≈ 26.4 → WARN */
    ASSERT(fovet_temp_get_level(&ctx) == FOVET_TEMP_LEVEL_WARN,
           "level WARN at 30°C / 65% (WBGT ~ 26°C)");
}

static void test_level_cold_at_low_temperature(void)
{
    fovet_temp_ctx_t ctx;
    setup();
    fovet_temp_init(&ctx, NULL, mock_alert, mock_led, NULL, NULL);
    run_warmup(&ctx, 4.0f, 80.0f);  /* T=4 ≤ cold_alert_c=10 → COLD */
    ASSERT(fovet_temp_get_level(&ctx) == FOVET_TEMP_LEVEL_COLD,
           "level COLD at 4°C (T ≤ cold_alert_c=10)");
}

static void test_cold_priority_over_wbgt(void)
{
    /* At 8°C / 80%: T ≤ 10°C → COLD regardless of WBGT value */
    fovet_temp_ctx_t ctx;
    setup();
    fovet_temp_init(&ctx, NULL, mock_alert, mock_led, NULL, NULL);
    run_warmup(&ctx, 8.0f, 80.0f);
    ASSERT(fovet_temp_get_level(&ctx) == FOVET_TEMP_LEVEL_COLD,
           "cold check takes priority: T=8°C → COLD");
}

static void test_exactly_cold_alert_threshold(void)
{
    /* T == cold_alert_c (10.0) → COLD (border: ≤ includes equality) */
    fovet_temp_ctx_t ctx;
    setup();
    fovet_temp_init(&ctx, NULL, mock_alert, mock_led, NULL, NULL);
    run_warmup(&ctx, 10.0f, 50.0f);
    ASSERT(fovet_temp_get_level(&ctx) == FOVET_TEMP_LEVEL_COLD,
           "T == cold_alert_c=10 → COLD (equality check)");
}

static void test_just_above_cold_threshold_is_safe(void)
{
    /* T = 11°C / 50% → not cold, WBGT ≈ 8.x → SAFE */
    fovet_temp_ctx_t ctx;
    setup();
    fovet_temp_init(&ctx, NULL, mock_alert, mock_led, NULL, NULL);
    run_warmup(&ctx, 11.0f, 50.0f);
    ASSERT(fovet_temp_get_level(&ctx) == FOVET_TEMP_LEVEL_SAFE,
           "T=11°C (just above cold_alert_c) → SAFE");
}

/* -------------------------------------------------------------------------
 * Tests — EMA smoothing
 * ------------------------------------------------------------------------- */

static void test_ema_smoothing_prevents_immediate_switch(void)
{
    fovet_temp_ctx_t ctx;
    setup();
    fovet_temp_init(&ctx, NULL, mock_alert, mock_led, NULL, NULL);

    /* Warmup at normal → SAFE */
    run_warmup(&ctx, 22.0f, 50.0f);
    ASSERT(fovet_temp_get_level(&ctx) == FOVET_TEMP_LEVEL_SAFE,
           "EMA test: baseline SAFE after warmup at 22°C");

    /* Single spike at 35°C, 72% — EMA barely moves (α=0.10):
     * ema = 0.1*35 + 0.9*22 = 23.3°C → WBGT(23.3, 72%) ≈ 20.7 → SAFE */
    s_mock_celsius  = 35.0f;
    s_mock_humidity = 72.0f;
    fovet_temp_tick(&ctx);

    ASSERT(fovet_temp_get_level(&ctx) == FOVET_TEMP_LEVEL_SAFE,
           "EMA smoothing: single heat spike does not immediately switch level");
}

static void test_ema_seeded_with_first_sample(void)
{
    fovet_temp_ctx_t ctx;
    fovet_temp_config_t cfg = fovet_temp_default_config();
    cfg.warmup_samples = 1U;  /* Only 1 sample needed — immediately seeds EMA */
    setup();
    fovet_temp_init(&ctx, &cfg, mock_alert, mock_led, NULL, NULL);

    s_mock_celsius  = 35.0f;
    s_mock_humidity = 72.0f;
    fovet_temp_tick(&ctx);   /* warmup tick 1: seeds EMA at 35°C, classifies */

    ASSERT(fovet_temp_get_level(&ctx) == FOVET_TEMP_LEVEL_DANGER,
           "EMA seeded with first sample: 35°C → DANGER at warmup=1");
}

/* -------------------------------------------------------------------------
 * Tests — alert callback
 * ------------------------------------------------------------------------- */

static void test_alert_fn_called_on_level_change(void)
{
    fovet_temp_ctx_t ctx;
    setup();
    fovet_temp_init(&ctx, NULL, mock_alert, mock_led, NULL, NULL);
    run_warmup(&ctx, 22.0f, 50.0f);  /* UNKNOWN → SAFE transition */

    ASSERT(s_alert_count >= 1, "alert fired at least once on level change");
    ASSERT(s_last_alert_level == FOVET_TEMP_LEVEL_SAFE,
           "alert level is SAFE at 22°C");
}

static void test_alert_fn_not_called_if_level_unchanged(void)
{
    fovet_temp_ctx_t ctx;
    int count_after_warmup;
    setup();
    fovet_temp_init(&ctx, NULL, mock_alert, mock_led, NULL, NULL);
    run_warmup(&ctx, 22.0f, 50.0f);
    count_after_warmup = s_alert_count;

    fovet_temp_tick(&ctx);
    fovet_temp_tick(&ctx);

    ASSERT(s_alert_count == count_after_warmup,
           "alert not re-fired when level stays unchanged");
}

/* -------------------------------------------------------------------------
 * Tests — LED callback
 * ------------------------------------------------------------------------- */

static void test_led_fn_called_every_tick_when_known(void)
{
    fovet_temp_ctx_t ctx;
    int base;
    setup();
    fovet_temp_init(&ctx, NULL, mock_alert, mock_led, NULL, NULL);
    run_warmup(&ctx, 22.0f, 50.0f);
    base = s_led_count;

    fovet_temp_tick(&ctx);
    fovet_temp_tick(&ctx);
    fovet_temp_tick(&ctx);

    ASSERT(s_led_count == base + 3,
           "led_fn called once per tick when level is known");
}

static void test_led_fn_not_called_during_warmup(void)
{
    fovet_temp_ctx_t    ctx;
    fovet_temp_config_t cfg;
    uint32_t i;
    setup();
    cfg = fovet_temp_default_config();
    fovet_temp_init(&ctx, &cfg, mock_alert, mock_led, NULL, NULL);

    for (i = 0; i < cfg.warmup_samples - 1U; i++)
        fovet_temp_tick(&ctx);

    ASSERT(s_led_count == 0, "led_fn not called during warmup");
}

/* -------------------------------------------------------------------------
 * Tests — sleep callback
 * ------------------------------------------------------------------------- */

static void test_sleep_fn_called_each_tick(void)
{
    fovet_temp_ctx_t ctx;
    setup();
    fovet_temp_init(&ctx, NULL, mock_alert, NULL, mock_sleep, NULL);
    fovet_temp_tick(&ctx);
    fovet_temp_tick(&ctx);
    fovet_temp_tick(&ctx);
    ASSERT(s_sleep_count == 3, "sleep_fn called once per tick");
}

static void test_sleep_fn_called_on_transient_error(void)
{
    fovet_temp_ctx_t ctx;
    setup();
    s_mock_rc = FOVET_DHT22_ERR_TIMEOUT;
    fovet_temp_init(&ctx, NULL, NULL, NULL, mock_sleep, NULL);
    fovet_temp_tick(&ctx);
    ASSERT(s_sleep_count == 1, "sleep_fn called even on transient error tick");
}

/* -------------------------------------------------------------------------
 * Tests — get_level accessor
 * ------------------------------------------------------------------------- */

static void test_get_level_returns_current_level(void)
{
    fovet_temp_ctx_t ctx;
    setup();
    fovet_temp_init(&ctx, NULL, mock_alert, mock_led, NULL, NULL);
    run_warmup(&ctx, 22.0f, 50.0f);
    ASSERT(fovet_temp_get_level(&ctx) == FOVET_TEMP_LEVEL_SAFE,
           "get_level returns SAFE after warmup at 22°C");
}

static void test_get_level_null_ctx_returns_unknown(void)
{
    ASSERT(fovet_temp_get_level(NULL) == FOVET_TEMP_LEVEL_UNKNOWN,
           "get_level(NULL) returns UNKNOWN");
}

/* -------------------------------------------------------------------------
 * Tests — NULL callbacks safe
 * ------------------------------------------------------------------------- */

static void test_null_led_fn_safe(void)
{
    fovet_temp_ctx_t ctx;
    setup();
    fovet_temp_init(&ctx, NULL, mock_alert, NULL, NULL, NULL);
    run_warmup(&ctx, 22.0f, 50.0f);
    ASSERT(fovet_temp_get_level(&ctx) == FOVET_TEMP_LEVEL_SAFE,
           "NULL led_fn does not crash");
}

static void test_null_alert_fn_safe(void)
{
    fovet_temp_ctx_t ctx;
    setup();
    fovet_temp_init(&ctx, NULL, NULL, mock_led, NULL, NULL);
    run_warmup(&ctx, 22.0f, 50.0f);
    ASSERT(fovet_temp_get_level(&ctx) == FOVET_TEMP_LEVEL_SAFE,
           "NULL alert_fn does not crash");
}

/* -------------------------------------------------------------------------
 * main
 * ------------------------------------------------------------------------- */

int main(void)
{
    printf("=== test_temp_profile ===\n\n");

    /* default config */
    test_default_config_wbgt_warn();
    test_default_config_wbgt_danger();
    test_default_config_cold_alert();
    test_default_config_ema_alpha();
    test_default_config_warmup_samples();
    test_default_config_sleep_ms();

    /* compute_wbgt */
    test_wbgt_normal_scenario_below_25();
    test_wbgt_warm_scenario_above_28();
    test_wbgt_moderate_scenario_in_warn_range();
    test_wbgt_increases_with_temperature();
    test_wbgt_increases_with_humidity();

    /* init */
    test_init_null_ctx_does_not_crash();
    test_init_with_null_cfg_uses_defaults();

    /* transient errors */
    test_tick_timeout_returns_ok();
    test_tick_checksum_returns_ok();
    test_tick_range_returns_ok();
    test_tick_transient_level_stays_unknown();
    test_tick_io_error_propagated();

    /* warmup */
    test_level_unknown_before_warmup();

    /* classification */
    test_level_safe_at_normal_temperature();
    test_level_danger_at_heat_stress();
    test_level_warn_at_moderate_heat();
    test_level_cold_at_low_temperature();
    test_cold_priority_over_wbgt();
    test_exactly_cold_alert_threshold();
    test_just_above_cold_threshold_is_safe();

    /* EMA */
    test_ema_smoothing_prevents_immediate_switch();
    test_ema_seeded_with_first_sample();

    /* alert */
    test_alert_fn_called_on_level_change();
    test_alert_fn_not_called_if_level_unchanged();

    /* LED */
    test_led_fn_called_every_tick_when_known();
    test_led_fn_not_called_during_warmup();

    /* sleep */
    test_sleep_fn_called_each_tick();
    test_sleep_fn_called_on_transient_error();

    /* get_level */
    test_get_level_returns_current_level();
    test_get_level_null_ctx_returns_unknown();

    /* NULL callbacks */
    test_null_led_fn_safe();
    test_null_alert_fn_safe();

    printf("\n=== Results: %d passed, %d failed ===\n", s_pass, s_fail);
    return s_fail > 0 ? 1 : 0;
}
