"""
Tests for the MQTT batch data collector.

All tests mock paho.mqtt.client — no real broker needed.
"""

from __future__ import annotations

import json
import threading
import time
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import numpy as np
import pytest

from forge.config import MqttDataConfig
from forge.data import mqtt_loader


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def make_config(**kwargs) -> MqttDataConfig:
    defaults = dict(
        source="mqtt",
        broker="localhost",
        port=1883,
        topic="fovet/devices/+/readings",
        columns=["value", "mean"],
        duration_seconds=1,
    )
    defaults.update(kwargs)
    return MqttDataConfig(**defaults)


def fake_mqtt_message(payload_dict: dict) -> SimpleNamespace:
    msg = SimpleNamespace()
    msg.payload = json.dumps(payload_dict).encode()
    return msg


def _make_paho_mock(mock_class: MagicMock) -> MagicMock:
    """Return a mock paho module with Client=mock_class."""
    return MagicMock(
        Client=mock_class,
        CallbackAPIVersion=MagicMock(VERSION2=2),
    )


def _make_mock_client(messages: list[dict], connect_rc: int = 0) -> MagicMock:
    """Return a mock paho Client instance that fires callbacks synchronously."""
    mock_client_instance = MagicMock()

    def fake_loop_start():
        on_connect = mock_client_instance.on_connect
        on_connect(mock_client_instance, None, {}, connect_rc)
        for payload in messages:
            msg = fake_mqtt_message(payload)
            mock_client_instance.on_message(mock_client_instance, None, msg)

    mock_client_instance.loop_start.side_effect = fake_loop_start
    return mock_client_instance


# ---------------------------------------------------------------------------
# Test cases
# ---------------------------------------------------------------------------

class TestMqttLoaderImportError:
    def test_raises_import_error_when_paho_missing(self):
        def raise_import_error():
            raise ImportError("paho-mqtt is required for MQTT data collection.")

        with patch("forge.data.mqtt_loader._load_paho", side_effect=raise_import_error):
            with pytest.raises(ImportError, match="paho-mqtt"):
                mqtt_loader.load(make_config())


class TestMqttLoaderBehavior:
    """Tests that mock paho.mqtt.client to avoid a real broker."""

    @patch("forge.data.mqtt_loader.time.sleep")
    def test_returns_dataset_with_correct_shape(self, mock_sleep):
        mock_class = MagicMock()
        msgs = [{"value": 1.0, "mean": 0.5}, {"value": 2.0, "mean": 0.6}]
        mock_class.return_value = _make_mock_client(msgs)

        with patch("forge.data.mqtt_loader._load_paho", return_value=_make_paho_mock(mock_class)):
            cfg = make_config(columns=["value", "mean"])
            ds = mqtt_loader.load(cfg)

        assert ds.samples.shape == (2, 2)
        assert ds.columns == ["value", "mean"]
        assert len(ds.timestamps) == 2

    @patch("forge.data.mqtt_loader.time.sleep")
    def test_correct_column_order(self, mock_sleep):
        mock_class = MagicMock()
        msgs = [{"mean": 0.5, "value": 1.0, "zScore": 2.0}]  # extra field ignored
        mock_class.return_value = _make_mock_client(msgs)

        with patch("forge.data.mqtt_loader._load_paho", return_value=_make_paho_mock(mock_class)):
            cfg = make_config(columns=["value", "mean"])
            ds = mqtt_loader.load(cfg)

        # Columns must be in config order, not message key order
        assert ds.samples[0, 0] == pytest.approx(1.0)  # value
        assert ds.samples[0, 1] == pytest.approx(0.5)  # mean

    @patch("forge.data.mqtt_loader.time.sleep")
    def test_skips_malformed_messages(self, mock_sleep):
        mock_class = MagicMock()
        msgs = [
            {"value": 1.0},                     # missing "mean" → skipped
            {"value": "not_a_number", "mean": 0.5},  # non-numeric → skipped
            {"value": 2.0, "mean": 0.7},        # valid
        ]
        mock_class.return_value = _make_mock_client(msgs)

        with patch("forge.data.mqtt_loader._load_paho", return_value=_make_paho_mock(mock_class)):
            ds = mqtt_loader.load(make_config())

        assert ds.samples.shape == (1, 2)

    @patch("forge.data.mqtt_loader.time.sleep")
    def test_raises_when_no_messages_received(self, mock_sleep):
        mock_class = MagicMock()
        mock_class.return_value = _make_mock_client([])  # zero messages

        with patch("forge.data.mqtt_loader._load_paho", return_value=_make_paho_mock(mock_class)):
            with pytest.raises(RuntimeError, match="No messages received"):
                mqtt_loader.load(make_config())

    def test_raises_on_connection_timeout(self):
        mock_class = MagicMock()
        instance = MagicMock()
        # loop_start does NOT call on_connect → connected event never set
        instance.loop_start.return_value = None
        mock_class.return_value = instance

        with patch("forge.data.mqtt_loader._load_paho", return_value=_make_paho_mock(mock_class)):
            with patch("forge.data.mqtt_loader.threading.Event") as mock_event_class:
                mock_event = MagicMock()
                mock_event.wait.return_value = False  # timeout
                mock_event_class.return_value = mock_event

                with pytest.raises(RuntimeError, match="Could not connect"):
                    mqtt_loader.load(make_config())

    @patch("forge.data.mqtt_loader.time.sleep")
    def test_credentials_passed_to_client(self, mock_sleep):
        mock_class = MagicMock()
        instance = _make_mock_client([{"value": 1.0, "mean": 0.5}])
        mock_class.return_value = instance

        with patch("forge.data.mqtt_loader._load_paho", return_value=_make_paho_mock(mock_class)):
            mqtt_loader.load(make_config(username="user", password="pass"))

        instance.username_pw_set.assert_called_once_with("user", "pass")

    @patch("forge.data.mqtt_loader.time.sleep")
    def test_no_credentials_when_username_none(self, mock_sleep):
        mock_class = MagicMock()
        instance = _make_mock_client([{"value": 1.0, "mean": 0.5}])
        mock_class.return_value = instance

        with patch("forge.data.mqtt_loader._load_paho", return_value=_make_paho_mock(mock_class)):
            mqtt_loader.load(make_config(username=None))

        instance.username_pw_set.assert_not_called()


class TestLoaderRouting:
    """Verify that loader.py dispatches to mqtt_loader for source=mqtt."""

    @patch("forge.data.mqtt_loader.time.sleep")
    def test_load_data_dispatches_to_mqtt(self, mock_sleep):
        from forge.data.loader import load_data

        mock_class = MagicMock()
        msgs = [{"value": 5.0, "mean": 1.0}]
        mock_class.return_value = _make_mock_client(msgs)

        with patch("forge.data.mqtt_loader._load_paho", return_value=_make_paho_mock(mock_class)):
            cfg = make_config()
            ds = load_data(cfg)

        assert ds.samples.shape[1] == 2
