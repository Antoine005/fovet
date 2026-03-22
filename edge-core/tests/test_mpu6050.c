/*
 * Fovet SDK — Sentinelle
 * Copyright (C) 2026 Antoine Porte. All rights reserved.
 * LGPL v3 for non-commercial use.
 * Commercial licensing: contact@fovet.eu
 */

/*
 * test_mpu6050.c — Native PC unit tests for the MPU-6050 driver
 *
 * Provides a mock I2C backend (same pattern as test_i2c_hal.c) so the
 * driver can be tested entirely on host without hardware.
 *
 * Build (standalone):
 *   gcc -std=c99 -Wall -I../include -DFOVET_NATIVE_TEST \
 *       -o test_mpu6050 test_mpu6050.c ../src/drivers/mpu6050.c -lm
 */

#include <stdio.h>
#include <stdint.h>
#include <stdbool.h>
#include <string.h>
#include <math.h>

#include "fovet/hal/hal_i2c.h"
#include "fovet/drivers/mpu6050.h"

/* =========================================================================
 * Mock I2C backend (identical to test_i2c_hal.c)
 * ========================================================================= */

#define MOCK_ADDR_MAX 128U
#define MOCK_REG_MAX  256U

/* MPU-6050 register addresses (mirrors mpu6050.c constants) */
#define REG_ACCEL_CONFIG  0x1CU
#define REG_ACCEL_XOUT_H  0x3BU
#define REG_PWR_MGMT_1    0x6BU
#define REG_WHO_AM_I      0x75U

static uint8_t mock_regs[MOCK_ADDR_MAX][MOCK_REG_MAX];
static bool    mock_present[MOCK_ADDR_MAX];
static bool    mock_force_nack;

static void mock_reset(void)
{
    memset(mock_regs,    0,     sizeof(mock_regs));
    memset(mock_present, false, sizeof(mock_present));
    mock_force_nack = false;
}

static void mock_device_add(uint8_t addr)
{
    mock_present[addr & 0x7F] = true;
}

static void mock_reg_set(uint8_t addr, uint8_t reg, uint8_t val)
{
    mock_regs[addr & 0x7F][reg] = val;
}

static uint8_t mock_reg_get(uint8_t addr, uint8_t reg)
{
    return mock_regs[addr & 0x7F][reg];
}

/* Helper: store a big-endian signed 16-bit value into two consecutive regs */
static void mock_set_i16(uint8_t addr, uint8_t reg_h, int16_t val)
{
    mock_regs[addr & 0x7F][reg_h]     = (uint8_t)((uint16_t)val >> 8);
    mock_regs[addr & 0x7F][reg_h + 1] = (uint8_t)((uint16_t)val & 0xFF);
}

/* =========================================================================
 * Mock HAL I2C implementation
 * ========================================================================= */

void hal_i2c_init(uint8_t sda, uint8_t scl, uint32_t freq) { (void)sda; (void)scl; (void)freq; }

hal_i2c_err_t hal_i2c_write_reg(uint8_t addr, uint8_t reg, const uint8_t *data, uint8_t len)
{
    if (mock_force_nack || !mock_present[addr & 0x7F]) return HAL_I2C_ERR_NACK;
    for (uint8_t i = 0; i < len; i++)
        mock_regs[addr & 0x7F][(uint8_t)(reg + i)] = data[i];
    return HAL_I2C_OK;
}

hal_i2c_err_t hal_i2c_read_reg(uint8_t addr, uint8_t reg, uint8_t *buf, uint8_t len)
{
    if (mock_force_nack || !mock_present[addr & 0x7F]) return HAL_I2C_ERR_NACK;
    for (uint8_t i = 0; i < len; i++)
        buf[i] = mock_regs[addr & 0x7F][(uint8_t)(reg + i)];
    return HAL_I2C_OK;
}

hal_i2c_err_t hal_i2c_read_byte(uint8_t addr, uint8_t reg, uint8_t *out)
{
    return hal_i2c_read_reg(addr, reg, out, 1);
}

hal_i2c_err_t hal_i2c_write_byte(uint8_t addr, uint8_t reg, uint8_t value)
{
    return hal_i2c_write_reg(addr, reg, &value, 1);
}

bool hal_i2c_probe(uint8_t addr)
{
    return !mock_force_nack && mock_present[addr & 0x7F];
}

/* =========================================================================
 * Test framework
 * ========================================================================= */

static int g_pass = 0;
static int g_fail = 0;

#define TEST(name) static void name(void)

#define EXPECT(expr)                                                            \
    do {                                                                        \
        if (expr) { g_pass++; }                                                 \
        else {                                                                  \
            g_fail++;                                                           \
            fprintf(stderr, "  FAIL %s:%d  %s\n", __FILE__, __LINE__, #expr);  \
        }                                                                       \
    } while (0)

#define EXPECT_FLOAT_NEAR(a, b, tol)  EXPECT(fabsf((float)(a) - (float)(b)) <= (float)(tol))

/* Populate a "fresh MPU-6050 device" in the mock register bank */
static void mock_add_mpu6050(uint8_t addr)
{
    mock_device_add(addr);
    mock_reg_set(addr, REG_WHO_AM_I,    0x68);  /* WHO_AM_I default */
    mock_reg_set(addr, REG_PWR_MGMT_1,  0x40);  /* SLEEP=1 at power-on */
    mock_reg_set(addr, REG_ACCEL_CONFIG, 0x00);
}

/* =========================================================================
 * Tests — probe
 * ========================================================================= */

TEST(test_probe_present_returns_true)
{
    mock_reset();
    mock_device_add(0x68);
    EXPECT(mpu6050_probe(0x68) == true);
}

TEST(test_probe_absent_returns_false)
{
    mock_reset();
    EXPECT(mpu6050_probe(0x68) == false);
}

/* =========================================================================
 * Tests — init
 * ========================================================================= */

TEST(test_init_success)
{
    mock_reset();
    mock_add_mpu6050(0x68);
    EXPECT(mpu6050_init(0x68, MPU6050_RANGE_2G) == true);
}

TEST(test_init_device_absent_fails)
{
    mock_reset();
    EXPECT(mpu6050_init(0x68, MPU6050_RANGE_2G) == false);
}

TEST(test_init_wrong_whoami_fails)
{
    mock_reset();
    mock_device_add(0x68);
    mock_reg_set(0x68, REG_WHO_AM_I, 0xAB);  /* wrong value */
    EXPECT(mpu6050_init(0x68, MPU6050_RANGE_2G) == false);
}

TEST(test_init_wakes_from_sleep)
{
    mock_reset();
    mock_add_mpu6050(0x68);
    mpu6050_init(0x68, MPU6050_RANGE_2G);
    EXPECT(mock_reg_get(0x68, REG_PWR_MGMT_1) == 0x00);
}

TEST(test_init_range_2g_sets_config)
{
    mock_reset();
    mock_add_mpu6050(0x68);
    mpu6050_init(0x68, MPU6050_RANGE_2G);
    EXPECT(mock_reg_get(0x68, REG_ACCEL_CONFIG) == 0x00);
}

TEST(test_init_range_4g_sets_config)
{
    mock_reset();
    mock_add_mpu6050(0x68);
    mpu6050_init(0x68, MPU6050_RANGE_4G);
    EXPECT(mock_reg_get(0x68, REG_ACCEL_CONFIG) == 0x08);
}

TEST(test_init_range_8g_sets_config)
{
    mock_reset();
    mock_add_mpu6050(0x68);
    mpu6050_init(0x68, MPU6050_RANGE_8G);
    EXPECT(mock_reg_get(0x68, REG_ACCEL_CONFIG) == 0x10);
}

TEST(test_init_range_16g_sets_config)
{
    mock_reset();
    mock_add_mpu6050(0x68);
    mpu6050_init(0x68, MPU6050_RANGE_16G);
    EXPECT(mock_reg_get(0x68, REG_ACCEL_CONFIG) == 0x18);
}

/* =========================================================================
 * Tests — read_accel
 * ========================================================================= */

TEST(test_read_accel_all_zero)
{
    mock_reset();
    mock_add_mpu6050(0x68);
    mpu6050_init(0x68, MPU6050_RANGE_2G);
    /* raw bytes already 0 after mock_reset */
    mpu6050_accel_t a;
    EXPECT(mpu6050_read_accel(0x68, &a) == true);
    EXPECT_FLOAT_NEAR(a.x,         0.0f, 1e-4f);
    EXPECT_FLOAT_NEAR(a.y,         0.0f, 1e-4f);
    EXPECT_FLOAT_NEAR(a.z,         0.0f, 1e-4f);
    EXPECT_FLOAT_NEAR(a.magnitude, 0.0f, 1e-4f);
}

TEST(test_read_accel_1g_z_range2g)
{
    mock_reset();
    mock_add_mpu6050(0x68);
    mpu6050_init(0x68, MPU6050_RANGE_2G);
    /* Z = +16384 raw = +1.0g at ±2g */
    mock_set_i16(0x68, REG_ACCEL_XOUT_H + 4, 16384);  /* Z high at offset 4,5 */
    mpu6050_accel_t a;
    EXPECT(mpu6050_read_accel(0x68, &a) == true);
    EXPECT_FLOAT_NEAR(a.x, 0.0f, 1e-3f);
    EXPECT_FLOAT_NEAR(a.y, 0.0f, 1e-3f);
    EXPECT_FLOAT_NEAR(a.z, 1.0f, 1e-3f);
    EXPECT_FLOAT_NEAR(a.magnitude, 1.0f, 1e-3f);
}

TEST(test_read_accel_1g_x_range2g)
{
    mock_reset();
    mock_add_mpu6050(0x68);
    mpu6050_init(0x68, MPU6050_RANGE_2G);
    mock_set_i16(0x68, REG_ACCEL_XOUT_H + 0, 16384);  /* X */
    mpu6050_accel_t a;
    mpu6050_read_accel(0x68, &a);
    EXPECT_FLOAT_NEAR(a.x, 1.0f, 1e-3f);
    EXPECT_FLOAT_NEAR(a.y, 0.0f, 1e-3f);
    EXPECT_FLOAT_NEAR(a.z, 0.0f, 1e-3f);
}

TEST(test_read_accel_1g_y_range2g)
{
    mock_reset();
    mock_add_mpu6050(0x68);
    mpu6050_init(0x68, MPU6050_RANGE_2G);
    mock_set_i16(0x68, REG_ACCEL_XOUT_H + 2, 16384);  /* Y */
    mpu6050_accel_t a;
    mpu6050_read_accel(0x68, &a);
    EXPECT_FLOAT_NEAR(a.y, 1.0f, 1e-3f);
}

TEST(test_read_accel_negative_z)
{
    mock_reset();
    mock_add_mpu6050(0x68);
    mpu6050_init(0x68, MPU6050_RANGE_2G);
    /* -16384 raw = -1.0g */
    mock_set_i16(0x68, REG_ACCEL_XOUT_H + 4, -16384);
    mpu6050_accel_t a;
    mpu6050_read_accel(0x68, &a);
    EXPECT_FLOAT_NEAR(a.z, -1.0f, 1e-3f);
}

TEST(test_read_accel_1g_range_4g)
{
    mock_reset();
    mock_add_mpu6050(0x68);
    mpu6050_init(0x68, MPU6050_RANGE_4G);
    /* At ±4g: 8192 raw = 1.0g */
    mock_set_i16(0x68, REG_ACCEL_XOUT_H + 4, 8192);
    mpu6050_accel_t a;
    mpu6050_read_accel(0x68, &a);
    EXPECT_FLOAT_NEAR(a.z, 1.0f, 1e-3f);
}

TEST(test_read_accel_1g_range_8g)
{
    mock_reset();
    mock_add_mpu6050(0x68);
    mpu6050_init(0x68, MPU6050_RANGE_8G);
    mock_set_i16(0x68, REG_ACCEL_XOUT_H + 4, 4096);
    mpu6050_accel_t a;
    mpu6050_read_accel(0x68, &a);
    EXPECT_FLOAT_NEAR(a.z, 1.0f, 1e-3f);
}

TEST(test_read_accel_1g_range_16g)
{
    mock_reset();
    mock_add_mpu6050(0x68);
    mpu6050_init(0x68, MPU6050_RANGE_16G);
    mock_set_i16(0x68, REG_ACCEL_XOUT_H + 4, 2048);
    mpu6050_accel_t a;
    mpu6050_read_accel(0x68, &a);
    EXPECT_FLOAT_NEAR(a.z, 1.0f, 1e-3f);
}

TEST(test_read_accel_magnitude_1g_gravity)
{
    /* Simulates device resting flat: x=0, y=0, z=1g → |a|=1.0 */
    mock_reset();
    mock_add_mpu6050(0x68);
    mpu6050_init(0x68, MPU6050_RANGE_2G);
    mock_set_i16(0x68, REG_ACCEL_XOUT_H + 4, 16384);
    mpu6050_accel_t a;
    mpu6050_read_accel(0x68, &a);
    EXPECT_FLOAT_NEAR(a.magnitude, 1.0f, 1e-3f);
}

TEST(test_read_accel_magnitude_xyz_pythagorean)
{
    /* x=y=z=1g → magnitude = sqrt(3) ≈ 1.732 */
    mock_reset();
    mock_add_mpu6050(0x68);
    mpu6050_init(0x68, MPU6050_RANGE_2G);
    mock_set_i16(0x68, REG_ACCEL_XOUT_H + 0, 16384);  /* X=1g */
    mock_set_i16(0x68, REG_ACCEL_XOUT_H + 2, 16384);  /* Y=1g */
    mock_set_i16(0x68, REG_ACCEL_XOUT_H + 4, 16384);  /* Z=1g */
    mpu6050_accel_t a;
    mpu6050_read_accel(0x68, &a);
    EXPECT_FLOAT_NEAR(a.magnitude, sqrtf(3.0f), 1e-3f);
}

TEST(test_read_accel_nack_returns_false)
{
    mock_reset();
    mock_add_mpu6050(0x68);
    mpu6050_init(0x68, MPU6050_RANGE_2G);
    mock_force_nack = true;
    mpu6050_accel_t a;
    EXPECT(mpu6050_read_accel(0x68, &a) == false);
}

TEST(test_two_devices_independent_scale)
{
    /* Two MPU-6050 at 0x68 and 0x69, different ranges */
    mock_reset();
    mock_add_mpu6050(0x68);
    mock_add_mpu6050(0x69);
    mock_reg_set(0x69, REG_WHO_AM_I, 0x68);
    mock_reg_set(0x69, REG_PWR_MGMT_1, 0x40);

    mpu6050_init(0x68, MPU6050_RANGE_2G);  /* scale = 16384 */
    mpu6050_init(0x69, MPU6050_RANGE_4G);  /* scale =  8192 */

    /* Both get raw=8192 on Z */
    mock_set_i16(0x68, REG_ACCEL_XOUT_H + 4, 8192);
    mock_set_i16(0x69, REG_ACCEL_XOUT_H + 4, 8192);

    mpu6050_accel_t a68, a69;
    mpu6050_read_accel(0x68, &a68);
    mpu6050_read_accel(0x69, &a69);

    /* At ±2g: 8192/16384 = 0.5g */
    EXPECT_FLOAT_NEAR(a68.z, 0.5f, 1e-3f);
    /* At ±4g: 8192/8192 = 1.0g */
    EXPECT_FLOAT_NEAR(a69.z, 1.0f, 1e-3f);
}

/* =========================================================================
 * Main
 * ========================================================================= */

int main(void)
{
    printf("=== test_mpu6050 ===\n");

    test_probe_present_returns_true();
    test_probe_absent_returns_false();
    test_init_success();
    test_init_device_absent_fails();
    test_init_wrong_whoami_fails();
    test_init_wakes_from_sleep();
    test_init_range_2g_sets_config();
    test_init_range_4g_sets_config();
    test_init_range_8g_sets_config();
    test_init_range_16g_sets_config();
    test_read_accel_all_zero();
    test_read_accel_1g_z_range2g();
    test_read_accel_1g_x_range2g();
    test_read_accel_1g_y_range2g();
    test_read_accel_negative_z();
    test_read_accel_1g_range_4g();
    test_read_accel_1g_range_8g();
    test_read_accel_1g_range_16g();
    test_read_accel_magnitude_1g_gravity();
    test_read_accel_magnitude_xyz_pythagorean();
    test_read_accel_nack_returns_false();
    test_two_devices_independent_scale();

    printf("  %d passed, %d failed\n", g_pass, g_fail);
    return g_fail > 0 ? 1 : 0;
}
