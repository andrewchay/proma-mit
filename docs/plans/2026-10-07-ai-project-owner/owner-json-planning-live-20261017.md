# Owner 反馈规划：JSON 输出与历史回读复验

2026-10-17，基线 `2828f53e`。用户将本轮请求总上限从12次追加到16次，仍共享原¥15预算。本段实际新增3次，总计15/16，保留最后1次；没有按新轮次重置计数或预算。

## 实际失败与修复

1. **请求13**：修复旧提示中不平衡的花括号并明确授权字段层级后，模型返回有效JSON，却将deliveryChangeAssessment放到根层。严格解析器拒绝未知字段，未生成计划。
2. **历史回读**：提示修改后，旧记录按当前提示重算hash，导致列表报来源记录无效。现在仅按已冻结完整prompt hash，在三种明确已知的历史提示格式中精确匹配；未知hash拒绝。旧记录和旧许可的文本不改写、不升级。新准备使用完整响应示例，assessment位于proposal内。三种格式的精确回读、旧准备幂等、原记录不变及伪造hash拒绝均有SQLite集成回归。
3. **请求14**：完整响应示例仍未保证模型生成有效JSON。Provider返回HTTP200、stop和完整usage，但内容缺少闭合括号；输出token为3199，低于8192上限，不能归因于本次输出上限截断。严格解析器拒绝，未隐式补括号、修改字段或重发。
4. **v4 JSON输出**：新DeepSeek Flash OpenAI Chat规划准备冻结v4，实际通过AI SDK `Output.json()`发送`response_format:{type:"json_object"}`；最终出口严格核验该精确格式。旧v1–v3不能追加此参数；其他模型、普通Agent、业务执行不自动开启。仍然零工具、最多1请求、8192输出上限、SDK/外层零重试。

官方依据：[DeepSeek JSON Output](https://api-docs.deepseek.com/guides/json_mode/)、[Chat Completions](https://api-docs.deepseek.com/api/create-chat-completion/)。JSON模式约束语法，应用仍按原严格协议校验字段、来源、授权影响和冻结验收标准，没有放宽解析器。

## 第15次真实请求：已生成待审计划

最终固定包实际点击：对应Task目标草案→最新v4准备→预检→界面显示“JSON 格式输出，内容仍需校验”、单请求/8192→勾选费用确认→确认开始。实际请求体保存有`response_format:{type:"json_object"}`，没有工具或隐藏历史。主进程完成后，原生窗口自动显示“审阅Owner计划提案”和“计划v1 · 待审阅 · AI生成（可信Run）”，没有点击刷新、手工导入模型结果或改写数据库状态。

- 项目：`b4066585-fec2-45fb-8bc7-37245ede4627`
- 反馈目标Task：`0da1ec59-00f4-4138-8f61-4154db9702a3`
- 新规划承载Task：`247f084a-b14b-47ad-91a8-1ae61869d800`
- Run：`87812413-1f72-4706-8235-123b1ff40b76`
- Provider response ID：`a3af551e-9599-45a7-a9a6-03e445c0f8ea`
- 回执：`db314c07fa681798334fce55c256de9b0478ede69d0e4a73f9581389f71bc4f7`
- 输入4964、输出1955 tokens；完整stop与usage，应用validTerminal=true、outcome=proposed。

新计划保留旧版，建议将竞品断言改为待验证假设、痛点改为推导，按原顺序逐项覆盖三条冻结验收标准；全部still_open，明确“尚未实施”、`new_grant_required`和“不沿用旧授权”。它是可审阅的新计划，不是修订成果已执行、已业务签收或新执行许可。本段没有确认计划内容、发行新业务grant或派工；原三条失败历史均继续展示。

## 费用和证据边界

总实际转发15次；此前12次的保守峰时费用上界¥0.362544，加本段3次后合计**¥0.461762**。这是按完整usage和官方峰时单价、缓存输入按未命中计的上界，不是逐请求账单。第13–15次期间账户级余额API差为¥0.04，受精度、更新时延和并发消费归因限制。应用该规划回执的美元cost仍为unknown、不是零；不能用人民币估算覆盖或伪造该账本字段。AO-G3独立逐请求账单仍缺。

隔离profile已关闭，复制的渠道配置已移除；默认用户配置未修改。原文、原始SSE、实际请求体、usage、正式IPC返回、原生SQLite备份和manifest保存在忽略目录`test-results/owner-live-final-20261017/`。旧profile回读前更新了loopback端口，因此通过正式接口显式重存Owner配置及新准备；原绑定/Run记录保留，没有绕过配置漂移门禁。Renderer异常为空，SQLite integrity_check=ok。

## 固定包与工程核对

Electron 0.13.24、shared 0.2.63；最终arm64目录包与正式package-smoke通过。最终`app.asar` SHA-256=`295463e2f7632d0d749ce6998c31f626f25196fb3219b64c9348167242635534`。请求13使用中间包`67b8b356ed3894ccee0c4e9510666af73b2d20c45bbfa81cac307f89f4f090a6`；请求14使用中间包`68a517aed3a4d8afd59aa54ce0ab5b499b9e4c20b55cba9e62dd1b0d02decef3`，不把其失败算作最终v4通过。均为未签名本地包，未安装替换或推送。

JSON模式的实际SDK→序列化→凭据→单请求占位集成通过；另覆盖v4缺参数/错格式/夹带schema拒绝、旧协议不升级、模型/协议限制、预检说明及历史hash兼容。独立code_simplifier复核没有发现权限、预算或重试扩大。末轮完整664个隔离测试文件失败0，全workspace typecheck、完整Electron build、变更19个TS/TSX文件Biome、docs和diff检查通过。初轮全套发现窄AI SDK mock缺Output导出并中断；补齐四处mock、定向复验后重跑完整末轮，失败记录保留，没有算作通过。没有把历史664文件结果冒称本轮新结果。

## 仍未完成

本段关闭真实反馈规划“无有效新版本”的缺口，未关闭完整Ledger。代码Owner仍缺冻结范围内源码读取、验证命令证据及Reviewer准确产物适配；此前真实代码写入和独立4项测试不代替该内部链路。AO-A02仍遵守用户此前待验收决定；独立Provider账单和业务签收也未代用户完成。最后1次请求保留，未在已知代码适配缺口上继续消耗。
