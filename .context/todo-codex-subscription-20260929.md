# ChatGPT 订阅 Chat/Pi Agent 修复（2026-09-29）
- [x] 静态审计 OAuth→模型选择→请求链路；确认 Chat 缺适配器、Pi 空 URL 与错误协议。
- [x] 接入 Pi 内置 Codex 模型与应用渠道 OAuth 凭据存储（不传 JSON 作为 API Key）。
- [x] Chat 原生 Codex 流、工具续接、标题；Pi Agent Codex 路由；补代理/超时/凭据并发守卫。
- [x] 离线测试：Pi SDK 原生 Codex SSE mock 验证请求地址、Bearer 与流事件；凭据并发/重新登录、Chat transcript；定向测试 23 PASS、typecheck、Biome 通过。代码审查指出工具末轮问题并已修复。
- [ ] 交付边界：尚未以用户真实订阅账号完成 Chat/Pi Agent 请求验证；需用户在应用内验证登录、模型选用及代理连通性。
