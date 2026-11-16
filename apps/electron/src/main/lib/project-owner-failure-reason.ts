/** 面向用户的失败原因：脱敏、截断，不暴露内部ID或凭据。 */
export function ownerAssignmentFailureReason(detail: string): string {
  const reason = detail.replace(/Bearer\s+[^\s,;]+/gi, 'Bearer [已隐藏]')
    .replace(/(api[_-]?key|authorization|access[_-]?token)\s*[:=]\s*[^,\s;]+/gi, '$1=[已隐藏]')
    .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, '[已隐藏凭据]')
    .replace(/[\r\n\t]+/g, ' ').trim().slice(0, 240)
  // 协议拒绝信息本身是内部术语（如「Owner研发验证命令无效」），单看无法判断该改什么。
  // 这里补一句面向用户的下一步说明，保留原因为核对依据。
  const hint = failureNextStepHint(reason)
  return hint ? `${reason}（${hint}）` : reason
}

/**
 * 把已知的协议拒绝归类成可执行的下一步。
 *
 * 只覆盖能明确指出「该改什么」的几类；其余返回 null，保持原文，
 * 不猜测原因，也不弱化失败。
 */
function failureNextStepHint(reason: string): string | null {
  if (reason.includes('验证命令无效') || reason.includes('只能使用内置浏览器断言或内置构建命令验证')) {
    return '模型没有给出可执行的验证方式；原生或命令行成果需要在目标路径中包含可构建的源码，并选用内置构建命令（如 build:swift）'
  }
  if (reason.includes('验证命令与目标文件不匹配')) return '验证命令与成果类型不一致；原生项目应选用与目标文件扩展名匹配的构建命令'
  if (reason.includes('需要根目录 Package.swift')) return 'Swift 构建需要工作区根部有 Package.swift 和至少一个 Swift 源文件'
  if (reason.includes('必须完整覆盖所选步骤的全部岗位')) return '执行人员没有覆盖方案的全部岗位；可调整岗位范围后再安排'
  if (reason.includes('独立评审员审核')) return '需要一位不承担执行岗位的员工做独立评审'
  if (reason.includes('提案格式无效或夹带未授权字段')) return '模型输出未符合协议格式，可重试一次安排'
  return null
}
