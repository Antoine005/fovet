/*
 * Fovet SDK — Sentinelle
 * Copyright (C) 2026 Antoine Porte. All rights reserved.
 * LGPL v3 for non-commercial use.
 * Commercial licensing: contact@fovet.eu
 *
 * -------------------------------------------------------------------------
 * mpu6050_hal.c — MPU-6050 IMU driver implementation
 * -------------------------------------------------------------------------
 */

#include "fovet/hal/mpu6050_hal.h"
#include "fovet/hal/hal_time.h"

#include <math.h>
#include <stddef.h>

/* -------------------------------------------------------------------------
 * MPU-6050 register addresses
 * ------------------------------------------------------------------------- */

#define MPU6050_REG_SMPLRT_DIV      0x19U
#define MPU6050_REG_CONFIG          0x1AU
#define MPU6050_REG_GYRO_CONFIG     0x1BU
#define MPU6050_REG_ACCEL_CONFIG    0x1CU
#define MPU6050_REG_ACCEL_XOUT_H   0x3BU
#define MPU6050_REG_PWR_MGMT_1     0x6BU
#define MPU6050_REG_WHO_AM_I       0x75U

/* WHO_AM_I expected values */
#define MPU6050_WHO_AM_I_68         0x68U
#define MPU6050_WHO_AM_I_69         0x69U

/* Scale factors */
#define MPU6050_ACCEL_SCALE         16384.0f   /* LSB/g  for ±2g range  */
#define MPU6050_GYRO_SCALE          131.0f     /* LSB/(°/s) for ±250°/s */

/* Sample rate limits */
#define MPU6050_RATE_MIN_HZ         10U
#define MPU6050_RATE_MAX_HZ         200U
#define MPU6050_RATE_DEFAULT_HZ     25U

/* -------------------------------------------------------------------------
 * Module state
 * ------------------------------------------------------------------------- */

static fovet_i2c_write_fn_t s_i2c_write = NULL;
static fovet_i2c_read_fn_t  s_i2c_read  = NULL;
static uint8_t              s_i2c_addr  = 0x68U;
static int                  s_initialised = 0;

/* -------------------------------------------------------------------------
 * Internal helpers
 * ------------------------------------------------------------------------- */

static int16_t _to_int16(uint8_t hi, uint8_t lo)
{
    return (int16_t)(((uint16_t)hi << 8) | lo);
}

/* -------------------------------------------------------------------------
 * Public API
 * ------------------------------------------------------------------------- */

void fovet_mpu6050_set_i2c(fovet_i2c_write_fn_t write_fn,
                             fovet_i2c_read_fn_t  read_fn)
{
    s_i2c_write = write_fn;
    s_i2c_read  = read_fn;
}

void fovet_mpu6050_reset(void)
{
    s_initialised = 0;
}

int fovet_hal_imu_init(uint8_t i2c_addr)
{
    uint8_t who_am_i = 0;

    s_initialised = 0;
    s_i2c_addr    = i2c_addr;

    /* 1. Verify chip identity */
    if (s_i2c_read(i2c_addr, MPU6050_REG_WHO_AM_I, &who_am_i, 1) != 0)
        return FOVET_MPU_ERR_I2C;

    if (who_am_i != MPU6050_WHO_AM_I_68 && who_am_i != MPU6050_WHO_AM_I_69)
        return FOVET_MPU_ERR_ID;

    /* 2. Wake from sleep */
    if (s_i2c_write(i2c_addr, MPU6050_REG_PWR_MGMT_1, 0x00U) != 0)
        return FOVET_MPU_ERR_I2C;

    /* 3. Configure DLPF (bandwidth ~184 Hz, 1 kHz internal rate) */
    if (s_i2c_write(i2c_addr, MPU6050_REG_CONFIG, 0x01U) != 0)
        return FOVET_MPU_ERR_I2C;

    /* 3b. Accel range ±2g */
    if (s_i2c_write(i2c_addr, MPU6050_REG_ACCEL_CONFIG, 0x00U) != 0)
        return FOVET_MPU_ERR_I2C;

    /* 3c. Gyro range ±250°/s */
    if (s_i2c_write(i2c_addr, MPU6050_REG_GYRO_CONFIG, 0x00U) != 0)
        return FOVET_MPU_ERR_I2C;

    /* 4. Set default sample rate */
    if (fovet_hal_imu_set_sample_rate(MPU6050_RATE_DEFAULT_HZ) != FOVET_HAL_OK)
        return FOVET_MPU_ERR_I2C;

    s_initialised = 1;

    /* 5. Auto-register with biosignal HAL */
    return fovet_hal_biosignal_register(FOVET_SOURCE_IMU, fovet_hal_imu_read);
}

int fovet_hal_imu_read(fovet_biosignal_sample_t *out)
{
    /* 14 bytes: ACCEL_XOUT_H…ACCEL_ZOUT_L, TEMP_OUT_H, TEMP_OUT_L,
     *           GYRO_XOUT_H…GYRO_ZOUT_L                              */
    uint8_t buf[14];

    if (out == NULL)
        return FOVET_HAL_ERR_NULL;

    if (!s_initialised)
        return FOVET_MPU_ERR_I2C;

    if (s_i2c_read(s_i2c_addr, MPU6050_REG_ACCEL_XOUT_H, buf, 14) != 0)
        return FOVET_MPU_ERR_I2C;

    out->source       = FOVET_SOURCE_IMU;
    out->timestamp_ms = hal_time_ms();

    /* Accel — bytes 0..5 */
    out->value.imu.ax = (float)_to_int16(buf[0],  buf[1])  / MPU6050_ACCEL_SCALE;
    out->value.imu.ay = (float)_to_int16(buf[2],  buf[3])  / MPU6050_ACCEL_SCALE;
    out->value.imu.az = (float)_to_int16(buf[4],  buf[5])  / MPU6050_ACCEL_SCALE;

    /* bytes 6..7 = temperature — ignored */

    /* Gyro — bytes 8..13 */
    out->value.imu.gx = (float)_to_int16(buf[8],  buf[9])  / MPU6050_GYRO_SCALE;
    out->value.imu.gy = (float)_to_int16(buf[10], buf[11]) / MPU6050_GYRO_SCALE;
    out->value.imu.gz = (float)_to_int16(buf[12], buf[13]) / MPU6050_GYRO_SCALE;

    return FOVET_HAL_OK;
}

float fovet_hal_imu_get_magnitude(const fovet_biosignal_sample_t *s)
{
    if (s == NULL)
        return 0.0f;

    float ax = s->value.imu.ax;
    float ay = s->value.imu.ay;
    float az = s->value.imu.az;
    return sqrtf(ax * ax + ay * ay + az * az);
}

int fovet_hal_imu_set_sample_rate(uint32_t hz)
{
    uint8_t div;

    /* Clamp to supported range */
    if (hz < MPU6050_RATE_MIN_HZ)  hz = MPU6050_RATE_MIN_HZ;
    if (hz > MPU6050_RATE_MAX_HZ)  hz = MPU6050_RATE_MAX_HZ;

    /* SMPLRT_DIV = 1000 / hz - 1  (DLPF active → 1 kHz gyro rate) */
    div = (uint8_t)(1000U / hz - 1U);

    if (s_i2c_write(s_i2c_addr, MPU6050_REG_SMPLRT_DIV, div) != 0)
        return FOVET_MPU_ERR_I2C;

    return FOVET_HAL_OK;
}
