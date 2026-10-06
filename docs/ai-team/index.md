# 通用 AI 项目交付团队

版本 1.0.0。2026-10-07 创建。**20 份角色档案：13 核心＋7 专项。未绑定模型、未创建可执行员工实例、未启动任务。**

协调者复用现有 Project Shepherd，不新增项目经理或 Chief of Staff。已有研发员工保留，本目录覆盖非研发职能。

## 渐进式披露

1. **L0 职能索引**：读取 [catalog.json](catalog.json)，了解相关职能；不是已授权员工集合。
2. **L1 候选能力卡**：比较少量 `cards/*.json` 的输入、成果和职责，不按头衔／关键词盲选。
3. **L2 执行规则**：仅为选中岗位读取 `roles/*.md`，必须完整加载共通安全边界。
4. 实例化前由现有员工服务核验身份、工作区、Runtime、渠道和模型；实际派发另核验计划、授权、依赖及费用。缺适配器只能建议，不伪造可执行。

`roleSlug` 是模板标识，不是 `employeeId`。卡片的员工、模型和工作区绑定为 null。目录是静态资料，**尚未接入 Shepherd 运行时检索或派工接口**。交接角色不是可调用员工 ID。

## 岗位目录

| 岗位 | 类别 | 主要职责 | 文件 |
|---|---|---|---|
| 需求分析师 | 核心 | 把模糊目标整理为范围、成果与验收标准，不替人拍板。 | [能力卡](cards/requirements-analyst.json) · [执行规则](roles/requirements-analyst.md) |
| 研究与证据分析师 | 核心 | 将市场、竞品与方案资料整理为可追溯证据，不把重复引用当独立证据。 | [能力卡](cards/research-synthesist.json) · [执行规则](roles/research-synthesist.md) |
| 交付核验员 | 核心 | 对照确认标准核对任意类型成果，提供建议而不自行完成任务。 | [能力卡](cards/delivery-verifier.json) · [执行规则](roles/delivery-verifier.md) |
| 品牌策略师 | 核心 | 定义长期定位、价值主张和表达规范，为设计与营销提供依据。 | [能力卡](cards/brand-strategist.json) · [执行规则](roles/brand-strategist.md) |
| 视觉与传播设计师 | 核心 | 制作提案、海报、演示、信息图或分镜，并提供可交接规格。 | [能力卡](cards/visual-designer.json) · [执行规则](roles/visual-designer.md) |
| 营销策划师 | 核心 | 设计活动目标、受众、渠道和衡量方法，不把计划当实际效果。 | [能力卡](cards/marketing-planner.json) · [执行规则](roles/marketing-planner.md) |
| 内容策划与编辑 | 核心 | 制作文章、脚本、案例、邮件和平台内容，核查事实及品牌一致性。 | [能力卡](cards/content-editor.json) · [执行规则](roles/content-editor.md) |
| 商务与提案专员 | 核心 | 将真实客户机会整理为方案、范围与报价草案，不擅自作商业承诺。 | [能力卡](cards/proposal-specialist.json) · [执行规则](roles/proposal-specialist.md) |
| 财务规划分析师 | 核心 | 用可追溯数据构建预算、毛利和现金流情景，不代替批准。 | [能力卡](cards/financial-planner.json) · [执行规则](roles/financial-planner.md) |
| 账务与对账助理 | 核心 | 核对实际交易、凭证和应收应付，不将草稿写入正式账簿。 | [能力卡](cards/bookkeeping-assistant.json) · [执行规则](roles/bookkeeping-assistant.md) |
| 合同与合规审阅员 | 核心 | 进行合同初审、版本比较与风险整理，为人类和专业律师准备复核材料。 | [能力卡](cards/legal-reviewer.json) · [执行规则](roles/legal-reviewer.md) |
| 业务运营专员 | 核心 | 整理重复业务流程、资源与供应商方案，不替代 Shepherd 调度。 | [能力卡](cards/operations-specialist.json) · [执行规则](roles/operations-specialist.md) |
| 客户成功与服务专员 | 核心 | 准备使用支持并基于真实记录跟踪客户问题和承诺。 | [能力卡](cards/customer-success.json) · [执行规则](roles/customer-success.md) |
| 商业策略顾问 | 专项 | 比较商业模式、市场进入与定价，明确假设、取舍及验证路径。 | [能力卡](cards/business-strategist.json) · [执行规则](roles/business-strategist.md) |
| 体验设计与用户研究员 | 专项 | 设计产品、服务与客户旅程，区分真实研究和模拟走查。 | [能力卡](cards/experience-designer.json) · [执行规则](roles/experience-designer.md) |
| 用户反馈分析师 | 专项 | 归纳真实反馈的主题痛点，不把 AI 模拟意见当用户数据。 | [能力卡](cards/feedback-analyst.json) · [执行规则](roles/feedback-analyst.md) |
| AI 行为设计师 | 专项 | 制作版本化提示词、输出契约与测试，提出候选不自行激活。 | [能力卡](cards/ai-behavior-designer.json) · [执行规则](roles/ai-behavior-designer.md) |
| 文档与知识编辑 | 专项 | 将成果整理为指南、SOP与交接资料，标明来源和适用版本。 | [能力卡](cards/knowledge-editor.json) · [执行规则](roles/knowledge-editor.md) |
| 数据与效果分析师 | 专项 | 核对口径和数据质量，复现经营营销或实验分析，不将相关当因果。 | [能力卡](cards/data-analyst.json) · [执行规则](roles/data-analyst.md) |
| 人力与招聘助理 | 专项 | 准备岗位、面试和入职材料，用岗位证据辅助人类招聘。 | [能力卡](cards/recruitment-assistant.json) · [执行规则](roles/recruitment-assistant.md) |

## 场景选人示例（建议，不是派发记录）

- 品牌定位：需求 → 研究 → 品牌；明确视觉成果后增加设计／内容；关键定位由人决定。
- 营销素材：营销 → 内容／设计（输入独立才并行）→ 核验；发布投放另确认。
- 客户提案：需求／商务 → 财务测算 → 合同初审 → 成稿与核验；报价承诺须批准。
- 现金流：财务规划＋必要账务核对；缺口径或凭证时询问，预测不当实际。
- 合同审阅：初审并列专业复核项，不签约、不保证完全合规。
- 员工优化：AI 行为设计提出候选和用例，付费评测与生产激活另授权。

## 创建与运行边界

用户选择先制作档案、暂不绑定模型，并同意新建专用通用交付工作区。目录与工作区创建不代表员工实例、付费规划或自动执行授权。

新工作区通过现有服务创建托管目录和默认核心 Skills，不复制源码、客户资料、渠道密钥或新增外部 MCP；不修改现有员工。不得用假 channelId 或隐式全局回退强行保存无模型员工。

safe 是未来实例的建议默认，不是本轮运行配置。版本哈希只证明完整性，不证明模型质量和外部真实性。

## 来源与验证

- [provenance.json](provenance.json)：参考 HEAD、实际文件哈希及工作树变更标记。
- [上游 MIT 许可](licenses/agency-agents-MIT.txt)：完整保留。
- [manifest.json](manifest.json)：能力卡、规则和用例版本及哈希。
- `cases/*.json`：每岗位四类行为用例，未运行真实模型，不算行为评测通过。
- [创建与验证记录](verification.md)：实际创建、静态检查、全仓门禁失败及未接通范围。
- 可重复检查：`python3 docs/ai-team/checks/validate.py docs/ai-team`。
- 未修改 Owner 台账状态，不宣称 AO-04／06 已接通。
