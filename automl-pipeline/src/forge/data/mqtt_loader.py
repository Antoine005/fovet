"""
MQTT batch data collector — Forge data source.

Connects to a broker, subscribes to the configured topic,
collects readings for ``duration_seconds``, then returns a Dataset.

Requires extra: uv sync --extra mqtt
"""

from __future__ import annotations

import json
import threading
import time
from typing import TYPE_CHECKING

import numpy as np

from forge.data.base import Dataset

if TYPE_CHECKING:
    from forge.config import MqttDataConfig


def _load_paho() -> object:
    """Import paho.mqtt.client lazily. Extracted for testability."""
    try:
        import paho.mqtt.client as paho_client
        return paho_client
    except ImportError as exc:
        raise ImportError(
            "paho-mqtt is required for MQTT data collection.\n"
            "Install it with: uv sync --extra mqtt"
        ) from exc


def load(config: "MqttDataConfig") -> Dataset:
    """
    Connect to MQTT, subscribe, collect for ``config.duration_seconds``,
    return a :class:`Dataset`.

    The broker must publish JSON objects on ``config.topic``.
    Each message must contain all keys listed in ``config.columns``.
    Messages missing any required column are skipped with a warning.

    Raises:
        ImportError: if ``paho-mqtt`` is not installed (uv sync --extra mqtt).
        RuntimeError: if no messages are received within the collection window.
    """
    paho = _load_paho()

    rows: list[list[float]] = []
    timestamps: list[float] = []
    lock = threading.Lock()
    connected = threading.Event()

    def on_connect(client: paho.Client, _userdata: object, _flags: dict, rc: int, _props: object = None) -> None:
        if rc == 0:
            client.subscribe(config.topic, qos=1)
            connected.set()
        else:
            raise RuntimeError(f"MQTT connection refused (rc={rc})")

    def on_message(_client: paho.Client, _userdata: object, msg: paho.MQTTMessage) -> None:
        try:
            payload = json.loads(msg.payload.decode())
        except (json.JSONDecodeError, UnicodeDecodeError):
            return

        # Extract exactly the requested columns in order
        try:
            row = [float(payload[col]) for col in config.columns]
        except (KeyError, TypeError, ValueError):
            return  # skip malformed messages silently

        with lock:
            rows.append(row)
            timestamps.append(time.time())

    client = paho.Client(
        paho.CallbackAPIVersion.VERSION2,
        client_id=f"fovet-forge-collector-{int(time.time())}",
        clean_session=True,
    )
    client.on_connect = on_connect
    client.on_message = on_message

    if config.username:
        client.username_pw_set(config.username, config.password)

    client.connect(config.broker, config.port, keepalive=60)
    client.loop_start()

    if not connected.wait(timeout=10):
        client.loop_stop()
        raise RuntimeError(
            f"Could not connect to MQTT broker {config.broker}:{config.port} within 10s"
        )

    print(
        f"[Forge/MQTT] Connected to {config.broker}:{config.port}, "
        f"collecting for {config.duration_seconds}s …"
    )
    time.sleep(config.duration_seconds)
    client.loop_stop()
    client.disconnect()

    with lock:
        n = len(rows)

    if n == 0:
        raise RuntimeError(
            f"No messages received on topic '{config.topic}' "
            f"within {config.duration_seconds}s. "
            "Check broker address, credentials, and topic."
        )

    print(f"[Forge/MQTT] Collected {n} samples on columns {config.columns}")

    samples = np.array(rows, dtype=np.float64)
    return Dataset(
        samples=samples,
        columns=list(config.columns),
        timestamps=np.array(timestamps),
    )
