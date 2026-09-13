/** 内置出海 sourcing 执行器：惰性加载，由 esbuild 纳入安装包，避免依赖用户目录中的源码相对路径。 */
interface DirectoryExecutor { execute(input: unknown): Promise<unknown> }

const executors: Record<string, () => DirectoryExecutor> = {
  sourcing_list_inbox: () => require('../../../default-tools/outbound-sourcing/sourcing/sourcing_list_inbox/execute.ts'),
  sourcing_queue_email: () => require('../../../default-tools/outbound-sourcing/sourcing/sourcing_queue_email/execute.ts'),
  sourcing_get_mail_status: () => require('../../../default-tools/outbound-sourcing/sourcing/sourcing_get_mail_status/execute.ts'),
  sourcing_search_buyers: () => require('../../../default-tools/outbound-sourcing/sourcing/sourcing_search_buyers/execute.ts'),
  sourcing_verify_company: () => require('../../../default-tools/outbound-sourcing/sourcing/sourcing_verify_company/execute.ts'),
  sourcing_build_persona: () => require('../../../default-tools/outbound-sourcing/sourcing/sourcing_build_persona/execute.ts'),
  sourcing_outreach_metrics: () => require('../../../default-tools/outbound-sourcing/sourcing/sourcing_outreach_metrics/execute.ts'),
}

export function getBundledOutboundExecutor(id: string): DirectoryExecutor | undefined { return executors[id]?.() }
