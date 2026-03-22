/*
 * Fovet SDK — Sentinelle
 * Copyright (C) 2026 Antoine Porte. All rights reserved.
 * LGPL v3 for non-commercial use.
 * Commercial licensing: contact@fovet.eu
 */

#ifndef FOVET_DRIVERS_MPU6050_H
#define FOVET_DRIVERS_MPU6050_H

#include <stdint.h>
#include <stdbool.h>

#ifdef __cplusplus
extern "C" {
#endif

/**
 * @brief MPU-6050 3-axis accelerometer + gyroscope (I2C).
 *
 * This driver covers the accelerometer only (sufficient for fall/motion
 * detection in Fovet Sentinelle Phase 3).
 *
 * Wiring on ESP32-CAM (external sensor header):
 *   VCC → 3.3 V
 *   GND → GND
 *   SDA → GPIO13
 *   SCL → GPIO14
 *   AD0 → GND  →  I2C address = 0x68
 *   AD0 → VCC  →  I2C address = 0x69 (second unit)
 *
 * Call hal_i2c_init(13, 14, 400000) before any mpu6050_* function.
 */

/* Default 7-bit I2C address (AD0 pin tied to GND) */
#define MPU6050_ADDR_DEFAULT  0x68U
/* Alternate address (AD0 pin tied to VCC) */
#define MPU6050_ADDR_ALT      0x69U

/**
 * @brief Accelerometer full-scale range.
 *
 * Trade-off: wider range → less resolution, but needed for high-g impacts.
 * For fall/motion detection ±4g or ±8g are typical.
 */
typedef enum {
    MPU6050_RANGE_2G  = 0,  /**< ±2g  — 16384 LSB/g  (highest resolution) */
    MPU6050_RANGE_4G  = 1,  /**< ±4g  —  8192 LSB/g */
    MPU6050_RANGE_8G  = 2,  /**< ±8g  —  4096 LSB/g */
    MPU6050_RANGE_16G = 3,  /**< ±16g —  2048 LSB/g (captures hard falls)  */
} mpu6050_range_t;

/**
 * @brief Calibrated accelerometer sample.
 *
 * All values are in g (1g ≈ 9.81 m/s²).
 * At rest on a flat surface: x≈0, y≈0, z≈+1 (gravity).
 */
typedef struct {
    float x;          /**< Acceleration X axis, in g */
    float y;          /**< Acceleration Y axis, in g */
    float z;          /**< Acceleration Z axis, in g */
    float magnitude;  /**< |a| = sqrt(x² + y² + z²), in g */
} mpu6050_accel_t;

/**
 * @brief Probe the I2C bus for an MPU-6050 at the given address.
 *
 * @param addr  7-bit I2C address (MPU6050_ADDR_DEFAULT or MPU6050_ADDR_ALT)
 * @return true if device ACKs
 */
bool mpu6050_probe(uint8_t addr);

/**
 * @brief Initialize the MPU-6050.
 *
 * - Verifies WHO_AM_I register (0x68)
 * - Wakes device from sleep (PWR_MGMT_1 = 0x00)
 * - Sets accelerometer full-scale range
 *
 * @param addr   7-bit I2C address
 * @param range  Accelerometer full-scale range
 * @return true on success, false if device not found or WHO_AM_I mismatch
 */
bool mpu6050_init(uint8_t addr, mpu6050_range_t range);

/**
 * @brief Read raw accelerometer data and convert to g.
 *
 * Reads 6 bytes starting at ACCEL_XOUT_H (0x3B), converts using the
 * scale factor set in mpu6050_init().
 *
 * @param addr  7-bit I2C address
 * @param out   Pointer to receive the accelerometer sample
 * @return true on success, false on I2C error
 */
bool mpu6050_read_accel(uint8_t addr, mpu6050_accel_t *out);

#ifdef __cplusplus
}
#endif

#endif /* FOVET_DRIVERS_MPU6050_H */
