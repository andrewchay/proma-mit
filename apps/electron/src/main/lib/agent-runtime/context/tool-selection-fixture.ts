/**
 * M4-04 工具选择实验 fixture。
 *
 * 30 个工具的确定性目录 + 10 个选择用例；每个用例的任务描述恰好指向一个工具。
 * 目录/用例均为纯数据，离线可测，真实评测经注入 delegate 消费同一份 fixture。
 */
import type { CapabilityDescriptor } from '@gravitas/shared'
import { createCapabilityCatalog, type CapabilityCatalog } from '@gravitas/shared'

interface ToolSpec {
  id: string
  name: string
  summary: string
  access: CapabilityDescriptor['access']
  confirmation: CapabilityDescriptor['confirmation']
  properties: Record<string, { type: string; description: string }>
  required: string[]
}

const TOOL_SPECS: readonly ToolSpec[] = [
  { id: 'builtin:read-file', name: 'ReadFile', summary: '读取工作区内指定路径的文件内容', access: 'read', confirmation: 'never', properties: { path: { type: 'string', description: '文件相对路径' } }, required: ['path'] },
  { id: 'builtin:write-file', name: 'WriteFile', summary: '把文本内容写入工作区内指定路径的文件', access: 'write', confirmation: 'on_demand', properties: { path: { type: 'string', description: '文件相对路径' }, content: { type: 'string', description: '写入的正文' } }, required: ['path', 'content'] },
  { id: 'builtin:list-directory', name: 'ListDirectory', summary: '列出工作区内某个目录的文件与子目录', access: 'read', confirmation: 'never', properties: { path: { type: 'string', description: '目录相对路径' } }, required: ['path'] },
  { id: 'builtin:web-search', name: 'WebSearch', summary: '用关键词搜索公开网页并返回结果列表', access: 'external', confirmation: 'never', properties: { query: { type: 'string', description: '搜索关键词' } }, required: ['query'] },
  { id: 'builtin:fetch-url', name: 'FetchUrl', summary: '抓取指定 URL 的网页正文', access: 'external', confirmation: 'never', properties: { url: { type: 'string', description: '完整 URL' } }, required: ['url'] },
  { id: 'builtin:send-email', name: 'SendEmail', summary: '通过已配置的邮箱给指定收件人发送邮件', access: 'external', confirmation: 'always', properties: { to: { type: 'string', description: '收件人地址' }, subject: { type: 'string', description: '邮件主题' }, body: { type: 'string', description: '邮件正文' } }, required: ['to', 'subject', 'body'] },
  { id: 'builtin:create-event', name: 'CreateCalendarEvent', summary: '在用户日历上创建一个带提醒的日程', access: 'write', confirmation: 'on_demand', properties: { title: { type: 'string', description: '日程标题' }, startAt: { type: 'string', description: '开始时间 ISO 字符串' } }, required: ['title', 'startAt'] },
  { id: 'builtin:query-database', name: 'QueryDatabase', summary: '对项目 SQLite 库执行只读 SQL 查询并返回行', access: 'read', confirmation: 'never', properties: { sql: { type: 'string', description: '只读 SELECT 语句' } }, required: ['sql'] },
  { id: 'builtin:run-tests', name: 'RunTests', summary: '在仓库里运行指定文件的单元测试', access: 'write', confirmation: 'on_demand', properties: { files: { type: 'string', description: '逗号分隔的测试文件路径' } }, required: ['files'] },
  { id: 'builtin:translate-text', name: 'TranslateText', summary: '把一段文本翻译成目标语言', access: 'external', confirmation: 'never', properties: { text: { type: 'string', description: '原文' }, targetLanguage: { type: 'string', description: '目标语言' } }, required: ['text', 'targetLanguage'] },
  { id: 'builtin:summarize-doc', name: 'SummarizeDocument', summary: '对一篇长文档生成要点摘要', access: 'read', confirmation: 'never', properties: { path: { type: 'string', description: '文档路径' } }, required: ['path'] },
  { id: 'builtin:generate-image', name: 'GenerateImage', summary: '按文字描述生成一张图片', access: 'external', confirmation: 'on_demand', properties: { prompt: { type: 'string', description: '画面描述' } }, required: ['prompt'] },
  { id: 'builtin:git-status', name: 'GitStatus', summary: '查看当前仓库的分支与变更状态', access: 'read', confirmation: 'never', properties: {}, required: [] },
  { id: 'builtin:git-commit', name: 'GitCommit', summary: '把已暂存的变更提交为一个 commit', access: 'write', confirmation: 'always', properties: { message: { type: 'string', description: '提交信息' } }, required: ['message'] },
  { id: 'builtin:remember-fact', name: 'RememberFact', summary: '把一条长期事实写入跨会话记忆', access: 'write', confirmation: 'on_demand', properties: { fact: { type: 'string', description: '要记住的事实' } }, required: ['fact'] },
  { id: 'builtin:recall-memory', name: 'RecallMemory', summary: '按关键词检索跨会话长期记忆', access: 'read', confirmation: 'never', properties: { keywords: { type: 'string', description: '检索关键词' } }, required: ['keywords'] },
  { id: 'builtin:create-todo', name: 'CreateTodo', summary: '创建一条带截止时间的待办事项', access: 'write', confirmation: 'never', properties: { title: { type: 'string', description: '待办标题' }, dueAt: { type: 'string', description: '截止时间 ISO 字符串' } }, required: ['title'] },
  { id: 'builtin:read-inbox', name: 'ReadInbox', summary: '读取协作收件箱里的待处理事项', access: 'read', confirmation: 'never', properties: {}, required: [] },
  { id: 'builtin:rename-file', name: 'RenameFile', summary: '重命名工作区内的一个文件', access: 'write', confirmation: 'on_demand', properties: { from: { type: 'string', description: '原路径' }, to: { type: 'string', description: '新路径' } }, required: ['from', 'to'] },
  { id: 'builtin:delete-file', name: 'DeleteFile', summary: '删除工作区内的一个文件', access: 'write', confirmation: 'always', properties: { path: { type: 'string', description: '文件相对路径' } }, required: ['path'] },
  { id: 'builtin:export-csv', name: 'ExportCsv', summary: '把查询结果导出为 CSV 文件', access: 'write', confirmation: 'on_demand', properties: { rows: { type: 'string', description: 'JSON 行数组' }, path: { type: 'string', description: '导出路径' } }, required: ['rows', 'path'] },
  { id: 'builtin:lint-code', name: 'LintCode', summary: '对指定源码文件运行静态检查', access: 'read', confirmation: 'never', properties: { paths: { type: 'string', description: '逗号分隔的文件路径' } }, required: ['paths'] },
  { id: 'builtin:format-code', name: 'FormatCode', summary: '格式化指定源码文件', access: 'write', confirmation: 'never', properties: { paths: { type: 'string', description: '逗号分隔的文件路径' } }, required: ['paths'] },
  { id: 'builtin:search-notes', name: 'SearchNotes', summary: '在用户笔记库中按关键词检索笔记', access: 'read', confirmation: 'never', properties: { keywords: { type: 'string', description: '关键词' } }, required: ['keywords'] },
  { id: 'builtin:post-message', name: 'PostChannelMessage', summary: '向协作渠道发送一条消息', access: 'external', confirmation: 'always', properties: { channel: { type: 'string', description: '渠道名' }, text: { type: 'string', description: '消息正文' } }, required: ['channel', 'text'] },
  { id: 'builtin:read-config', name: 'ReadConfig', summary: '读取应用的用户配置项', access: 'read', confirmation: 'never', properties: { key: { type: 'string', description: '配置键' } }, required: ['key'] },
  { id: 'builtin:write-config', name: 'WriteConfig', summary: '修改应用的用户配置项', access: 'write', confirmation: 'on_demand', properties: { key: { type: 'string', description: '配置键' }, value: { type: 'string', description: '配置值' } }, required: ['key', 'value'] },
  { id: 'builtin:snapshot-page', name: 'SnapshotPage', summary: '对受管浏览器当前页面做结构化快照', access: 'read', confirmation: 'never', properties: {}, required: [] },
  { id: 'builtin:click-element', name: 'ClickElement', summary: '点击受管浏览器页面上的一个元素', access: 'external', confirmation: 'on_demand', properties: { ref: { type: 'string', description: '元素引用' } }, required: ['ref'] },
  { id: 'builtin:time-now', name: 'CurrentTime', summary: '获取当前时区的当前时间', access: 'read', confirmation: 'never', properties: {}, required: [] },
]

export function buildSelectionCatalog(): CapabilityCatalog {
  return createCapabilityCatalog(TOOL_SPECS.map((spec) => ({
    version: 1 as const,
    id: spec.id,
    name: spec.name,
    summary: spec.summary,
    source: 'builtin' as const,
    schemaRef: `${spec.id}:schema`,
    access: spec.access,
    dataClasses: spec.access === 'external' ? (['network'] as const) : (['workspace'] as const),
    confirmation: spec.confirmation,
    parallelSafe: spec.access === 'read',
    toolName: spec.name,
  })))
}

/** 完整参数 schema 正文；full_schema 变体按 schemaRef 取用。 */
export function getSelectionSchemaBody(schemaRef: string): string {
  const spec = TOOL_SPECS.find((candidate) => `${candidate.id}:schema` === schemaRef)
  if (!spec) throw new Error(`unknown schemaRef: ${schemaRef}`)
  return JSON.stringify({ type: 'object', properties: spec.properties, required: spec.required })
}

export interface ToolSelectionCase {
  id: string
  task: string
  expectedToolId: string
}

export const TOOL_SELECTION_CASES: readonly ToolSelectionCase[] = [
  { id: 'SEL-01', task: '把今晚 8 点的评审会写进我的日历，并设置提醒。', expectedToolId: 'builtin:create-event' },
  { id: 'SEL-02', task: '帮我看看仓库现在有哪些文件改动还没提交。', expectedToolId: 'builtin:git-status' },
  { id: 'SEL-03', task: '查一下项目库里最近一个月的支出记录，只要只读查询。', expectedToolId: 'builtin:query-database' },
  { id: 'SEL-04', task: '把这段中文产品介绍翻译成英文。', expectedToolId: 'builtin:translate-text' },
  { id: 'SEL-05', task: '搜一下业内最近关于 context caching 的公开资料。', expectedToolId: 'builtin:web-search' },
  { id: 'SEL-06', task: '记住：以后所有发布说明都要抄送运维负责人。', expectedToolId: 'builtin:remember-fact' },
  { id: 'SEL-07', task: '把 src 目录下所有 TS 文件统一格式化一遍。', expectedToolId: 'builtin:format-code' },
  { id: 'SEL-08', task: '现在几点了？我需要对个时间。', expectedToolId: 'builtin:time-now' },
  { id: 'SEL-09', task: '给合作方邮箱发一封带议程的会议邀请邮件。', expectedToolId: 'builtin:send-email' },
  { id: 'SEL-10', task: '删除工作区里那个过期的草稿文件 draft-old.md。', expectedToolId: 'builtin:delete-file' },
]
