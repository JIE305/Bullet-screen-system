# DaMuSystem

DaMuSystem 是面向 Windows 窗口化游戏的本地画面弹幕实验项目。Electron 负责窗口选择、画面采集和透明覆盖显示，Python 服务负责识别、规则和后续持久化。

当前进度：**里程碑 0 与第 1 周最小纵向链路已验收**。本阶段使用 `DummyRecognizer` 验证“捕获 → HTTP → Python → WebSocket → 覆盖层”，真实 OCR 和 SQLite 将在后续里程碑接入。

## 环境

- Windows 10/11
- Node.js 24+
- pnpm 11+
- Python 3.12（不要使用默认 Python 3.14）

## 安装与启动

```powershell
.\scripts\setup.ps1
.\scripts\dev.ps1
```

## 自动验证

```powershell
.\scripts\test.ps1
.\scripts\smoke-desktop.ps1
```

第一条命令运行后端单测、桌面端单测、TypeScript 类型检查和生产构建；第二条命令真实启动 Electron 与 Python，自动跑通测试画面到弹幕事件后退出。

## 第 1 周手工演示

1. 启动应用，等待顶部状态变为“后端在线 / WS 已连接”。
2. 点击“启动内置测试链路”。
3. 应用打开测试画面，隐藏采集窗口以约 1 FPS 上传 JPEG。
4. Python 的 `DummyRecognizer` 返回标准化识别事件和弹幕事件。
5. 透明覆盖层显示弹幕；点击“停止会话”结束采集。

详细资料见 [架构说明](./docs/architecture.md)、[接口契约](./docs/contracts.md)、[数据模型](./docs/data-model.md)与[第 1 周报告](./docs/milestone-1-report.md)。
