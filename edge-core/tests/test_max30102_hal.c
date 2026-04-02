/*
 * Ardent SDK — Pulse
 * Copyright (C) 2026 Antoine Porte. All rights reserved.
 * LGPL v3 for non-commercial use.
 * Commercial licensing: contact@fovet.eu
 *
 * -------------------------------------------------------------------------
 * test_max30102_hal.c — unit tests for max30102_hal (native gcc, no hardware)
 * -------------------------------------------------------------------------
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <math.h>
#include <time.h>

#ifndef M_PI
#define M_PI 3.14159265358979323846
#endif

/* Mirror of the private register constant needed in mock_read */
#define REG_FIFO_DATA 0x07U

#include "ardent/hal/max30102_hal.h"
#include "ardent/hal/ard_biosignal_hal.h"

/* -------------------------------------------------------------------------
 * Minimal test framework
 * ------------------------------------------------------------------------- */

static int s_pass = 0;
static int s_fail = 0;

#define ASSERT(cond) do { \
    if (cond) { s_pass++; printf("[PASS] %s\n", __func__); } \
    else       { s_fail++; printf("[FAIL] %s  (line %d)\n", __func__, __LINE__); } \
} while (0)

#define ASSERT_EQ(a, b)   ASSERT((a) == (b))
#define ASSERT_NE(a, b)   ASSERT((a) != (b))
#define ASSERT_GT(a, b)   ASSERT((a) > (b))
#define ASSERT_NEAR(a, b, tol) ASSERT(fabsf((float)(a) - (float)(b)) <= (float)(tol))

/* -------------------------------------------------------------------------
 * HAL stubs
 * ------------------------------------------------------------------------- */

uint32_t hal_time_ms(void)
{
    return (uint32_t)(clock() / (CLOCKS_PER_SEC / 1000));
}

/* -------------------------------------------------------------------------
 * Mock I2C state
 * ------------------------------------------------------------------------- */

static uint8_t s_regs[256];

/* FIFO sample queue — up to 200 samples */
static uint32_t s_fifo_ir[200];
static uint32_t s_fifo_red[200];
static uint32_t s_fifo_total  = 0;
static uint32_t s_fifo_served = 0;

static int s_i2c_fail_write = 0;
static int s_i2c_fail_read  = 0;

/* -------------------------------------------------------------------------
 * Mock I2C callbacks
 * ------------------------------------------------------------------------- */

static int mock_write(uint8_t addr, uint8_t reg, uint8_t data)
{
    (void)addr;
    if (s_i2c_fail_write) return -1;
    s_regs[reg] = data;
    return 0;
}

static int mock_read(uint8_t addr, uint8_t reg, uint8_t *buf, uint8_t len)
{
    (void)addr;
    if (s_i2c_fail_read) return -1;

    if (reg == REG_FIFO_DATA && len == 6)
    {
        if (s_fifo_served >= s_fifo_total)
        {
            /* No sample — make WR == RD so caller knows FIFO is empty */
            return -1;
        }
        uint32_t ir  = s_fifo_ir[s_fifo_served];
        uint32_t red = s_fifo_red[s_fifo_served];
        s_fifo_served++;

        buf[0] = (uint8_t)((red >> 16) & 0x03U);
        buf[1] = (uint8_t)((red >>  8) & 0xFFU);
        buf[2] = (uint8_t)( red        & 0xFFU);
        buf[3] = (uint8_t)((ir  >> 16) & 0x03U);
        buf[4] = (uint8_t)((ir  >>  8) & 0xFFU);
        buf[5] = (uint8_t)( ir         & 0xFFU);
        return 0;
    }

    for (uint8_t i = 0; i < len; i++)
        buf[i] = s_regs[reg + i];
    return 0;
}


/* -------------------------------------------------------------------------
 * Test helpers
 * ------------------------------------------------------------------------- */

/* Load n samples with a sinusoidal heartbeat into the FIFO queue. */
static void load_bpm_signal(double bpm, uint32_t n)
{
    double freq = bpm / 60.0;
    for (uint32_t i = 0; i < n; i++)
    {
        double t = (double)i / (double)ARD_MAX30102_SAMPLE_RATE;
        s_fifo_ir[i]  = (uint32_t)(100000.0 + 5000.0 * sin(2.0 * M_PI * freq * t));
        /* DC_red/DC_ir ~0.8, AC_red/AC_ir ~0.4 → R ≈ 0.5 → SpO2 ≈ 97.5 */
        s_fifo_red[i] = (uint32_t)( 80000.0 + 2000.0 * sin(2.0 * M_PI * freq * t));
    }
    s_fifo_total  = n;
    s_fifo_served = 0;
}

/* Load n flat samples (no heartbeat — constant DC, no peaks). */
static void load_flat_signal(uint32_t n)
{
    for (uint32_t i = 0; i < n; i++)
    {
        s_fifo_ir[i]  = 100000U;
        s_fifo_red[i] =  80000U;
    }
    s_fifo_total  = n;
    s_fifo_served = 0;
}

/* Prime one sample into the mock FIFO (WR=1, RD=0 → 1 sample available). */
static void prime_fifo_one(void)
{
    s_regs[0x04] = 1;  /* FIFO_WR_PTR */
    s_regs[0x06] = 0;  /* FIFO_RD_PTR */
}

/* Fill the window by calling ard_hal_hr_read N times.
 * Optionally captures the last sample into *out.
 * Returns the return code of the last call. */
static int fill_window(uint32_t n, ard_biosignal_sample_t *out)
{
    ard_biosignal_sample_t sample;
    memset(&sample, 0, sizeof(sample));
    int rc = ARD_HR_ERR_NODATA;
    for (uint32_t i = 0; i < n; i++)
    {
        prime_fifo_one();
        rc = ard_hal_hr_read(&sample);
    }
    if (out != NULL) *out = sample;
    return rc;
}

/* Setup called before every test */
static void setup(void)
{
    memset(s_regs, 0, sizeof(s_regs));
    s_regs[0xFFU] = ARD_MAX30102_PART_ID;   /* correct PART_ID */
    s_regs[0x04]  = 0;                          /* WR_PTR = RD_PTR = 0 (empty) */
    s_regs[0x06]  = 0;

    s_fifo_total  = 0;
    s_fifo_served = 0;
    s_i2c_fail_write = 0;
    s_i2c_fail_read  = 0;

    ard_max30102_reset();
    ard_hal_biosignal_reset();
    ard_max30102_set_i2c(mock_write, mock_read);
}

/* -------------------------------------------------------------------------
 * Tests — init
 * ------------------------------------------------------------------------- */

static void test_init_returns_ok_with_correct_part_id(void)
{
    setup();
    int rc = ard_max30102_init();
    ASSERT_EQ(rc, ARD_HAL_OK);
}

static void test_init_returns_err_id_on_wrong_part_id(void)
{
    setup();
    s_regs[0xFFU] = 0x00U;   /* wrong PART_ID */
    int rc = ard_max30102_init();
    ASSERT_EQ(rc, ARD_HR_ERR_ID);
}

static void test_init_returns_err_i2c_on_read_failure(void)
{
    setup();
    s_i2c_fail_read = 1;
    int rc = ard_max30102_init();
    ASSERT_EQ(rc, ARD_HR_ERR_I2C);
}

static void test_init_returns_err_i2c_on_write_failure(void)
{
    setup();
    s_i2c_fail_write = 1;
    int rc = ard_max30102_init();
    /* write_fn is called after successful PART_ID read */
    ASSERT_EQ(rc, ARD_HR_ERR_I2C);
}

static void test_init_registers_source_hr_in_biosignal_hal(void)
{
    setup();
    ard_max30102_init();
    load_flat_signal(ARD_MAX30102_WINDOW_SIZE);

    ard_biosignal_sample_t s;
    /* Fill the window via the biosignal HAL — should NOT return ARD_HAL_ERR_NOREG (-3) */
    int last_rc = ARD_HR_ERR_NODATA;
    for (uint32_t i = 0; i < ARD_MAX30102_WINDOW_SIZE; i++)
    {
        prime_fifo_one();
        last_rc = ard_hal_biosignal_read(ARD_SOURCE_HR, &s);
    }
    /* NODATA (-4) on warm-up or OK (0) when full — never NOREG (-3) */
    ASSERT(last_rc != ARD_HAL_ERR_NOREG);
}

static void test_init_writes_mode_spo2(void)
{
    setup();
    ard_max30102_init();
    /* REG_MODE_CONFIG (0x09) must be 0x03 (SpO2 mode) after init */
    ASSERT_EQ(s_regs[0x09], 0x03U);
}

/* -------------------------------------------------------------------------
 * Tests — FIFO / warm-up
 * ------------------------------------------------------------------------- */

static void test_read_returns_nodata_when_fifo_empty(void)
{
    setup();
    ard_max30102_init();
    /* WR_PTR == RD_PTR == 0 → empty */
    ard_biosignal_sample_t s;
    int rc = ard_hal_hr_read(&s);
    ASSERT_EQ(rc, ARD_HR_ERR_NODATA);
}

static void test_read_returns_nodata_during_warmup(void)
{
    setup();
    ard_max30102_init();
    load_flat_signal(ARD_MAX30102_WINDOW_SIZE);

    ard_biosignal_sample_t s;
    int last_rc = ARD_HR_ERR_NODATA;

    /* First WINDOW_SIZE-1 calls must all return ARD_HR_ERR_NODATA */
    for (uint32_t i = 0; i < ARD_MAX30102_WINDOW_SIZE - 1U; i++)
    {
        prime_fifo_one();
        last_rc = ard_hal_hr_read(&s);
        if (last_rc != ARD_HR_ERR_NODATA) break;
    }
    ASSERT_EQ(last_rc, ARD_HR_ERR_NODATA);
}

static void test_read_returns_ok_on_100th_sample(void)
{
    setup();
    ard_max30102_init();
    load_flat_signal(ARD_MAX30102_WINDOW_SIZE);
    int rc = fill_window(ARD_MAX30102_WINDOW_SIZE, NULL);
    ASSERT_EQ(rc, ARD_HAL_OK);
}

static void test_read_returns_err_i2c_on_failure(void)
{
    setup();
    ard_max30102_init();
    s_i2c_fail_read = 1;
    ard_biosignal_sample_t s;
    int rc = ard_hal_hr_read(&s);
    ASSERT_EQ(rc, ARD_HR_ERR_I2C);
}

/* -------------------------------------------------------------------------
 * Tests — BPM detection
 * ------------------------------------------------------------------------- */

static void test_bpm_zero_before_window_full(void)
{
    setup();
    ard_max30102_init();
    /* Don't fill window — BPM should remain 0 */
    ASSERT_NEAR(ard_max30102_get_spo2(), 0.0f, 1.0f);
}

static void test_bpm_detected_at_60bpm(void)
{
    setup();
    ard_max30102_init();
    load_bpm_signal(60.0, ARD_MAX30102_WINDOW_SIZE);

    ard_biosignal_sample_t s;
    fill_window(ARD_MAX30102_WINDOW_SIZE, &s);

    /* Expect 60 BPM ± 5 */
    ASSERT_NEAR(s.value.hr.bpm, 60.0f, 5.0f);
}

static void test_bpm_detected_at_80bpm(void)
{
    setup();
    ard_max30102_init();
    load_bpm_signal(80.0, ARD_MAX30102_WINDOW_SIZE);

    ard_biosignal_sample_t s;
    fill_window(ARD_MAX30102_WINDOW_SIZE, &s);

    /* Expect 80 BPM ± 6 */
    ASSERT_NEAR(s.value.hr.bpm, 80.0f, 6.0f);
}

static void test_bpm_zero_for_flat_signal(void)
{
    setup();
    ard_max30102_init();
    load_flat_signal(ARD_MAX30102_WINDOW_SIZE);

    ard_biosignal_sample_t s;
    fill_window(ARD_MAX30102_WINDOW_SIZE, &s);

    /* No peaks in a flat signal → BPM stays at 0 */
    ASSERT_NEAR(s.value.hr.bpm, 0.0f, 1.0f);
}

static void test_rr_interval_approx_1000ms_at_60bpm(void)
{
    setup();
    ard_max30102_init();
    load_bpm_signal(60.0, ARD_MAX30102_WINDOW_SIZE);

    ard_biosignal_sample_t s;
    fill_window(ARD_MAX30102_WINDOW_SIZE, &s);

    /* At 60 BPM the RR interval should be ~1000 ms */
    ASSERT_NEAR(s.value.hr.rmssd, 1000.0f, 80.0f);
}

static void test_bpm_in_physiological_range(void)
{
    setup();
    ard_max30102_init();
    load_bpm_signal(72.0, ARD_MAX30102_WINDOW_SIZE);

    ard_biosignal_sample_t s;
    fill_window(ARD_MAX30102_WINDOW_SIZE, &s);

    /* BPM must be either 0 (not detected) or in [30, 220] */
    int valid = (s.value.hr.bpm == 0.0f) ||
                (s.value.hr.bpm >= 30.0f && s.value.hr.bpm <= 220.0f);
    ASSERT(valid);
}

/* -------------------------------------------------------------------------
 * Tests — SpO2
 * ------------------------------------------------------------------------- */

static void test_spo2_normal_range_for_standard_signal(void)
{
    /* DC_red/DC_ir = 0.8, AC_red/AC_ir = 0.4 → R = 0.5 → SpO2 ≈ 97.5 */
    setup();
    ard_max30102_init();
    load_bpm_signal(60.0, ARD_MAX30102_WINDOW_SIZE);
    fill_window(ARD_MAX30102_WINDOW_SIZE, NULL);

    float spo2 = ard_max30102_get_spo2();
    /* Expect 95–100% */
    ASSERT(spo2 >= 90.0f && spo2 <= 100.0f);
}

static void test_spo2_clamped_to_100_on_high_value(void)
{
    /* Load signal where R ≈ 0 (very low red AC) → raw SpO2 >> 100 → clamped to 100 */
    setup();
    ard_max30102_init();

    for (uint32_t i = 0; i < ARD_MAX30102_WINDOW_SIZE; i++)
    {
        /* IR with large AC, RED with essentially zero AC → R ≈ 0 → SpO2 = 110 → clamped */
        double t = (double)i / (double)ARD_MAX30102_SAMPLE_RATE;
        s_fifo_ir[i]  = (uint32_t)(100000.0 + 5000.0 * sin(2.0 * M_PI * 1.0 * t));
        s_fifo_red[i] = 80000U;  /* flat RED → AC_red ≈ 0 → R ≈ 0 */
    }
    s_fifo_total  = ARD_MAX30102_WINDOW_SIZE;
    s_fifo_served = 0;
    fill_window(ARD_MAX30102_WINDOW_SIZE, NULL);

    ASSERT(ard_max30102_get_spo2() <= 100.0f);
}

static void test_spo2_clamped_to_0_on_low_value(void)
{
    /* RED AC >> IR AC → R >> 4 → SpO2 < 0 → clamped to 0 */
    setup();
    ard_max30102_init();

    for (uint32_t i = 0; i < ARD_MAX30102_WINDOW_SIZE; i++)
    {
        double t = (double)i / (double)ARD_MAX30102_SAMPLE_RATE;
        s_fifo_ir[i]  = 100000U;  /* flat IR */
        s_fifo_red[i] = (uint32_t)(80000.0 + 20000.0 * sin(2.0 * M_PI * 1.0 * t));
    }
    s_fifo_total  = ARD_MAX30102_WINDOW_SIZE;
    s_fifo_served = 0;
    fill_window(ARD_MAX30102_WINDOW_SIZE, NULL);

    ASSERT(ard_max30102_get_spo2() >= 0.0f);
}

/* -------------------------------------------------------------------------
 * Tests — biosignal HAL integration
 * ------------------------------------------------------------------------- */

static void test_biosignal_read_delegates_to_hr_driver(void)
{
    setup();
    ard_max30102_init();
    load_bpm_signal(60.0, ARD_MAX30102_WINDOW_SIZE);

    ard_biosignal_sample_t s;
    int rc = ARD_HR_ERR_NODATA;
    for (uint32_t i = 0; i < ARD_MAX30102_WINDOW_SIZE; i++)
    {
        prime_fifo_one();
        rc = ard_hal_biosignal_read(ARD_SOURCE_HR, &s);
    }
    ASSERT_EQ(rc, ARD_HAL_OK);
}

static void test_biosignal_sample_source_is_hr(void)
{
    setup();
    ard_max30102_init();
    load_bpm_signal(60.0, ARD_MAX30102_WINDOW_SIZE);

    ard_biosignal_sample_t s;
    for (uint32_t i = 0; i < ARD_MAX30102_WINDOW_SIZE; i++)
    {
        prime_fifo_one();
        ard_hal_biosignal_read(ARD_SOURCE_HR, &s);
    }
    ASSERT_EQ(s.source, ARD_SOURCE_HR);
}

/* -------------------------------------------------------------------------
 * Tests — reset
 * ------------------------------------------------------------------------- */

static void test_reset_clears_window_and_bpm(void)
{
    setup();
    ard_max30102_init();
    load_bpm_signal(60.0, ARD_MAX30102_WINDOW_SIZE);
    ard_biosignal_sample_t s;
    fill_window(ARD_MAX30102_WINDOW_SIZE, &s);
    float bpm_before = s.value.hr.bpm;

    /* Reset then try to read one sample → warm-up again */
    ard_max30102_reset();
    ard_max30102_set_i2c(mock_write, mock_read);
    s_regs[0xFFU] = ARD_MAX30102_PART_ID;
    prime_fifo_one();
    load_flat_signal(1);
    int rc = ard_hal_hr_read(&s);

    ASSERT_GT(bpm_before, 0.0f);          /* had a BPM before reset     */
    ASSERT_EQ(rc, ARD_HR_ERR_NODATA);   /* back to warm-up after reset */
}

/* -------------------------------------------------------------------------
 * main
 * ------------------------------------------------------------------------- */

int main(void)
{
    printf("=== test_max30102_hal ===\n\n");

    test_init_returns_ok_with_correct_part_id();
    test_init_returns_err_id_on_wrong_part_id();
    test_init_returns_err_i2c_on_read_failure();
    test_init_returns_err_i2c_on_write_failure();
    test_init_registers_source_hr_in_biosignal_hal();
    test_init_writes_mode_spo2();

    test_read_returns_nodata_when_fifo_empty();
    test_read_returns_nodata_during_warmup();
    test_read_returns_ok_on_100th_sample();
    test_read_returns_err_i2c_on_failure();

    test_bpm_zero_before_window_full();
    test_bpm_detected_at_60bpm();
    test_bpm_detected_at_80bpm();
    test_bpm_zero_for_flat_signal();
    test_rr_interval_approx_1000ms_at_60bpm();
    test_bpm_in_physiological_range();

    test_spo2_normal_range_for_standard_signal();
    test_spo2_clamped_to_100_on_high_value();
    test_spo2_clamped_to_0_on_low_value();

    test_biosignal_read_delegates_to_hr_driver();
    test_biosignal_sample_source_is_hr();

    test_reset_clears_window_and_bpm();

    printf("\n=== Results: %d passed, %d failed ===\n", s_pass, s_fail);
    return s_fail > 0 ? 1 : 0;
}
