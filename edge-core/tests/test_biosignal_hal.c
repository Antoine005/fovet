/*
 * Ardent SDK — Pulse
 * Copyright (C) 2026 Antoine Porte. All rights reserved.
 * LGPL v3 for non-commercial use.
 * Commercial licensing: contact@fovet.eu
 */

/*
 * Native unit tests for fovet_biosignal_hal — compile with gcc, no hardware needed.
 *
 *   make -C edge-core/tests
 *   ./edge-core/tests/test_biosignal_hal
 */

#include <stdio.h>
#include <stdlib.h>
#include <math.h>
#include <stdbool.h>
#include <stdint.h>
#include <string.h>

#include "../include/ardent/hal/ard_biosignal_hal.h"

/* -------------------------------------------------------------------------
 * Minimal test framework (same pattern as test_zscore.c)
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

#define ASSERT_FLOAT_EQ(a, b, eps, msg)                                 \
    do {                                                                \
        float _diff = (float)(a) - (float)(b);                         \
        if (_diff < 0.0f) _diff = -_diff;                              \
        if (_diff <= (float)(eps)) {                                    \
            printf("[PASS] %s\n", msg);                                 \
            g_pass++;                                                   \
        } else {                                                        \
            printf("[FAIL] %s  (expected %.6f, got %.6f, line %d)\n",  \
                   msg, (float)(b), (float)(a), __LINE__);              \
            g_fail++;                                                   \
        }                                                               \
    } while (0)

/* -------------------------------------------------------------------------
 * Stub drivers
 * ------------------------------------------------------------------------- */

static int stub_imu_read(ard_biosignal_sample_t *out)
{
    out->source          = ARD_SOURCE_IMU;
    out->timestamp_ms    = 1000U;
    out->value.imu.ax    = 0.1f;
    out->value.imu.ay    = 0.2f;
    out->value.imu.az    = 9.8f;
    out->value.imu.gx    = 1.0f;
    out->value.imu.gy    = 2.0f;
    out->value.imu.gz    = 3.0f;
    return ARD_HAL_OK;
}

static int stub_hr_read(ard_biosignal_sample_t *out)
{
    out->source           = ARD_SOURCE_HR;
    out->timestamp_ms     = 2000U;
    out->value.hr.bpm     = 72.0f;
    out->value.hr.spo2    = 98.5f;
    out->value.hr.rmssd   = 42.0f;
    return ARD_HAL_OK;
}

static int stub_temp_read(ard_biosignal_sample_t *out)
{
    out->source                = ARD_SOURCE_TEMP;
    out->timestamp_ms          = 3000U;
    out->value.temp.celsius    = 36.7f;
    return ARD_HAL_OK;
}

static int stub_ecg_read(ard_biosignal_sample_t *out)
{
    out->source            = ARD_SOURCE_ECG;
    out->timestamp_ms      = 4000U;
    out->value.ecg.mv      = 1.23f;
    out->value.ecg.rr_ms   = 833;
    return ARD_HAL_OK;
}

static int stub_error_read(ard_biosignal_sample_t *out)
{
    (void)out;
    return -42; /* driver-defined error */
}

/* -------------------------------------------------------------------------
 * Tests
 * ------------------------------------------------------------------------- */

static void test_register_returns_ok(void)
{
    ard_hal_biosignal_reset();
    ASSERT_INT_EQ(ard_hal_biosignal_register(ARD_SOURCE_IMU, stub_imu_read),
                  ARD_HAL_OK,
                  "register IMU returns ARD_HAL_OK");
}

static void test_register_null_fn_returns_err_null(void)
{
    ard_hal_biosignal_reset();
    ASSERT_INT_EQ(ard_hal_biosignal_register(ARD_SOURCE_IMU, NULL),
                  ARD_HAL_ERR_NULL,
                  "register NULL fn returns ARD_HAL_ERR_NULL");
}

static void test_register_out_of_range_returns_err_type(void)
{
    ard_hal_biosignal_reset();
    ASSERT_INT_EQ(
        ard_hal_biosignal_register(
            (ard_biosignal_source_t)ARD_BIOSIGNAL_SOURCE_COUNT,
            stub_imu_read),
        ARD_HAL_ERR_TYPE,
        "register out-of-range type returns ARD_HAL_ERR_TYPE");
}

static void test_read_null_out_returns_err_null(void)
{
    ard_hal_biosignal_reset();
    ard_hal_biosignal_register(ARD_SOURCE_IMU, stub_imu_read);
    ASSERT_INT_EQ(ard_hal_biosignal_read(ARD_SOURCE_IMU, NULL),
                  ARD_HAL_ERR_NULL,
                  "read with NULL out returns ARD_HAL_ERR_NULL");
}

static void test_read_out_of_range_returns_err_type(void)
{
    ard_hal_biosignal_reset();
    ard_biosignal_sample_t s;
    ASSERT_INT_EQ(
        ard_hal_biosignal_read(
            (ard_biosignal_source_t)ARD_BIOSIGNAL_SOURCE_COUNT, &s),
        ARD_HAL_ERR_TYPE,
        "read out-of-range type returns ARD_HAL_ERR_TYPE");
}

static void test_read_no_handler_returns_err_noreg(void)
{
    ard_hal_biosignal_reset();
    ard_biosignal_sample_t s;
    ASSERT_INT_EQ(ard_hal_biosignal_read(ARD_SOURCE_HR, &s),
                  ARD_HAL_ERR_NOREG,
                  "read unregistered source returns ARD_HAL_ERR_NOREG");
}

static void test_read_imu_ok(void)
{
    ard_hal_biosignal_reset();
    ard_hal_biosignal_register(ARD_SOURCE_IMU, stub_imu_read);
    ard_biosignal_sample_t s;
    ASSERT_INT_EQ(ard_hal_biosignal_read(ARD_SOURCE_IMU, &s),
                  ARD_HAL_OK,
                  "read IMU returns ARD_HAL_OK");
}

static void test_read_imu_payload(void)
{
    ard_hal_biosignal_reset();
    ard_hal_biosignal_register(ARD_SOURCE_IMU, stub_imu_read);
    ard_biosignal_sample_t s;
    ard_hal_biosignal_read(ARD_SOURCE_IMU, &s);

    ASSERT(s.source == ARD_SOURCE_IMU,       "IMU sample.source == ARD_SOURCE_IMU");
    ASSERT(s.timestamp_ms == 1000U,            "IMU sample.timestamp_ms == 1000");
    ASSERT_FLOAT_EQ(s.value.imu.ax,  0.1f, 1e-5f, "IMU ax == 0.1");
    ASSERT_FLOAT_EQ(s.value.imu.az,  9.8f, 1e-5f, "IMU az == 9.8");
    ASSERT_FLOAT_EQ(s.value.imu.gz,  3.0f, 1e-5f, "IMU gz == 3.0");
}

static void test_read_hr_payload(void)
{
    ard_hal_biosignal_reset();
    ard_hal_biosignal_register(ARD_SOURCE_HR, stub_hr_read);
    ard_biosignal_sample_t s;
    ard_hal_biosignal_read(ARD_SOURCE_HR, &s);

    ASSERT(s.source == ARD_SOURCE_HR,        "HR sample.source == ARD_SOURCE_HR");
    ASSERT_FLOAT_EQ(s.value.hr.bpm,   72.0f, 1e-5f, "HR bpm == 72.0");
    ASSERT_FLOAT_EQ(s.value.hr.spo2,  98.5f, 1e-5f, "HR spo2 == 98.5");
    ASSERT_FLOAT_EQ(s.value.hr.rmssd, 42.0f, 1e-5f, "HR rmssd == 42.0");
}

static void test_read_temp_payload(void)
{
    ard_hal_biosignal_reset();
    ard_hal_biosignal_register(ARD_SOURCE_TEMP, stub_temp_read);
    ard_biosignal_sample_t s;
    ard_hal_biosignal_read(ARD_SOURCE_TEMP, &s);

    ASSERT(s.source == ARD_SOURCE_TEMP,      "TEMP sample.source == ARD_SOURCE_TEMP");
    ASSERT_FLOAT_EQ(s.value.temp.celsius, 36.7f, 1e-4f, "TEMP celsius == 36.7");
}

static void test_read_ecg_payload(void)
{
    ard_hal_biosignal_reset();
    ard_hal_biosignal_register(ARD_SOURCE_ECG, stub_ecg_read);
    ard_biosignal_sample_t s;
    ard_hal_biosignal_read(ARD_SOURCE_ECG, &s);

    ASSERT(s.source == ARD_SOURCE_ECG,       "ECG sample.source == ARD_SOURCE_ECG");
    ASSERT_FLOAT_EQ(s.value.ecg.mv, 1.23f, 1e-5f, "ECG mv == 1.23");
    ASSERT_INT_EQ(s.value.ecg.rr_ms, 833,     "ECG rr_ms == 833");
}

static void test_driver_error_forwarded(void)
{
    ard_hal_biosignal_reset();
    ard_hal_biosignal_register(ARD_SOURCE_IMU, stub_error_read);
    ard_biosignal_sample_t s;
    ASSERT_INT_EQ(ard_hal_biosignal_read(ARD_SOURCE_IMU, &s),
                  -42,
                  "driver error code is forwarded unchanged");
}

static void test_reregister_overwrites(void)
{
    ard_hal_biosignal_reset();
    ard_hal_biosignal_register(ARD_SOURCE_IMU, stub_error_read);
    ard_hal_biosignal_register(ARD_SOURCE_IMU, stub_imu_read); /* overwrite */
    ard_biosignal_sample_t s;
    ASSERT_INT_EQ(ard_hal_biosignal_read(ARD_SOURCE_IMU, &s),
                  ARD_HAL_OK,
                  "re-registering same source overwrites previous handler");
}

static void test_reset_clears_all(void)
{
    ard_hal_biosignal_register(ARD_SOURCE_IMU,  stub_imu_read);
    ard_hal_biosignal_register(ARD_SOURCE_HR,   stub_hr_read);
    ard_hal_biosignal_register(ARD_SOURCE_TEMP, stub_temp_read);
    ard_hal_biosignal_register(ARD_SOURCE_ECG,  stub_ecg_read);
    ard_hal_biosignal_reset();

    ard_biosignal_sample_t s;
    ASSERT_INT_EQ(ard_hal_biosignal_read(ARD_SOURCE_IMU,  &s),
                  ARD_HAL_ERR_NOREG, "reset: IMU cleared");
    ASSERT_INT_EQ(ard_hal_biosignal_read(ARD_SOURCE_HR,   &s),
                  ARD_HAL_ERR_NOREG, "reset: HR cleared");
    ASSERT_INT_EQ(ard_hal_biosignal_read(ARD_SOURCE_TEMP, &s),
                  ARD_HAL_ERR_NOREG, "reset: TEMP cleared");
    ASSERT_INT_EQ(ard_hal_biosignal_read(ARD_SOURCE_ECG,  &s),
                  ARD_HAL_ERR_NOREG, "reset: ECG cleared");
}

static void test_all_sources_independent(void)
{
    ard_hal_biosignal_reset();
    ard_hal_biosignal_register(ARD_SOURCE_IMU,  stub_imu_read);
    ard_hal_biosignal_register(ARD_SOURCE_HR,   stub_hr_read);
    ard_hal_biosignal_register(ARD_SOURCE_TEMP, stub_temp_read);
    ard_hal_biosignal_register(ARD_SOURCE_ECG,  stub_ecg_read);

    ard_biosignal_sample_t s;
    ard_hal_biosignal_read(ARD_SOURCE_IMU, &s);
    ASSERT(s.source == ARD_SOURCE_IMU,  "independent sources: IMU reads correct source");

    ard_hal_biosignal_read(ARD_SOURCE_ECG, &s);
    ASSERT(s.source == ARD_SOURCE_ECG,  "independent sources: ECG reads correct source");
}

static void test_sample_struct_size(void)
{
    /* Verify layout: 4 + 24 + 4 = 32 bytes on 32-bit platforms */
    ASSERT(sizeof(ard_biosignal_sample_t) >= 32U,
           "sizeof(ard_biosignal_sample_t) >= 32");
}

/* -------------------------------------------------------------------------
 * main
 * ------------------------------------------------------------------------- */

int main(void)
{
    printf("=== test_biosignal_hal ===\n\n");

    test_register_returns_ok();
    test_register_null_fn_returns_err_null();
    test_register_out_of_range_returns_err_type();
    test_read_null_out_returns_err_null();
    test_read_out_of_range_returns_err_type();
    test_read_no_handler_returns_err_noreg();
    test_read_imu_ok();
    test_read_imu_payload();
    test_read_hr_payload();
    test_read_temp_payload();
    test_read_ecg_payload();
    test_driver_error_forwarded();
    test_reregister_overwrites();
    test_reset_clears_all();
    test_all_sources_independent();
    test_sample_struct_size();

    printf("\n=== Results: %d passed, %d failed ===\n", g_pass, g_fail);
    return g_fail == 0 ? 0 : 1;
}
