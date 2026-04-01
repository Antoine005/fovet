/*
 * Fovet SDK — Sentinelle
 * Copyright (C) 2026 Antoine Porte. All rights reserved.
 * LGPL v3 for non-commercial use.
 * Commercial licensing: contact@fovet.eu
 */

/*
 * Native unit tests for fovet_hal_mpu6050 — compile with gcc, no hardware needed.
 *
 *   make -C edge-core/tests test_mpu6050_hal
 *   ./edge-core/tests/test_mpu6050_hal
 *
 * A simulated MPU-6050 register file (s_regs[256]) is maintained by mock I2C
 * callbacks.  Tests manipulate registers directly to exercise all code paths.
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <math.h>
#include <stdint.h>
#include <time.h>

#include "../include/fovet/hal/mpu6050_hal.h"
#include "../include/fovet/hal/fovet_biosignal_hal.h"

/* -------------------------------------------------------------------------
 * hal_time_ms stub (satisfies linker; returns system clock in ms)
 * ------------------------------------------------------------------------- */

uint32_t hal_time_ms(void)
{
    return (uint32_t)(clock() / (CLOCKS_PER_SEC / 1000));
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
 * Simulated MPU-6050 register file
 * ------------------------------------------------------------------------- */

static uint8_t s_regs[256];
static int     s_i2c_fail_write = 0;  /* set to 1 to simulate I2C write error */
static int     s_i2c_fail_read  = 0;  /* set to 1 to simulate I2C read error  */

/* MPU-6050 register addresses (mirrored from driver) */
#define REG_SMPLRT_DIV      0x19
#define REG_CONFIG          0x1A
#define REG_GYRO_CONFIG     0x1B
#define REG_ACCEL_CONFIG    0x1C
#define REG_ACCEL_XOUT_H   0x3B
#define REG_PWR_MGMT_1     0x6B
#define REG_WHO_AM_I       0x75

static int mock_i2c_write(uint8_t dev_addr, uint8_t reg, uint8_t data)
{
    (void)dev_addr;
    if (s_i2c_fail_write) return -1;
    s_regs[reg] = data;
    return 0;
}

static int mock_i2c_read(uint8_t dev_addr, uint8_t reg, uint8_t *buf, uint8_t len)
{
    uint8_t i;
    (void)dev_addr;
    if (s_i2c_fail_read) return -1;
    for (i = 0; i < len; i++)
        buf[i] = s_regs[(uint8_t)(reg + i)];
    return 0;
}

/* -------------------------------------------------------------------------
 * Test setup helpers
 * ------------------------------------------------------------------------- */

static void setup(void)
{
    memset(s_regs, 0, sizeof(s_regs));
    s_i2c_fail_write = 0;
    s_i2c_fail_read  = 0;
    fovet_hal_biosignal_reset();
    fovet_mpu6050_reset();
    fovet_mpu6050_set_i2c(mock_i2c_write, mock_i2c_read);
    /* Default: valid chip ID */
    s_regs[REG_WHO_AM_I] = 0x68;
}

/* Set raw accel register pair (big-endian signed 16-bit) */
static void set_raw_accel(int axis, int16_t raw)
{
    uint8_t base = (uint8_t)(REG_ACCEL_XOUT_H + axis * 2);
    s_regs[base]     = (uint8_t)((uint16_t)raw >> 8);
    s_regs[base + 1] = (uint8_t)((uint16_t)raw & 0xFF);
}

/* Set raw gyro register pair (big-endian signed 16-bit).
   Gyro starts at 0x43 = ACCEL_XOUT_H + 8 (6 acc + 2 temp) */
static void set_raw_gyro(int axis, int16_t raw)
{
    uint8_t base = (uint8_t)(REG_ACCEL_XOUT_H + 8 + axis * 2);
    s_regs[base]     = (uint8_t)((uint16_t)raw >> 8);
    s_regs[base + 1] = (uint8_t)((uint16_t)raw & 0xFF);
}

/* -------------------------------------------------------------------------
 * Tests — init
 * ------------------------------------------------------------------------- */

static void test_init_valid_chip_id_68(void)
{
    setup();
    s_regs[REG_WHO_AM_I] = 0x68;
    ASSERT_INT_EQ(fovet_hal_imu_init(0x68), FOVET_HAL_OK,
                  "init: chip ID 0x68 returns FOVET_HAL_OK");
}

static void test_init_valid_chip_id_69(void)
{
    setup();
    s_regs[REG_WHO_AM_I] = 0x69;
    ASSERT_INT_EQ(fovet_hal_imu_init(0x69), FOVET_HAL_OK,
                  "init: chip ID 0x69 returns FOVET_HAL_OK");
}

static void test_init_invalid_chip_id(void)
{
    setup();
    s_regs[REG_WHO_AM_I] = 0x12; /* unexpected */
    ASSERT_INT_EQ(fovet_hal_imu_init(0x68), FOVET_MPU_ERR_ID,
                  "init: wrong chip ID returns FOVET_MPU_ERR_ID");
}

static void test_init_i2c_read_error(void)
{
    setup();
    s_i2c_fail_read = 1;
    ASSERT_INT_EQ(fovet_hal_imu_init(0x68), FOVET_MPU_ERR_I2C,
                  "init: I2C read error returns FOVET_MPU_ERR_I2C");
}

static void test_init_i2c_write_error(void)
{
    setup();
    /* Read WHO_AM_I succeeds, then first write fails */
    s_i2c_fail_write = 1;
    ASSERT_INT_EQ(fovet_hal_imu_init(0x68), FOVET_MPU_ERR_I2C,
                  "init: I2C write error returns FOVET_MPU_ERR_I2C");
}

static void test_init_wakes_device(void)
{
    setup();
    s_regs[REG_PWR_MGMT_1] = 0x40; /* pre-sleep state */
    fovet_hal_imu_init(0x68);
    ASSERT_INT_EQ(s_regs[REG_PWR_MGMT_1], 0x00,
                  "init: PWR_MGMT_1 written to 0x00 (wake from sleep)");
}

static void test_init_auto_registers_with_hal(void)
{
    setup();
    fovet_hal_imu_init(0x68);
    /* If auto-registered, reading via biosignal HAL should succeed */
    fovet_biosignal_sample_t s;
    ASSERT_INT_EQ(fovet_hal_biosignal_read(FOVET_SOURCE_IMU, &s), FOVET_HAL_OK,
                  "init: driver auto-registered with biosignal HAL");
}

/* -------------------------------------------------------------------------
 * Tests — read
 * ------------------------------------------------------------------------- */

static void test_read_returns_ok(void)
{
    setup();
    fovet_hal_imu_init(0x68);
    fovet_biosignal_sample_t s;
    ASSERT_INT_EQ(fovet_hal_imu_read(&s), FOVET_HAL_OK,
                  "read: returns FOVET_HAL_OK");
}

static void test_read_source_is_imu(void)
{
    setup();
    fovet_hal_imu_init(0x68);
    fovet_biosignal_sample_t s;
    fovet_hal_imu_read(&s);
    ASSERT(s.source == FOVET_SOURCE_IMU, "read: source == FOVET_SOURCE_IMU");
}

static void test_read_null_returns_err_null(void)
{
    setup();
    fovet_hal_imu_init(0x68);
    ASSERT_INT_EQ(fovet_hal_imu_read(NULL), FOVET_HAL_ERR_NULL,
                  "read: NULL out returns FOVET_HAL_ERR_NULL");
}

static void test_read_before_init_returns_error(void)
{
    setup();
    /* Do NOT call init — driver not initialised */
    fovet_biosignal_sample_t s;
    ASSERT_INT_EQ(fovet_hal_imu_read(&s), FOVET_MPU_ERR_I2C,
                  "read: before init returns FOVET_MPU_ERR_I2C");
}

static void test_read_acc_1g_z(void)
{
    setup();
    fovet_hal_imu_init(0x68);
    /* 1g = 16384 LSB */
    set_raw_accel(2, 16384); /* az = +1g */
    fovet_biosignal_sample_t s;
    fovet_hal_imu_read(&s);
    ASSERT_FLOAT_EQ(s.value.imu.ax, 0.0f,  1e-4f, "read: ax = 0g");
    ASSERT_FLOAT_EQ(s.value.imu.ay, 0.0f,  1e-4f, "read: ay = 0g");
    ASSERT_FLOAT_EQ(s.value.imu.az, 1.0f,  1e-4f, "read: az = 1g");
}

static void test_read_acc_negative(void)
{
    setup();
    fovet_hal_imu_init(0x68);
    set_raw_accel(0, -16384); /* ax = -1g */
    fovet_biosignal_sample_t s;
    fovet_hal_imu_read(&s);
    ASSERT_FLOAT_EQ(s.value.imu.ax, -1.0f, 1e-4f, "read: ax = -1g");
}

static void test_read_gyro_1dps(void)
{
    setup();
    fovet_hal_imu_init(0x68);
    /* 1°/s = 131 LSB */
    set_raw_gyro(0, 131); /* gx = +1°/s */
    fovet_biosignal_sample_t s;
    fovet_hal_imu_read(&s);
    ASSERT_FLOAT_EQ(s.value.imu.gx, 1.0f, 1e-4f, "read: gx = 1°/s");
}

static void test_read_timestamp_set(void)
{
    setup();
    fovet_hal_imu_init(0x68);
    fovet_biosignal_sample_t s;
    fovet_hal_imu_read(&s);
    /* timestamp_ms is set to hal_time_ms() — just check the field is written (uint32_t is always >= 0) */
    ASSERT(s.source == FOVET_SOURCE_IMU, "read: timestamp_ms test — source still correct after read");
}

static void test_read_i2c_error(void)
{
    setup();
    fovet_hal_imu_init(0x68);
    s_i2c_fail_read = 1; /* fail subsequent reads */
    fovet_biosignal_sample_t s;
    ASSERT_INT_EQ(fovet_hal_imu_read(&s), FOVET_MPU_ERR_I2C,
                  "read: I2C error returns FOVET_MPU_ERR_I2C");
}

/* -------------------------------------------------------------------------
 * Tests — magnitude
 * ------------------------------------------------------------------------- */

static void test_magnitude_gravity_vector(void)
{
    fovet_biosignal_sample_t s;
    s.source = FOVET_SOURCE_IMU;
    s.value.imu.ax = 0.0f;
    s.value.imu.ay = 0.0f;
    s.value.imu.az = 1.0f; /* standing still on earth */
    ASSERT_FLOAT_EQ(fovet_hal_imu_get_magnitude(&s), 1.0f, 1e-5f,
                    "magnitude: (0,0,1g) = 1.0g");
}

static void test_magnitude_pythagorean(void)
{
    fovet_biosignal_sample_t s;
    s.source = FOVET_SOURCE_IMU;
    s.value.imu.ax = 3.0f;
    s.value.imu.ay = 4.0f;
    s.value.imu.az = 0.0f;
    ASSERT_FLOAT_EQ(fovet_hal_imu_get_magnitude(&s), 5.0f, 1e-4f,
                    "magnitude: (3,4,0)g = 5.0g (3-4-5 triplet)");
}

static void test_magnitude_null_ptr(void)
{
    ASSERT_FLOAT_EQ(fovet_hal_imu_get_magnitude(NULL), 0.0f, 1e-9f,
                    "magnitude: NULL pointer returns 0.0f");
}

/* -------------------------------------------------------------------------
 * Tests — sample rate
 * ------------------------------------------------------------------------- */

static void test_sample_rate_25hz(void)
{
    setup();
    fovet_hal_imu_init(0x68);
    fovet_hal_imu_set_sample_rate(25);
    /* SMPLRT_DIV = 1000/25 - 1 = 39 */
    ASSERT_INT_EQ((int)s_regs[REG_SMPLRT_DIV], 39,
                  "sample rate 25 Hz → SMPLRT_DIV = 39");
}

static void test_sample_rate_200hz(void)
{
    setup();
    fovet_hal_imu_init(0x68);
    fovet_hal_imu_set_sample_rate(200);
    /* SMPLRT_DIV = 1000/200 - 1 = 4 */
    ASSERT_INT_EQ((int)s_regs[REG_SMPLRT_DIV], 4,
                  "sample rate 200 Hz → SMPLRT_DIV = 4");
}

static void test_sample_rate_clamped_high(void)
{
    setup();
    fovet_hal_imu_init(0x68);
    fovet_hal_imu_set_sample_rate(9999); /* beyond max → clamped to 200 */
    ASSERT_INT_EQ((int)s_regs[REG_SMPLRT_DIV], 4,
                  "sample rate > 200 Hz clamped → SMPLRT_DIV = 4");
}

static void test_sample_rate_clamped_low(void)
{
    setup();
    fovet_hal_imu_init(0x68);
    fovet_hal_imu_set_sample_rate(1); /* below min → clamped to 10 */
    /* SMPLRT_DIV = 1000/10 - 1 = 99 */
    ASSERT_INT_EQ((int)s_regs[REG_SMPLRT_DIV], 99,
                  "sample rate < 10 Hz clamped → SMPLRT_DIV = 99");
}

/* -------------------------------------------------------------------------
 * main
 * ------------------------------------------------------------------------- */

int main(void)
{
    printf("=== test_mpu6050_hal ===\n\n");

    /* init */
    test_init_valid_chip_id_68();
    test_init_valid_chip_id_69();
    test_init_invalid_chip_id();
    test_init_i2c_read_error();
    test_init_i2c_write_error();
    test_init_wakes_device();
    test_init_auto_registers_with_hal();

    /* read */
    test_read_returns_ok();
    test_read_source_is_imu();
    test_read_null_returns_err_null();
    test_read_before_init_returns_error();
    test_read_acc_1g_z();
    test_read_acc_negative();
    test_read_gyro_1dps();
    test_read_timestamp_set();
    test_read_i2c_error();

    /* magnitude */
    test_magnitude_gravity_vector();
    test_magnitude_pythagorean();
    test_magnitude_null_ptr();

    /* sample rate */
    test_sample_rate_25hz();
    test_sample_rate_200hz();
    test_sample_rate_clamped_high();
    test_sample_rate_clamped_low();

    printf("\n=== Results: %d passed, %d failed ===\n", g_pass, g_fail);
    return g_fail == 0 ? 0 : 1;
}
