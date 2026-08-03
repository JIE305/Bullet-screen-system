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

复验命令：

```powershell
.\scripts\test.ps1
.\scripts\smoke-desktop.ps1
```
