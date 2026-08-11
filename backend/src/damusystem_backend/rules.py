from __future__ import annotations

import time
import unicodedata
from dataclasses import dataclass
from typing import Literal

from .contracts import DanmakuRule
from .recognition import RecognitionCandidate


def normalize_text(value: str) -> str:
    normalized = unicodedata.normalize("NFKC", value)
    return " ".join(normalized.strip().split()).casefold()


@dataclass(frozen=True, slots=True)
class GeneratedDanmaku:
    rule_id: str
    text: str


RuleDecision = Literal["no_rule", "not_matched", "cooldown", "emitted"]


@dataclass(frozen=True, slots=True)
class RuleCheck:
    rule_id: str
    match_type: str
    pattern: str
    status: Literal["not_matched", "below_confidence", "cooldown", "emitted"]


@dataclass(frozen=True, slots=True)
class RuleEvaluation:
    normalized_text: str
    messages: list[GeneratedDanmaku]
    status: RuleDecision
    checks: list[RuleCheck]

    @property
    def matched_rule_count(self) -> int:
        return sum(check.status in {"cooldown", "emitted"} for check in self.checks)


class RuleEngine:
    def __init__(
        self,
        rules: list[DanmakuRule],
        dedupe_seconds: float = 3.0,
    ) -> None:
        self._rules = [rule for rule in rules if rule.enabled]
        self._dedupe_seconds = dedupe_seconds
        self._last_seen: dict[tuple[str, str], float] = {}
        self._last_emitted: dict[tuple[str, str], float] = {}

    @property
    def minimum_confidence(self) -> float:
        return min((rule.confidence for rule in self._rules), default=0.65)

    def accept(
        self,
        region_id: str,
        candidate: RecognitionCandidate,
        now: float | None = None,
    ) -> RuleEvaluation | None:
        if candidate.confidence < self.minimum_confidence:
            return None
        normalized = normalize_text(candidate.text)
        if not normalized:
            return None
        current = time.monotonic() if now is None else now
        dedupe_key = (region_id, normalized)
        previous = self._last_seen.get(dedupe_key)
        if previous is not None and current - previous < self._dedupe_seconds:
            return None
        self._last_seen[dedupe_key] = current

        generated: list[GeneratedDanmaku] = []
        checks: list[RuleCheck] = []
        for rule in self._rules:
            pattern = normalize_text(rule.pattern)
            matched = (
                normalized == pattern
                if rule.match_type == "exact"
                else pattern in normalized
            )
            if not matched:
                checks.append(RuleCheck(str(rule.id), rule.match_type, rule.pattern, "not_matched"))
                continue
            if candidate.confidence < rule.confidence:
                checks.append(RuleCheck(str(rule.id), rule.match_type, rule.pattern, "below_confidence"))
                continue
            cooldown_key = (str(rule.id), normalized)
            last_emitted = self._last_emitted.get(cooldown_key)
            if last_emitted is not None and current - last_emitted < rule.cooldown_ms / 1000:
                checks.append(RuleCheck(str(rule.id), rule.match_type, rule.pattern, "cooldown"))
                continue
            self._last_emitted[cooldown_key] = current
            checks.append(RuleCheck(str(rule.id), rule.match_type, rule.pattern, "emitted"))
            generated.append(
                GeneratedDanmaku(
                    rule_id=str(rule.id),
                    text=rule.template.replace("{text}", candidate.text.strip()),
                )
            )
        status: RuleDecision
        if not self._rules:
            status = "no_rule"
        elif generated:
            status = "emitted"
        elif any(check.status == "cooldown" for check in checks):
            status = "cooldown"
        else:
            status = "not_matched"
        return RuleEvaluation(normalized, generated, status, checks)
