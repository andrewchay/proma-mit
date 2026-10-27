/** 面向用户的失败原因：脱敏、截断，不暴露内部ID或凭据。 */
export function ownerAssignmentFailureReason(detail: string): string {
  return detail.replace(/Bearer\s+[^\s,;]+/gi, 'Bearer [已隐藏]')
    .replace(/(api[_-]?key|authorization|access[_-]?token)\s*[:=]\s*[^,\s;]+/gi, '$1=[已隐藏]')
    .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, '[已隐藏凭据]')
    .replace(/[\r\n\t]+/g, ' ').trim().slice(0, 240)
}
