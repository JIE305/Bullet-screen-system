import asyncio
import statistics
import time

import cv2
import numpy as np

from damusystem_backend.recognition import RapidOcrRecognizer, decode_and_preprocess


def make_fixture() -> bytes:
    image = np.full((180, 720, 3), 255, dtype=np.uint8)
    cv2.putText(image, "VICTORY 2026", (20, 120), cv2.FONT_HERSHEY_SIMPLEX, 2.2, (0, 0, 0), 5, cv2.LINE_AA)
    ok, encoded = cv2.imencode(".jpg", image)
    assert ok
    return encoded.tobytes()


def test_preprocessing_modes_and_invalid_jpeg() -> None:
    fixture = make_fixture()
    assert decode_and_preprocess(fixture, "original").shape == (180, 720, 3)
    assert decode_and_preprocess(fixture, "high_contrast").shape == (180, 720, 3)
    try:
        decode_and_preprocess(b"broken", "original")
    except ValueError as error:
        assert "JPEG" in str(error)
    else:
        raise AssertionError("bad JPEG should fail")


def test_rapidocr_recognizes_stable_fixture() -> None:
    async def scenario() -> None:
        recognizer = RapidOcrRecognizer()
        try:
            candidates = await recognizer.recognize(make_fixture())
            timings = []
            for _ in range(3):
                started = time.perf_counter()
                await recognizer.recognize(make_fixture())
                timings.append(time.perf_counter() - started)
        finally:
            await recognizer.close()
        text = " ".join(candidate.text for candidate in candidates).casefold()
        assert "victory" in text
        assert "2026" in text
        assert statistics.median(timings) < 2

    asyncio.run(scenario())
