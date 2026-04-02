/*
 * Ardent SDK — Pulse
 * Copyright (C) 2026 Antoine Porte. All rights reserved.
 * LGPL v3 for non-commercial use.
 * Commercial licensing: contact@fovet.eu
 *
 * -------------------------------------------------------------------------
 * max30102_hal.c — MAX30102 driver implementation
 * -------------------------------------------------------------------------
 */

#include "ardent/hal/max30102_hal.h"
#include "ardent/hal/hal_time.h"

#include <math.h>
#include <string.h>
#include <stddef.h>

/* -------------------------------------------------------------------------
 * Register map
 * ------------------------------------------------------------------------- */

#define REG_INT_STATUS1    0x00U
#define REG_INT_STATUS2    0x01U
#define REG_FIFO_WR_PTR    0x04U
#define REG_OVF_COUNTER    0x05U
#define REG_FIFO_RD_PTR    0x06U
#define REG_FIFO_DATA      0x07U
#define REG_FIFO_CONFIG    0x08U  /* SMP_AVE | FIFO_ROLLOVER | FIFO_A_FULL */
#define REG_MODE_CONFIG    0x09U  /* SHDN | RESET | MODE[2:0]               */
#define REG_SPO2_CONFIG    0x0AU  /* ADC_RGE | SPO2_SR | LED_PW             */
#define REG_LED1_PA        0x0CU  /* RED LED pulse amplitude                */
#define REG_LED2_PA        0x0DU  /* IR  LED pulse amplitude                */
#define REG_PART_ID        0xFFU

/* REG_MODE_CONFIG values */
#define MODE_RESET         0x40U  /* software reset                         */
#define MODE_SPO2          0x03U  /* SpO2 mode: RED + IR                    */

/* REG_FIFO_CONFIG: SMP_AVE=4 (010), ROLLOVER=1, FIFO_A_FULL=15
 * → 4-sample hardware average → 100 Hz / 4 = 25 Hz output              */
#define FIFO_CFG_25HZ      0x5FU

/* REG_SPO2_CONFIG: ADC_RGE=10 (8192 nA), SPO2_SR=001 (100 Hz), LED_PW=11 (411 µs, 18-bit) */
#define SPO2_CFG           0x47U

/* LED current ~7.2 mA */
#define LED_AMPLITUDE      0x24U

/* -------------------------------------------------------------------------
 * Internal state
 * ------------------------------------------------------------------------- */

/** Peak-detection refractory period: 280 ms @ 25 Hz = 7 samples. */
#define REFRACTORY_SAMPLES  7U

/** Maximum number of peaks to collect per window. */
#define MAX_PEAKS           20U

typedef struct {
    float    ir_window[ARD_MAX30102_WINDOW_SIZE];
    float    red_window[ARD_MAX30102_WINDOW_SIZE];
    uint32_t window_head;
    uint32_t window_count;

    float    last_bpm;
    float    last_rr_ms;   /* stored in hr.rmssd */
    float    last_spo2;    /* stored in hr.spo2  */
} ard_max30102_ctx_t;

static ard_max30102_ctx_t s_ctx;
static ard_i2c_write_fn_t s_write;
static ard_i2c_read_fn_t  s_read;
static uint8_t              s_initialised;

/* -------------------------------------------------------------------------
 * BPM + SpO2 computation (called when window is full)
 * ------------------------------------------------------------------------- */

static void compute_bpm_spo2(void)
{
    uint32_t i;

    /* Build oldest-first view of the window */
    float ir[ARD_MAX30102_WINDOW_SIZE];
    float red[ARD_MAX30102_WINDOW_SIZE];

    for (i = 0; i < ARD_MAX30102_WINDOW_SIZE; i++)
    {
        uint32_t idx = (s_ctx.window_head + i) % ARD_MAX30102_WINDOW_SIZE;
        ir[i]  = s_ctx.ir_window[idx];
        red[i] = s_ctx.red_window[idx];
    }

    /* DC levels (mean) */
    float dc_ir = 0.0f, dc_red = 0.0f;
    for (i = 0; i < ARD_MAX30102_WINDOW_SIZE; i++)
    {
        dc_ir  += ir[i];
        dc_red += red[i];
    }
    dc_ir  /= (float)ARD_MAX30102_WINDOW_SIZE;
    dc_red /= (float)ARD_MAX30102_WINDOW_SIZE;

    if (dc_ir <= 0.0f || dc_red <= 0.0f)
        return;

    /* AC signals (zero-mean) + RMS for SpO2 */
    float ac_ir[ARD_MAX30102_WINDOW_SIZE];
    float rms_ir = 0.0f, rms_red = 0.0f;

    for (i = 0; i < ARD_MAX30102_WINDOW_SIZE; i++)
    {
        float air  = ir[i]  - dc_ir;
        float ared = red[i] - dc_red;
        ac_ir[i] = air;
        rms_ir  += air  * air;
        rms_red += ared * ared;
    }

    rms_ir  = sqrtf(rms_ir  / (float)ARD_MAX30102_WINDOW_SIZE);
    rms_red = sqrtf(rms_red / (float)ARD_MAX30102_WINDOW_SIZE);

    /* SpO2 — ratio of ratios */
    if (rms_ir > 0.0f)
    {
        float R = (rms_red / dc_red) / (rms_ir / dc_ir);
        float spo2 = 110.0f - 25.0f * R;
        if (spo2 < 0.0f)   spo2 = 0.0f;
        if (spo2 > 100.0f) spo2 = 100.0f;
        s_ctx.last_spo2 = spo2;
    }

    /* BPM — peak detection on AC IR signal */

    /* Adaptive threshold: 40% of peak-to-peak amplitude */
    float min_ac = ac_ir[0], max_ac = ac_ir[0];
    for (i = 1; i < ARD_MAX30102_WINDOW_SIZE; i++)
    {
        if (ac_ir[i] < min_ac) min_ac = ac_ir[i];
        if (ac_ir[i] > max_ac) max_ac = ac_ir[i];
    }

    float threshold = min_ac + 0.4f * (max_ac - min_ac);

    /* Collect peak positions (local maxima above threshold, refractory window) */
    uint32_t peak_pos[MAX_PEAKS];
    uint32_t n_peaks  = 0;
    uint32_t last_peak = 0;

    for (i = 1; i + 1 < ARD_MAX30102_WINDOW_SIZE && n_peaks < MAX_PEAKS; i++)
    {
        int above     = ac_ir[i] > threshold;
        int local_max = ac_ir[i] > ac_ir[i - 1] && ac_ir[i] > ac_ir[i + 1];
        int refractory = (n_peaks == 0) || (i - last_peak >= REFRACTORY_SAMPLES);

        if (above && local_max && refractory)
        {
            peak_pos[n_peaks++] = i;
            last_peak = i;
        }
    }

    if (n_peaks < 2U)
        return;

    /* Average RR interval in samples */
    float rr_sum = 0.0f;
    for (i = 1; i < n_peaks; i++)
        rr_sum += (float)(peak_pos[i] - peak_pos[i - 1]);

    float avg_rr_samples = rr_sum / (float)(n_peaks - 1U);

    /* Convert to ms: 1 sample = 1000 ms / ARD_MAX30102_SAMPLE_RATE */
    float rr_ms = avg_rr_samples * (1000.0f / (float)ARD_MAX30102_SAMPLE_RATE);
    float bpm   = 60000.0f / rr_ms;

    /* Clamp to physiological range [30, 220] BPM */
    if (bpm < 30.0f || bpm > 220.0f)
        return;

    s_ctx.last_rr_ms = rr_ms;
    s_ctx.last_bpm   = bpm;
}

/* -------------------------------------------------------------------------
 * ard_max30102_set_i2c
 * ------------------------------------------------------------------------- */

void ard_max30102_set_i2c(ard_i2c_write_fn_t write_fn,
                             ard_i2c_read_fn_t  read_fn)
{
    s_write = write_fn;
    s_read  = read_fn;
}

/* -------------------------------------------------------------------------
 * ard_max30102_init
 * ------------------------------------------------------------------------- */

int ard_max30102_init(void)
{
    uint8_t part_id;

    /* 1. Verify PART_ID */
    if (s_read(ARD_MAX30102_I2C_ADDR, REG_PART_ID, &part_id, 1) != 0)
        return ARD_HR_ERR_I2C;

    if (part_id != ARD_MAX30102_PART_ID)
        return ARD_HR_ERR_ID;

    /* 2. Software reset */
    if (s_write(ARD_MAX30102_I2C_ADDR, REG_MODE_CONFIG, MODE_RESET) != 0)
        return ARD_HR_ERR_I2C;

    /* 3. Configure SpO2 mode */
    if (s_write(ARD_MAX30102_I2C_ADDR, REG_FIFO_CONFIG, FIFO_CFG_25HZ)  != 0) return ARD_HR_ERR_I2C;
    if (s_write(ARD_MAX30102_I2C_ADDR, REG_MODE_CONFIG, MODE_SPO2)      != 0) return ARD_HR_ERR_I2C;
    if (s_write(ARD_MAX30102_I2C_ADDR, REG_SPO2_CONFIG, SPO2_CFG)       != 0) return ARD_HR_ERR_I2C;
    if (s_write(ARD_MAX30102_I2C_ADDR, REG_LED1_PA,     LED_AMPLITUDE)  != 0) return ARD_HR_ERR_I2C;
    if (s_write(ARD_MAX30102_I2C_ADDR, REG_LED2_PA,     LED_AMPLITUDE)  != 0) return ARD_HR_ERR_I2C;

    /* 4. Reset FIFO pointers */
    if (s_write(ARD_MAX30102_I2C_ADDR, REG_FIFO_WR_PTR, 0x00U) != 0) return ARD_HR_ERR_I2C;
    if (s_write(ARD_MAX30102_I2C_ADDR, REG_OVF_COUNTER,  0x00U) != 0) return ARD_HR_ERR_I2C;
    if (s_write(ARD_MAX30102_I2C_ADDR, REG_FIFO_RD_PTR,  0x00U) != 0) return ARD_HR_ERR_I2C;

    /* 5. Register in biosignal HAL */
    int rc = ard_hal_biosignal_register(ARD_SOURCE_HR, ard_hal_hr_read);
    if (rc != ARD_HAL_OK)
        return rc;

    s_initialised = 1U;
    return ARD_HAL_OK;
}

/* -------------------------------------------------------------------------
 * ard_hal_hr_read
 * ------------------------------------------------------------------------- */

int ard_hal_hr_read(ard_biosignal_sample_t *out)
{
    uint8_t wr_ptr, rd_ptr;
    uint8_t raw[6];

    /* Check FIFO has at least one sample */
    if (s_read(ARD_MAX30102_I2C_ADDR, REG_FIFO_WR_PTR, &wr_ptr, 1) != 0)
        return ARD_HR_ERR_I2C;
    if (s_read(ARD_MAX30102_I2C_ADDR, REG_FIFO_RD_PTR, &rd_ptr, 1) != 0)
        return ARD_HR_ERR_I2C;

    if (wr_ptr == rd_ptr)
        return ARD_HR_ERR_NODATA;

    /* Read one sample: 3 bytes RED + 3 bytes IR */
    if (s_read(ARD_MAX30102_I2C_ADDR, REG_FIFO_DATA, raw, 6) != 0)
        return ARD_HR_ERR_I2C;

    /* Advance FIFO read pointer */
    uint8_t new_rd = (uint8_t)((rd_ptr + 1U) % 32U);
    if (s_write(ARD_MAX30102_I2C_ADDR, REG_FIFO_RD_PTR, new_rd) != 0)
        return ARD_HR_ERR_I2C;

    /* Extract 18-bit values (bits [17:0] of each 3-byte word) */
    uint32_t red_raw = ((uint32_t)(raw[0] & 0x03U) << 16)
                     | ((uint32_t)raw[1] << 8)
                     |  (uint32_t)raw[2];
    uint32_t ir_raw  = ((uint32_t)(raw[3] & 0x03U) << 16)
                     | ((uint32_t)raw[4] << 8)
                     |  (uint32_t)raw[5];

    /* Accumulate into circular window */
    s_ctx.ir_window[s_ctx.window_head]  = (float)ir_raw;
    s_ctx.red_window[s_ctx.window_head] = (float)red_raw;
    s_ctx.window_head = (s_ctx.window_head + 1U) % ARD_MAX30102_WINDOW_SIZE;
    if (s_ctx.window_count < ARD_MAX30102_WINDOW_SIZE)
        s_ctx.window_count++;

    /* Window still warming up */
    if (s_ctx.window_count < ARD_MAX30102_WINDOW_SIZE)
        return ARD_HR_ERR_NODATA;

    /* Compute BPM + SpO2 */
    compute_bpm_spo2();

    if (out != NULL)
    {
        out->source       = ARD_SOURCE_HR;
        out->timestamp_ms = hal_time_ms();
        out->value.hr.bpm   = s_ctx.last_bpm;
        out->value.hr.spo2  = s_ctx.last_spo2;
        out->value.hr.rmssd = s_ctx.last_rr_ms;
    }

    return ARD_HAL_OK;
}

/* -------------------------------------------------------------------------
 * ard_max30102_get_spo2
 * ------------------------------------------------------------------------- */

float ard_max30102_get_spo2(void)
{
    return s_ctx.last_spo2;
}

/* -------------------------------------------------------------------------
 * ard_max30102_reset
 * ------------------------------------------------------------------------- */

void ard_max30102_reset(void)
{
    memset(&s_ctx, 0, sizeof(s_ctx));
    s_initialised = 0U;
}
