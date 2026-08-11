from uuid import uuid4

from damusystem_backend.contracts import DanmakuRule
from damusystem_backend.recognition import RecognitionCandidate
from damusystem_backend.rules import RuleEngine, normalize_text


def test_normalize_text_uses_nfkc_whitespace_and_casefold() -> None:
    assert normalize_text("  ＶＩＣＴＯＲＹ\n  2026  ") == "victory 2026"


def test_confidence_contains_exact_dedupe_and_cooldown() -> None:
    contains = DanmakuRule(
        id=uuid4(),
        match_type="contains",
        pattern="victory",
        template="命中：{text}",
        confidence=0.65,
        cooldown_ms=5000,
    )
    exact = DanmakuRule(
        id=uuid4(),
        match_type="exact",
        pattern="victory 2026",
        template="精确：{text}",
        confidence=0.8,
        cooldown_ms=5000,
    )
    engine = RuleEngine([contains, exact], dedupe_seconds=3)
    assert engine.accept("r1", RecognitionCandidate("VICTORY", 0.5), now=0) is None
    accepted = engine.accept("r1", RecognitionCandidate("Victory 2026", 0.9), now=1)
    assert accepted is not None
    assert accepted.normalized_text == "victory 2026"
    assert accepted.status == "emitted"
    assert accepted.matched_rule_count == 2
    assert [message.text for message in accepted.messages] == ["命中：Victory 2026", "精确：Victory 2026"]
    assert engine.accept("r1", RecognitionCandidate("Victory 2026", 0.9), now=2) is None
    after_dedupe = engine.accept("r1", RecognitionCandidate("Victory 2026", 0.9), now=4.1)
    assert after_dedupe is not None
    assert after_dedupe.status == "cooldown"
    assert after_dedupe.messages == []
    after_cooldown = engine.accept("r1", RecognitionCandidate("Victory 2026", 0.9), now=7.2)
    assert after_cooldown is not None
    assert after_cooldown.status == "emitted"
    assert len(after_cooldown.messages) == 2


def test_rule_evaluation_explains_no_rule_and_keyword_mismatch() -> None:
    no_rule = RuleEngine([]).accept("r1", RecognitionCandidate("胜利", 0.99996), now=1)
    assert no_rule is not None
    assert no_rule.status == "no_rule"
    assert no_rule.checks == []
    assert no_rule.messages == []

    test_rule = DanmakuRule(
        id=uuid4(),
        match_type="contains",
        pattern="测试",
        template="识别到：{text}",
        confidence=0.65,
        cooldown_ms=5000,
    )
    mismatch = RuleEngine([test_rule]).accept(
        "r1", RecognitionCandidate("胜利", 0.99996), now=1
    )
    assert mismatch is not None
    assert mismatch.status == "not_matched"
    assert mismatch.matched_rule_count == 0
    assert mismatch.checks[0].pattern == "测试"


def test_victory_contains_and_exact_rules_emit_expected_text() -> None:
    rules = [
        DanmakuRule(match_type="contains", pattern="胜利", template="{text}"),
        DanmakuRule(match_type="exact", pattern="胜利", template="确认：{text}"),
    ]
    accepted = RuleEngine(rules).accept(
        "r1", RecognitionCandidate("胜利", 0.99996), now=1
    )
    assert accepted is not None
    assert accepted.status == "emitted"
    assert [message.text for message in accepted.messages] == ["胜利", "确认：胜利"]
