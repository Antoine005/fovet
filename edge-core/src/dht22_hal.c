/*
 * Ardent SDK — Pulse
 * Copyright (C) 2026 Antoine Porte. All rights reserved.
 * LGPL v3 for non-commercial use.
 * Commercial licensing: contact@fovet.eu
 *
 * -------------------------------------------------------------------------
 * dht22_hal.c — DHT22 single-wire driver (H3.1)
 * -------------------------------------------------------------------------
 */

#include "ardent/hal/dht22_hal.h"
#include "ardent/hal/ard_biosignal_hal.h"

#include <string.h>
#include <stddef.h>

/* -------------------------------------------------------------------------
 * Internal constants
 * ------------------------------------------------------------------------- */

/* Host start: pull LOW for ≥ 1 ms before releasing. */
#define DHT22_START_LOW_US   1100U

/* Host: wait after releasing before sensor responds. */
#define DHT22_RELEASE_US       30U

/* Sensor handshake: ~80 µs LOW then ~80 µs HIGH. */
#define DHT22_HANDSHAKE_US    200U

/* Bit timing: each bit starts with ~50 µs LOW. */
#define DHT22_BIT_START_US    100U

/* Bit timing: HIGH duration. > 40 µs → bit=1, ≤ 40 µs → bit=0. */
#define DHT22_BIT_HIGH_US     100U
#define DHT22_BIT_THRESHOLD_US 40U

/* Number of data bits in a DHT22 frame. */
#define DHT22_BITS              40U
#define DHT22_BYTES              5U

/* -------------------------------------------------------------------------
 * Module-level IO bundle (set via ard_dht22_set_io)
 * ------------------------------------------------------------------------- */

static ard_dht22_io_t g_io;
static int              g_io_set = 0;

/* -------------------------------------------------------------------------
 * ard_dht22_set_io
 * ------------------------------------------------------------------------- */

void ard_dht22_set_io(const ard_dht22_io_t *io)
{
    if (io == NULL)
        return;
    g_io     = *io;
    g_io_set = (io->pin_write != NULL &&
                io->pulse_us  != NULL &&
                io->delay_us  != NULL) ? 1 : 0;
}

/* -------------------------------------------------------------------------
 * ard_dht22_reset  (tests only)
 * ------------------------------------------------------------------------- */

void ard_dht22_reset(void)
{
    memset(&g_io, 0, sizeof(g_io));
    g_io_set = 0;
}

/* -------------------------------------------------------------------------
 * ard_dht22_read
 * ------------------------------------------------------------------------- */

int ard_dht22_read(ard_dht22_reading_t *out)
{
    uint8_t  bytes[DHT22_BYTES];
    uint32_t i;
    uint8_t  sum;

    if (out == NULL)
        return ARD_HAL_ERR_NULL;

    if (!g_io_set)
        return ARD_DHT22_ERR_IO;

    /* ------------------------------------------------------------------ */
    /* 1. Host start signal                                                 */
    /* ------------------------------------------------------------------ */
    g_io.pin_write(0U);
    g_io.delay_us(DHT22_START_LOW_US);
    g_io.pin_write(1U);
    g_io.delay_us(DHT22_RELEASE_US);

    /* ------------------------------------------------------------------ */
    /* 2. Sensor handshake — LOW ~80 µs then HIGH ~80 µs                   */
    /* ------------------------------------------------------------------ */
    if (g_io.pulse_us(0U, DHT22_HANDSHAKE_US) == 0U)
        return ARD_DHT22_ERR_TIMEOUT;

    if (g_io.pulse_us(1U, DHT22_HANDSHAKE_US) == 0U)
        return ARD_DHT22_ERR_TIMEOUT;

    /* ------------------------------------------------------------------ */
    /* 3. Read 40 data bits, MSB first                                      */
    /* ------------------------------------------------------------------ */
    memset(bytes, 0, sizeof(bytes));

    for (i = 0U; i < DHT22_BITS; i++)
    {
        uint32_t dur;

        /* Each bit starts with ~50 µs LOW */
        if (g_io.pulse_us(0U, DHT22_BIT_START_US) == 0U)
            return ARD_DHT22_ERR_TIMEOUT;

        /* HIGH duration: < 40 µs → bit=0, ≥ 40 µs → bit=1 */
        dur = g_io.pulse_us(1U, DHT22_BIT_HIGH_US);
        if (dur == 0U)
            return ARD_DHT22_ERR_TIMEOUT;

        if (dur >= DHT22_BIT_THRESHOLD_US)
            bytes[i / 8U] |= (uint8_t)(1U << (7U - (i % 8U)));
    }

    /* ------------------------------------------------------------------ */
    /* 4. Verify checksum                                                   */
    /* ------------------------------------------------------------------ */
    sum = (uint8_t)((bytes[0] + bytes[1] + bytes[2] + bytes[3]) & 0xFFU);
    if (sum != bytes[4])
        return ARD_DHT22_ERR_CHECKSUM;

    /* ------------------------------------------------------------------ */
    /* 5. Decode                                                            */
    /* ------------------------------------------------------------------ */
    {
        float humidity;
        float celsius;
        uint16_t raw_h;
        uint16_t raw_t;

        raw_h    = (uint16_t)(((uint16_t)bytes[0] << 8U) | bytes[1]);
        humidity = (float)raw_h / 10.0f;

        raw_t   = (uint16_t)((((uint16_t)(bytes[2] & 0x7FU)) << 8U) | bytes[3]);
        celsius = (float)raw_t / 10.0f;
        if (bytes[2] & 0x80U)
            celsius = -celsius;

        /* ---------------------------------------------------------------- */
        /* 6. Validate physical range                                        */
        /* ---------------------------------------------------------------- */
        if (celsius  < ARD_DHT22_TEMP_MIN    ||
            celsius  > ARD_DHT22_TEMP_MAX    ||
            humidity > ARD_DHT22_HUMIDITY_MAX)
        {
            return ARD_DHT22_ERR_RANGE;
        }

        out->celsius      = celsius;
        out->humidity_pct = humidity;
    }

    return ARD_HAL_OK;
}

/* -------------------------------------------------------------------------
 * ard_hal_temp_read  — biosignal HAL callback
 * ------------------------------------------------------------------------- */

int ard_hal_temp_read(ard_biosignal_sample_t *out)
{
    ard_dht22_reading_t r;
    int rc;

    if (out == NULL)
        return ARD_HAL_ERR_NULL;

    rc = ard_dht22_read(&r);
    if (rc != ARD_HAL_OK)
        return rc;

    out->source                = ARD_SOURCE_TEMP;
    out->value.temp.celsius    = r.celsius;
    out->value.temp.humidity_pct = r.humidity_pct;
    out->timestamp_ms          = 0U; /* caller fills if hal_time_ms available */

    return ARD_HAL_OK;
}

/* -------------------------------------------------------------------------
 * ard_dht22_init
 * ------------------------------------------------------------------------- */

int ard_dht22_init(void)
{
    if (!g_io_set)
        return ARD_DHT22_ERR_IO;

    return ard_hal_biosignal_register(ARD_SOURCE_TEMP, ard_hal_temp_read);
}
