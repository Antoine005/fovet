/*
 * Fovet SDK — Sentinelle
 * Copyright (C) 2026 Antoine Porte. All rights reserved.
 * LGPL v3 for non-commercial use.
 * Commercial licensing: contact@fovet.eu
 *
 * -------------------------------------------------------------------------
 * test_dht22_hal.c — Unit tests for DHT22 HAL driver (H3.1)
 *
 * Mock strategy: the DHT22 single-wire protocol is fully simulated via
 * the pulse_us injectable callback.  For a given temperature + humidity,
 * the 40-bit frame is pre-encoded as a sequence of pulse durations.
 *
 * Pulse sequence layout (82 values per reading):
 *   [0]  preamble: sensor LOW ~80 µs
 *   [1]  preamble: sensor HIGH ~80 µs
 *   [2..81] 40 bits × 2 values each:
 *     [2i+2] bit-start LOW  ~50 µs
 *     [2i+3] bit-HIGH       ~26 µs (bit=0) or ~70 µs (bit=1)
 * -------------------------------------------------------------------------
 */

#include <stdio.h>
#include <stdint.h>
#include <string.h>
#include <math.h>

#define FOVET_NATIVE_TEST
#include "../include/fovet/hal/dht22_hal.h"
#include "../include/fovet/hal/fovet_biosignal_hal.h"

/* =========================================================================
 * Test harness
 * ========================================================================= */

static int g_pass = 0;
static int g_fail = 0;

#define ASSERT(cond, msg) \
    do { \
        if (cond) { \
            g_pass++; \
        } else { \
            fprintf(stderr, "FAIL [%s:%d] %s\n", __FILE__, __LINE__, (msg)); \
            g_fail++; \
        } \
    } while (0)

#define ASSERT_INT_EQ(a, b, msg) \
    ASSERT((a) == (b), msg)

#define ASSERT_FLOAT_EQ(a, b, eps, msg) \
    ASSERT(fabsf((float)(a) - (float)(b)) <= (eps), msg)

/* =========================================================================
 * Mock IO
 * ========================================================================= */

#define PULSE_SEQ_MAX 128

static uint32_t g_pulse_seq[PULSE_SEQ_MAX];
static int      g_pulse_count;
static int      g_pulse_idx;
static uint8_t  g_pin_level;
static int      g_pin_write_calls;

static void mock_pin_write(uint8_t level)
{
    g_pin_level = level;
    g_pin_write_calls++;
}

static uint32_t mock_pulse_us(uint8_t expected_level, uint32_t timeout_us)
{
    (void)expected_level;
    (void)timeout_us;
    if (g_pulse_idx >= g_pulse_count)
        return 0U; /* simulate timeout */
    return g_pulse_seq[g_pulse_idx++];
}

static void mock_delay_us(uint32_t us)
{
    (void)us;
}

static const fovet_dht22_io_t k_mock_io = {
    mock_pin_write,
    mock_pulse_us,
    mock_delay_us
};

/* =========================================================================
 * Helpers
 * ========================================================================= */

/**
 * @brief Build the 5 raw bytes for given temperature + humidity.
 *
 * bytes[0..1] = humidity  × 10  (uint16, MSB first)
 * bytes[2..3] = |temp|    × 10  (uint16, MSB first; bytes[2] bit7 = sign)
 * bytes[4]    = checksum  = (bytes[0]+bytes[1]+bytes[2]+bytes[3]) & 0xFF
 */
static void make_bytes(float celsius, float humidity_pct, uint8_t bytes[5])
{
    uint16_t raw_h;
    uint16_t raw_t;
    float    abs_t = (celsius < 0.0f) ? -celsius : celsius;

    raw_h    = (uint16_t)(humidity_pct * 10.0f + 0.5f);
    bytes[0] = (uint8_t)(raw_h >> 8U);
    bytes[1] = (uint8_t)(raw_h & 0xFFU);

    raw_t    = (uint16_t)(abs_t * 10.0f + 0.5f);
    bytes[2] = (uint8_t)((raw_t >> 8U) & 0x7FU);
    if (celsius < 0.0f)
        bytes[2] |= 0x80U;
    bytes[3] = (uint8_t)(raw_t & 0xFFU);
    bytes[4] = (uint8_t)((bytes[0] + bytes[1] + bytes[2] + bytes[3]) & 0xFFU);
}

/**
 * @brief Load pulse sequence for a valid reading of (celsius, humidity_pct).
 *
 * Preamble: 80, 80
 * Per bit:  50, (bit ? 70 : 26)
 */
static void setup_pulse_seq(float celsius, float humidity_pct)
{
    uint8_t bytes[5];
    int     n = 0;
    int     i;

    make_bytes(celsius, humidity_pct, bytes);

    g_pulse_seq[n++] = 80U; /* handshake LOW  ~80 µs */
    g_pulse_seq[n++] = 80U; /* handshake HIGH ~80 µs */

    for (i = 0; i < 40; i++)
    {
        uint8_t byte = bytes[i / 8];
        uint8_t bit  = (byte >> (7 - (i % 8))) & 1U;
        g_pulse_seq[n++] = 50U;        /* bit-start LOW */
        g_pulse_seq[n++] = bit ? 70U : 26U; /* bit-HIGH */
    }

    g_pulse_count = n;
    g_pulse_idx   = 0;
}

static void reset_mock(void)
{
    g_pulse_count     = 0;
    g_pulse_idx       = 0;
    g_pin_level       = 1U;
    g_pin_write_calls = 0;
    fovet_dht22_reset();
    fovet_hal_biosignal_reset();
}

/* =========================================================================
 * Tests — default header constants
 * ========================================================================= */

static void test_constants(void)
{
    ASSERT_FLOAT_EQ(FOVET_DHT22_TEMP_MIN,    -40.0f, 1e-4f, "TEMP_MIN == -40.0");
    ASSERT_FLOAT_EQ(FOVET_DHT22_TEMP_MAX,     80.0f, 1e-4f, "TEMP_MAX == 80.0");
    ASSERT_FLOAT_EQ(FOVET_DHT22_HUMIDITY_MAX, 100.0f, 1e-4f, "HUMIDITY_MAX == 100.0");
    ASSERT_INT_EQ(FOVET_DHT22_ERR_TIMEOUT,  -1, "ERR_TIMEOUT == -1");
    ASSERT_INT_EQ(FOVET_DHT22_ERR_CHECKSUM, -2, "ERR_CHECKSUM == -2");
    ASSERT_INT_EQ(FOVET_DHT22_ERR_RANGE,    -3, "ERR_RANGE == -3");
    ASSERT_INT_EQ(FOVET_DHT22_ERR_IO,       -4, "ERR_IO == -4");
}

/* =========================================================================
 * Tests — IO setup guard
 * ========================================================================= */

static void test_read_without_set_io_returns_err_io(void)
{
    fovet_dht22_reading_t r;
    reset_mock();
    /* do NOT call set_io */
    ASSERT_INT_EQ(fovet_dht22_read(&r), FOVET_DHT22_ERR_IO,
                  "read without set_io → ERR_IO");
}

static void test_init_without_set_io_returns_err_io(void)
{
    reset_mock();
    ASSERT_INT_EQ(fovet_dht22_init(), FOVET_DHT22_ERR_IO,
                  "init without set_io → ERR_IO");
}

/* =========================================================================
 * Tests — positive temperature reading
 * ========================================================================= */

static void test_read_positive_temperature(void)
{
    fovet_dht22_reading_t r;
    reset_mock();
    setup_pulse_seq(25.3f, 60.5f);
    fovet_dht22_set_io(&k_mock_io);
    ASSERT_INT_EQ(fovet_dht22_read(&r), FOVET_HAL_OK, "read OK");
    ASSERT_FLOAT_EQ(r.celsius,      25.3f, 0.1f, "celsius == 25.3");
    ASSERT_FLOAT_EQ(r.humidity_pct, 60.5f, 0.1f, "humidity == 60.5");
}

static void test_read_zero_temperature(void)
{
    fovet_dht22_reading_t r;
    reset_mock();
    setup_pulse_seq(0.0f, 50.0f);
    fovet_dht22_set_io(&k_mock_io);
    ASSERT_INT_EQ(fovet_dht22_read(&r), FOVET_HAL_OK, "read OK");
    ASSERT_FLOAT_EQ(r.celsius, 0.0f, 0.1f, "celsius == 0.0");
}

/* =========================================================================
 * Tests — negative temperature reading
 * ========================================================================= */

static void test_read_negative_temperature(void)
{
    fovet_dht22_reading_t r;
    reset_mock();
    setup_pulse_seq(-12.5f, 45.0f);
    fovet_dht22_set_io(&k_mock_io);
    ASSERT_INT_EQ(fovet_dht22_read(&r), FOVET_HAL_OK, "read OK");
    ASSERT_FLOAT_EQ(r.celsius,      -12.5f, 0.1f, "celsius == -12.5");
    ASSERT_FLOAT_EQ(r.humidity_pct,  45.0f, 0.1f, "humidity == 45.0");
}

/* =========================================================================
 * Tests — boundary humidity values
 * ========================================================================= */

static void test_read_humidity_zero(void)
{
    fovet_dht22_reading_t r;
    reset_mock();
    setup_pulse_seq(20.0f, 0.0f);
    fovet_dht22_set_io(&k_mock_io);
    ASSERT_INT_EQ(fovet_dht22_read(&r), FOVET_HAL_OK, "read OK");
    ASSERT_FLOAT_EQ(r.humidity_pct, 0.0f, 0.1f, "humidity == 0.0");
}

static void test_read_humidity_max(void)
{
    fovet_dht22_reading_t r;
    reset_mock();
    setup_pulse_seq(25.0f, 99.9f);
    fovet_dht22_set_io(&k_mock_io);
    ASSERT_INT_EQ(fovet_dht22_read(&r), FOVET_HAL_OK, "read OK");
    ASSERT_FLOAT_EQ(r.humidity_pct, 99.9f, 0.2f, "humidity == 99.9");
}

/* =========================================================================
 * Tests — boundary temperature values
 * ========================================================================= */

static void test_read_temp_min(void)
{
    fovet_dht22_reading_t r;
    reset_mock();
    setup_pulse_seq(-40.0f, 20.0f);
    fovet_dht22_set_io(&k_mock_io);
    ASSERT_INT_EQ(fovet_dht22_read(&r), FOVET_HAL_OK, "read OK");
    ASSERT_FLOAT_EQ(r.celsius, -40.0f, 0.1f, "celsius == -40.0");
}

static void test_read_temp_max(void)
{
    fovet_dht22_reading_t r;
    reset_mock();
    setup_pulse_seq(80.0f, 20.0f);
    fovet_dht22_set_io(&k_mock_io);
    ASSERT_INT_EQ(fovet_dht22_read(&r), FOVET_HAL_OK, "read OK");
    ASSERT_FLOAT_EQ(r.celsius, 80.0f, 0.1f, "celsius == 80.0");
}

/* =========================================================================
 * Tests — error cases
 * ========================================================================= */

static void test_timeout_at_handshake_low(void)
{
    fovet_dht22_reading_t r;
    reset_mock();
    fovet_dht22_set_io(&k_mock_io);
    /* provide no pulses — mock returns 0 (timeout) immediately */
    g_pulse_count = 0;
    g_pulse_idx   = 0;
    ASSERT_INT_EQ(fovet_dht22_read(&r), FOVET_DHT22_ERR_TIMEOUT,
                  "timeout at handshake LOW");
}

static void test_timeout_at_handshake_high(void)
{
    fovet_dht22_reading_t r;
    reset_mock();
    fovet_dht22_set_io(&k_mock_io);
    /* only 1 pulse — handshake LOW OK, HIGH times out */
    g_pulse_seq[0] = 80U; /* handshake LOW OK */
    g_pulse_count  = 1;
    g_pulse_idx    = 0;
    ASSERT_INT_EQ(fovet_dht22_read(&r), FOVET_DHT22_ERR_TIMEOUT,
                  "timeout at handshake HIGH");
}

static void test_timeout_during_bit_read(void)
{
    fovet_dht22_reading_t r;
    reset_mock();
    fovet_dht22_set_io(&k_mock_io);
    /* 2 preamble + only 1 bit-start pulse, then timeout */
    g_pulse_seq[0] = 80U;
    g_pulse_seq[1] = 80U;
    g_pulse_seq[2] = 50U;  /* bit-start LOW */
    /* no HIGH pulse → timeout */
    g_pulse_count  = 3;
    g_pulse_idx    = 0;
    ASSERT_INT_EQ(fovet_dht22_read(&r), FOVET_DHT22_ERR_TIMEOUT,
                  "timeout during bit HIGH");
}

static void test_checksum_mismatch(void)
{
    fovet_dht22_reading_t r;
    uint8_t bytes[5];
    int     n = 0;
    int     i;

    reset_mock();
    fovet_dht22_set_io(&k_mock_io);

    /* Build bytes for 25.0 °C / 60.0 % then corrupt checksum */
    make_bytes(25.0f, 60.0f, bytes);
    bytes[4] ^= 0xFFU; /* corrupt */

    g_pulse_seq[n++] = 80U;
    g_pulse_seq[n++] = 80U;
    for (i = 0; i < 40; i++) {
        uint8_t bit = (bytes[i / 8] >> (7 - (i % 8))) & 1U;
        g_pulse_seq[n++] = 50U;
        g_pulse_seq[n++] = bit ? 70U : 26U;
    }
    g_pulse_count = n;
    g_pulse_idx   = 0;

    ASSERT_INT_EQ(fovet_dht22_read(&r), FOVET_DHT22_ERR_CHECKSUM,
                  "corrupted checksum → ERR_CHECKSUM");
}

static void test_humidity_out_of_range(void)
{
    fovet_dht22_reading_t r;
    uint8_t bytes[5];
    int     n = 0;
    int     i;

    reset_mock();
    fovet_dht22_set_io(&k_mock_io);

    /*
     * Humidity = 105 % (raw = 1050 = 0x041A) — above FOVET_DHT22_HUMIDITY_MAX.
     * Build bytes manually to bypass make_bytes clamping.
     */
    bytes[0] = 0x04U;
    bytes[1] = 0x1AU;
    bytes[2] = 0x00U; /* temp = 0 °C */
    bytes[3] = 0x00U;
    bytes[4] = (bytes[0] + bytes[1] + bytes[2] + bytes[3]) & 0xFFU;

    g_pulse_seq[n++] = 80U;
    g_pulse_seq[n++] = 80U;
    for (i = 0; i < 40; i++) {
        uint8_t bit = (bytes[i / 8] >> (7 - (i % 8))) & 1U;
        g_pulse_seq[n++] = 50U;
        g_pulse_seq[n++] = bit ? 70U : 26U;
    }
    g_pulse_count = n;
    g_pulse_idx   = 0;

    ASSERT_INT_EQ(fovet_dht22_read(&r), FOVET_DHT22_ERR_RANGE,
                  "humidity > 100% → ERR_RANGE");
}

static void test_temperature_out_of_range_high(void)
{
    fovet_dht22_reading_t r;
    uint8_t bytes[5];
    int     n = 0;
    int     i;

    reset_mock();
    fovet_dht22_set_io(&k_mock_io);

    /* Temperature = 81.0 °C (raw = 810 = 0x032A) — above FOVET_DHT22_TEMP_MAX */
    bytes[0] = 0x01U; /* humidity 5.0 % */
    bytes[1] = 0x32U;
    bytes[2] = 0x03U; /* temp = +81.0 °C (0x032A, positive) */
    bytes[3] = 0x2AU;
    bytes[4] = (bytes[0] + bytes[1] + bytes[2] + bytes[3]) & 0xFFU;

    g_pulse_seq[n++] = 80U;
    g_pulse_seq[n++] = 80U;
    for (i = 0; i < 40; i++) {
        uint8_t bit = (bytes[i / 8] >> (7 - (i % 8))) & 1U;
        g_pulse_seq[n++] = 50U;
        g_pulse_seq[n++] = bit ? 70U : 26U;
    }
    g_pulse_count = n;
    g_pulse_idx   = 0;

    ASSERT_INT_EQ(fovet_dht22_read(&r), FOVET_DHT22_ERR_RANGE,
                  "temp > 80 °C → ERR_RANGE");
}

/* =========================================================================
 * Tests — biosignal HAL integration
 * ========================================================================= */

static void test_init_registers_temp_source(void)
{
    fovet_biosignal_sample_t s;
    reset_mock();
    fovet_dht22_set_io(&k_mock_io);
    ASSERT_INT_EQ(fovet_dht22_init(), FOVET_HAL_OK, "init → HAL_OK");

    /* A subsequent read via biosignal HAL must succeed */
    setup_pulse_seq(22.0f, 55.0f);
    ASSERT_INT_EQ(fovet_hal_biosignal_read(FOVET_SOURCE_TEMP, &s),
                  FOVET_HAL_OK, "biosignal_read TEMP → HAL_OK");
}

static void test_biosignal_hal_fills_source_field(void)
{
    fovet_biosignal_sample_t s;
    reset_mock();
    fovet_dht22_set_io(&k_mock_io);
    fovet_dht22_init();
    setup_pulse_seq(22.0f, 55.0f);
    fovet_hal_biosignal_read(FOVET_SOURCE_TEMP, &s);
    ASSERT(s.source == FOVET_SOURCE_TEMP, "sample.source == FOVET_SOURCE_TEMP");
}

static void test_biosignal_hal_fills_celsius(void)
{
    fovet_biosignal_sample_t s;
    reset_mock();
    fovet_dht22_set_io(&k_mock_io);
    fovet_dht22_init();
    setup_pulse_seq(22.0f, 55.0f);
    fovet_hal_biosignal_read(FOVET_SOURCE_TEMP, &s);
    ASSERT_FLOAT_EQ(s.value.temp.celsius, 22.0f, 0.1f, "sample.temp.celsius == 22.0");
}

static void test_biosignal_hal_fills_humidity(void)
{
    fovet_biosignal_sample_t s;
    reset_mock();
    fovet_dht22_set_io(&k_mock_io);
    fovet_dht22_init();
    setup_pulse_seq(22.0f, 55.0f);
    fovet_hal_biosignal_read(FOVET_SOURCE_TEMP, &s);
    ASSERT_FLOAT_EQ(s.value.temp.humidity_pct, 55.0f, 0.1f, "sample.temp.humidity_pct == 55.0");
}

static void test_biosignal_hal_not_registered_without_init(void)
{
    fovet_biosignal_sample_t s;
    reset_mock();
    /* no init → no handler registered */
    ASSERT_INT_EQ(fovet_hal_biosignal_read(FOVET_SOURCE_TEMP, &s),
                  FOVET_HAL_ERR_NOREG,
                  "no init → HAL_ERR_NOREG");
}

/* =========================================================================
 * Tests — pin_write behavior
 * ========================================================================= */

static void test_pin_write_called_for_start_signal(void)
{
    fovet_dht22_reading_t r;
    reset_mock();
    fovet_dht22_set_io(&k_mock_io);
    setup_pulse_seq(20.0f, 50.0f);
    fovet_dht22_read(&r);
    /* pin_write(0) + pin_write(1) = at least 2 calls for start signal */
    ASSERT(g_pin_write_calls >= 2, "pin_write called at least twice (start signal)");
}

static void test_reset_clears_io_state(void)
{
    fovet_dht22_reading_t r;
    reset_mock();
    fovet_dht22_set_io(&k_mock_io);
    fovet_dht22_reset();
    /* After reset, IO must be cleared */
    ASSERT_INT_EQ(fovet_dht22_read(&r), FOVET_DHT22_ERR_IO,
                  "after reset → ERR_IO");
}

/* =========================================================================
 * Tests — multiple successive reads
 * ========================================================================= */

static void test_two_successive_reads(void)
{
    fovet_dht22_reading_t r1, r2;
    reset_mock();
    fovet_dht22_set_io(&k_mock_io);

    setup_pulse_seq(25.0f, 60.0f);
    ASSERT_INT_EQ(fovet_dht22_read(&r1), FOVET_HAL_OK, "read 1 OK");

    setup_pulse_seq(30.0f, 70.0f);
    ASSERT_INT_EQ(fovet_dht22_read(&r2), FOVET_HAL_OK, "read 2 OK");

    ASSERT_FLOAT_EQ(r1.celsius, 25.0f, 0.1f, "read 1 celsius == 25.0");
    ASSERT_FLOAT_EQ(r2.celsius, 30.0f, 0.1f, "read 2 celsius == 30.0");
}

/* =========================================================================
 * Main
 * ========================================================================= */

int main(void)
{
    printf("=== test_dht22_hal ===\n");

    /* Constants */
    test_constants();

    /* IO guard */
    test_read_without_set_io_returns_err_io();
    test_init_without_set_io_returns_err_io();

    /* Positive temperature */
    test_read_positive_temperature();
    test_read_zero_temperature();

    /* Negative temperature */
    test_read_negative_temperature();

    /* Boundary humidity */
    test_read_humidity_zero();
    test_read_humidity_max();

    /* Boundary temperature */
    test_read_temp_min();
    test_read_temp_max();

    /* Error cases */
    test_timeout_at_handshake_low();
    test_timeout_at_handshake_high();
    test_timeout_during_bit_read();
    test_checksum_mismatch();
    test_humidity_out_of_range();
    test_temperature_out_of_range_high();

    /* Biosignal HAL integration */
    test_init_registers_temp_source();
    test_biosignal_hal_fills_source_field();
    test_biosignal_hal_fills_celsius();
    test_biosignal_hal_fills_humidity();
    test_biosignal_hal_not_registered_without_init();

    /* Pin behavior */
    test_pin_write_called_for_start_signal();
    test_reset_clears_io_state();

    /* Successive reads */
    test_two_successive_reads();

    printf("%d/%d passed\n", g_pass, g_pass + g_fail);
    return (g_fail == 0) ? 0 : 1;
}
