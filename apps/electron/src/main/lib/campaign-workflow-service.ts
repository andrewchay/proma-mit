/**
 * Campaign 工作流状态服务
 *
 * 管理每个 Campaign 的 15 步标准工作流进度。
 * 存储位置：~/.proma-mit/agent-workspaces/campaign-{id}/
 *
 * 目录结构：
 *   campaign-workflow.json    # 工作流状态
 *   .context/
 *     ├── todo.md              # 结构化 todo 列表
 *     ├── campaign.md          # Campaign 上下文
 *     └── history.md           # 执行历史
 *   brand-dna/                 # 品牌 DNA 产物
 *   brand-concept/             # 品牌概念产物（品牌愿景、价值观、品牌屋）
 *   creative-concept/          # 创意概念产物
 *   platform-matrix/           # 平台矩阵产物
 *   kol-pyramid/             # KOL 金字塔产物
 *   kol-search/              # 搜索结果
 *   briefs/                  # KOL Briefs
 *   ab-test/                 # A/B 测试方案
 *   .context/                # 上下文文件（todo.md、campaign.md、history.md）
 *
 * 每步完成后 Agent 可以更新状态，用户也可手动标记。
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, copyFileSync } from 'node:fs'
import { join } from 'node:path'
import { getAgentWorkspacePath } from './config-paths'
import { listAgentWorkspaces } from './agent-workspace-manager'
import { readJsonFileSafe, writeJsonFileAtomic } from './safe-file'
import type {
  CampaignWorkflow,
  CampaignWorkflowStep,
  CampaignWorkflowStepId,
  UpdateWorkflowStepInput,
  AdvanceWorkflowInput,
} from '@gravitas/shared'
import { buildArtifactPersistenceDirective, splitOutputByFiles } from '@gravitas/shared'

// =====================================================================
// 标准目录定义
// =====================================================================

const ARTIFACT_DIRS = [
  'market-analysis',
  'competitor-analysis',
  'user-analysis',
  'brand-dna',
  'brand-fact-check',
  'brand-concept',
  'goal-setting',
  'creative-concept',
  'platform-matrix',
  'kol-pyramid',
  'kol-search',
  'briefs',
  'ab-test',
  'video-assets',
  '.context',
]

const STEP_DIR_MAP: Record<CampaignWorkflowStepId, string> = {
  market_analysis: 'market-analysis',
  competitor_analysis: 'competitor-analysis',
  user_analysis: 'user-analysis',
  brand_dna: 'brand-dna',
  brand_fact_check: 'brand-fact-check',
  brand_concept: 'brand-concept',
  goal_setting: 'goal-setting',
  creative_concept: 'creative-concept',
  platform_matrix: 'platform-matrix',
  kol_pyramid: 'kol-pyramid',
  search_kols: 'kol-search',
  add_to_pool: 'kol-search',
  generate_briefs: 'briefs',
  ab_test: 'ab-test',
  generate_video_assets: 'video-assets',
}

// =====================================================================
// 默认 14 步工作流定义
// =====================================================================

export const DEFAULT_WORKFLOW_STEPS: Omit<CampaignWorkflowStep, 'status' | 'completedAt'>[] = [
  {
    id: 'market_analysis',
    title: '市场分析',
    description: '分析市场规模、品类趋势、品类痛点，判断市场机会与趋势切入点',
    toolName: 'ma-market-analysis',
    minArtifactLength: 300,
    artifactRequirements: [
      { name: '市场规模', aliases: ['规模', '大盘', '增速', '渗透率', '市场容量'] },
      { name: '品类趋势', aliases: ['趋势', '周期', '上升', '衰退', '偏好变化', '趋势机会'] },
      { name: '品类痛点', aliases: ['痛点', '需求', '未被满足', '空白', '切入', '机会点'] },
    ],
    agentPrompt: `## 步骤 1: 市场分析

目标：系统分析目标市场的规模、品类趋势与品类痛点，为后续品牌策略提供市场数据支撑。

分析框架：
1. **市场规模**：大盘数据、品类增速、渗透率、市场容量
2. **品类趋势**：当前处于什么周期（上升/平稳/衰退），用户偏好变化趋势
3. **品类痛点**：用户当前未被满足的需求、行业普遍问题、空白切入点

执行要求：
1. 使用 ma-market-analysis 工具分析市场
2. 产出必须保存到以下目录：\`market-analysis/\`
3. 文件命名建议：\`market-analysis.md\`
4. 完成标准（校验时会检查）：
   - market-analysis.md 必须包含市场规模、品类趋势、品类痛点分析（至少300字）
   - 需标明数据来源（如艾瑞咨询、36氪等）

完成后，请返回 "已完成：市场分析"并附上产物摘要。`,
  },
  {
    id: 'competitor_analysis',
    title: '竞品分析',
    description: '列出直接竞品与间接竞品，分析市场份额、营销动作、核心卖点与空白机会',
    toolName: 'ma-competitor-analyzer',
    minArtifactLength: 300,
    artifactRequirements: [
      { name: '竞品清单', aliases: ['竞品', '对手', '竞争', '品牌', '对标'] },
      { name: '市场占比', aliases: ['份额', '声量', '占比', '竞争格局'] },
      { name: '营销动作', aliases: ['营销', '动作', '追踪', '平台', '内容', '达人'] },
      { name: '核心卖点', aliases: ['卖点', '差异化', '主张', '定位', 'USP'] },
      { name: '空白机会', aliases: ['空白', '机会', '差异化', '策略', '没做'] },
    ],
    agentPrompt: `## 步骤 2: 竞品分析

目标：系统分析竞品矩阵，识别竞争格局与差异化机会。

分析框架：
1. **竞品清单**：列出直接竞品 + 间接竞品
2. **市场占比**：各竞品的市场份额、声量占比
3. **营销动作**：竞品当前在做什么平台、什么内容、什么达人
4. **核心卖点**：竞品主打的差异化点
5. **空白机会**：竞品没做或没做好的地方

执行要求：
1. 使用 ma-competitor-analyzer 工具分析竞品
2. 产出必须保存到以下目录：\`competitor-analysis/\`
3. 文件命名建议：\`competitor-analysis.md\`、\`competitor-matrix.md\`
4. 完成标准（校验时会检查）：
   - competitor-analysis.md 必须包含竞品清单、市场占比、营销动作、核心卖点、空白机会（至少300字）
   - competitor-matrix.md 必须包含竞品矩阵对比表（至少300字）

前置产物：\`market-analysis/\` 目录中的市场分析文件
完成后，请返回 "已完成：竞品分析"并附上产物摘要。`,
  },
  {
    id: 'user_analysis',
    title: '用户分析（TA画像 + 搜索习惯 + 消费者洞察）',
    description: '构建精准受众画像，补充搜索习惯，并提炼带张力的 4A 消费者洞察',
    toolName: 'ma-ta-portrait',
    minArtifactLength: 300,
    requiredFiles: ['ta-portrait.md', 'search-habits.md', 'consumer-insight.md'],
    artifactRequirements: [
      { name: '人口统计', aliases: ['年龄', '性别', '收入', '城市', '地域', '学历', '职业'] },
      { name: '兴趣偏好', aliases: ['兴趣', '偏好', '爱好', '生活方式', '消费观'] },
      { name: '痛点需求', aliases: ['痛点', '需求', '场景', '问题', '欲望', '动机'] },
      { name: '搜索习惯', aliases: ['搜索', '关键词', '平台', '场景', '下拉词', '联想词'] },
      { name: '消费者洞察', aliases: ['洞察', 'insight', '张力', '人性真相', '观察'] },
      { name: '传播切入点', aliases: ['切入点', 'entry point', '传播角度', '入口'] },
    ],
    agentPrompt: `## 步骤 3: 用户分析（TA画像 + 搜索习惯 + 消费者洞察）

目标：基于市场分析和竞品分析，构建精准受众画像，补充搜索习惯，并提炼可用于传播的消费者洞察（Insight）。

分析框架：
1. **人口统计画像**：年龄、性别、收入、城市、地域、学历、职业
2. **兴趣偏好**：兴趣标签、生活方式、消费观、价值观
3. **痛点与需求**：核心痛点、使用场景、未被满足的需求、购买动机
4. **搜索习惯**：
   - 在什么平台搜索（小红书、抖音、百度等）
   - 在什么场景下搜索（种草前、决策中、使用后等）
   - 搜索什么关键词（核心词、长尾词、竞品词）
5. **消费者洞察（Consumer Insight）**：
   - 基于画像与搜索习惯，提炼出一个带张力的人性真相
   - 区分 Observation（观察到的现象）与 Insight（背后的动机/冲突）
   - 参考 JWT TTB 的洞察标准：洞察不是观察，而是"为什么"的深层动机
6. **传播切入点（Entry Point）**：
   - 基于 Insight，明确本次 campaign 最能切入用户心智的角度

执行要求：
1. 使用 ma-ta-portrait 工具构建用户画像
2. 产出必须保存到以下目录：\`user-analysis/\`
3. 【必须】将分析拆成以下**三个指定文件名**分别保存到 \`user-analysis/\` 目录（校验会精确检查这三个文件名）：
   - \`ta-portrait.md\` — 目标受众画像（含人口统计、兴趣偏好、痛点需求）
   - \`search-habits.md\` — 搜索习惯（含搜索平台、搜索场景、搜索关键词）
   - \`consumer-insight.md\` — 消费者洞察（含消费者洞察、传播切入点）
4. 完成标准（校验时会检查）：
   - ta-portrait.md 必须包含人口统计、兴趣偏好、痛点需求（至少300字）
   - search-habits.md 必须包含搜索平台、搜索场景、关键词列表（至少300字）
   - consumer-insight.md 必须包含 Observation、Insight、传播切入点（至少300字）

前置产物：\`market-analysis/\`、\`competitor-analysis/\` 目录中的文件
完成后，请返回 "已完成：用户分析"并附上产物摘要。`,
  },
  {
    id: 'brand_dna',
    title: '品牌DNA + 品牌诊断',
    description: '基于市场/竞品/用户分析，提取品牌核心价值并输出品牌诊断（品牌阶段、产品现状、核心问题、核心目标）',
    toolName: 'ma-brand-dna',
    minArtifactLength: 300,
    artifactRequirements: [
      { name: '品牌历史', aliases: ['历史', '创立', '发展', '里程碑', '传承', 'heritage'] },
      { name: '产品服务', aliases: ['产品', '服务', '功能', '卖点', '价格', '产品线'] },
      { name: '品牌阶段', aliases: ['起步期', '成长期', '成熟期', '焕新期', '阶段', '定位'] },
      { name: '产品现状', aliases: ['产品力', '供应链', '价格带', 'SKU', '产品诊断'] },
      { name: '核心问题', aliases: ['认知问题', '转化问题', '口碑问题', '问题', '定义'] },
      { name: '核心目标', aliases: ['目标', '优先级', '曝光', '破圈', '拉新', '首要目标'] },
      { name: '差异化优势', aliases: ['差异化', '优势', '差异', '不同', '独特', '核心竞争力'] },
    ],
    agentPrompt: `## 步骤 4: 品牌DNA + 品牌诊断

目标：基于市场分析、竞品分析和用户分析的数据支撑，提取品牌核心价值并输出品牌诊断。

分析框架：
1. **品牌自身历史**：创立背景、发展历程、里程碑事件、品牌传承
2. **产品/服务 + 现有传播**：核心产品线、功能卖点、价格带、过往 campaign、slogan、核心文案
3. **品牌阶段诊断**：起步期 / 成长期 / 成熟期 / 焕新期
4. **产品现状诊断**：产品力、供应链、价格带、SKU
5. **核心问题定义**：当前要解决的是认知问题 / 转化问题 / 口碑问题
6. **核心目标**：基于阶段和问题，确定首要目标（曝光/破圈拉新）及目标优先级
7. **差异化优势**：结合市场/竞品/用户分析，总结能戳到洞察的核心差异点

执行要求：
1. 使用 ma-brand-dna 工具分析品牌
2. 产出必须保存到以下目录：\`brand-dna/\`
3. 文件命名建议：\`brand-dna.md\`、\`brand-diagnosis.md\`、\`differentiation.md\`
4. 完成标准（校验时会检查）：
   - brand-dna.md 必须包含品牌历史、产品/服务、品牌核心价值、差异化优势（至少300字）
   - brand-diagnosis.md 必须包含品牌阶段、产品现状、核心问题、核心目标（至少300字）
   - differentiation.md 必须包含差异化优势总结（至少300字）

前置产物：\`market-analysis/\`、\`competitor-analysis/\`、\`user-analysis/\` 目录中的文件
完成后，请返回 "已完成：品牌DNA + 品牌诊断"并附上产物摘要。`,
  },
  {
    id: 'brand_fact_check',
    title: '品牌信息核实',
    description: '通过公开搜索核实品牌DNA中提取的信息，识别可能存在的误差并提示用户',
    toolName: 'web_search',
    minArtifactLength: 300,
    requiredFiles: ['brand-fact-check.md'],
    artifactRequirements: [
      { name: '核实结论', aliases: ['核实', '确认', '结论', '验证结论', '信息确认'] },
      { name: '搜索来源', aliases: ['来源', '搜索', '查询', '链接', '参考'] },
      { name: '差异项', aliases: ['差异', '不一致', '矛盾', '偏差', '出入'] },
      { name: '风险提示', aliases: ['风险', '提示', '误差', '可能存在', '谨慎'] },
    ],
    agentPrompt: `## 步骤 5: 品牌信息核实

目标：基于公开网络搜索，核实上一步 \`brand-dna/\` 中提取的品牌信息是否准确，识别可能存在的误差并向用户提示。

执行要求：
1. 读取 \`brand-dna/\` 目录中的品牌信息。
2. 使用 \`web_search\` 工具对品牌名称、创立时间、发展历程、核心产品线、价格带、供应链等关键信息进行公开搜索。
3. 将搜索结果与 \`brand-dna/\` 中的内容进行逐条对比。
4. 在 \`brand-fact-check/\` 目录中写入 \`brand-fact-check.md\`，必须包含：
   - **核实结论**：哪些信息得到确认，哪些无法确认
   - **搜索来源**：列出使用的搜索查询和来源链接
   - **差异项**：列出与 \`brand-dna/\` 不一致或存在矛盾的地方
   - **风险提示**：若发现关键信息无法核实或存在矛盾，必须明确提示“用户信息可能存在误差，建议在后续步骤中补充或修正”
5. 完成标准（校验时会检查）：
   - brand-fact-check.md 必须包含核实结论、搜索来源、差异项、风险提示（至少300字）

前置产物：\`brand-dna/\` 目录中的品牌DNA与品牌诊断文件
完成后，请返回 "已完成：品牌信息核实"并附上产物摘要。`,
  },
  {
    id: 'brand_concept',
    title: 'Brand Concept 产出',
    description: '基于品牌DNA和品牌诊断，产出品牌愿景/使命、品牌意念、品牌主张、slogan、品牌屋、Brand Tone & Visual',
    toolName: 'ma-brand-house',
    minArtifactLength: 300,
    requiredFiles: ['brand-concept.md', 'brand-house.md', 'brand-idea.md'],
    artifactRequirements: [
      { name: '品牌愿景', aliases: ['愿景', 'vision', '长期目标'] },
      { name: '品牌使命', aliases: ['使命', 'mission', '为什么存在'] },
      { name: '品牌意念', aliases: ['品牌意念', 'brand idea', '核心思想', '品牌核心'] },
      { name: '品牌价值观', aliases: ['价值观', '信仰', 'value', '信念'] },
      { name: '品牌主张', aliases: ['主张', 'slogan', 'tagline', '宣言', '定位'] },
      { name: '品牌人格', aliases: ['人格', '个性', '性格', 'personality', '拟人'] },
      { name: '产品定位', aliases: ['定位', 'functional benefit', 'rtb', '差异化定位', '利益点'] },
      { name: '品牌屋', aliases: ['品牌屋', 'brand house', '架构', '金字塔', '品牌模型'] },
      { name: 'Brand Tone', aliases: ['tone', '调性', '语气', '语言风格', 'tone of voice'] },
      { name: 'Brand Visual', aliases: ['visual', '视觉', '色彩', '风格', '字体'] },
    ],
    agentPrompt: `## 步骤 5: Brand Concept 产出

目标：基于品牌DNA（步骤4产物）和品牌诊断，系统产出品牌概念体系。参考 JWT TTB：Brand Vision → Brand Idea → Brand Concept；参考奥美 360 品牌管家：品牌愿景、品牌写真、品牌屋。

产出框架：
1. **品牌愿景（Vision）**：品牌希望实现的长期理想状态（未来想成为什么）
2. **品牌使命（Mission）**：品牌为什么存在、现在每天解决什么问题（与 Vision 区分）
3. **品牌意念（Brand Idea）**：
   - 一句话可传播的品牌核心思想
   - 连接品牌愿景与消费者洞察的桥梁
   - 是后续 Big Idea 的上层指引
4. **品牌价值观**：品牌的核心信仰与价值判断
5. **品牌主张**：并生成 slogan / tagline 候选
6. **附加价值**（情感定位）：情感、文化、生活方式层面的价值定位
7. **品牌人格**：3-5 个具体的形容词描述品牌拟人化特质
8. **产品定位**（支持情感定位）：
   - Functional benefit：产品具体解决什么问题
   - 差异化定位：与竞品最核心的差异
   - RTB（Reasons to Believe）：支持点 / 证据
9. **品牌屋搭建**：确保愿景→价值观→利益点→RTB→目标人群 各层级逻辑自洽
10. **Brand Tone 产出**：语言风格、用词风格、禁忌词
11. **Brand Visual 产出**：视觉风格、色彩策略、字体偏好

执行要求：
1. 使用 ma-brand-house 工具构建品牌概念体系
2. 产出必须保存到：\`brand-concept/\`
3. 文件命名建议：\`brand-concept.md\`、\`brand-house.md\`、\`brand-idea.md\`、\`tone-visual.md\`
4. 完成标准（校验时会检查）：
   - brand-concept.md 必须包含品牌愿景、品牌使命、品牌价值观、品牌主张、slogan（至少300字）
   - brand-house.md 必须包含品牌屋架构（愿景/价值观/利益点/RTB/目标人群）（至少300字）
   - brand-idea.md 必须包含品牌意念、与愿景/洞察的连接、对 Big Idea 的指引（至少300字）

前置产物：\`brand-dna/\`、\`user-analysis/\` 目录中的文件
完成后，请返回 "已完成：Brand Concept 产出"并附上产物摘要。`,
  },
  {
    id: 'goal_setting',
    title: '目标设定',
    description: '基于品牌诊断，设定总目标、分层目标与量化指标（KPI）',
    toolName: 'ma-campaign-optimizer',
    minArtifactLength: 300,
    artifactRequirements: [
      { name: '总目标', aliases: ['总目标', '核心问题', '品类认知', '内容模型', '搜索转化'] },
      { name: '分层目标', aliases: ['分层', '平台', '阶段', '人群', '测试期', '爆文模型'] },
      { name: '量化指标', aliases: ['KPI', '指标', '互动率', 'CPE', '爆文率', '搜索量', 'ROI', '可追踪'] },
    ],
    agentPrompt: `## 步骤 6: 目标设定

目标：基于品牌诊断（步骤4产物），设定Campaign的总目标、分层目标与量化指标。

目标框架：
1. **总目标**：本阶段要解决的核心问题
   - 示例：建立品类认知 / 验证内容模型 / 拉动搜索转化
2. **分层目标**：按平台/阶段/人群拆解
   - 示例：小红书测试期：找到1组可复制的爆文模型
3. **量化指标**：KPI必须可追踪、可复盘
   - 示例：互动率、CPE、爆文率、搜索量、ROI

执行要求：
1. 使用 ma-campaign-optimizer 工具设定目标
2. 产出必须保存到：\`goal-setting/\`
3. 文件命名建议：\`goal-setting.md\`
4. 完成标准（校验时会检查）：
   - goal-setting.md 必须包含总目标、分层目标、量化指标（至少300字）
   - 指标必须具体、可量化、可追踪

前置产物：\`brand-dna/\` 目录中的品牌诊断文件
完成后，请返回 "已完成：目标设定"并附上产物摘要。`,
  },
  {
    id: 'creative_concept',
    title: '生成 Big Idea',
    description: '基于品牌DNA、Brand Concept和目标设定，生成Campaign核心创意概念（Big Idea），并用 DDB ROI 和李奥贝纳 Inherent Drama 评估',
    toolName: 'ma-creative-concept',
    minArtifactLength: 300,
    requiredFiles: ['big-idea.md', 'creative-directions.md'],
    artifactRequirements: [
      { name: '核心创意', aliases: ['Big Idea', '核心概念', '创意概念', '传播主张', '大创意'] },
      { name: '创意方向', aliases: ['创意方向', '视觉方向', '文案方向', '内容方向', '媒介建议'] },
      { name: '推荐方案', aliases: ['推荐', '最优方案', '首选', '主推方案', '最终选择'] },
      { name: '品牌戏剧性', aliases: ['戏剧性', 'inherent drama', '人性冲突', '情感张力'] },
      { name: '相关性', aliases: ['relevance', '相关性', '品牌相关', '用户相关'] },
      { name: '原创性', aliases: ['originality', '原创性', '差异化', '新颖'] },
      { name: '影响力', aliases: ['impact', '影响力', '传播力', '记忆度'] },
    ],
    agentPrompt: `## 步骤 7: 生成 Big Idea

目标：基于品牌DNA、Brand Concept和目标设定，生成3个创意方向并推荐最优方案。评估标准参考 DDB ROI 创意原则（Relevance / Originality / Impact）和李奥贝纳 Inherent Drama（品牌内在戏剧性）。

产出框架：
1. **Big Idea**：一句话能说清的核心创意概念
2. **传播主张**：Hero Message / 传播主题
3. **品牌戏剧性（Inherent Drama）**：
   - 品牌或产品中天然存在的人性冲突/情感张力
   - 不是人为制造的噱头，而是品牌与用户之间真实的戏剧性关系
4. **DDB ROI 评估**：每个创意方向必须给出 1-10 分的三项评分
   - Relevance（相关性）：与品牌/产品/用户的关联度
   - Originality（原创性）：与竞品传播的差异化
   - Impact（影响力）：能否引发注意、讨论和记忆
5. **推荐方案及理由**：明确推荐哪个方向，并说明 ROI 和戏剧性优势

执行要求：
1. 使用 ma-creative-concept 工具生成创意概念
2. 产出必须保存到：\`creative-concept/\`
3. 文件命名建议：\`big-idea.md\`、\`creative-directions.md\`
4. 完成标准（校验时会检查）：
   - big-idea.md 必须包含核心创意概念、传播主张、创意钩子、品牌戏剧性（至少300字）
   - creative-directions.md 必须包含3个方向、每个方向的 ROI 评分及推荐（至少300字）
   - 必须明确推荐最优方案及理由

前置产物：\`brand-dna/\`、\`brand-concept/\`、\`goal-setting/\` 目录中的文件
完成后，请返回 "已完成：Big Idea 生成"并附上产物摘要。`,
  },
  {
    id: 'platform_matrix',
    title: '设计平台矩阵',
    description: '根据创意概念和TA画像，设计多平台内容分发矩阵和角色分工',
    toolName: 'ma-platform-role-mapper',
    minArtifactLength: 300,
    artifactRequirements: [
      { name: '平台角色', aliases: ['平台角色', '平台定位', '平台策略', '内容角色', '分发策略'] },
      { name: 'KPI', aliases: ['KPI', '指标', '目标', '考核', '效果指标'] },
      { name: '预算分配', aliases: ['预算', '分配', '预算比例', '预算分配', '资源分配'] },
      { name: '内容排期', aliases: ['排期', '日历', '排期表', '时间线', '内容日历'] },
    ],
    agentPrompt: `## 步骤 8: 设计平台矩阵

目标：基于 Big Idea 和 TA 画像，为每个平台分配内容角色、KPI 和预算比例。

执行要求：
1. 使用 ma-platform-role-mapper 工具设计平台矩阵
2. 产出必须保存到：\`platform-matrix/\`
3. 文件命名建议：\`platform-matrix.md\`、\`content-calendar.md\`
4. 完成标准（校验时会检查）：
   - platform-matrix.md 必须包含各平台角色、内容类型、发布频率、KPI、预算分配（至少300字）
   - content-calendar.md 必须包含首月内容排期（至少300字）

前置产物：\`creative-concept/\` 目录中的 Big Idea 文件
完成后，请返回 "已完成：平台矩阵设计"并附上产物摘要。`,
  },
  {
    id: 'kol_pyramid',
    title: '设计 KOL 金字塔',
    description: '根据预算、平台矩阵和品牌人格，设计 KOL 合作金字塔与达人形象角色矩阵',
    toolName: 'ma-kol-pyramid',
    minArtifactLength: 300,
    requiredFiles: ['kol-pyramid.md', 'kol-role-matrix.md'],
    artifactRequirements: [
      { name: '金字塔结构', aliases: ['金字塔', '层级', '头部', '腰部', '尾部', '比例'] },
      { name: '预算分配', aliases: ['预算', '预算分配', '预算比例', '费用', '投入'] },
      { name: '筛选标准', aliases: ['筛选', '标准', '要求', '条件', '粉丝量', '互动率'] },
      { name: '达人角色', aliases: ['角色', '形象角色', '品牌人格', '人设', '形象匹配'] },
      { name: '形象匹配', aliases: ['形象契合', '调性契合', '品牌调性', '人格匹配'] },
    ],
    agentPrompt: `## 步骤 9: 设计 KOL 金字塔

目标：基于总预算 {budget} 元、平台矩阵、目标人群和品牌人格，设计头部/腰部/尾部 KOL 金字塔，并明确各层级达人承担的"形象角色"。

产出框架：
1. **金字塔结构**：头部 / 腰部 / 尾部（KOC）的比例、数量、预算分配
2. **筛选标准**：粉丝画像匹配度、互动率、垂类匹配度、内容质量、履约稳定性
3. **达人形象角色矩阵**：
   - 每个层级应承担的形象角色（如头部 = 品牌背书者 / 腰部 = 场景种草者 / KOC = 真实体验者）
   - 该角色与品牌人格（Brand Personality）的匹配逻辑
   - 参考 BBDO 产品形象 × 用户形象连接：达人形象应能放大品牌人格
4. **平台与层级分工**：各平台主攻哪个层级，理由是什么
5. **预算约束**：总预算分配不超过 {budget} 元

执行要求：
1. 使用 ma-kol-pyramid 工具设计 KOL 金字塔
2. 产出必须保存到：\`kol-pyramid/\`
3. 文件命名建议：\`kol-pyramid.md\`、\`kol-tier-spec.md\`、\`kol-role-matrix.md\`
4. 完成标准（校验时会检查）：
   - kol-pyramid.md 必须包含各层级比例、数量、预算分配、筛选标准（至少300字）
   - kol-role-matrix.md 必须包含达人形象角色、与品牌人格的匹配逻辑、各平台分工（至少300字）
   - 总预算分配不超过 {budget} 元

前置产物：\`platform-matrix/\`、\`brand-concept/\` 目录中的文件
完成后，请返回 "已完成：KOL 金字塔设计"并附上产物摘要。`,
  },
  {
    id: 'search_kols',
    title: '筛选候选达人',
    description: '基于 KOL 金字塔参数，从蒲公英平台采集并筛选符合形象角色与调性契合度的候选达人',
    toolName: 'ma-kol-scraper',
    minArtifactLength: 300,
    artifactRequirements: [
      { name: '搜索条件', aliases: ['搜索', '筛选', '条件', '参数', '筛选标准'] },
      { name: 'KOL 列表', aliases: ['KOL', '达人', '博主', '候选人', '推荐列表'] },
      { name: '推荐理由', aliases: ['推荐理由', '匹配度', '分析', '评估', '为什么'] },
      { name: '形象契合', aliases: ['形象契合', '形象匹配', '品牌人格', '调性契合', '人设'] },
      { name: '历史审阅', aliases: ['历史审阅', '履约评估', '合作历史', '风险评估', '过往内容'] },
    ],
    agentPrompt: `## 步骤 10: 筛选候选达人

目标：基于 KOL 金字塔参数（平台、类目、粉丝量级、预算范围、形象角色），使用 ma-kol-scraper skill 通过蒲公英平台采集并筛选候选达人。

执行要求：
1. 使用 ma-kol-scraper skill 通过 CDP 连接 Chrome，从蒲公英博主广场按参数搜索筛选候选 KOL
2. 对重点达人，从详情页评估：
   - 近 10-20 条内容质量与风格稳定性
   - 过往品牌合作数据
   - 达人数据分析（粉丝画像、数据表现等）
3. 筛选结果必须保存到：\`kol-search/\`
4. 文件命名建议：\`kol-search-results.md\`、\`kol-shortlist.md\`
5. 完成标准（校验时会检查）：
   - kol-search-results.md 必须包含搜索条件、筛选逻辑、KOL 列表（至少300字）
   - kol-shortlist.md 必须包含精选推荐及推荐理由（至少300字）
   - 每位 KOL 推荐理由必须包含：数据匹配度、形象契合度、调性契合度、历史数据摘要
   - 每位 KOL 信息包含：ID、名称、平台、粉丝量、互动率、类目、报价、城市

前置产物：\`kol-pyramid/\` 目录中的 KOL 金字塔与形象角色矩阵文件
完成后，请返回 "已完成：候选达人筛选"并附上产物摘要。`,
  },
  {
    id: 'add_to_pool',
    title: '加入候选池',
    description: '将筛选出的达人从数据库导入 Campaign 候选池，并设置初始状态',
    toolName: 'ma-campaign-agent',
    minArtifactLength: 100,
    artifactRequirements: [
      { name: '导入记录', aliases: ['导入', '加入', '候选池', '导入记录', '导入日志'] },
      { name: 'KOL ID', aliases: ['KOL ID', '达人ID', 'ID列表', 'kol_id', '编号'] },
      { name: '导入结果', aliases: ['成功', '失败', '跳过', '结果', '状态'] },
    ],
    agentPrompt: `## 步骤 11: 将达人加入候选池

目标：将上一步筛选出的候选 KOL 从数据库导入当前 Campaign 候选池。

执行要求：
1. 使用 ma-campaign-agent 的 ma_campaign_kol_add 功能（不是 kol_status！）
2. 提供 kol_ids 参数（逗号分隔的 KOL ID 列表，从 kol-search-results.md 中提取）
3. 导入完成后，调用 ma_campaign_kol_list 确认导入结果
4. 记录保存到：\`kol-search/\`
5. 文件命名建议：\`pool-import-log.md\`
6. 完成标准（校验时会检查）：
   - pool-import-log.md 必须包含导入时间、KOL ID 列表、成功/失败数、导入后候选池总数（至少100字）
   - 所有目标 KOL 都已出现在候选池中（status = candidate）
   - 已存在的 KOL 会被跳过（不会重复导入）

前置产物：\`kol-search/\` 目录中的搜索结果文件
完成后，请返回 "已完成：达人导入候选池"并附上导入摘要。`,
  },
  {
    id: 'generate_briefs',
    title: '生成达人 Brief',
    description: '为每个已确认的达人生成个性化的合作 Brief，以 JTBD 任务规格与四力模型为策略内核，包含内容方向、Tone & Manner、品牌戏剧性植入、合规检查与交付物',
    toolName: 'ma-creative-pilot',
    minArtifactLength: 300,
    artifactRequirements: [
      { name: 'Brief 索引', aliases: ['Brief', '索引', 'briefs', '清单', '列表'] },
      { name: 'JTBD 任务陈述', aliases: ['任务陈述', 'JTBD', '待办任务', 'job spec', '雇用'] },
      { name: '四力分析', aliases: ['四力', '推力', '拉力', 'forces', '阻碍'] },
      { name: '内容方向', aliases: ['内容方向', '内容策略', '关键信息', '信息点', '核心信息'] },
      { name: 'Tone & Manner', aliases: ['tone', 'manner', '调性', '语气', '语言风格'] },
      { name: '品牌戏剧性', aliases: ['戏剧性', 'inherent drama', '情感张力', '冲突', '植入点'] },
      { name: '合规检查', aliases: ['合规', '广告法', '禁用词', '平台规范', '审核'] },
      { name: '交付物', aliases: ['交付物', '交付清单', '要求', '产出', '作品'] },
      { name: '时间线', aliases: ['时间', '时间线', '节点', 'deadline', '截止日期'] },
    ],
    agentPrompt: `## 步骤 12: 生成达人 Brief

目标：为当前 Campaign 候选池中的每位已确认达人（status = confirmed）生成个性化 Brief。Brief 以 JTBD（Jobs-to-be-Done）任务规格和四力模型为策略内核——先想清楚目标用户"雇用"产品/内容来完成什么任务、是什么力量在推动或阻碍他们，再展开内容方向、Tone & Manner、品牌戏剧性植入点、合规要求和交付标准。

产出框架（每个 brief-{kol-id}.md 必须包含）：
1. **JTBD 任务陈述（Job Spec）**：
   - 任务陈述：当【情境】时，目标用户想要【动机/期望结果】，以便【功能/情感/社会层面的收益】
   - 三维度拆解：功能维度（要完成什么实际任务）、情感维度（想获得/摆脱什么感受）、社会维度（希望被他人如何看待）
   - 跨品类竞争集：用户不选我们时会"雇用"什么替代品（不限于同类品牌，可能是完全不同品类的方案）
   - 障碍与焦虑：用户在尝试新方案时担心什么（价格、效果、麻烦程度、社交风险等）
   - 关键取舍：用户愿意为哪个维度牺牲另一个维度
2. **四力分析（Forces of Progress）**：
   - 推力：现有方案的哪些不满把用户推向新选择 → 内容要放大什么场景痛点
   - 拉力：新方案的哪些吸引力把用户拉过来 → 内容要突出什么收益与憧憬
   - 惯性：哪些旧习惯让用户原地不动 → 内容要降低什么改变成本
   - 焦虑：哪些担忧让用户不敢尝试 → 内容要提供什么保证/证据来消解
   - 每种力量都要落到该达人内容中的具体动作（说什么、演什么、展示什么）
3. **内容方向**：核心信息、内容角度、必须呈现的场景/卖点（须与任务陈述和四力映射一致）
4. **Tone & Manner 校准**：
   - 该达人的语言风格如何适配品牌全局调性
   - 可说的话 / 不可说的话（禁忌词、敏感表达）
   - 参考 ma-tone-manner 中定义的品牌声音
5. **品牌戏剧性植入点（Inherent Drama）**：
   - 本次内容要呈现的人性冲突/情感张力（应与四力中的推力/焦虑呼应）
   - 品牌在这个冲突中扮演的角色
   - 达人如何自然地带出这个戏剧性
6. **合规检查清单**：
   - 平台规范（小红书/抖音等）
   - 广告法禁用词（最、第一、纯天然等）
   - 必须标注的利益关系声明
7. **交付物清单**：图文/视频数量、封面要求、话题标签、是否需要露出产品包装等
8. **时间线**：发布节点、审稿节点、修改截止时间

执行要求：
1. 使用 ma-creative-pilot 工具生成 Brief
2. 可调用 ma-script-studio 为重要达人生成故事脚本/分镜（可选）
3. 产出必须保存到：\`briefs/\`
4. 文件命名建议：\`briefs-index.md\`、\`brief-{kol-id}.md\`（每位达人单独一个文件）
5. 结构化落库：每位达人的 Brief 保存时，调用 ma_campaign_brief_update 并额外传入两个字段：
   - \`job_spec\`：JSON 字符串，包含 functional/emotional/social 三维任务陈述、competing_solutions（跨品类竞争集）、anxieties（障碍与焦虑）、tradeoffs（关键取舍）
   - \`forces_map\`：JSON 字符串，包含 push/pull/inertia/anxiety 四力及其对应的内容动作
6. 完成标准（校验时会检查）：
   - briefs-index.md 必须包含所有已确认 KOL 列表、Brief 状态、交付时间线（至少300字）
   - 每个 brief-{kol-id}.md 必须包含：JTBD 任务陈述、四力分析、内容方向、Tone & Manner、品牌戏剧性植入点、合规检查、交付物清单、时间节点（至少300字）
   - 每位达人的 Brief 都体现其个人风格和受众特点，且任务陈述与该达人的受众情境匹配

前置产物：\`brand-concept/\`、\`creative-concept/\`、\`kol-search/\` 目录中的文件
完成后，请返回 "已完成：达人 Brief 生成"并附上产物摘要。`,
  },
  {
    id: 'ab_test',
    title: '投放测试、阶段复盘与放量决策',
    description: '设计 A/B 测试方案，并预设阶段复盘框架、调优规则与放量/止损决策标准',
    toolName: 'ma-campaign-tester',
    minArtifactLength: 300,
    requiredFiles: ['ab-test-plan.md', 'ab-test-review.md', 'scale-up-plan.md'],
    artifactRequirements: [
      { name: '测试变量', aliases: ['变量', '测试变量', 'A/B测试', '对比', '测试方案'] },
      { name: '分组方案', aliases: ['分组', '受众分组', '分组方案', '测试组', '对照组'] },
      { name: '指标', aliases: ['指标', 'KPI', '关键指标', '成功指标', '统计指标'] },
      { name: '样本量', aliases: ['样本量', '样本', '计算', '统计', '显著性'] },
      { name: '数据复盘', aliases: ['数据复盘', '阶段复盘', '复盘', '数据分析', '核心发现'] },
      { name: '调优方案', aliases: ['调优', '优化方案', '策略调整', '组合优化'] },
      { name: '放量决策', aliases: ['放量', '放量决策', 'go/no-go', 'scale', '正式投放'] },
    ],
    agentPrompt: `## 步骤 13: 投放测试、阶段复盘与放量决策

目标：为 Campaign 设计 A/B 测试方案，并提前建立“测试 → 复盘 → 调优 → 放量/止损”的完整衔接机制。本步骤不能只停留在测试设计，还要明确测试结束后如何读取数据、如何判断是否放量、如何调整达人组合与预算。

产出框架：
1. **A/B 测试方案**（保存到 \`ab-test-plan.md\`）
   - 测试假设与目标：要验证的核心问题（如“腰部达人 vs KOC 的 CPE 差异”）
   - 测试变量：每次只测一个变量，避免混淆
   - 分组方案：测试组 / 对照组、受众分配、达人数量
   - 核心指标与阈值：CPE、互动率、ROI、CTR 等；明确通过/不通过阈值
   - 样本量与统计显著性：最低样本量、检验功效、显著性水平
   - 测试预算与周期：建议为正式预算的 10-20%，周期 7-14 天
   - 止损线：如“前 3 天 CPE > 15 元即暂停该组”

2. **阶段复盘框架**（保存到 \`ab-test-review.md\`）
   - 数据回收清单：曝光、浏览、点赞、收藏、评论、转发、CPM、CPE、CTR、互动率
   - 分析维度：达人层级、平台、内容风格、发布时段、Brief 版本
   - 核心发现模板：最佳组合、表现不佳元素、异常值说明
   - 与目标的对比：哪些指标达成、哪些未达成、原因假设
   - 复盘触发条件：测试结束后自动调用 ma-phase-reviewer 生成阶段复盘报告

3. **调优与放量方案**（保存到 \`scale-up-plan.md\`）
   - 调优规则：基于测试数据的组合调整、预算重分配、内容策略调整
   - 放量决策标准：Go / No-go 的量化门槛（如“CPE < 5 元且 ROI > 1:3”则放量）
   - 正式投放方案：放量预算、达人组合比例、平台分配、时间线
   - 风险预案：效果稀释、达人档期、内容同质化等风险及应对措施
   - 若测试未达标：明确止损动作、预算回收、二次测试条件

执行要求：
1. 使用 ma-campaign-tester 工具设计 A/B 测试方案
2. 使用 ma-campaign-optimizer 工具生成测试后的调优规则与放量方案
3. 测试结束后，使用 ma-phase-reviewer 工具基于真实数据进行阶段复盘
4. 产出必须保存到：\`ab-test/\`
5. 文件命名建议：\`ab-test-plan.md\`、\`ab-test-review.md\`、\`scale-up-plan.md\`
6. 完成标准（校验时会检查）：
   - ab-test-plan.md 必须包含测试目标、变量、分组、指标、样本量、预算、周期、止损线（至少300字）
   - ab-test-review.md 必须包含数据回收清单、分析维度、核心发现模板、目标达成判定（至少300字）
   - scale-up-plan.md 必须包含调优规则、放量决策标准、正式投放方案、风险预案（至少300字）
   - 三份文件均与创意概念、平台矩阵、达人金字塔保持一致

前置产物：\`creative-concept/\`、\`platform-matrix/\`、\`kol-pyramid/\` 目录中的文件
完成后，请返回 "已完成：投放测试、阶段复盘与放量决策"并附上产物摘要。`,
  },
  {
    id: 'generate_video_assets',
    title: '生成广告视频素材',
    description: '基于创意概念和文案，生成可投放的多平台广告视频（支持 Seedance / MiniMax H3）',
    toolName: 'ma-video-creative',
    minArtifactLength: 300,
    requiredFiles: ['video-assets.md'],
    artifactRequirements: [
      { name: '创意方向', aliases: ['创意方向', '视频创意', '脚本', '分镜'] },
      { name: '分镜脚本', aliases: ['分镜', 'storyboard', '镜头', '景', 'scene'] },
      { name: '平台适配', aliases: ['平台', 'aspect_ratio', '尺寸', '分辨率', '抖音', '小红书'] },
      { name: '生成引擎', aliases: ['Seedance', 'MiniMax', '引擎', '生成方式', 'H3'] },
      { name: '生成参数', aliases: ['prompt', '提示词', '时长', 'duration', '首帧'] },
    ],
    agentPrompt: `## 步骤 14: 生成广告视频素材

目标：基于创意概念、品牌 DNA 和达人 Brief，为 Campaign 生成可投放的多平台广告视频。

执行框架：
1. **视频创意脚本**：
   - 基于 Big Idea 拆解为 5-30 秒的短视频脚本
   - 单镜不超过 10 秒（受 AI 视频生成引擎限制）
   - 每个镜头包含：画面描述、旁白、字幕、首帧提示词
2. **平台适配**：
   - 根据投放平台选择宽高比（小红书 3:4 / 抖音 9:16 / B站 16:9）
   - 前 3 秒必须有强 Hook
3. **引擎选择**：
   - 人物出镜 / 抖音内容 → Seedance（字节生态优化）
   - 大运动 / 物理特效 → MiniMax H3
4. **一键流水线（推荐）**：
   - 调用内置工具 \`video_pipeline\`，传入产品信息/卖点/平台/时长/引擎，自动完成 分镜→生成→拼接成片
   - 产物自动落到当前工作区的 \`video-assets/\` 目录（raw=分镜片段, final=成片）

执行要求：
1. 优先调用 \`video_pipeline\` 工具一键生成；若需精细控制可先用 ma-video-creative 生成分镜脚本后再逐镜生成
2. 产物必须保存到：\`video-assets/\`
3. 文件命名建议：\`video-assets.md\`（记录创意方向/引擎/生成参数）、\`raw/\`、\`final/\`
4. 完成标准（校验时会检查）：
   - video-assets.md 必须包含创意方向、分镜脚本、平台适配、引擎选择、生成参数（至少300字）

前置产物：\`creative-concept/\`、\`platform-matrix/\` 目录中的文件
完成后，请返回 "已完成：广告视频素材生成"并附上产物摘要。`,
  },
]

// =====================================================================
// 目录和文件管理
// =====================================================================

/**
 * 解析 Campaign 工作流产物的根目录。
 *
 * - 若该 Campaign 在创建时指定了本地项目文件夹（workspace 绑定了 rootPath），
 *   则产物统一存放在 `<项目文件夹>/campaign-{id}/` 子目录，便于用户直接查看。
 * - 否则退回默认内部隔离目录 `~/.proma-mit/agent-workspaces/campaign-{id}/`。
 *
 * 注意：运行状态文件（campaign-workflow.json、.context/）始终存放在内部隔离目录
 *（由 getAgentWorkspacePath(slug) 返回），与产物分离。
 */
function getCampaignArtifactsRoot(campaignId: string): string {
  const slug = `campaign-${campaignId}`
  const ws = listAgentWorkspaces().find((w) => w.slug === slug)
  if (ws?.rootPath) {
    const dir = join(ws.rootPath, slug)
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true })
    }
    return dir
  }
  return getAgentWorkspacePath(slug)
}

/** 确保所有标准 artifact 目录存在 */
function ensureArtifactDirs(campaignId: string): void {
  const baseDir = getCampaignArtifactsRoot(campaignId)
  for (const dir of ARTIFACT_DIRS) {
    const dirPath = join(baseDir, dir)
    if (!existsSync(dirPath)) {
      mkdirSync(dirPath, { recursive: true })
      console.log(`[CampaignWorkflow] 已创建目录: ${dirPath}`)
    }
  }
}

/** 生成 todo.md 内容 */
function generateTodoMarkdown(workflow: CampaignWorkflow): string {
  const lines: string[] = [
    '# Campaign 工作流 Todo',
    '',
    `Campaign ID: ${workflow.campaignId}`,
    `创建时间: ${new Date(workflow.createdAt).toLocaleString()}`,
    `更新时间: ${new Date(workflow.updatedAt).toLocaleString()}`,
    '',
  ]

  // 当前步骤
  const currentStep = workflow.currentStepIndex >= 0 ? workflow.steps[workflow.currentStepIndex] : null
  if (currentStep && currentStep.status === 'in_progress') {
    lines.push('## 🔵 当前步骤', '')
    lines.push(`- [ ] **步骤 ${workflow.currentStepIndex + 1}**: ${currentStep.title} (${currentStep.toolName})`)
    lines.push(`  - 描述: ${currentStep.description}`)
    lines.push(`  - 产物目录: \`${STEP_DIR_MAP[currentStep.id]}\``)
    lines.push('')
  }

  // 已完成
  const completed = workflow.steps.filter((s) => s.status === 'completed')
  if (completed.length > 0) {
    lines.push('## ✅ 已完成', '')
    for (const step of completed) {
      const idx = workflow.steps.indexOf(step) + 1
      lines.push(`- [x] **步骤 ${idx}**: ${step.title}`)
      if (step.outputSummary) {
        lines.push(`  - 产出: ${step.outputSummary}`)
      }
      if (step.completedAt) {
        lines.push(`  - 完成于: ${new Date(step.completedAt).toLocaleString()}`)
      }
      lines.push(`  - 产物目录: \`${STEP_DIR_MAP[step.id]}\``)
    }
    lines.push('')
  }

  // 待完成
  const pending = workflow.steps.filter((s) => s.status !== 'completed' && s.status !== 'skipped')
  if (pending.length > 0) {
    lines.push('## ⏳ 待完成', '')
    for (const step of pending) {
      const idx = workflow.steps.indexOf(step) + 1
      const icon = step.status === 'in_progress' ? '🔵' : '⭕'
      lines.push(`${icon} **步骤 ${idx}**: ${step.title} (${step.toolName})`)
      lines.push(`   描述: ${step.description}`)
      lines.push(`   产物目录: \`${STEP_DIR_MAP[step.id]}\``)
      lines.push('')
    }
  }

  // 已跳过
  const skipped = workflow.steps.filter((s) => s.status === 'skipped')
  if (skipped.length > 0) {
    lines.push('## ⏭️ 已跳过', '')
    for (const step of skipped) {
      const idx = workflow.steps.indexOf(step) + 1
      lines.push(`- **步骤 ${idx}**: ${step.title}`)
    }
    lines.push('')
  }

  // 产物目录索引
  lines.push('## 📁 产物目录索引', '')
  for (const dir of ARTIFACT_DIRS) {
    if (dir === '.context') continue
    lines.push(`- \`${dir}/\` — ${getDirDescription(dir)}`)
  }
  lines.push('')

  // 使用说明
  lines.push('## 📝 使用说明', '')
  lines.push('1. 点击"执行此步骤"按钮，Agent 会自动执行该步骤')
  lines.push('2. 执行完成后，点击"标记完成"或让 Agent 自动回写状态')
  lines.push('3. 如果需要调整已完成的步骤，点击"重新执行"或"调整此步骤"')
  lines.push('4. 所有产物文件保存在对应的目录中')
  lines.push('')

  return lines.join('\n')
}

function getDirDescription(dir: string): string {
  const desc: Record<string, string> = {
    'market-analysis': '市场分析文档（市场规模/品类趋势/品类痛点）',
    'competitor-analysis': '竞品分析文档（竞品矩阵/竞争格局/差异化策略）',
    'user-analysis': '用户分析文档（TA画像/搜索习惯/关键词）',
    'brand-dna': '品牌DNA + 品牌诊断（品牌阶段/产品现状/核心问题/核心目标）',
    'brand-concept': '品牌概念产出（愿景/价值观/品牌屋/Tone/Visual）',
    'goal-setting': '目标设定（总目标/分层目标/量化指标）',
    'creative-concept': '核心创意概念（Big Idea）',
    'platform-matrix': '平台内容分发矩阵',
    'kol-pyramid': 'KOL 合作金字塔方案',
    'kol-search': '候选达人搜索结果',
    'briefs': 'KOL 个性化 Brief',
    'ab-test': 'A/B 测试设计方案',
    'video-assets': '广告视频素材（分镜脚本/生成参数/视频产物）',
  }
  return desc[dir] ?? '产物目录'
}

/** 更新所有工作区文件 */
function syncWorkspaceFiles(workflow: CampaignWorkflow): void {
  try {
    const slug = `campaign-${workflow.campaignId}`
    const baseDir = getAgentWorkspacePath(slug)
    const contextDir = join(baseDir, '.context')

    // 1. 确保目录存在
    ensureArtifactDirs(workflow.campaignId)

    // 2. 更新 todo.md
    writeFileSync(join(contextDir, 'todo.md'), generateTodoMarkdown(workflow), 'utf-8')

    // 3. 更新 campaign.md（如果还没创建）
    const campaignMdPath = join(contextDir, 'campaign.md')
    if (!existsSync(campaignMdPath)) {
      writeFileSync(campaignMdPath, generateCampaignMdPlaceholder(workflow), 'utf-8')
    }
  } catch (err) {
    // todo.md / campaign.md 的同步失败不应阻断工作流加载（例如磁盘满、目录只读、绑定的本地文件夹失效）。
    // 仅记录告警，工作流仍以内存中的状态返回，UI 降级为只读展示。
    console.warn('[CampaignWorkflow] 同步工作区文件失败（忽略，不影响工作流读取）:', err)
  }
}

function generateCampaignMdPlaceholder(workflow: CampaignWorkflow): string {
  return `# Campaign 上下文

Campaign ID: ${workflow.campaignId}

## 基本信息

- 品牌:
- 平台:
- 总预算:
- 投放周期:
- 目标城市:
- 目标人群:

## 工作流进度

${workflow.steps.map((s, i) => `- ${s.status === 'completed' ? '[x]' : '[ ]'} 步骤 ${i + 1}: ${s.title}`).join('\n')}

## 产物目录

\`\`\`
market-analysis/      — 市场分析（市场规模/品类趋势/品类痛点）
competitor-analysis/  — 竞品分析（竞品矩阵/竞争格局/差异化策略）
user-analysis/        — 用户分析（TA画像/搜索习惯/关键词）
brand-dna/            — 品牌DNA + 品牌诊断（品牌阶段/产品现状/核心问题/核心目标）
brand-concept/        — 品牌概念（愿景/价值观/品牌屋/Tone/Visual）
goal-setting/         — 目标设定（总目标/分层目标/量化指标）
creative-concept/     — 创意概念（Big Idea）
platform-matrix/      — 平台矩阵
kol-pyramid/          — KOL 金字塔
kol-search/           — 达人搜索
briefs/               — KOL Briefs
ab-test/              — A/B 测试
video-assets/         — 广告视频（创意/分镜/生成参数）
\`\`\`

## 历史记录

见 history.md
`
}

// =====================================================================
// 工作流文件路径
// =====================================================================

function getWorkflowPath(campaignId: string): string {
  const slug = `campaign-${campaignId}`
  return join(getAgentWorkspacePath(slug), 'campaign-workflow.json')
}

// =====================================================================
// 初始化工作流
// =====================================================================

function createDefaultWorkflow(campaignId: string): CampaignWorkflow {
  const now = Date.now()
  return {
    campaignId,
    currentStepIndex: -1,
    steps: DEFAULT_WORKFLOW_STEPS.map((step) => ({
      ...step,
      status: 'pending' as const,
      agentPrompt: step.agentPrompt,
    })),
    createdAt: now,
    updatedAt: now,
  }
}

// =====================================================================
// 读写工作流
// =====================================================================

export function loadCampaignWorkflow(campaignId: string): CampaignWorkflow {
  const path = getWorkflowPath(campaignId)

  if (existsSync(path)) {
    // readJsonFileSafe 自带 .tmp/.bak 多层恢复；返回 null 说明所有恢复路径均失败
    const workflow = readJsonFileSafe<CampaignWorkflow>(path)
    if (workflow && Array.isArray(workflow.steps)) {
      // 如果步骤数量不匹配（版本升级），需要合并/更新
      if (workflow.steps.length !== DEFAULT_WORKFLOW_STEPS.length) {
        const migrated = migrateWorkflow(workflow, campaignId)
        syncWorkspaceFiles(migrated)
        return migrated
      }
      // 确保目录和 todo.md 存在（旧 Campaign 兼容）
      syncWorkspaceFiles(workflow)
      return workflow
    }
    // 文件存在但无法恢复：先备份损坏文件再重建，避免用户进度被静默覆盖
    backupCorruptWorkflowFile(path, campaignId)
  }

  const workflow = createDefaultWorkflow(campaignId)
  try {
    saveWorkflow(workflow)
  } catch (err) {
    // 写盘失败（磁盘满 / 权限不足 / 目录被占用）时仍返回内存中的默认工作流，避免 UI 直接「加载失败」。
    console.error('[CampaignWorkflow] 新建工作流写盘失败（返回内存默认值）:', err)
  }
  syncWorkspaceFiles(workflow)
  return workflow
}

/** 备份损坏的工作流文件（.corrupt-{ts}），便于事后人工恢复 */
function backupCorruptWorkflowFile(path: string, campaignId: string): void {
  try {
    const backupPath = `${path}.corrupt-${Date.now()}`
    copyFileSync(path, backupPath)
    console.error(`[CampaignWorkflow] 工作流文件损坏，已备份到 ${backupPath} 后重建: ${campaignId}`)
  } catch (err) {
    console.error(`[CampaignWorkflow] 损坏文件备份失败，直接重建: ${campaignId}`, err)
  }
}

export function saveWorkflow(workflow: CampaignWorkflow): void {
  const path = getWorkflowPath(workflow.campaignId)
  workflow.updatedAt = Date.now()
  // 原子写入（tmp+rename，自动保留 .bak），防止崩溃时截断工作流文件
  writeJsonFileAtomic(path, workflow as unknown as object)
  // 同步更新 todo.md 等文件
  syncWorkspaceFiles(workflow)
}

/** 工作流版本迁移：新增步骤时保留已有状态 */
function migrateWorkflow(old: CampaignWorkflow, campaignId: string): CampaignWorkflow {
  const now = Date.now()
  const stepMap = new Map(old.steps.map((s) => [s.id, s]))
  const oldCurrentStepId = old.currentStepIndex >= 0 ? old.steps[old.currentStepIndex]?.id : undefined
  const newSteps: CampaignWorkflowStep[] = DEFAULT_WORKFLOW_STEPS.map((defaultStep) => {
    const existing = stepMap.get(defaultStep.id)
    if (existing) {
      // 步骤定义（title/description/agentPrompt/artifactRequirements/toolName/minArtifactLength）
      // 从代码更新，确保已有 Campaign 也能使用新的步骤定义
      // 状态性字段（status/completedAt/outputSummary/notes）保留旧值
      return {
        ...defaultStep,
        status: existing.status,
        completedAt: existing.completedAt,
        outputSummary: existing.outputSummary,
        notes: existing.notes,
      }
    }
    return { ...defaultStep, status: 'pending' as const }
  })
  const migratedCurrentIndex = resolveMigratedCurrentStepIndex(newSteps, oldCurrentStepId)

  const workflow: CampaignWorkflow = {
    campaignId,
    currentStepIndex: migratedCurrentIndex,
    steps: newSteps,
    createdAt: old.createdAt,
    updatedAt: now,
  }
  try {
    saveWorkflow(workflow)
  } catch (err) {
    // 迁移写盘失败时返回内存结果，避免旧版本 Campaign 因磁盘/权限问题打不开。
    console.error('[CampaignWorkflow] 工作流迁移写盘失败（返回内存迁移结果）:', err)
  }
  return workflow
}

function resolveMigratedCurrentStepIndex(
  steps: CampaignWorkflowStep[],
  oldCurrentStepId: CampaignWorkflowStepId | undefined,
): number {
  if (oldCurrentStepId) {
    const sameStepIndex = steps.findIndex((step) => step.id === oldCurrentStepId)
    if (sameStepIndex >= 0 && steps[sameStepIndex]?.status === 'in_progress') {
      return sameStepIndex
    }
  }

  const inProgressIndex = steps.findIndex((step) => step.status === 'in_progress')
  if (inProgressIndex >= 0) return inProgressIndex

  const nextPendingIndex = steps.findIndex((step) => step.status === 'pending' || step.status === 'failed')
  return nextPendingIndex >= 0 ? nextPendingIndex : -1
}

// =====================================================================
// 工作流操作
// =====================================================================

/** 更新单个步骤状态 */
export function updateWorkflowStep(input: UpdateWorkflowStepInput): CampaignWorkflow {
  const workflow = loadCampaignWorkflow(input.campaignId)
  const stepIndex = workflow.steps.findIndex((s) => s.id === input.stepId)
  if (stepIndex === -1) {
    throw new Error(`步骤不存在: ${input.stepId}`)
  }

  const step = workflow.steps[stepIndex]!
  if (input.status !== undefined) {
    step.status = input.status
    if (input.status === 'completed') {
      step.completedAt = Date.now()
      // 如果完成了当前步骤，自动推进到下一步
      if (workflow.currentStepIndex === stepIndex) {
        workflow.currentStepIndex = Math.min(stepIndex + 1, workflow.steps.length - 1)
      }
    } else if (input.status === 'in_progress') {
      workflow.currentStepIndex = stepIndex
    }
  }
  if (input.outputSummary !== undefined) step.outputSummary = input.outputSummary
  if (input.notes !== undefined) step.notes = input.notes

  saveWorkflow(workflow)
  return workflow
}

/** 推进到指定步骤 */
export function advanceWorkflow(input: AdvanceWorkflowInput): CampaignWorkflow {
  const workflow = loadCampaignWorkflow(input.campaignId)
  const stepIndex = workflow.steps.findIndex((s) => s.id === input.stepId)
  if (stepIndex === -1) {
    throw new Error(`步骤不存在: ${input.stepId}`)
  }

  // 标记当前步骤为完成
  workflow.steps[stepIndex]!.status = 'completed'
  workflow.steps[stepIndex]!.completedAt = Date.now()

  // 推进到下一步
  const nextIndex = workflow.steps.findIndex((s) => s.id === input.nextStepId)
  if (nextIndex !== -1) {
    workflow.currentStepIndex = nextIndex
    workflow.steps[nextIndex]!.status = 'in_progress'
  }

  saveWorkflow(workflow)
  return workflow
}

/** 重置工作流 */
export function resetWorkflow(campaignId: string): CampaignWorkflow {
  const workflow = createDefaultWorkflow(campaignId)
  saveWorkflow(workflow)
  return workflow
}

/** 获取某步骤的 Agent 提示词（支持模板替换） */
export function getStepAgentPrompt(
  campaignId: string,
  stepId: CampaignWorkflowStepId,
  context?: Record<string, string>,
): string {
  const workflow = loadCampaignWorkflow(campaignId)
  const step = workflow.steps.find((s) => s.id === stepId)
  if (!step) return ''

  let prompt = step.agentPrompt
  if (context) {
    for (const [key, value] of Object.entries(context)) {
      prompt = prompt.replace(new RegExp(`\\{${key}\\}`, 'g'), value)
    }
  }

  // 带 requiredFiles 的步骤：追加「落盘硬约束」，强制模型真实调用 Write 工具写文件
  if (step.requiredFiles && step.requiredFiles.length > 0) {
    prompt += `\n\n${buildArtifactPersistenceDirective(STEP_DIR_MAP[stepId], step.requiredFiles)}`
  }

  return prompt
}

/** 获取当前活跃步骤 */
export function getCurrentStep(campaignId: string): CampaignWorkflowStep | null {
  const workflow = loadCampaignWorkflow(campaignId)
  if (workflow.currentStepIndex < 0) return null
  return workflow.steps[workflow.currentStepIndex] ?? null
}

/** 获取已完成步骤列表 */
export function getCompletedSteps(campaignId: string): CampaignWorkflowStep[] {
  const workflow = loadCampaignWorkflow(campaignId)
  return workflow.steps.filter((s) => s.status === 'completed')
}

/** 检查工作流是否全部完成 */
export function isWorkflowComplete(campaignId: string): boolean {
  const workflow = loadCampaignWorkflow(campaignId)
  return workflow.steps.every((s) => s.status === 'completed' || s.status === 'skipped')
}

/** 获取工作流进度百分比 */
export function getWorkflowProgress(campaignId: string): number {
  const workflow = loadCampaignWorkflow(campaignId)
  const completed = workflow.steps.filter(
    (s) => s.status === 'completed' || s.status === 'skipped',
  ).length
  return Math.round((completed / workflow.steps.length) * 100)
}

// =====================================================================
// 产物校验与历史记录
// =====================================================================

import { readdirSync } from 'node:fs'

/** 检查内容是否满足语义锚点要求（任一 alias 匹配即通过） */
function checkRequirement(content: string, req: import('@gravitas/shared').ArtifactRequirement): boolean {
  const lower = content.toLowerCase()
  return req.aliases.some((alias) => lower.includes(alias.toLowerCase()))
}

/** 判断文件是否像文本文件（基于扩展名） */
function isTextFile(filename: string): boolean {
  if (filename.startsWith('.')) return false
  const ext = filename.split('.').pop()?.toLowerCase() ?? ''
  if (!ext) return true // 无扩展名，尝试读取
  const textExts = ['md', 'txt', 'json', 'yaml', 'yml', 'csv', 'tsv', 'xml', 'html', 'css', 'js', 'ts']
  return textExts.includes(ext)
}

/** 读取目录下所有文本文件内容（递归） */
function readTextFiles(dirPath: string, options?: { recursive?: boolean }): { files: string[]; totalChars: number; combinedContent: string } {
  const files: string[] = []
  let totalChars = 0
  let combinedContent = ''

  if (!existsSync(dirPath)) return { files, totalChars, combinedContent }

  function scanDir(currentDir: string, prefix: string = '') {
    const entries = readdirSync(currentDir, { withFileTypes: true })
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name

      if (entry.isDirectory()) {
        if (options?.recursive) {
          scanDir(join(currentDir, entry.name), relativePath)
        }
      } else if (isTextFile(entry.name)) {
        const filePath = join(currentDir, entry.name)
        try {
          const content = readFileSync(filePath, 'utf-8')
          if (content.trim().length > 0) {
            files.push(relativePath)
            totalChars += content.trim().length
            combinedContent += content + '\n'
          }
        } catch (err) {
          console.error(`[CampaignWorkflow] 读取文件失败: ${filePath}`, err)
        }
      }
    }
  }

  scanDir(dirPath)
  return { files, totalChars, combinedContent }
}

/** 验证步骤产物（基础结构校验：目录、文件、长度、语义锚点） */
export function validateStepArtifacts(
  campaignId: string,
  stepId: CampaignWorkflowStepId,
): {
  valid: boolean
  files: string[]
  totalChars: number
  missing: string[]
  unmetRequirements: import('@gravitas/shared').ArtifactRequirement[]
} {
  const dirName = STEP_DIR_MAP[stepId]
  const artifactsRoot = getCampaignArtifactsRoot(campaignId)
  const dirPath = join(artifactsRoot, dirName)
  const workspaceRoot = artifactsRoot

  const missing: string[] = []
  const unmetRequirements: import('@gravitas/shared').ArtifactRequirement[] = []

  // 1. 检查目录存在
  if (!existsSync(dirPath)) {
    missing.push(`${dirName}/ 目录不存在`)
  }

  // 2. 读取目标目录文本文件（递归）
  let { files, totalChars, combinedContent } = readTextFiles(dirPath, { recursive: true })

  // 3. 如果目标目录为空，尝试在工作区根目录搜索相关文件（fallback）
  if (files.length === 0) {
    const rootResult = readTextFiles(workspaceRoot, { recursive: true })
    // 过滤出与步骤相关的文件（文件名包含步骤关键词）
    const stepKeywords = [dirName, stepId.replace('_', '-')]
    const relatedFiles = rootResult.files.filter((f) =>
      stepKeywords.some((kw) => f.toLowerCase().includes(kw.toLowerCase()))
    )
    if (relatedFiles.length > 0) {
      console.log(`[CampaignWorkflow] 在根目录找到相关文件: ${relatedFiles.join(', ')}`)
      files = relatedFiles
      totalChars = rootResult.totalChars
      combinedContent = rootResult.combinedContent
    }
  }

  // 4. 检查是否有文本文件
  if (files.length === 0) {
    missing.push(`${dirName}/ 目录中没有可读产物（文本文件）`)
  }

  // 5. 检查必需文件是否存在
  let requiredFiles: string[] = []
  try {
    const workflow = loadCampaignWorkflow(campaignId)
    const step = workflow.steps.find((s) => s.id === stepId)
    if (step?.requiredFiles) requiredFiles = step.requiredFiles
  } catch {
    // 忽略
  }

  for (const requiredFile of requiredFiles) {
    const exists = files.some((f) => f.toLowerCase() === requiredFile.toLowerCase())
    if (!exists) {
      missing.push(`${dirName}/ 缺少必需产物文件: ${requiredFile}`)
    }
  }

  // 6. 检查文件非空
  if (totalChars === 0) {
    missing.push(`${dirName}/ 目录中文件均为空`)
  }

  // 7. 加载工作流获取 minArtifactLength
  let minLength = 300
  try {
    const workflow = loadCampaignWorkflow(campaignId)
    const step = workflow.steps.find((s) => s.id === stepId)
    if (step?.minArtifactLength) minLength = step.minArtifactLength
  } catch {
    // 忽略，使用默认 300
  }

  // 8. 检查字数
  if (totalChars < minLength) {
    missing.push(`${dirName}/ 总字数 ${totalChars} 低于最低要求 ${minLength} 字`)
  }

  // 9. 检查语义锚点
  let requirements: import('@gravitas/shared').ArtifactRequirement[] = []
  try {
    const workflow = loadCampaignWorkflow(campaignId)
    const step = workflow.steps.find((s) => s.id === stepId)
    if (step?.artifactRequirements) requirements = step.artifactRequirements
  } catch {
    // 忽略
  }

  for (const req of requirements) {
    if (!checkRequirement(combinedContent, req)) {
      unmetRequirements.push(req)
      // 语义锚点为软校验：缺失仅作质量提醒，不进入 missing，不判定产物失败
    }
  }

  const valid = missing.length === 0

  return {
    valid,
    files,
    totalChars,
    missing,
    unmetRequirements,
  }
}

/** 判断消息是否为 assistant 消息（兼容 AgentMessage 的 role 与 SDKMessage 的 type） */
function isAssistantMessage(msg: unknown): boolean {
  if (!msg || typeof msg !== 'object') return false
  const record = msg as Record<string, unknown>
  return record.role === 'assistant' || record.type === 'assistant'
}

/**
 * 提取消息文本内容
 *
 * 兼容两种持久化格式：
 * - AgentMessage: { role, content: string }
 * - SDKMessage: { type, message: { content: [{ type: 'text', text }, ...] } }（Phase 4 之后 JSONL 实际格式）
 */
export function extractMessageText(msg: unknown): string {
  if (!msg || typeof msg !== 'object') return ''
  const record = msg as Record<string, unknown>
  // AgentMessage 格式
  if (typeof record.content === 'string') return record.content
  // SDKMessage 格式：拼接 text block（跳过 thinking / tool_use 等）
  const message = record.message as { content?: unknown } | undefined
  if (Array.isArray(message?.content)) {
    return (message.content as unknown[])
      .map((block) => {
        if (!block || typeof block !== 'object') return ''
        const b = block as { type?: unknown; text?: unknown }
        return b.type === 'text' && typeof b.text === 'string' ? b.text : ''
      })
      .filter(Boolean)
      .join('\n')
  }
  return ''
}

/**
 * 判断用户消息是否为指定步骤的执行/调整提示词
 *
 * 用于流式完成后自动推进工作流前的触发源校验：只有"执行此步骤 / 调整步骤"
 * 入口发送的消息才允许翻转工作流状态，防止同一会话中的闲聊误标步骤状态。
 */
export function isStepExecutionMessage(
  userMessage: string | undefined,
  step: Pick<CampaignWorkflowStep, 'title'>,
  stepIndex: number,
): boolean {
  if (!userMessage) return false
  const head = userMessage.slice(0, 300)
  // handleExecuteStep: agentPrompt 模板以 "## 步骤 N: ..." 开头（N 为步骤序号）
  if (head.startsWith(`## 步骤 ${stepIndex + 1}:`)) return true
  // handleAdjustStep: 以 "## 调整 Campaign 工作流步骤：{title}" 开头
  if (head.startsWith('## 调整 Campaign 工作流步骤') && head.includes(step.title)) return true
  return false
}

/** 从 Agent 消息中提取摘要（最后一条 assistant 消息的前 200 字符） */
export function extractOutputSummary(
  messages: import('@gravitas/shared').AgentMessage[] | undefined,
): string {
  if (!messages || messages.length === 0) return '执行完成，未获取输出摘要'

  // 找最后一条 assistant 消息
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (!isAssistantMessage(msg)) continue
    const text = extractMessageText(msg)
    if (text.trim()) {
      return text.trim().slice(0, 200)
    }
  }

  return '执行完成'
}

function extractAssistantOutput(messages: import('@gravitas/shared').AgentMessage[] | undefined): string {
  if (!messages || messages.length === 0) return ''

  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (!isAssistantMessage(msg)) continue
    const text = extractMessageText(msg)
    if (text.trim()) {
      return text.trim()
    }
  }

  return ''
}

/**
 * 兜底产物落盘：如果 Agent 只在对话里输出内容、没有写入文件，则将输出保存为该步骤产物。
 * 真正是否达标仍交给 validateStepArtifacts 判定。
 */
function materializeAssistantOutputIfNeeded(
  campaignId: string,
  stepId: CampaignWorkflowStepId,
  messages: import('@gravitas/shared').AgentMessage[] | undefined,
): void {
  const dirName = STEP_DIR_MAP[stepId]
  const dirPath = join(getCampaignArtifactsRoot(campaignId), dirName)
  const existing = readTextFiles(dirPath)

  if (existing.files.length > 0 && existing.totalChars > 0) return

  const output = extractAssistantOutput(messages)
  if (!output) return

  mkdirSync(dirPath, { recursive: true })
  const workflow = loadCampaignWorkflow(campaignId)
  const step = workflow.steps.find((s) => s.id === stepId)
  const stepTitle = step?.title ?? stepId
  const requiredFiles = step?.requiredFiles ?? []

  // 带 requiredFiles 的步骤：兜底时必须按精确文件名落盘，否则 validateStepArtifacts 仍会失败。
  // 优先按文件名标题拆分输出；拆不出的文件用整段输出兜底，保证每个必需文件非空、够字数。
  if (requiredFiles.length > 0) {
    const sections = splitOutputByFiles(output, requiredFiles)
    for (const rf of requiredFiles) {
      const section = sections.get(rf)?.trim()
      const body = section && section.length > 0 ? section : output
      writeFileSync(join(dirPath, rf), `# ${rf}\n\n${body}\n`, 'utf-8')
    }
    // 额外保留完整原始输出，便于回溯模型实际产出的内容
    writeFileSync(join(dirPath, 'agent-output.md'), `# ${stepTitle}\n\n${output}\n`, 'utf-8')
    console.log(
      `[CampaignWorkflow] 已将 Agent 输出按 requiredFiles 兜底落盘: ${dirName}/${requiredFiles.join(', ')}（含 agent-output.md 原始输出）`,
    )
    return
  }

  const content = `# ${stepTitle}\n\n${output}\n`
  writeFileSync(join(dirPath, 'agent-output.md'), content, 'utf-8')
  console.log(`[CampaignWorkflow] 已将 Agent 输出保存为兜底产物: ${dirName}/agent-output.md`)
}

/** 追加执行历史到 history.md */
export function appendHistory(
  campaignId: string,
  stepId: CampaignWorkflowStepId,
  stepTitle: string,
  status: 'completed' | 'failed' | 'adjusted',
  outputSummary: string,
): void {
  const slug = `campaign-${campaignId}`
  const baseDir = getAgentWorkspacePath(slug)
  const contextDir = join(baseDir, '.context')
  const historyPath = join(contextDir, 'history.md')

  const timestamp = new Date().toLocaleString()
  const entry = `## ${timestamp} — ${stepTitle}\n\n- 状态: ${status === 'completed' ? '✅ 完成' : status === 'failed' ? '❌ 失败' : '🔄 调整'}\n- 步骤: ${stepId}\n- 摘要: ${outputSummary}\n\n---\n\n`

  try {
    if (existsSync(historyPath)) {
      const existing = readFileSync(historyPath, 'utf-8')
      writeFileSync(historyPath, existing + entry, 'utf-8')
    } else {
      writeFileSync(
        historyPath,
        `# Campaign 执行历史\n\n记录所有工作流步骤的执行历史。\n\n${entry}`,
        'utf-8',
      )
    }
    console.log(`[CampaignWorkflow] 已追加历史记录: ${stepId}`)
  } catch (err) {
    console.error('[CampaignWorkflow] 写入 history.md 失败:', err)
  }
}

/** 带产物校验的完成步骤 */
export function completeStepWithValidation(
  campaignId: string,
  stepId: CampaignWorkflowStepId,
  messages: import('@gravitas/shared').AgentMessage[] | undefined,
): { success: boolean; workflow: CampaignWorkflow; reason?: string } {
  materializeAssistantOutputIfNeeded(campaignId, stepId, messages)
  const validation = validateStepArtifacts(campaignId, stepId)
  const outputSummary = extractOutputSummary(messages)

  if (!validation.valid) {
    // 产物校验失败，标记为 failed
    const workflow = updateWorkflowStep({
      campaignId,
      stepId,
      status: 'failed',
      outputSummary: `产物校验失败: ${validation.missing.join('; ')}`,
    })
    appendHistory(campaignId, stepId, workflow.steps.find(s => s.id === stepId)?.title ?? stepId, 'failed', outputSummary)
    return { success: false, workflow, reason: validation.missing.join('; ') }
  }

  // 产物校验通过，标记完成
  // 软校验：若存在未命中的语义锚点，将提醒追加到 outputSummary（不阻断完成）
  let finalSummary = outputSummary
  if (validation.unmetRequirements.length > 0) {
    const names = validation.unmetRequirements.map((r) => r.name).join('、')
    finalSummary = `${outputSummary}（已通过，建议补充语义锚点：${names}）`
  }
  const workflow = updateWorkflowStep({
    campaignId,
    stepId,
    status: 'completed',
    outputSummary: finalSummary,
  })
  appendHistory(campaignId, stepId, workflow.steps.find(s => s.id === stepId)?.title ?? stepId, 'completed', finalSummary)
  return { success: true, workflow }
}
