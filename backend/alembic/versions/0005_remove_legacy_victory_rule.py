"""remove the legacy default victory rule

Revision ID: 0005_remove_legacy_victory_rule
Revises: 0004_empty_initial_global_rules
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0005_remove_legacy_victory_rule"
down_revision = "0004_empty_initial_global_rules"
branch_labels = None
depends_on = None


LEGACY_RULE_FILTER = """
    profile_id IS NULL
    AND match_type = 'contains'
    AND pattern = '胜利'
    AND template = '{text}，太强了'
    AND ABS(confidence - 0.65) < 0.000001
    AND cooldown_ms = 5000
"""


def upgrade() -> None:
    connection = op.get_bind()
    # Do this explicitly because SQLite foreign-key enforcement is connection
    # local and may not be enabled on Alembic's migration connection.
    connection.execute(
        sa.text(
            "UPDATE danmaku_messages SET rule_id = NULL WHERE rule_id IN "
            f"(SELECT id FROM danmaku_rules WHERE {LEGACY_RULE_FILTER})"
        )
    )
    connection.execute(
        sa.text(f"DELETE FROM danmaku_rules WHERE {LEGACY_RULE_FILTER}")
    )


def downgrade() -> None:
    # Removed configuration cannot be reconstructed safely. A downgrade must
    # not reintroduce the legacy keyword that this migration intentionally clears.
    pass
