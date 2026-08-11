"""remove seeded global rules so the initial rule list is empty

Revision ID: 0004_empty_initial_global_rules
Revises: 0003_game_context_defaults
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0004_empty_initial_global_rules"
down_revision = "0003_game_context_defaults"
branch_labels = None
depends_on = None


SEEDED_RULES = (
    ("31000000-0000-4000-8000-000000000001", "胜利", "拿下了！{text}"),
    ("31000000-0000-4000-8000-000000000002", "VICTORY", "拿下了！{text}"),
    ("31000000-0000-4000-8000-000000000003", "失败", "可惜了，{text}，下局再来！"),
    ("31000000-0000-4000-8000-000000000004", "DEFEAT", "可惜了，{text}，下局再来！"),
    ("31000000-0000-4000-8000-000000000005", "击杀", "漂亮击杀！{text}"),
    ("31000000-0000-4000-8000-000000000006", "KILL", "漂亮击杀！{text}"),
    ("31000000-0000-4000-8000-000000000007", "阵亡", "稳住，{text}，下一波打回来！"),
    ("31000000-0000-4000-8000-000000000008", "SLAIN", "稳住，{text}，下一波打回来！"),
    ("31000000-0000-4000-8000-000000000009", "助攻", "团队配合拉满！{text}"),
    ("31000000-0000-4000-8000-000000000010", "ASSIST", "团队配合拉满！{text}"),
    ("31000000-0000-4000-8000-000000000011", "MVP", "实至名归！{text}"),
    ("31000000-0000-4000-8000-000000000012", "GAME OVER", "{text}，这一局打完了！"),
)


def upgrade() -> None:
    connection = op.get_bind()
    connection.execute(
        sa.text(
            "DELETE FROM danmaku_rules WHERE profile_id IS NULL AND id IN ("
            + ",".join(f"'{rule_id}'" for rule_id, _, _ in SEEDED_RULES)
            + ")"
        )
    )


def downgrade() -> None:
    connection = op.get_bind()
    max_priority = int(
        connection.execute(
            sa.text(
                "SELECT COALESCE(MAX(priority), -1) FROM danmaku_rules "
                "WHERE profile_id IS NULL"
            )
        ).scalar_one()
    )
    for offset, (rule_id, pattern, template) in enumerate(SEEDED_RULES, start=1):
        exists = connection.execute(
            sa.text("SELECT 1 FROM danmaku_rules WHERE id = :id"), {"id": rule_id}
        ).first()
        if exists:
            continue
        connection.execute(
            sa.text(
                """
                INSERT INTO danmaku_rules
                    (id, profile_id, match_type, pattern, template, confidence,
                     cooldown_ms, priority, enabled)
                VALUES
                    (:id, NULL, 'contains', :pattern, :template, 0.65, 5000,
                     :priority, 1)
                """
            ),
            {
                "id": rule_id,
                "pattern": pattern,
                "template": template,
                "priority": max_priority + offset,
            },
        )
