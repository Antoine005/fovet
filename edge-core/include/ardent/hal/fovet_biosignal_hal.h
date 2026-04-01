/*
 * Fovet SDK — Sentinelle
 * Copyright (C) 2026 Antoine Porte. All rights reserved.
 * LGPL v3 for non-commercial use.
 * Commercial licensing: contact@fovet.eu
 *
 * -------------------------------------------------------------------------
 * fovet_biosignal_hal.h — Generic biosignal HAL interface
 *
 * Provides a hardware-agnostic abstraction layer for all physiological
 * sensors (IMU, heart-rate, temperature, ECG).  Algorithms and profiles
 * interact exclusively with this interface; concrete drivers (MPU-6050,
 * MAX30102, NTC, AD8232) register themselves via
 * fovet_hal_biosignal_register() and implement fovet_hal_read_fn_t.
 *
 * Design constraints:
 *   - C99 pure, zero malloc, zero global state beyond the static registry
 *   - sizeof(fovet_biosignal_sample_t) == 32 bytes (4 + 24 + 4, aligned)
 *   - Up to FOVET_BIOSIGNAL_SOURCE_COUNT sources registered simultaneously
 *   - Re-registering the same source overwrites the previous handler
 * -------------------------------------------------------------------------
 */

#ifndef FOVET_BIOSIGNAL_HAL_H
#define FOVET_BIOSIGNAL_HAL_H

#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/* -------------------------------------------------------------------------
 * Return codes
 * ------------------------------------------------------------------------- */

/** Operation completed successfully. */
#define FOVET_HAL_OK           0

/** Null pointer passed where a valid pointer is required. */
#define FOVET_HAL_ERR_NULL    -1

/** Source type is out of range (>= FOVET_BIOSIGNAL_SOURCE_COUNT). */
#define FOVET_HAL_ERR_TYPE    -2

/** No handler registered for the requested source type. */
#define FOVET_HAL_ERR_NOREG   -3

/* -------------------------------------------------------------------------
 * Source types
 * ------------------------------------------------------------------------- */

/**
 * @brief Biosignal source identifiers.
 *
 * Each value maps to one sensor family.  The numeric values are used as
 * indices into the internal registry array — do not reorder without
 * updating FOVET_BIOSIGNAL_SOURCE_COUNT.
 */
typedef enum {
    FOVET_SOURCE_IMU  = 0, /**< Inertial measurement unit (accel + gyro)  */
    FOVET_SOURCE_HR   = 1, /**< Heart rate / SpO2 (MAX30102 or equivalent) */
    FOVET_SOURCE_TEMP = 2, /**< Body temperature (NTC thermistor)          */
    FOVET_SOURCE_ECG  = 3  /**< Electrocardiogram (AD8232 or equivalent)   */
} fovet_biosignal_source_t;

/** Number of distinct source types — must equal the last enum value + 1. */
#define FOVET_BIOSIGNAL_SOURCE_COUNT 4U

/* -------------------------------------------------------------------------
 * Value union
 * ------------------------------------------------------------------------- */

/**
 * @brief Per-source payload — access only the member matching the source type.
 *
 * Size: 24 bytes (largest member is imu: 6 × float = 24 bytes).
 */
typedef union {
    /** IMU: linear acceleration (g) and angular rate (°/s). */
    struct {
        float ax; /**< Acceleration X axis (g)   */
        float ay; /**< Acceleration Y axis (g)   */
        float az; /**< Acceleration Z axis (g)   */
        float gx; /**< Gyroscope X axis (°/s)    */
        float gy; /**< Gyroscope Y axis (°/s)    */
        float gz; /**< Gyroscope Z axis (°/s)    */
    } imu;

    /** Heart rate + SpO2 + HRV. */
    struct {
        float bpm;   /**< Beats per minute                          */
        float spo2;  /**< Blood oxygen saturation (%, 0–100)        */
        float rmssd; /**< Root mean square of successive RR diffs   */
    } hr;

    /** Skin / body / ambient temperature + humidity (DHT22, NTC, etc.). */
    struct {
        float celsius;      /**< Temperature in degrees Celsius           */
        float humidity_pct; /**< Relative humidity in percent (0–100)     */
    } temp;

    /** Single-lead ECG. */
    struct {
        float   mv;     /**< Lead voltage in millivolts  */
        int32_t rr_ms;  /**< R–R interval in milliseconds (0 if unknown) */
    } ecg;

} fovet_biosignal_value_t;

/* -------------------------------------------------------------------------
 * Sample struct
 * ------------------------------------------------------------------------- */

/**
 * @brief A single biosignal reading with metadata.
 *
 * Layout (C99, no padding on 32-bit ARM / x86):
 *   offset 0  : source      (4 bytes, enum stored as int)
 *   offset 4  : value       (24 bytes, union)
 *   offset 28 : timestamp_ms (4 bytes)
 * sizeof == 32 bytes.
 */
typedef struct {
    fovet_biosignal_source_t source;       /**< Identifies which union member is valid */
    fovet_biosignal_value_t  value;        /**< Payload — read the member matching source */
    uint32_t                 timestamp_ms; /**< hal_time_ms() at the moment of acquisition */
} fovet_biosignal_sample_t;

/* -------------------------------------------------------------------------
 * Driver callback type
 * ------------------------------------------------------------------------- */

/**
 * @brief Prototype for a sensor read function.
 *
 * The driver must fill all fields of *out, including source and timestamp_ms.
 *
 * @param[out] out  Pointer to the sample to populate.  Never NULL when called
 *                  by fovet_hal_biosignal_read().
 *
 * @return FOVET_HAL_OK on success, a negative error code on failure
 *         (driver-defined; e.g. -1 for I2C timeout).
 */
typedef int (*fovet_hal_read_fn_t)(fovet_biosignal_sample_t *out);

/* -------------------------------------------------------------------------
 * Public API
 * ------------------------------------------------------------------------- */

/**
 * @brief Register a driver callback for a biosignal source.
 *
 * Re-registering the same @p type replaces the previous handler.
 * Thread safety: not guaranteed — call from a single task/context.
 *
 * @param type  The sensor source type to register.
 * @param fn    Driver read function.  Must not be NULL.
 *
 * @return FOVET_HAL_OK            on success.
 * @return FOVET_HAL_ERR_NULL     if fn is NULL.
 * @return FOVET_HAL_ERR_TYPE     if type is out of range.
 */
int fovet_hal_biosignal_register(fovet_biosignal_source_t type,
                                  fovet_hal_read_fn_t      fn);

/**
 * @brief Read a biosignal sample from a registered driver.
 *
 * Calls the function registered for @p type and returns its result.
 *
 * @param type  The sensor source to read.
 * @param[out] out  Destination for the sample.  Must not be NULL.
 *
 * @return FOVET_HAL_OK            if the driver populated *out successfully.
 * @return FOVET_HAL_ERR_NULL     if out is NULL.
 * @return FOVET_HAL_ERR_TYPE     if type is out of range.
 * @return FOVET_HAL_ERR_NOREG    if no handler is registered for type.
 * @return Any negative driver error code forwarded from the read function.
 */
int fovet_hal_biosignal_read(fovet_biosignal_source_t  type,
                              fovet_biosignal_sample_t *out);

/**
 * @brief Clear all registered handlers.
 *
 * Intended for unit tests.  After this call every source returns
 * FOVET_HAL_ERR_NOREG until re-registered.
 */
void fovet_hal_biosignal_reset(void);

#ifdef __cplusplus
}
#endif

#endif /* FOVET_BIOSIGNAL_HAL_H */
