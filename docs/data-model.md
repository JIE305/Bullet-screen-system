# SQLite 数据模型（已实现）

数据库由 SQLAlchemy 2.0 管理，并通过 Alembic `0001_initial`、`0002_global_rules` 迁移。生产文件位于 Electron 用户数据目录的 `runtime/damusystem.sqlite3`。

| 表 | 核心字段 | 关系与索引 | 保留策略 |
|---|---|---|---|
| `game_profiles` | id、name、window_title_pattern、overlay_settings、created_at、updated_at | name 索引 | 永久 |
| `recognition_regions` | id、profile_id、name、x/y/w/h、recognition_type、config、enabled | profile_id 索引；删除配置时级联 | 永久 |
| `danmaku_rules` | id、可空 profile_id、match_type、pattern、template、confidence、cooldown_ms、priority | `profile_id=NULL` 为全局规则；非空为内置测试等配置规则 | 永久 |
| `capture_sessions` | id、profile_id、source_id、window_name、started_at、ended_at、end_reason | started_at 索引 | 7 天 |
| `recognition_events` | id、session_id、region_id、normalized_text、confidence、content_hash、occurred_at、metadata | session_id、occurred_at、content_hash＋occurred_at | 7 天 |
| `danmaku_messages` | id、session_id、event_id、rule_id、text、style、emitted_at、expires_at | session_id、emitted_at | 7 天 |

SQLite 使用默认回滚日志、`foreign_keys=ON`、`busy_timeout=5000`、短事务和单后台写入队列；不启用 WAL。启动时及每小时执行一次 7 天数据清理。归一化 ROI 坐标必须位于 0～1；原始 JPEG 不持久化。
