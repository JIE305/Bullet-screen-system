# 第 1 周验收清单

- [x] Python 3.12 后端选择随机端口启动，并通过令牌认证健康检查。
- [x] Electron 启动后端、建立 WebSocket，并在退出时清理子进程。
- [x] 配置窗口枚举可捕获窗口，并显示后端、会话和事件状态。
- [x] 内置测试画面由隐藏采集 Renderer 以约 1 FPS 捕获。
- [x] JPEG 经安全 IPC 和 HTTP 进入 FastAPI，单帧限制为 1 MiB。
- [x] `DummyRecognizer` 生成标准化识别事件和弹幕事件。
- [x] 透明、置顶、鼠标穿透覆盖层显示并自动移除弹幕。
- [x] 最新帧队列容量为 1；旧帧被替换，超过 2 秒的帧被拒绝。
- [x] 后端 pytest、桌面端 Vitest、TypeScript 类型检查和生产构建全部通过。
- [x] 1100×720 无横向溢出；键盘焦点和减少动态效果样式已实现。
- [x] 1440×900 浏览器视觉验收无溢出、无控制台错误或警告。
- [x] 自动桌面冒烟链路产生 `danmaku.created`，接受帧数不少于 1。
- [x] 慢识别器并发测试证明等待帧会被新帧替换，并返回 `dropped_frame_id`。
- [x] 非 JPEG、损坏 JPEG、超过 1 MiB、未认证 WebSocket和停止后上传均有自动测试。
- [x] 自动崩溃注入证明 Python 意外退出后最多自动重启一次并恢复 WebSocket。
- [x] 会话重启时销毁并重建覆盖层，不闪现旧弹幕且无残留计时器。
- [x] v1 HTTP 路径、事件类型、UUID 与 UTC 时间契约冻结。

复验命令：

```powershell
.\scripts\test.ps1
.\scripts\smoke-desktop.ps1
```

封板结果（2026-08-03）：后端 15 项、桌面端 40 项全部通过，开发版与生产版 Electron 冒烟均通过。Starlette 测试客户端仍有 1 条上游弃用警告，不影响运行。
