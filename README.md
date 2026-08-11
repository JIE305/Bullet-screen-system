# DaMuSystem

DaMuSystem 是面向 Windows 窗口化游戏的本地画面弹幕实验项目。Electron 负责窗口选择、画面采集和透明覆盖显示，Python 服务负责 OCR、保守的 AI 生成调度和持久化。

当前进度：**第 1 周已封板，第 2、3 周核心功能已完成，第 4 周进入候选版本验收**。项目已具备 RapidOCR、单 ROI、OCR 直连 AI、调用频率控制、SQLite 六表持久化、PyInstaller 后端和 Electron Windows 安装包。

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
.\scripts\smoke-ocr.ps1
```

第一条命令运行后端单测、桌面端单测、TypeScript 类型检查和生产构建；后两条分别以 Dummy 与 RapidOCR 跑通真实 Electron 链路。生产包验证可使用 `.\scripts\smoke-desktop.ps1 -Packaged`。

## 开发版演示

1. 启动应用，等待顶部状态变为“后端在线 / WS 已连接”。
2. 点击“启动内置测试链路”。
3. 应用打开测试画面，隐藏采集窗口以约 1 FPS 上传 JPEG。
4. 在“识别区域”调整 ROI 和预处理；在左侧设置 AI 最低置信度、调用间隔、同文冷却和每分钟上限。
5. 内置测试链路使用固定模板且不调用 API；真实窗口通过 RapidOCR 识别后，在预算允许时由 AI 生成弹幕。
6. 透明覆盖层显示弹幕；点击“停止会话”结束采集。

## Windows 打包

```powershell
.\scripts\package.ps1
.\scripts\smoke-desktop.ps1 -Packaged
```

安装器输出为 `desktop\release\DaMuSystem Setup 0.1.0.exe`。打包脚本会优先使用已安装的 Electron 运行时，并为 electron-builder 工具链配置镜像；生产应用不依赖系统 Node 或 Python。

详细资料见 [架构说明](./docs/architecture.md)、[接口契约](./docs/contracts.md)、[数据模型](./docs/data-model.md)、[第 1 周报告](./docs/milestone-1-report.md)与[候选版本报告](./docs/milestone-2-4-report.md)。
