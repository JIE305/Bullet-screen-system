"""make real-window danmaku rules global

Revision ID: 0002_global_rules
Revises: 0001_initial
"""

from __future__ import annotations

from datetime import UTC, datetime
from uuid import uuid4

import sqlalchemy as sa
from alembic import op

revision = "0002_global_rules"
down_revision = "0001_initial"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("danmaku_rules") as batch:
        batch.alter_column(
            "profile_id",
            existing_type=sa.String(length=36),
            nullable=True,
        )

    connection = op.get_bind()
    rows = connection.execute(
        sa.text(
            """
            SELECT r.id, r.profile_id, r.match_type, r.pattern, r.template,
                   r.confidence, r.cooldown_ms, r.enabled
            FROM danmaku_rules AS r
            JOIN game_profiles AS p ON p.id = r.profile_id
            WHERE COALESCE(p.name, '') <> 'DaMu Test Scene'
              AND COALESCE(p.window_title_pattern, '') <> 'DaMu Test Scene'
            ORDER BY r.id
            """
        )
    ).mappings().all()

    survivors: dict[tuple[object, ...], str] = {}
    for row in rows:
        signature = (
            row["match_type"], row["pattern"], row["template"],
            row["confidence"], row["cooldown_ms"], row["enabled"],
        )
        survivor = survivors.get(signature)
        if survivor is None:
            survivors[signature] = row["id"]
            connection.execute(
                sa.text("UPDATE danmaku_rules SET profile_id = NULL WHERE id = :id"),
                {"id": row["id"]},
            )
            continue
        connection.execute(
            sa.text("UPDATE danmaku_messages SET rule_id = :survivor WHERE rule_id = :duplicate"),
            {"survivor": survivor, "duplicate": row["id"]},
        )
        connection.execute(
            sa.text("DELETE FROM danmaku_rules WHERE id = :id"),
            {"id": row["id"]},
        )


def downgrade() -> None:
    connection = op.get_bind()
    global_count = connection.execute(
        sa.text("SELECT COUNT(*) FROM danmaku_rules WHERE profile_id IS NULL")
    ).scalar_one()
    if global_count:
        profile_id = str(uuid4())
        now = datetime.now(UTC).isoformat()
        connection.execute(
            sa.text(
                """
                INSERT INTO game_profiles
                    (id, name, window_title_pattern, overlay_settings, created_at, updated_at)
                VALUES
                    (:id, 'Migrated Global Rules', NULL, NULL, :now, :now)
                """
            ),
            {"id": profile_id, "now": now},
        )
        connection.execute(
            sa.text("UPDATE danmaku_rules SET profile_id = :profile_id WHERE profile_id IS NULL"),
            {"profile_id": profile_id},
        )

    with op.batch_alter_table("danmaku_rules") as batch:
        batch.alter_column(
            "profile_id",
            existing_type=sa.String(length=36),
            nullable=False,
        )
