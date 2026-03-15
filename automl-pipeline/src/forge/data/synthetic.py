"""
Synthetic signal generator — produces labelled datasets for demos and tests.

Supported signals:
  - sine:        A * sin(2π * f * t) + noise
  - random_walk: cumulative Gaussian steps
  - constant:    fixed baseline + noise

Anomalies are injected at random positions by adding a spike of
`anomaly_magnitude * signal_std` to the signal.
"""

from __future__ import annotations

import numpy as np

from forge.config import SyntheticDataConfig
from forge.data.base import Dataset


def generate(config: SyntheticDataConfig) -> Dataset:
    """Generate a synthetic labelled dataset from a SyntheticDataConfig."""
    rng = np.random.default_rng(config.seed)
    n = config.n_samples
    n_features = len(config.columns)

    # --- Base signal --------------------------------------------------------
    t = np.linspace(0, 1, n)
    if config.signal == "sine":
        base = np.sin(2 * np.pi * config.frequency * t)
    elif config.signal == "random_walk":
        steps = rng.standard_normal((n, n_features))
        base = np.cumsum(steps, axis=0).mean(axis=1)
    else:  # constant
        base = np.zeros(n)

    # Broadcast to (n, n_features) and add noise
    signal = np.tile(base[:, None], (1, n_features))
    signal += rng.normal(0, config.noise_std, size=(n, n_features))

    # --- Anomaly injection --------------------------------------------------
    labels = np.zeros(n, dtype=np.int8)
    n_anomalies = int(n * config.anomaly_rate)
    if n_anomalies > 0:
        signal_std = float(signal.std()) or 1.0
        spike = config.anomaly_magnitude * signal_std
        anomaly_indices = rng.choice(n, size=n_anomalies, replace=False)
        for idx in anomaly_indices:
            direction = rng.choice([-1, 1])
            signal[idx] += direction * spike
            labels[idx] = 1

    return Dataset(
        samples=signal.astype(np.float32),
        columns=list(config.columns),
        labels=labels,
    )
