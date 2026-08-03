# 本地接口契约 v1

## 认证与通用规则

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
| GET/POST | `/api/v1/profiles` | 列出或创建内存配置 |
| GET/PATCH/DELETE | `/api/v1/profiles/{id}` | 读取、修改或删除内存配置 |
| POST | `/api/v1/sessions` | 启动采集会话 |
| DELETE | `/api/v1/sessions/{id}` | 停止采集会话 |
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

第 1 周事件类型：

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

样式结构版本为 `schemaVersion: 1`，包含内置字体枚举、14～48px 字号、400/500/600 字重、`#RRGGBB` 文字颜色及 0～1 背景不透明度。HTTP 与 WebSocket 协议不因此改变。

## 进程生命周期

1. Electron 生成随机令牌并启动 `py -3.12 -m damusystem_backend --port 0`。
2. Python 绑定随机环回端口并输出 `DAMU_BACKEND_READY {json}`。
3. Electron 在 10 秒内轮询健康检查，再建立 WebSocket。
4. WebSocket 断开后按 0.5、1、2、4、5 秒退避重连；断开期间暂停帧上传。
5. Electron 退出时调用认证关闭接口；3 秒后仍未退出才终止子进程。
6. 生产模式改为启动 `resources/backend/damusystem-backend.exe`，接口保持不变。
