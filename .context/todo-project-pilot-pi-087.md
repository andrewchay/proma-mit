# Project Pilot · Pi 0.87.1 候选验证（2026-09-28）
- [x] 核对仓库、已安装 SDK 与现有 readiness / adapter / 历史 PoC
- [x] 真实 Pi 0.87.1 AgentSession＋假 Provider 流验证请求前门禁、工具阻断、异常费用、hook 链式行为（4 PASS；原生重试未强制触发，仍需专门验证）
- [x] 定向 5 PASS；全仓 504 测试文件零失败、typecheck、lint（0 error、旧 2 warnings）、docs:check PASS。子代理审查超轮数未形成结论，已人工核对测试口径
- [x] 台账 `-40` 记录离线结论并校正顶部过期摘要；原生重试、终态用量来源、费用门禁生产接线与可信停止仍未闭合，不提前开启 capability/白名单
- [x] 用户选择先完成安全接线与无费用测试：orchestrator 阈值透传、Pi adapter 请求/工具软门禁、费用异常停等，有限阈值禁重试；readiness 与 capability 维持关闭
- [x] 本切片全仓 505 测试文件零失败、typecheck、Biome 0 error（已有 2 warnings）、docs:check PASS；真实 Provider 冒烟另需确认模型/渠道、调用上限及费用授权，本切片不自动调用
