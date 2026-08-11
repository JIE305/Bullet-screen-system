# 第 2～4 周候选版本报告

## 当前结论

第 2 周真实 OCR/ROI/规则闭环和第 3 周 SQLite 核心范围已经完成。第 4 周的 PyInstaller `onedir`、electron-builder NSIS、异常恢复和生产版自动冒烟已经完成；实际游戏、DPI 125% 和 30 分钟长时运行需在目标机器人工执行后才能标记最终验收。

## 已实现

- `Recognizer` 协议、`DummyRecognizer`、RapidOCR + ONNX Runtime CPU、OpenCV 原图/高对比预处理。
- 单活动 ROI，0～1 归一化坐标；Canvas 在上传前裁剪、缩放和 JPEG 编码。
- NFKC、空白折叠、大小写归一、0.65 默认阈值、3 秒去重。
- `contains` / `exact`、`{text}` 模板、会话+规则+文本冷却键。
- SQLite 六表、Alembic、配置重启恢复、7 天清理、单写入队列、无原始画面落盘。
- 目标窗口移动/缩放跟随，连续不可用后安全停止；WebSocket 退避重连和 Python 单次自动重启。
- PyInstaller `onedir` 后端、electron-builder `extraResources` 与 NSIS 安装器。

## 自动证据（2026-08-03）

| 项目 | 结果 |
| --- | --- |
| 后端 pytest | 15 项通过；1 条上游弃用警告 |
| 桌面 Vitest | 40 项通过 |
| TypeScript / 生产构建 | 通过 |
| RapidOCR 合成图 | 识别 `VICTORY 2026`；3 次中位耗时 < 2 秒 |
| 开发版 Electron 冒烟 | Dummy 与 RapidOCR 均通过 |
| PyInstaller 后端 | 独立启动、SQLite 健康检查和认证关闭通过 |
| `win-unpacked` 生产冒烟 | 完整链路、崩溃恢复、覆盖层和退出清理通过 |
| NSIS | `DaMuSystem Setup 0.1.0.exe` 已生成 |
| 浏览器视觉验收 | 1100×720 / 1440×900 无横向溢出、0 条控制台错误/警告 |

## 最终人工验收清单

1. 在 Windows 100% 与 125% 缩放下各测试 1100×720 和 1440×900。
2. 选择一款窗口化游戏：设置 ROI，移动、缩放、最小化、恢复并关闭目标窗口。
3. 连续启停三次，确认无旧弹幕闪烁、覆盖层始终置顶且鼠标穿透。
4. 连续运行 30 分钟，记录内存、帧接受/丢弃与端到端延迟。
5. 在未安装 Node/Python 的 Windows 环境安装 NSIS，完成启动、识别、退出和卸载。

完成上述五项并把截图、游戏名称和性能结果附在本文件后，方可将第 4 周标记为 100%。
