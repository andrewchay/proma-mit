/** 岗位资料只生成创建预填，不创建员工、不绑定模型或授予权限。 */
import { createHash } from 'node:crypto'
import { readFile, realpath, writeFile } from 'node:fs/promises'
import { resolve, sep } from 'node:path'
interface ManifestEntry { roleSlug: string; cardPath: string; contractPath: string; cardSha256: string; contractSha256: string }
interface RoleCard { slug: string; name: string; summary: string; employeeId: null; runtime: null; channelId: null; modelId: null; workspaceId: null; status: string; kind: string; executable: boolean; roleVersion: string }
const root = resolve(import.meta.dir, '..')
const directory = await realpath(resolve(root, 'docs/ai-team'))
async function sourcePath(path: string): Promise<string> {
  const resolved = await realpath(resolve(directory, path))
  if (!resolved.startsWith(`${directory}${sep}`)) throw new Error('岗位来源不能越过 ai-team 资料目录')
  return resolved
}
const manifest: { files: ManifestEntry[]; roleCount: number } = JSON.parse(await readFile(resolve(directory, 'manifest.json'), 'utf8'))
const templates = await Promise.all(manifest.files.map(async (entry) => {
  const [cardText, contract] = await Promise.all([readFile(await sourcePath(entry.cardPath), 'utf8'), readFile(await sourcePath(entry.contractPath), 'utf8')])
  const hash = (text: string) => createHash('sha256').update(text).digest('hex')
  if (hash(cardText) !== entry.cardSha256 || hash(contract) !== entry.contractSha256) throw new Error(`岗位来源哈希不匹配：${entry.roleSlug}`)
  const card: RoleCard = JSON.parse(cardText)
  if (card.slug !== entry.roleSlug || card.status !== 'draft-unbound' || card.kind !== 'role-template' || card.employeeId !== null || card.runtime !== null || card.channelId !== null || card.modelId !== null || card.workspaceId !== null || card.executable !== false) throw new Error(`岗位不是未绑定模板：${entry.roleSlug}`)
  return { id: card.slug, version: card.roleVersion, name: card.name, role: card.name, description: card.summary, sourceSha256: entry.contractSha256,
    systemPrompt: `模板来源：${card.slug} v${card.roleVersion}；规则SHA256：${entry.contractSha256}。\n` + '以下是岗位模板的完整执行规则。模板中的未绑定状态说明资料来源；实际员工、模型、工作区和权限以应用本次任务事实为准。模板不构成任何执行、费用或外发授权。\n\n' + contract.replace(/^---\n[\s\S]*?\n---\n\n/, '') }
}))
if (templates.length !== manifest.roleCount || new Set(templates.map((item) => item.id)).size !== templates.length) throw new Error('岗位模板数量或标识不匹配')
const output = resolve(root, 'apps/electron/resources/employee-role-templates.json')
const content = `${JSON.stringify(templates, null, 2)}\n`
const license = await readFile(await sourcePath('licenses/agency-agents-MIT.txt'), 'utf8')
const licenseOutput = resolve(root, 'apps/electron/resources/employee-role-templates-LICENSE.txt')
if (process.argv.includes('--check')) {
  if (await readFile(output, 'utf8') !== content || await readFile(licenseOutput, 'utf8') !== license) throw new Error('员工预填模板或许可过期，请运行 bun scripts/generate-employee-role-templates.ts')
} else {
  await writeFile(output, content)
  await writeFile(licenseOutput, license)
}
console.log(`员工岗位模板 ${templates.length} 份：${process.argv.includes('--check') ? '一致性通过' : '已生成'}`)
