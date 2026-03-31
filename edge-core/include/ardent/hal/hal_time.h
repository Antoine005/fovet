/*
 * Ardent SDK — Pulse
 * Copyright (C) 2026 Antoine Porte. All rights reserved.
 * LGPL v3 for non-commercial use.
 * Commercial licensing: contact@ardent.io
 */

#ifndef ARD_HAL_TIME_H
#define ARD_HAL_TIME_H

#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/**
 * @brief Return elapsed time in milliseconds since boot.
 * @return Timestamp in ms (wraps at UINT32_MAX ~49 days)
 */
uint32_t hal_time_ms(void);

/**
 * @brief Return elapsed time in microseconds since boot.
 * @return Timestamp in us
 */
uint32_t hal_time_us(void);

/**
 * @brief Busy-wait delay.
 * @param ms Duration in milliseconds
 */
void hal_delay_ms(uint32_t ms);

#ifdef __cplusplus
}
#endif

#endif /* ARD_HAL_TIME_H */
