/*
 * Ardent SDK — Pulse
 * Copyright (C) 2026 Antoine Porte. All rights reserved.
 * LGPL v3 for non-commercial use.
 * Commercial licensing: contact@fovet.eu
 *
 * -------------------------------------------------------------------------
 * pti_profile.c — PTI profile implementation
 * -------------------------------------------------------------------------
 */

#include "ardent/profiles/pti_profile.h"
#include "ardent/hal/hal_time.h"
#include "ardent/hal/ard_biosignal_hal.h"

#include <math.h>
#include <string.h>
#include <stddef.h>

/* -------------------------------------------------------------------------
 * ard_pti_default_config
 * ------------------------------------------------------------------------- */

ard_pti_config_t ard_pti_default_config(void)
{
    ard_pti_config_t cfg;
    cfg.fall_threshold         = 0.85f;
    cfg.motion_threshold_g     = 0.1f;
    cfg.motionless_timeout_ms  = 30000U;
    cfg.sos_gpio_pin           = 0U;
    cfg.sleep_between_ticks_ms = 40U;   /* ~25 Hz */
    return cfg;
}

/* -------------------------------------------------------------------------
 * ard_pti_init
 * ------------------------------------------------------------------------- */

void ard_pti_init(ard_pti_ctx_t          *ctx,
                    const ard_pti_config_t  *cfg,
                    ard_pti_alert_fn_t       alert_fn,
                    ard_pti_fall_score_fn_t  fall_score_fn,
                    ard_pti_gpio_read_fn_t   gpio_read_fn,
                    ard_pti_sleep_fn_t       sleep_fn,
                    void                      *user_data)
{
    if (ctx == NULL)
        return;

    memset(ctx, 0, sizeof(*ctx));

    ctx->config        = (cfg != NULL) ? *cfg : ard_pti_default_config();
    ctx->alert_fn      = alert_fn;
    ctx->fall_score_fn = fall_score_fn;
    ctx->gpio_read_fn  = gpio_read_fn;
    ctx->sleep_fn      = sleep_fn;
    ctx->user_data     = user_data;

    ctx->last_motion_ms = hal_time_ms();
}

/* -------------------------------------------------------------------------
 * ard_pti_tick
 * ------------------------------------------------------------------------- */

int ard_pti_tick(ard_pti_ctx_t *ctx)
{
    ard_biosignal_sample_t sample;
    float mag;
    uint32_t now;
    int rc;

    /* 1. Read IMU */
    rc = ard_hal_biosignal_read(ARD_SOURCE_IMU, &sample);
    if (rc != ARD_HAL_OK)
        return rc;

    /* 2. Compute |a| */
    {
        float ax = sample.value.imu.ax;
        float ay = sample.value.imu.ay;
        float az = sample.value.imu.az;
        mag = sqrtf(ax * ax + ay * ay + az * az);
    }

    /* 3. Push to circular window */
    ctx->mag_window[ctx->window_head] = mag;
    ctx->window_head = (ctx->window_head + 1U) % ARD_PTI_WINDOW_SIZE;
    if (ctx->window_count < ARD_PTI_WINDOW_SIZE)
        ctx->window_count++;

    /* 4. Fall detection — only when window is full */
    if (ctx->window_count >= ARD_PTI_WINDOW_SIZE)
    {
        /* Build oldest-first view: starting at window_head (which points to
         * the oldest sample in the circular buffer when full) */
        float ordered[ARD_PTI_WINDOW_SIZE];
        uint32_t i;
        for (i = 0; i < ARD_PTI_WINDOW_SIZE; i++)
        {
            uint32_t idx = (ctx->window_head + i) % ARD_PTI_WINDOW_SIZE;
            ordered[i] = ctx->mag_window[idx];
        }

        float score = ctx->fall_score_fn(ordered, ARD_PTI_WINDOW_SIZE);

        if (score > ctx->config.fall_threshold)
        {
            ctx->alert_fn(ARD_ALERT_FALL, ctx->user_data);
        }
    }

    /* 5. Immobility detection */
    now = hal_time_ms();

    if (mag < ctx->config.motion_threshold_g)
    {
        uint32_t elapsed = now - ctx->last_motion_ms;
        if (elapsed >= ctx->config.motionless_timeout_ms &&
            !ctx->motionless_alert_sent)
        {
            ctx->motionless_alert_sent = 1U;
            ctx->alert_fn(ARD_ALERT_MOTIONLESS, ctx->user_data);
        }
    }
    else
    {
        ctx->last_motion_ms       = now;
        ctx->motionless_alert_sent = 0U;
    }

    /* 6. SOS button (active-low) */
    if (ctx->gpio_read_fn(ctx->config.sos_gpio_pin) == 0)
    {
        if (!ctx->sos_alert_sent)
        {
            ctx->sos_alert_sent = 1U;
            ctx->alert_fn(ARD_ALERT_SOS, ctx->user_data);
        }
    }
    else
    {
        ctx->sos_alert_sent = 0U; /* reset when button released */
    }

    /* 7. Optional sleep */
    if (ctx->sleep_fn != NULL)
        ctx->sleep_fn(ctx->config.sleep_between_ticks_ms);

    return ARD_HAL_OK;
}

/* -------------------------------------------------------------------------
 * ard_pti_reset_alerts
 * ------------------------------------------------------------------------- */

void ard_pti_reset_alerts(ard_pti_ctx_t *ctx)
{
    if (ctx == NULL)
        return;
    ctx->motionless_alert_sent = 0U;
    ctx->sos_alert_sent        = 0U;
}
