/*
 * Fovet SDK — Sentinelle
 * Copyright (C) 2026 Antoine Porte. All rights reserved.
 * LGPL v3 for non-commercial use.
 * Commercial licensing: contact@fovet.eu
 *
 * -------------------------------------------------------------------------
 * mpu6050_hal.h — MPU-6050 IMU driver (InvenSense / TDK)
 *
 * Provides a hardware-abstracted driver for the MPU-6050 (and pin-compatible
 * MPU-6000, MPU-6500) 6-axis IMU.  The driver implements fovet_hal_read_fn_t
 * and auto-registers with the biosignal HAL on successful init.
 *
 * Design:
 *   - I2C is accessed through two injected callbacks (fovet_i2c_*_fn_t),
 *     making the driver testable on PC without Arduino Wire.h.
 *   - On Arduino targets: call fovet_mpu6050_set_i2c() with Wire-based
 *     wrappers before fovet_hal_imu_init() (see examples/esp32/).
 *   - Accel range  : ±2g  — scale 16384 LSB/g
 *   - Gyro range   : ±250°/s — scale 131 LSB/(°/s)
 *   - Default rate : 25 Hz (DLPF active, SMPLRT_DIV = 39)
 *   - Max rate     : 200 Hz
 *
 * Error codes (in addition to FOVET_HAL_*):
 *   FOVET_MPU_ERR_I2C   (-1) — I2C communication failure
 *   FOVET_MPU_ERR_ID    (-2) — WHO_AM_I returned unexpected value
 * -------------------------------------------------------------------------
 */

#ifndef FOVET_MPU6050_HAL_H
#define FOVET_MPU6050_HAL_H

#include <stdint.h>
#include "fovet/hal/fovet_biosignal_hal.h"

#ifdef __cplusplus
extern "C" {
#endif

/* -------------------------------------------------------------------------
 * Error codes
 * ------------------------------------------------------------------------- */

/** I2C communication failure (timeout, NACK, bus error). */
#define FOVET_MPU_ERR_I2C   (-1)

/** WHO_AM_I register returned an unexpected value (not 0x68 or 0x69). */
#define FOVET_MPU_ERR_ID    (-2)

/* -------------------------------------------------------------------------
 * I2C abstraction callbacks
 * ------------------------------------------------------------------------- */

/**
 * @brief Write one byte to a device register.
 *
 * @param dev_addr  7-bit I2C device address.
 * @param reg       Register address.
 * @param data      Byte to write.
 * @return 0 on success, negative on error.
 */
typedef int (*fovet_i2c_write_fn_t)(uint8_t dev_addr, uint8_t reg, uint8_t data);

/**
 * @brief Read consecutive bytes starting from a register.
 *
 * @param dev_addr  7-bit I2C device address.
 * @param reg       Starting register address.
 * @param buf       Output buffer.  Must be at least @p len bytes.
 * @param len       Number of bytes to read.
 * @return 0 on success, negative on error.
 */
typedef int (*fovet_i2c_read_fn_t)(uint8_t dev_addr, uint8_t reg,
                                    uint8_t *buf, uint8_t len);

/* -------------------------------------------------------------------------
 * Public API
 * ------------------------------------------------------------------------- */

/**
 * @brief Inject I2C implementation callbacks.
 *
 * Must be called before fovet_hal_imu_init().
 * On Arduino targets pass Wire-based wrappers; in unit tests pass mocks.
 *
 * @param write_fn  I2C single-byte write callback.  Must not be NULL.
 * @param read_fn   I2C burst-read callback.  Must not be NULL.
 */
void fovet_mpu6050_set_i2c(fovet_i2c_write_fn_t write_fn,
                             fovet_i2c_read_fn_t  read_fn);

/**
 * @brief Initialise the MPU-6050 and auto-register with the biosignal HAL.
 *
 * Sequence:
 *   1. Read WHO_AM_I (0x75) — must be 0x68 or 0x69.
 *   2. Write PWR_MGMT_1 = 0x00 (wake from sleep).
 *   3. Configure DLPF (CONFIG=0x01, ≈184 Hz BW), ±2g accel, ±250°/s gyro.
 *   4. Set sample rate to 25 Hz (default).
 *   5. Call fovet_hal_biosignal_register(FOVET_SOURCE_IMU, fovet_hal_imu_read).
 *
 * @param i2c_addr  7-bit I2C address: 0x68 (AD0 low) or 0x69 (AD0 high).
 *
 * @return FOVET_HAL_OK          on success.
 * @return FOVET_MPU_ERR_I2C    if any I2C transaction fails.
 * @return FOVET_MPU_ERR_ID     if WHO_AM_I does not match 0x68 or 0x69.
 */
int fovet_hal_imu_init(uint8_t i2c_addr);

/**
 * @brief Read one IMU sample from the MPU-6050.
 *
 * Reads 12 bytes starting at ACCEL_XOUT_H (0x3B), covering:
 *   accel XYZ (6 bytes) + temp (2 bytes, ignored) + gyro XYZ (6 bytes).
 *
 * Scales raw 16-bit values:
 *   - Accel: raw / 16384.0f  → g
 *   - Gyro:  raw / 131.0f    → °/s
 *
 * @param[out] out  Sample destination.  Must not be NULL.
 * @return FOVET_HAL_OK          on success.
 * @return FOVET_HAL_ERR_NULL   if out is NULL.
 * @return FOVET_MPU_ERR_I2C   if the I2C burst read fails.
 */
int fovet_hal_imu_read(fovet_biosignal_sample_t *out);

/**
 * @brief Compute linear acceleration magnitude from a sample.
 *
 * magnitude = sqrt(ax² + ay² + az²)
 *
 * @param s  Pointer to a sample whose source is FOVET_SOURCE_IMU.
 *           If NULL, returns 0.0f.
 * @return   Magnitude in g.
 */
float fovet_hal_imu_get_magnitude(const fovet_biosignal_sample_t *s);

/**
 * @brief Reset driver state (for unit tests).
 *
 * Clears the initialised flag so the next fovet_hal_imu_read() call
 * returns FOVET_MPU_ERR_I2C until fovet_hal_imu_init() is called again.
 * Does not touch the biosignal HAL registry.
 */
void fovet_mpu6050_reset(void);

/**
 * @brief Set the IMU output data rate.
 *
 * Uses the DLPF-active formula: SMPLRT_DIV = 1000 / hz - 1.
 * Clamped to [10, 200] Hz.
 *
 * @param hz  Desired sample rate in Hz.
 * @return FOVET_HAL_OK         on success.
 * @return FOVET_MPU_ERR_I2C  if the I2C write fails.
 */
int fovet_hal_imu_set_sample_rate(uint32_t hz);

#ifdef __cplusplus
}
#endif

#endif /* FOVET_MPU6050_HAL_H */
