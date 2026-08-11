# 本地接口契约 v1

## 认证与通用约定

- HTTP 前缀：`/api/v1`
- HTTP 请求头：`X-DaMu-Token`
- WebSocket：`/ws/v1/events`，同样使用 `X-DaMu-Token`
- ID：UUID 字符串
- 时间：UTC ISO 8601
- 图像：JPEG，最大 1 MiB，超过 2 秒视为过期

## HTTP

| 方法 | 路径 | 用途 |
|---|---|---|
| GET | `/api/v1/health` | 后端、识别器和存储状态 |
| GET | `/api/v1/windows/{hwnd}/bounds` | 读取目标窗口当前桌面坐标与尺寸 |
| GET/POST | `/api/v1/profiles` | 列出或创建 SQLite 配置 |
| GET/PATCH/DELETE | `/api/v1/profiles/{id}` | 读取、修改或删除 SQLite 配置 |
| PUT | `/api/v1/generation/config` | 同步仅驻留 Python 内存的云端配置与生成策略 |
| POST | `/api/v1/sessions` | 启动采集会话；`generation_mode=ai` 用于真实窗口，`profile_template` 用于内置测试 |
| DELETE | `/api/v1/sessions/{id}` | 停止采集会话；可选 `reason` 查询参数 |
| POST | `/api/v1/sessions/{id}/frames` | 上传区域 JPEG 与帧元数据 |
| POST | `/api/v1/shutdown` | 父 Electron 进程安全关闭后端 |

帧上传接受 `frame_id`、`region_id`、`captured_at`、`width`、`height` 和 `image`。队列已满时接受新帧并返回被替换的 `dropped_frame_id`；过期帧返回 `accepted: false`。

## WebSocket

```json
{
  "schema_version": "1",
  "event_id": "uuid",
  "type": "danmaku.created",
  "session_id": "uuid",
  "emitted_at": "2026-08-02T03:00:00Z",
  "payload": {}
}
```

冻结的 v1 事件类型：

- `session.status`
- `recognition.detected`
- `danmaku.created`
- `window.bounds_changed`
- `error`

## Electron 内部样式接口

弹幕样式由主进程持久化，Renderer 只能通过安全 preload 使用以下白名单能力：

- `getOverlayStyle()`：读取当前全局样式。
- `updateOverlayStyle(settings)`：校验、原子保存并广播完整样式。
- `onOverlayStyle(callback)`：接收活动样式变化。
- `notifyOverlayStyleReady()`：覆盖层完成首次样式应用后通知主进程解除透明状态。

样式结构版本为 `schemaVersion: 2`，包含内置字体枚举、14～48px 字号、400/500/600 字重、`#RRGGBB` 文字颜色、0～1 背景不透明度及 0.5～2.0 倍速度。HTTP 与 WebSocket 协议不因此改变。

## 进程生命周期

1. Electron 生成随机令牌并启动 `py -3.12 -m damusystem_backend --port 0`。
2. Python 绑定随机环回端口并输出 `DAMU_BACKEND_READY {json}`。
3. Electron 在 10 秒内轮询健康检查，再建立 WebSocket。
4. WebSocket 断开后按 0.5、1、2、4、5 秒退避重连；断开期间暂停帧上传。
5. Electron 退出时调用认证关闭接口；3 秒后仍未退出才终止子进程。
6. 生产模式改为启动 `resources/backend/damusystem-backend.exe`，接口保持不变。

`recognition.detected` 包含真实文字、标准化文字、置信度、可选文字框、内容哈希、`processing_ms` 与 `generation_evaluation`。生成结论为 `not_selected`、`cloud_unavailable`、`interval_limited`、`repeat_limited`、`rate_limited`、`calling`、`generated` 或 `failed`。调用中的事件与最终事件使用相同 `event_id`，控制台按 ID 更新，SQLite 使用 merge 更新元数据。

真实窗口不读取全局关键词规则。每帧有效候选中只选最高置信度文字申请 AI 额度；API 未配置、节流或失败时仅保留识别事件，不产生 `danmaku.created`。内置测试链路使用配置级“包含测试”规则和固定模板，不调用云端。

`ProfileCreate`/`ProfilePatch`/`ProfileRecord` 增加可选 `game_name`（最长 120 字符）。该值是用户确认的游戏名称候选，与只在本地用于找回配置的 `window_title_pattern` 分开保存。

正式生成只使用 `game_name` 和最多 300 字符的 `ocr_text`，不传递关键词、模板、截图、HWND、完整窗口标题或事件历史。项目不暴露独立的云端测试调用接口和全局关键词接口。
