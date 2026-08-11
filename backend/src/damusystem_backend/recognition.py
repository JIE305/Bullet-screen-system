from __future__ import annotations

import asyncio
import hashlib
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from typing import Protocol

import cv2
import numpy as np


@dataclass(frozen=True, slots=True)
class RecognitionCandidate:
    text: str
    confidence: float
    box: list[list[float]] | None = None


class Recognizer(Protocol):
    name: str

    async def recognize(
        self, image: bytes, preprocess_mode: str = "original"
    ) -> list[RecognitionCandidate]: ...

    async def close(self) -> None: ...


class DummyRecognizer:
    name = "dummy"

    async def recognize(
        self, image: bytes, preprocess_mode: str = "original"
    ) -> list[RecognitionCandidate]:
        await asyncio.sleep(0.03)
        digest = hashlib.sha256(image).hexdigest()[:8]
        return [RecognitionCandidate(text=f"测试帧 / {digest}", confidence=1.0)]

    async def close(self) -> None:
        return None


def decode_and_preprocess(image: bytes, mode: str) -> np.ndarray:
    data = np.frombuffer(image, dtype=np.uint8)
    decoded = cv2.imdecode(data, cv2.IMREAD_COLOR)
    if decoded is None:
        raise ValueError("无法解码 JPEG 图像")
    if mode == "original":
        return decoded
    if mode != "high_contrast":
        raise ValueError(f"未知预处理模式：{mode}")
    gray = cv2.cvtColor(decoded, cv2.COLOR_BGR2GRAY)
    clahe = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8))
    enhanced = clahe.apply(gray)
    return cv2.cvtColor(enhanced, cv2.COLOR_GRAY2BGR)


class RapidOcrRecognizer:
    name = "rapidocr"

    def __init__(self) -> None:
        from rapidocr import RapidOCR

        self._engine = RapidOCR()
        self._executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="rapidocr")

    def _recognize_sync(self, image: bytes, mode: str) -> list[RecognitionCandidate]:
        result = self._engine(decode_and_preprocess(image, mode))
        raw_texts = getattr(result, "txts", None)
        raw_scores = getattr(result, "scores", None)
        raw_boxes = getattr(result, "boxes", None)
        texts = list(raw_texts) if raw_texts is not None else []
        scores = list(raw_scores) if raw_scores is not None else []
        boxes = list(raw_boxes) if raw_boxes is not None else []
        candidates: list[RecognitionCandidate] = []
        for index, text in enumerate(texts):
            score = float(scores[index]) if index < len(scores) else 0.0
            raw_box = boxes[index] if index < len(boxes) else None
            box = raw_box.tolist() if hasattr(raw_box, "tolist") else raw_box
            candidates.append(
                RecognitionCandidate(text=str(text), confidence=score, box=box)
            )
        return candidates

    async def recognize(
        self, image: bytes, preprocess_mode: str = "original"
    ) -> list[RecognitionCandidate]:
        loop = asyncio.get_running_loop()
        return await loop.run_in_executor(
            self._executor, self._recognize_sync, image, preprocess_mode
        )

    async def close(self) -> None:
        self._executor.shutdown(wait=False, cancel_futures=True)
