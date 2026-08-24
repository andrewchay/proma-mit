/**
 * 预置 Benchmark 模板
 *
 * 为内置 sub-agent（code-reviewer / explorer / researcher）提供开箱即用的评测模板，
 * 降低用户创建 benchmark 的门槛，激活评测系统的使用。
 *
 * 模板设计原则：
 * - 覆盖各 sub-agent 的核心能力维度
 * - Rubric 总分 = 100，评分标准明确可量化
 * - Statement 模拟真实工作场景
 * - 包含正负案例，测试边界情况
 */

import type { CreateBenchmarkRequest } from './benchmark-store'

// 使用函数返回字符串，避免模板字符串与代码模板冲突
const securityCaseStatement = () =>
  '请审查以下代码片段，找出潜在的安全问题：\n\n' +
  '```typescript\n' +
  'function authenticateUser(token: string) {\n' +
  '  const decoded = atob(token);\n' +
  '  const user = JSON.parse(decoded);\n' +
  '  if (user.exp > Date.now()) {\n' +
  '    return user;\n' +
  '  }\n' +
  '  return null;\n' +
  '}\n\n' +
  'function processPayment(amount: number, cardNumber: string) {\n' +
  "  const query = 'INSERT INTO payments (amount, card) VALUES (' + amount + ', \"' + cardNumber + '\")';\n" +
  '  db.exec(query);\n' +
  '}\n' +
  '```\n\n' +
  '请输出审查结果，按严重程度分类。'

const performanceCaseStatement = () =>
  '请审查以下 React 组件的性能问题：\n\n' +
  '```tsx\n' +
  'function UserList({ users }: { users: User[] }) {\n' +
  "  const [filter, setFilter] = useState('');\n\n" +
  '  const filteredUsers = users.filter(u => \n' +
  '    u.name.includes(filter) || u.email.includes(filter)\n' +
  '  );\n\n' +
  '  const sortedUsers = filteredUsers.sort((a, b) => \n' +
  '    a.name.localeCompare(b.name)\n' +
  '  );\n\n' +
  '  return (\n' +
  '    <div>\n' +
  '      <input value={filter} onChange={e => setFilter(e.target.value)} />\n' +
  '      {sortedUsers.map(user => (\n' +
  '        <UserCard key={user.id} user={user} />\n' +
  '      ))}\n' +
  '    </div>\n' +
  '  );\n' +
  '}\n' +
  '```\n\n' +
  '请输出审查结果。'

const codeQualityCaseStatement = () =>
  '请审查以下代码的可读性和可维护性问题：\n\n' +
  '```typescript\n' +
  'function processData(d: any[]) {\n' +
  '  let r: any[] = [];\n' +
  '  for (let i = 0; i < d.length; i++) {\n' +
  '    if (d[i].active) {\n' +
  '      let t = d[i].value * 2;\n' +
  '      if (t > 100) {\n' +
  "        r.push({ id: d[i].id, val: t, type: 'high' });\n" +
  '      } else {\n' +
  "        r.push({ id: d[i].id, val: t, type: 'low' });\n" +
  '      }\n' +
  '    }\n' +
  '  }\n' +
  '  return r.sort((a, b) => b.val - a.val);\n' +
  '}\n' +
  '```\n\n' +
  '请输出审查结果。'

/** code-reviewer 评测模板：测试代码审查能力 */
export const codeReviewerTemplate: CreateBenchmarkRequest = {
  id: 'builtin-code-reviewer',
  title: '代码审查能力评测',
  description: '评测 code-reviewer sub-agent 的代码质量审查能力，包括问题发现、建议质量和输出格式。',
  targetAgentId: 'code-reviewer',
  provider: 'anthropic',
  modelId: 'claude-sonnet-4-20250514',
  targetScore: 75,
  cases: [
    {
      caseId: 'security-vulnerability',
      statement: securityCaseStatement(),
      rubricItems: [
        { name: '发现 SQL 注入漏洞', points: 25, check: '识别出 processPayment 中的字符串拼接 SQL 注入风险' },
        { name: '发现 JWT 验证缺陷', points: 25, check: '识别出 authenticateUser 中缺少签名验证、仅检查 exp 的问题' },
        { name: '发现敏感信息泄露', points: 20, check: '指出 cardNumber 明文存储问题' },
        { name: '输出格式规范', points: 15, check: '按严重程度分类（🔴/🟡/🟢），包含文件路径和行号' },
        { name: '给出修复建议', points: 15, check: '提供具体的代码修复示例或最佳实践建议' },
      ],
    },
    {
      caseId: 'performance-issue',
      statement: performanceCaseStatement(),
      rubricItems: [
        { name: '发现重复计算问题', points: 30, check: '指出 filter 和 sort 在每次渲染时重复执行，建议使用 useMemo' },
        { name: '发现缺少防抖', points: 20, check: '指出输入过滤缺少防抖/节流，频繁渲染问题' },
        { name: '发现 key 使用不当', points: 20, check: '检查是否提到 key={user.id} 在列表重排时的性能影响' },
        { name: '给出优化方案', points: 20, check: '提供具体的性能优化代码示例' },
        { name: '输出格式规范', points: 10, check: '按严重程度分类，结构清晰' },
      ],
    },
    {
      caseId: 'code-quality',
      statement: codeQualityCaseStatement(),
      rubricItems: [
        { name: '命名规范问题', points: 25, check: '指出变量命名不清晰（d, r, t 等单字母命名）' },
        { name: '类型安全', points: 25, check: '指出 any 类型使用，建议定义具体接口' },
        { name: '代码简化', points: 25, check: '建议使用 filter + map 替代 for 循环，或使用函数式编程风格' },
        { name: '魔法数字', points: 15, check: '指出 100 和 2 等魔法数字应提取为常量' },
        { name: '输出格式规范', points: 10, check: '按严重程度分类，建议具体可行' },
      ],
    },
  ],
}

const explorerAuthCaseStatement = () =>
  '在一个典型的 Express + TypeScript 项目中，用户认证流程涉及哪些文件和函数？\n\n' +
  '请搜索并返回：\n' +
  '1. 认证相关的路由定义文件\n' +
  '2. 中间件函数名称和位置\n' +
  '3. 用户模型/类型定义位置\n' +
  '4. JWT 或 session 处理逻辑位置\n\n' +
  '以结构化格式返回结果。'

const explorerDependencyCaseStatement = () =>
  '分析一个 React 项目的依赖关系：\n\n' +
  '项目使用 Vite + React + TypeScript，包含以下目录结构：\n' +
  '- src/components/\n' +
  '- src/hooks/\n' +
  '- src/utils/\n' +
  '- src/types/\n\n' +
  '请找出：\n' +
  '1. 哪些组件使用了自定义 hooks\n' +
  '2. 哪些文件被最多其他文件导入\n' +
  '3. 是否存在循环依赖风险\n\n' +
  '以结构化格式返回分析结果。'

/** explorer 评测模板：测试代码库探索能力 */
export const explorerTemplate: CreateBenchmarkRequest = {
  id: 'builtin-explorer',
  title: '代码库探索能力评测',
  description: '评测 explorer sub-agent 的代码库搜索、信息收集和结构化输出能力。',
  targetAgentId: 'explorer',
  provider: 'anthropic',
  modelId: 'claude-sonnet-4-20250514',
  targetScore: 70,
  cases: [
    {
      caseId: 'find-auth-flow',
      statement: explorerAuthCaseStatement(),
      rubricItems: [
        { name: '找到路由定义', points: 25, check: '正确识别 auth.routes.ts 或类似文件' },
        { name: '找到中间件', points: 25, check: '正确识别 auth.middleware.ts 或 verifyToken 等函数' },
        { name: '找到模型定义', points: 20, check: '正确识别 User 模型/接口定义位置' },
        { name: '找到 JWT/Session 逻辑', points: 20, check: '正确识别 token 生成和验证逻辑位置' },
        { name: '输出结构化', points: 10, check: '返回格式清晰，包含文件路径和函数名' },
      ],
    },
    {
      caseId: 'dependency-analysis',
      statement: explorerDependencyCaseStatement(),
      rubricItems: [
        { name: '识别 hooks 使用', points: 30, check: '正确列出组件与 hooks 的对应关系' },
        { name: '分析导入频次', points: 30, check: '正确识别高频被导入的文件（如 types、utils）' },
        { name: '发现循环依赖', points: 25, check: '识别潜在的循环依赖模式（如 A→B→C→A）' },
        { name: '输出结构化', points: 15, check: '使用表格或列表清晰展示依赖关系' },
      ],
    },
  ],
}

const researcherStateManagementStatement = () =>
  '调研 React 状态管理方案：\n\n' +
  '项目背景：\n' +
  '- 中大型 React 应用（50+ 组件）\n' +
  '- 需要服务端状态同步\n' +
  '- 团队 5-8 人，技术栈统一\n\n' +
  '请对比以下方案：\n' +
  '1. Redux Toolkit + RTK Query\n' +
  '2. Zustand + TanStack Query\n' +
  '3. Jotai + React Query\n' +
  '4. Context API + useReducer\n\n' +
  '输出结构化调研报告，包含对比表格和推荐方案。'

const researcherDeploymentStatement = () =>
  '调研前端部署策略：\n\n' +
  '项目背景：\n' +
  '- Next.js 应用，SSR + SSG 混合\n' +
  '- 需要 CI/CD 自动化\n' +
  '- 预算有限，追求性价比\n' +
  '- 需要全球 CDN 加速\n\n' +
  '请对比：\n' +
  '1. Vercel\n' +
  '2. Netlify\n' +
  '3. AWS Amplify\n' +
  '4. 自托管（Docker + Nginx + CDN）\n\n' +
  '输出结构化调研报告。'

/** researcher 评测模板：测试技术调研能力 */
export const researcherTemplate: CreateBenchmarkRequest = {
  id: 'builtin-researcher',
  title: '技术调研能力评测',
  description: '评测 researcher sub-agent 的技术方案对比、分析和推荐能力。',
  targetAgentId: 'researcher',
  provider: 'anthropic',
  modelId: 'claude-sonnet-4-20250514',
  targetScore: 70,
  cases: [
    {
      caseId: 'state-management',
      statement: researcherStateManagementStatement(),
      rubricItems: [
        { name: '方案覆盖完整', points: 25, check: '四个方案都有涉及，不遗漏' },
        { name: '对比维度清晰', points: 25, check: '使用表格对比学习曲线、性能、生态、适用场景等维度' },
        { name: '推荐有理有据', points: 25, check: '明确推荐一个方案，并说明与项目背景的匹配理由' },
        { name: '风险提示', points: 15, check: '指出各方案的潜在问题和注意事项' },
        { name: '输出格式规范', points: 10, check: '包含问题概述、方案对比、推荐方案、风险提示结构' },
      ],
    },
    {
      caseId: 'deployment-strategy',
      statement: researcherDeploymentStatement(),
      rubricItems: [
        { name: '方案覆盖完整', points: 25, check: '四个方案都有涉及' },
        { name: '成本分析', points: 25, check: '包含各方案的成本估算和性价比分析' },
        { name: '技术匹配度', points: 25, check: '分析与 Next.js SSR/SSG 的兼容性' },
        { name: '推荐有理有据', points: 15, check: '明确推荐并说明理由' },
        { name: '输出格式规范', points: 10, check: '结构清晰，包含对比表格' },
      ],
    },
  ],
}

/** 所有预置模板列表 */
export const builtinBenchmarkTemplates: CreateBenchmarkRequest[] = [
  codeReviewerTemplate,
  explorerTemplate,
  researcherTemplate,
]

/** 通过模板 ID 获取模板 */
export function getBenchmarkTemplate(id: string): CreateBenchmarkRequest | undefined {
  return builtinBenchmarkTemplates.find((t) => t.id === id)
}

/** 获取所有预置模板（不含 cases 详情，用于列表展示） */
export function listBenchmarkTemplates(): Array<Pick<CreateBenchmarkRequest, 'id' | 'title' | 'description' | 'targetAgentId'>> {
  return builtinBenchmarkTemplates.map((t) => ({
    id: t.id,
    title: t.title,
    description: t.description,
    targetAgentId: t.targetAgentId,
  }))
}
