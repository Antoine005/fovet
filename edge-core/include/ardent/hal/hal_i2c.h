/*
 * Fovet SDK — Sentinelle
 * Copyright (C) 2026 Antoine Porte. All rights reserved.
 * LGPL v3 for non-commercial use.
 * Commercial licensing: contact@fovet.eu
 */

#ifndef FOVET_HAL_I2C_H
#define FOVET_HAL_I2C_H

#include <stdint.h>
#include <stdbool.h>

#ifdef __cplusplus
extern "C" {
#endif

/**
 * @brief I2C operation result codes.
 */
typedef enum {
    HAL_I2C_OK           = 0,  /**< Success */
    HAL_I2C_ERR_NACK     = 1,  /**< Device not present or rejected address/register */
    HAL_I2C_ERR_TIMEOUT  = 2,  /**< Bus timeout — no response within expected window */
    HAL_I2C_ERR_BUS      = 3,  /**< Generic bus error (arbitration loss, short circuit) */
} hal_i2c_err_t;

/**
 * @brief Initialize the I2C bus.
 *
 * Must be called once before any read/write.  On ESP32-CAM:
 *   SDA=GPIO13, SCL=GPIO14 for external sensor headers.
 *
 * @param sda_pin  GPIO pin for SDA
 * @param scl_pin  GPIO pin for SCL
 * @param freq_hz  Bus frequency in Hz — use 100000 (Standard) or 400000 (Fast)
 */
void hal_i2c_init(uint8_t sda_pin, uint8_t scl_pin, uint32_t freq_hz);

/**
 * @brief Write bytes to a device register.
 *
 * Sends: START | addr+W | reg | data[0..len-1] | STOP
 *
 * @param addr  7-bit I2C device address (e.g. 0x68 for MPU-6050 with AD0=GND)
 * @param reg   Register address
 * @param data  Pointer to bytes to write
 * @param len   Number of bytes
 * @return HAL_I2C_OK on success, error code otherwise
 */
hal_i2c_err_t hal_i2c_write_reg(uint8_t addr, uint8_t reg,
                                  const uint8_t *data, uint8_t len);

/**
 * @brief Read bytes from a device register.
 *
 * Sends: START | addr+W | reg | RESTART | addr+R | read len bytes | STOP
 *
 * @param addr  7-bit I2C device address
 * @param reg   Register address to read from
 * @param buf   Buffer to store received bytes (must be >= len bytes)
 * @param len   Number of bytes to read
 * @return HAL_I2C_OK on success, error code otherwise
 */
hal_i2c_err_t hal_i2c_read_reg(uint8_t addr, uint8_t reg,
                                 uint8_t *buf, uint8_t len);

/**
 * @brief Read a single byte from a device register.
 *
 * Convenience wrapper around hal_i2c_read_reg().
 *
 * @param addr  7-bit I2C device address
 * @param reg   Register address
 * @param out   Pointer to store the received byte
 * @return HAL_I2C_OK on success, error code otherwise
 */
hal_i2c_err_t hal_i2c_read_byte(uint8_t addr, uint8_t reg, uint8_t *out);

/**
 * @brief Write a single byte to a device register.
 *
 * Convenience wrapper around hal_i2c_write_reg().
 *
 * @param addr   7-bit I2C device address
 * @param reg    Register address
 * @param value  Byte to write
 * @return HAL_I2C_OK on success, error code otherwise
 */
hal_i2c_err_t hal_i2c_write_byte(uint8_t addr, uint8_t reg, uint8_t value);

/**
 * @brief Check whether a device is present on the bus.
 *
 * Sends an address probe (START | addr+W | STOP) and checks for ACK.
 *
 * @param addr  7-bit I2C device address
 * @return true if device ACKs, false otherwise
 */
bool hal_i2c_probe(uint8_t addr);

#ifdef __cplusplus
}
#endif

#endif /* FOVET_HAL_I2C_H */
