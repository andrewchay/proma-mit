/**
 * 学术研究访问守卫（M3，关闭 G3）
 *
 * 方案 §11.1 硬门禁：**工具/渲染层参数是请求，不是授权**。
 *
 * 本模块是研究领域所有写操作的唯一入口校验点：
 * 1. actor 只从主进程确定（当前固定 local-user），**绝不接受调用方传入**
 * 2. projectId 必须存在且格式合法；不存在时统一报 NOT_FOUND，
 *    不区分「不存在」与「无权限」以免泄露对象存在性
 * 3. 保留未来的租户/成员校验扩展点（企业版多人协作时在此接入，
 *    不改变调用方签名）
 *
 * 说明：本地单用户 MVP 下，渲染层与主进程同机同用户，本层主要防的是
 * Agent/模型伪造参数；真正接入远端身份前，不得宣称已实现多人权限隔离。
 */

import type { ApprovalActor, ResearchProject } from '@gravitas/shared'
import { RESEARCH_ERROR_CODES, ResearchError } from '@gravitas/shared'

/** 唯一可信 actor 来源：主进程。渲染层传入的 actor 一律忽略。 */
export const LOCAL_USER_ACTOR: ApprovalActor = {
  id: 'local-user',
  displayName: '本机用户',
  trusted: true,
}

/** 系统验证器 actor（自动验收用；本里程碑仅批准场景不使用） */
export function systemActor(verifier: string): ApprovalActor {
  return { id: `system:${verifier}`, displayName: `系统验证器 ${verifier}`, trusted: true }
}

/** 项目 ID 形状校验（与 research-store 的目录约束一致） */
const PROJECT_ID_PATTERN = /^[a-zA-Z0-9-]{1,64}$/

/**
 * 断言本次调用可访问该项目。
 *
 * @param projectId 调用方请求的项目 ID（视为不可信输入）
 * @param loader 项目读取函数（避免本模块依赖具体存储实现）
 */
export async function assertProjectAccess(
  projectId: string,
  loader: (id: string) => Promise<ResearchProject | null>,
): Promise<ResearchProject> {
  if (typeof projectId !== 'string' || !PROJECT_ID_PATTERN.test(projectId)) {
    // 不泄露「格式非法」与「不存在」的差别
    throw new ResearchError(RESEARCH_ERROR_CODES.NOT_FOUND, `研究项目不可访问: ${String(projectId)}`)
  }
  const project = await loader(projectId)
  if (!project) {
    throw new ResearchError(RESEARCH_ERROR_CODES.NOT_FOUND, `研究项目不可访问: ${projectId}`)
  }
  return project
}

/**
 * 记录操作 actor。
 *
 * 注意：这里**不接受参数**——调用方无法指定 actor。
 * 若未来支持远端身份，应在此函数内从可信会话解析，而不是加参数。
 */
export function currentActor(): ApprovalActor {
  return LOCAL_USER_ACTOR
}
