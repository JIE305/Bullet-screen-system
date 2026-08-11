"""add game context and seed editable global rules

Revision ID: 0003_game_context_defaults
Revises: 0002_global_rules
"""

from __future__ import annotations

import unicodedata

import sqlalchemy as sa
from alembic import op

revision = "0003_game_context_defaults"
down_revision = "0002_global_rules"
branch_labels = None
depends_on = None


DEFAULT_RULES = (
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


def _normalized(value: str) -> str:
    return " ".join(unicodedata.normalize("NFKC", value).strip().split()).casefold()


def upgrade() -> None:
    connection = op.get_bind()
    profile_columns = {
        column["name"] for column in sa.inspect(connection).get_columns("game_profiles")
    }
    if "game_name" not in profile_columns:
        with op.batch_alter_table("game_profiles") as batch:
            batch.add_column(sa.Column("game_name", sa.String(length=120), nullable=True))
    existing_rows = connection.execute(
        sa.text(
            "SELECT match_type, pattern FROM danmaku_rules WHERE profile_id IS NULL"
        )
    ).mappings().all()
    existing = {
        (str(row["match_type"]), _normalized(str(row["pattern"])))
        for row in existing_rows
    }
    max_priority = connection.execute(
        sa.text(
            "SELECT COALESCE(MAX(priority), -1) FROM danmaku_rules WHERE profile_id IS NULL"
        )
    ).scalar_one()
    priority = int(max_priority) + 1
    for rule_id, pattern, template in DEFAULT_RULES:
        key = ("contains", _normalized(pattern))
        if key in existing:
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
                "priority": priority,
            },
        )
        existing.add(key)
        priority += 1


def downgrade() -> None:
    connection = op.get_bind()
    connection.execute(
        sa.text(
            "DELETE FROM danmaku_rules WHERE id IN ("
            + ",".join(f"'{rule_id}'" for rule_id, _, _ in DEFAULT_RULES)
            + ")"
        )
    )
    profile_columns = {
        column["name"] for column in sa.inspect(connection).get_columns("game_profiles")
    }
    if "game_name" in profile_columns:
        with op.batch_alter_table("game_profiles") as batch:
            batch.drop_column("game_name")
