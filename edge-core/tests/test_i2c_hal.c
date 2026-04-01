/*
 * Fovet SDK — Sentinelle
 * Copyright (C) 2026 Antoine Porte. All rights reserved.
 * LGPL v3 for non-commercial use.
 * Commercial licensing: contact@fovet.eu
 */

/*
 * test_i2c_hal.c — Native PC unit tests for hal_i2c.h
 *
 * Provides a software mock of the I2C bus using a 2-D register array:
 *   mock_regs[device_7bit_addr][register_addr]
 *
 * Devices marked present in mock_present[] will ACK probes and
 * read/write operations; absent devices return HAL_I2C_ERR_NACK.
 *
 * Build (standalone):
 *   gcc -std=c99 -Wall -I../include -DFOVET_NATIVE_TEST -o test_i2c_hal test_i2c_hal.c
 */

#include <stdio.h>
#include <stdint.h>
#include <stdbool.h>
#include <string.h>
#include <assert.h>

#include "fovet/hal/hal_i2c.h"

/* =========================================================================
 * Mock I2C backend
 * ========================================================================= */

#define MOCK_ADDR_MAX 128U
#define MOCK_REG_MAX  256U

static uint8_t  mock_regs[MOCK_ADDR_MAX][MOCK_REG_MAX];
static bool     mock_present[MOCK_ADDR_MAX];
static bool     mock_force_timeout;  /* when true, all ops return TIMEOUT */
static bool     mock_initialized;

/* Reset mock state — call between test cases */
static void mock_reset(void)
{
    memset(mock_regs,    0,     sizeof(mock_regs));
    memset(mock_present, false, sizeof(mock_present));
    mock_force_timeout = false;
    mock_initialized   = false;
}

/* Register a device as present on the bus */
static void mock_device_add(uint8_t addr)
{
    mock_present[addr & 0x7F] = true;
}

/* Pre-load a register value (simulates device having a value ready to read) */
static void mock_reg_set(uint8_t addr, uint8_t reg, uint8_t val)
{
    mock_regs[addr & 0x7F][reg] = val;
}

/* Inspect what was written to a register */
static uint8_t mock_reg_get(uint8_t addr, uint8_t reg)
{
    return mock_regs[addr & 0x7F][reg];
}

/* =========================================================================
 * Mock HAL implementation
 * ========================================================================= */

void hal_i2c_init(uint8_t sda_pin, uint8_t scl_pin, uint32_t freq_hz)
{
    (void)sda_pin;
    (void)scl_pin;
    (void)freq_hz;
    mock_initialized = true;
}

hal_i2c_err_t hal_i2c_write_reg(uint8_t addr, uint8_t reg,
                                  const uint8_t *data, uint8_t len)
{
    if (mock_force_timeout)         return HAL_I2C_ERR_TIMEOUT;
    if (!mock_present[addr & 0x7F]) return HAL_I2C_ERR_NACK;
    for (uint8_t i = 0; i < len; i++) {
        mock_regs[addr & 0x7F][(uint8_t)(reg + i)] = data[i];
    }
    return HAL_I2C_OK;
}

hal_i2c_err_t hal_i2c_read_reg(uint8_t addr, uint8_t reg,
                                 uint8_t *buf, uint8_t len)
{
    if (mock_force_timeout)         return HAL_I2C_ERR_TIMEOUT;
    if (!mock_present[addr & 0x7F]) return HAL_I2C_ERR_NACK;
    for (uint8_t i = 0; i < len; i++) {
        buf[i] = mock_regs[addr & 0x7F][(uint8_t)(reg + i)];
    }
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
    if (mock_force_timeout) return false;
    return mock_present[addr & 0x7F];
}

/* =========================================================================
 * Test framework
 * ========================================================================= */

static int g_pass = 0;
static int g_fail = 0;

#define TEST(name) static void name(void)

#define EXPECT(expr)                                                         \
    do {                                                                     \
        if (expr) {                                                          \
            g_pass++;                                                        \
        } else {                                                             \
            g_fail++;                                                        \
            fprintf(stderr, "  FAIL %s:%d  %s\n", __FILE__, __LINE__, #expr); \
        }                                                                    \
    } while (0)

/* =========================================================================
 * Tests
 * ========================================================================= */

/* --- init ---------------------------------------------------------------- */

TEST(test_init_sets_initialized_flag)
{
    mock_reset();
    hal_i2c_init(13, 14, 100000);
    EXPECT(mock_initialized == true);
}

/* --- probe --------------------------------------------------------------- */

TEST(test_probe_present_device_returns_true)
{
    mock_reset();
    mock_device_add(0x68);
    EXPECT(hal_i2c_probe(0x68) == true);
}

TEST(test_probe_absent_device_returns_false)
{
    mock_reset();
    EXPECT(hal_i2c_probe(0x68) == false);
}

TEST(test_probe_multiple_devices_independent)
{
    mock_reset();
    mock_device_add(0x68);
    mock_device_add(0x76);
    EXPECT(hal_i2c_probe(0x68) == true);
    EXPECT(hal_i2c_probe(0x76) == true);
    EXPECT(hal_i2c_probe(0x77) == false);
}

TEST(test_probe_timeout_returns_false)
{
    mock_reset();
    mock_device_add(0x68);
    mock_force_timeout = true;
    EXPECT(hal_i2c_probe(0x68) == false);
}

/* --- write_byte ---------------------------------------------------------- */

TEST(test_write_byte_ok)
{
    mock_reset();
    mock_device_add(0x68);
    hal_i2c_err_t r = hal_i2c_write_byte(0x68, 0x6B, 0x00);
    EXPECT(r == HAL_I2C_OK);
    EXPECT(mock_reg_get(0x68, 0x6B) == 0x00);
}

TEST(test_write_byte_stores_value)
{
    mock_reset();
    mock_device_add(0x68);
    hal_i2c_write_byte(0x68, 0x1C, 0xAB);
    EXPECT(mock_reg_get(0x68, 0x1C) == 0xAB);
}

TEST(test_write_byte_absent_device_nack)
{
    mock_reset();
    hal_i2c_err_t r = hal_i2c_write_byte(0x68, 0x6B, 0x00);
    EXPECT(r == HAL_I2C_ERR_NACK);
}

TEST(test_write_byte_timeout)
{
    mock_reset();
    mock_device_add(0x68);
    mock_force_timeout = true;
    hal_i2c_err_t r = hal_i2c_write_byte(0x68, 0x6B, 0x00);
    EXPECT(r == HAL_I2C_ERR_TIMEOUT);
}

/* --- read_byte ----------------------------------------------------------- */

TEST(test_read_byte_ok)
{
    mock_reset();
    mock_device_add(0x68);
    mock_reg_set(0x68, 0x75, 0x68);  /* MPU-6050 WHO_AM_I */
    uint8_t val = 0;
    hal_i2c_err_t r = hal_i2c_read_byte(0x68, 0x75, &val);
    EXPECT(r == HAL_I2C_OK);
    EXPECT(val == 0x68);
}

TEST(test_read_byte_absent_device_nack)
{
    mock_reset();
    uint8_t val = 0;
    hal_i2c_err_t r = hal_i2c_read_byte(0x68, 0x75, &val);
    EXPECT(r == HAL_I2C_ERR_NACK);
}

TEST(test_read_byte_timeout)
{
    mock_reset();
    mock_device_add(0x68);
    mock_force_timeout = true;
    uint8_t val = 0;
    hal_i2c_err_t r = hal_i2c_read_byte(0x68, 0x75, &val);
    EXPECT(r == HAL_I2C_ERR_TIMEOUT);
}

/* --- write_reg (multi-byte) --------------------------------------------- */

TEST(test_write_reg_multi_byte)
{
    mock_reset();
    mock_device_add(0x68);
    uint8_t data[3] = {0xAA, 0xBB, 0xCC};
    hal_i2c_err_t r = hal_i2c_write_reg(0x68, 0x10, data, 3);
    EXPECT(r == HAL_I2C_OK);
    EXPECT(mock_reg_get(0x68, 0x10) == 0xAA);
    EXPECT(mock_reg_get(0x68, 0x11) == 0xBB);
    EXPECT(mock_reg_get(0x68, 0x12) == 0xCC);
}

TEST(test_write_reg_single_byte_via_multi)
{
    mock_reset();
    mock_device_add(0x68);
    uint8_t data[1] = {0x01};
    hal_i2c_err_t r = hal_i2c_write_reg(0x68, 0x6B, data, 1);
    EXPECT(r == HAL_I2C_OK);
    EXPECT(mock_reg_get(0x68, 0x6B) == 0x01);
}

TEST(test_write_reg_nack_on_absent)
{
    mock_reset();
    uint8_t data[2] = {0x01, 0x02};
    hal_i2c_err_t r = hal_i2c_write_reg(0x76, 0x00, data, 2);
    EXPECT(r == HAL_I2C_ERR_NACK);
}

/* --- read_reg (multi-byte) ---------------------------------------------- */

TEST(test_read_reg_multi_byte)
{
    mock_reset();
    mock_device_add(0x68);
    mock_reg_set(0x68, 0x3B, 0x01);
    mock_reg_set(0x68, 0x3C, 0x80);
    uint8_t buf[2] = {0};
    hal_i2c_err_t r = hal_i2c_read_reg(0x68, 0x3B, buf, 2);
    EXPECT(r == HAL_I2C_OK);
    EXPECT(buf[0] == 0x01);
    EXPECT(buf[1] == 0x80);
}

TEST(test_read_reg_nack_on_absent)
{
    mock_reset();
    uint8_t buf[2] = {0};
    hal_i2c_err_t r = hal_i2c_read_reg(0x68, 0x3B, buf, 2);
    EXPECT(r == HAL_I2C_ERR_NACK);
}

/* --- write then read roundtrip ------------------------------------------ */

TEST(test_write_then_read_roundtrip)
{
    mock_reset();
    mock_device_add(0x68);
    hal_i2c_write_byte(0x68, 0x19, 0x07);  /* SMPLRT_DIV = 7 */
    uint8_t val = 0;
    hal_i2c_read_byte(0x68, 0x19, &val);
    EXPECT(val == 0x07);
}

TEST(test_two_devices_isolated)
{
    mock_reset();
    mock_device_add(0x68);
    mock_device_add(0x69);  /* MPU-6050 with AD0=HIGH */
    hal_i2c_write_byte(0x68, 0x1C, 0x10);
    hal_i2c_write_byte(0x69, 0x1C, 0x18);
    uint8_t v1 = 0, v2 = 0;
    hal_i2c_read_byte(0x68, 0x1C, &v1);
    hal_i2c_read_byte(0x69, 0x1C, &v2);
    EXPECT(v1 == 0x10);
    EXPECT(v2 == 0x18);
}

/* --- MPU-6050 WHO_AM_I simulation --------------------------------------- */

TEST(test_mpu6050_who_am_i)
{
    mock_reset();
    mock_device_add(0x68);
    mock_reg_set(0x68, 0x75, 0x68);  /* default WHO_AM_I */
    uint8_t who = 0;
    hal_i2c_err_t r = hal_i2c_read_byte(0x68, 0x75, &who);
    EXPECT(r == HAL_I2C_OK);
    EXPECT(who == 0x68);
}

TEST(test_mpu6050_power_on_sequence)
{
    /* Wake from sleep: write 0x00 to PWR_MGMT_1 (0x6B) */
    mock_reset();
    mock_device_add(0x68);
    mock_reg_set(0x68, 0x6B, 0x40);  /* device starts in sleep mode */
    hal_i2c_write_byte(0x68, 0x6B, 0x00);
    uint8_t pwr = 0;
    hal_i2c_read_byte(0x68, 0x6B, &pwr);
    EXPECT(pwr == 0x00);
}

/* --- error code identity ------------------------------------------------ */

TEST(test_error_codes_are_distinct)
{
    EXPECT(HAL_I2C_OK          != HAL_I2C_ERR_NACK);
    EXPECT(HAL_I2C_OK          != HAL_I2C_ERR_TIMEOUT);
    EXPECT(HAL_I2C_OK          != HAL_I2C_ERR_BUS);
    EXPECT(HAL_I2C_ERR_NACK    != HAL_I2C_ERR_TIMEOUT);
    EXPECT(HAL_I2C_ERR_NACK    != HAL_I2C_ERR_BUS);
    EXPECT(HAL_I2C_ERR_TIMEOUT != HAL_I2C_ERR_BUS);
}

/* =========================================================================
 * Main
 * ========================================================================= */

int main(void)
{
    printf("=== test_i2c_hal ===\n");

    test_init_sets_initialized_flag();
    test_probe_present_device_returns_true();
    test_probe_absent_device_returns_false();
    test_probe_multiple_devices_independent();
    test_probe_timeout_returns_false();
    test_write_byte_ok();
    test_write_byte_stores_value();
    test_write_byte_absent_device_nack();
    test_write_byte_timeout();
    test_read_byte_ok();
    test_read_byte_absent_device_nack();
    test_read_byte_timeout();
    test_write_reg_multi_byte();
    test_write_reg_single_byte_via_multi();
    test_write_reg_nack_on_absent();
    test_read_reg_multi_byte();
    test_read_reg_nack_on_absent();
    test_write_then_read_roundtrip();
    test_two_devices_isolated();
    test_mpu6050_who_am_i();
    test_mpu6050_power_on_sequence();
    test_error_codes_are_distinct();

    printf("  %d passed, %d failed\n", g_pass, g_fail);
    return g_fail > 0 ? 1 : 0;
}
