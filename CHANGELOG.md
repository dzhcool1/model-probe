# 更新日志

本文件记录 Model Probe 的功能更新，按时间倒序排列。

## 2026-09-03

- 完成模型探测仪表盘初版，支持 OpenAI-compatible、Gemini 和 Claude 协议，并可自动识别协议。
- 支持获取模型列表、批量探测总延迟/流式 TTFT/输出速度，以及按名称和状态筛选、排序。
- 增加失败重试、单模型复测、JSON/CSV 报告导出、并发数、超时和输出上限等操作。
- 增加测试历史、模型目录缓存、缓存 usage 观察和延迟/TTFT/缓存状态图表。
- 增加产品截图与界面预览文档。
- 增加 macOS Apple Silicon `.app` 打包能力。
- 增加从 Windows CC Switch 一键导入连接配置的能力。
- 优化按钮的 hover、active 等交互反馈样式。