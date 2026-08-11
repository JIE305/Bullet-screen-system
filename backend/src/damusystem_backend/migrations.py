from __future__ import annotations

import sys
from pathlib import Path

from alembic import command
from alembic.config import Config


def migration_root() -> Path:
    if getattr(sys, "frozen", False):
        return Path(getattr(sys, "_MEIPASS")) / "alembic"
    return Path(__file__).resolve().parents[2] / "alembic"


def upgrade_database(database_path: Path) -> None:
    root = migration_root()
    config = Config()
    config.set_main_option("script_location", str(root))
    config.set_main_option("sqlalchemy.url", f"sqlite:///{database_path.as_posix()}")
    command.upgrade(config, "head")
