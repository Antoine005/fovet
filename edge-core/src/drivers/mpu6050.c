/*
 * Fovet SDK — Sentinelle
 * Copyright (C) 2026 Antoine Porte. All rights reserved.
 * LGPL v3 for non-commercial use.
 * Commercial licensing: contact@fovet.eu
 */

#include "fovet/drivers/mpu6050.h"
#include "fovet/hal/hal_i2c.h"

#include <math.h>

/* -------------------------------------------------------------------------
 * MPU-6050 register map (subset used by this driver)
 * ------------------------------------------------------------------------- */

#define REG_ACCEL_CONFIG  0x1CU  /* Accelerometer full-scale range selector  */
#define REG_ACCEL_XOUT_H  0x3BU  /* First of 6 bytes: XH, XL, YH, YL, ZH, ZL */
#define REG_PWR_MGMT_1    0x6BU  /* Power management — bit6 = SLEEP           */
#define REG_WHO_AM_I      0x75U  /* Fixed identity register → 0x68            */

#define WHO_AM_I_VALUE    0x68U  /* Expected response from WHO_AM_I           */
#define WAKE_UP_VALUE     0x00U  /* Clear SLEEP bit → device awake            */

/* Full-scale range bits for ACCEL_CONFIG register (AFS_SEL[4:3]) */
#define AFS_SEL_2G   (0x00U)   /* ±2g  */
#define AFS_SEL_4G   (0x08U)   /* ±4g  */
#define AFS_SEL_8G   (0x10U)   /* ±8g  */
#define AFS_SEL_16G  (0x18U)   /* ±16g */

/* LSB/g scale factors for each range */
#define SCALE_2G   16384.0f
#define SCALE_4G    8192.0f
#define SCALE_8G    4096.0f
#define SCALE_16G   2048.0f

/* -------------------------------------------------------------------------
 * Per-device state
 * Scale factor is stored per address to avoid re-reading ACCEL_CONFIG
 * on every sample (saves one I2C transaction per read).
 * The array index is the 7-bit I2C address (0–127).
 * ------------------------------------------------------------------------- */

static float g_scale[128]; /* LSB/g for each device address */

/* -------------------------------------------------------------------------
 * Internal helpers
 * ------------------------------------------------------------------------- */

static uint8_t range_to_afs_sel(mpu6050_range_t range)
{
    switch (range) {
        case MPU6050_RANGE_4G:  return AFS_SEL_4G;
        case MPU6050_RANGE_8G:  return AFS_SEL_8G;
        case MPU6050_RANGE_16G: return AFS_SEL_16G;
        default:                return AFS_SEL_2G;
    }
}

static float range_to_scale(mpu6050_range_t range)
{
    switch (range) {
        case MPU6050_RANGE_4G:  return SCALE_4G;
        case MPU6050_RANGE_8G:  return SCALE_8G;
        case MPU6050_RANGE_16G: return SCALE_16G;
        default:                return SCALE_2G;
    }
}

/* -------------------------------------------------------------------------
 * Public API
 * ------------------------------------------------------------------------- */

bool mpu6050_probe(uint8_t addr)
{
    return hal_i2c_probe(addr);
}

bool mpu6050_init(uint8_t addr, mpu6050_range_t range)
{
    /* 1. Check device is present */
    if (!hal_i2c_probe(addr)) return false;

    /* 2. Verify identity */
    uint8_t who = 0;
    if (hal_i2c_read_byte(addr, REG_WHO_AM_I, &who) != HAL_I2C_OK) return false;
    if (who != WHO_AM_I_VALUE) return false;

    /* 3. Wake from sleep (default power-on state has SLEEP=1) */
    if (hal_i2c_write_byte(addr, REG_PWR_MGMT_1, WAKE_UP_VALUE) != HAL_I2C_OK) return false;

    /* 4. Set accelerometer full-scale range */
    uint8_t afs = range_to_afs_sel(range);
    if (hal_i2c_write_byte(addr, REG_ACCEL_CONFIG, afs) != HAL_I2C_OK) return false;

    /* 5. Store scale factor for this address */
    g_scale[addr & 0x7FU] = range_to_scale(range);

    return true;
}

bool mpu6050_read_accel(uint8_t addr, mpu6050_accel_t *out)
{
    uint8_t buf[6];
    if (hal_i2c_read_reg(addr, REG_ACCEL_XOUT_H, buf, 6U) != HAL_I2C_OK) return false;

    /* Reconstruct signed 16-bit values (big-endian) */
    int16_t raw_x = (int16_t)((uint16_t)buf[0] << 8 | buf[1]);
    int16_t raw_y = (int16_t)((uint16_t)buf[2] << 8 | buf[3]);
    int16_t raw_z = (int16_t)((uint16_t)buf[4] << 8 | buf[5]);

    /* Convert to g using the scale set during init */
    float scale = g_scale[addr & 0x7FU];
    if (scale < 1.0f) scale = SCALE_2G; /* safety: use ±2g if init was skipped */

    out->x = (float)raw_x / scale;
    out->y = (float)raw_y / scale;
    out->z = (float)raw_z / scale;
    out->magnitude = sqrtf(out->x * out->x + out->y * out->y + out->z * out->z);

    return true;
}
