/** 内置岗位能力建议目录；模板不是已创建员工，不能据此派工。 */
import { createHash } from 'node:crypto'
import type { ProjectOwnerRoleAdvice } from '@gravitas/shared'
import templates from '../../../resources/employee-role-templates.json'

export function getProjectOwnerRoleAdviceCatalog(): ProjectOwnerRoleAdvice[] {
  const roles = templates.map(({ id, name, version, sourceSha256, systemPrompt }) => ({
    key: id, name, version, sourceSha256, rulesSha256: createHash('sha256').update(systemPrompt).digest('hex'),
  }))
  if (roles.length === 0 || new Set(roles.map((role) => role.key)).size !== roles.length
    || roles.some((role) => !role.key.trim() || !role.name.trim() || !/^\d+\.\d+\.\d+$/.test(role.version)
      || !/^[a-f0-9]{64}$/.test(role.sourceSha256))) {
    throw new Error('Owner 岗位建议目录无效，请核查打包资源')
  }
  return roles
}
