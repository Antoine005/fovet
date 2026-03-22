"""
Fovet Forge — convert.py

Converts a trained Keras/TF model to TFLite optimised for MCU deployment.

Features:
  - float32 or INT8 full-quantisation
  - Tensor arena size estimation (validates < 200 KB for ESP32-CAM)
  - JSON compatibility report

Usage (CLI):
    forge convert --model model.h5 --output model.tflite [--quantization int8]
    forge convert --model model.h5 --quantization int8 --calibration calib.npy

Usage (module):
    from forge.convert import convert_keras_to_tflite, ConvertResult
    result = convert_keras_to_tflite(Path("model.h5"), Path("model.tflite"))
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np

# Maximum recommended tensor arena for ESP32-CAM (conservative, leaves room for stack)
ESP32_MAX_ARENA_BYTES: int = 200 * 1024

# Overhead added by TFLite Micro runtime bookkeeping beyond raw tensor buffers
_TFLITE_MICRO_OVERHEAD_BYTES: int = 8 * 1024


@dataclass
class ConvertResult:
    """Result returned by convert_keras_to_tflite()."""

    tflite_path: Path
    report_path: Path
    model_size_bytes: int
    arena_estimate_bytes: int
    fits_esp32: bool
    quantization: str
    warnings: list[str] = field(default_factory=list)

    @property
    def model_size_kb(self) -> float:
        return round(self.model_size_bytes / 1024, 1)

    @property
    def arena_estimate_kb(self) -> float:
        return round(self.arena_estimate_bytes / 1024, 1)


def convert_keras_to_tflite(
    model_path: Path,
    output_path: Path,
    quantization: str = "float32",
    calibration_data: np.ndarray | None = None,
    calibration_samples: int = 100,
) -> ConvertResult:
    """Convert a Keras model to a TFLite flatbuffer optimised for ESP32.

    Args:
        model_path:          Path to Keras model (.h5 file or SavedModel directory).
        output_path:         Destination .tflite path. Parent directory is created.
        quantization:        ``"float32"`` (default) or ``"int8"`` (full INT8).
        calibration_data:    Representative samples for INT8 calibration.
                             Shape ``(n_samples, *input_shape)``, float32.
                             If *None* and quantization is ``"int8"``,
                             synthetic Gaussian data is generated.
        calibration_samples: Number of synthetic samples when no calibration
                             data is provided. Ignored for float32.

    Returns:
        :class:`ConvertResult` with file paths and compatibility info.

    Raises:
        ImportError:       If tensorflow is not installed.
        FileNotFoundError: If *model_path* does not exist.
        ValueError:        If *quantization* is not ``"float32"`` or ``"int8"``.
    """
    try:
        import tensorflow as tf  # noqa: PLC0415
    except ImportError as exc:
        raise ImportError(
            "tensorflow is required for model conversion. "
            "Install with: uv sync --extra ml"
        ) from exc

    if not model_path.exists():
        raise FileNotFoundError(f"Model not found: {model_path}")

    if quantization not in ("float32", "int8"):
        raise ValueError(f"quantization must be 'float32' or 'int8', got {quantization!r}")

    # ------------------------------------------------------------------
    # Load model
    # ------------------------------------------------------------------
    model = tf.keras.models.load_model(str(model_path))
    input_shape = tuple(model.input_shape[1:])  # remove batch dim

    # ------------------------------------------------------------------
    # Build TFLite converter
    # ------------------------------------------------------------------
    converter = tf.lite.TFLiteConverter.from_keras_model(model)

    if quantization == "int8":
        converter.optimizations = [tf.lite.Optimize.DEFAULT]

        # Build calibration array
        if calibration_data is None:
            rng = np.random.default_rng(42)
            calibration_data = rng.standard_normal(
                (calibration_samples, *input_shape)
            ).astype(np.float32)

        calib = calibration_data.astype(np.float32)

        def representative_dataset():  # type: ignore[return]
            for sample in calib:
                yield [sample.reshape(1, *input_shape)]

        converter.representative_dataset = representative_dataset
        converter.target_spec.supported_ops = [tf.lite.OpsSet.TFLITE_BUILTINS_INT8]
        converter.inference_input_type = tf.int8
        converter.inference_output_type = tf.int8

    tflite_bytes = converter.convert()

    # ------------------------------------------------------------------
    # Write .tflite
    # ------------------------------------------------------------------
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_bytes(tflite_bytes)

    # ------------------------------------------------------------------
    # Estimate tensor arena
    # ------------------------------------------------------------------
    arena_bytes = _estimate_arena(tflite_bytes)
    model_size = len(tflite_bytes)
    fits = arena_bytes <= ESP32_MAX_ARENA_BYTES

    warnings: list[str] = []
    if not fits:
        warnings.append(
            f"Tensor arena estimate ({arena_bytes // 1024} KB) exceeds the "
            f"recommended ESP32-CAM limit ({ESP32_MAX_ARENA_BYTES // 1024} KB). "
            "Consider reducing model size or switching to INT8 quantization."
        )
    if model_size > 1_000_000:
        warnings.append(
            f"Model file size ({model_size // 1024} KB) is large for flash storage. "
            "Ensure your PlatformIO partition table reserves enough flash."
        )

    # ------------------------------------------------------------------
    # Write JSON compatibility report
    # ------------------------------------------------------------------
    report = {
        "model_path": str(model_path),
        "tflite_path": str(output_path),
        "quantization": quantization,
        "model_size_bytes": model_size,
        "model_size_kb": round(model_size / 1024, 1),
        "tensor_arena_estimate_bytes": arena_bytes,
        "tensor_arena_estimate_kb": round(arena_bytes / 1024, 1),
        "esp32_max_arena_bytes": ESP32_MAX_ARENA_BYTES,
        "esp32_max_arena_kb": ESP32_MAX_ARENA_BYTES // 1024,
        "fits_esp32_arena": fits,
        "input_shape": list(input_shape),
        "warnings": warnings,
    }
    report_path = output_path.with_suffix(".compat.json")
    report_path.write_text(json.dumps(report, indent=2), encoding="utf-8")

    return ConvertResult(
        tflite_path=output_path,
        report_path=report_path,
        model_size_bytes=model_size,
        arena_estimate_bytes=arena_bytes,
        fits_esp32=fits,
        quantization=quantization,
        warnings=warnings,
    )


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------

def _estimate_arena(tflite_bytes: bytes) -> int:
    """Estimate the tensor arena requirement by running the TFLite interpreter.

    Allocates tensors and sums all tensor buffer sizes as a lower bound, then
    adds :data:`_TFLITE_MICRO_OVERHEAD_BYTES` for runtime bookkeeping.
    """
    try:
        import tensorflow as tf  # noqa: PLC0415
    except ImportError:
        return 0

    interpreter = tf.lite.Interpreter(model_content=tflite_bytes)
    interpreter.allocate_tensors()

    total = 0
    for tensor_detail in interpreter.get_tensor_details():
        shape = tensor_detail["shape"]
        dtype = tensor_detail["dtype"]
        if len(shape) > 0:
            total += int(np.prod(shape)) * np.dtype(dtype).itemsize

    return total + _TFLITE_MICRO_OVERHEAD_BYTES


# ---------------------------------------------------------------------------
# Standalone entry point
# ---------------------------------------------------------------------------

def _main() -> None:
    import argparse

    parser = argparse.ArgumentParser(
        description="Fovet Forge — convert a Keras model to TFLite for ESP32."
    )
    parser.add_argument("--model", "-m", required=True, help="Path to Keras model (.h5 or SavedModel)")
    parser.add_argument("--output", "-o", help="Output .tflite path (default: <model>.tflite)")
    parser.add_argument(
        "--quantization", "-q",
        choices=["float32", "int8"],
        default="float32",
        help="Quantization mode (default: float32)",
    )
    parser.add_argument(
        "--calibration",
        help="Path to .npy calibration data for INT8 (n_samples × *input_shape)",
    )
    args = parser.parse_args()

    model_path = Path(args.model)
    output_path = Path(args.output) if args.output else model_path.with_suffix(".tflite")

    calib_data: np.ndarray | None = None
    if args.calibration:
        calib_data = np.load(args.calibration).astype(np.float32)

    try:
        result = convert_keras_to_tflite(
            model_path, output_path,
            quantization=args.quantization,
            calibration_data=calib_data,
        )
    except (ImportError, FileNotFoundError, ValueError) as exc:
        print(f"Error: {exc}", flush=True)
        raise SystemExit(1) from exc

    print(f"TFLite model : {result.tflite_path}  ({result.model_size_kb} KB)")
    print(f"Arena estimate: {result.arena_estimate_kb} KB  "
          f"({'OK' if result.fits_esp32 else 'TOO LARGE'} — limit {ESP32_MAX_ARENA_BYTES // 1024} KB)")
    print(f"Report       : {result.report_path}")
    for w in result.warnings:
        print(f"WARNING: {w}")


if __name__ == "__main__":
    _main()
