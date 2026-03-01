/*
 * Fovet SDK — Sentinelle
 * Copyright (C) 2026 Antoine Porte. All rights reserved.
 * LGPL v3 for non-commercial use.
 * Commercial licensing: contact@fovet.eu
 */

#ifndef FOVET_HAL_UART_H
#define FOVET_HAL_UART_H

#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/**
 * @brief Initialize UART peripheral.
 * @param baud_rate Baud rate (e.g. 115200)
 */
void hal_uart_init(uint32_t baud_rate);

/**
 * @brief Write bytes over UART.
 * @param data Pointer to data buffer
 * @param len  Number of bytes to write
 */
void hal_uart_write(const char *data, uint32_t len);

/**
 * @brief Write a null-terminated string over UART.
 * @param str Null-terminated string
 */
void hal_uart_print(const char *str);

/**
 * @brief Flush the UART TX buffer.
 */
void hal_uart_flush(void);

#ifdef __cplusplus
}
#endif

#endif /* FOVET_HAL_UART_H */
