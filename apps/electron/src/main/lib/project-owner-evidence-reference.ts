import type { OwnerDevelopmentDeliveryArtifact } from '@gravitas/shared'
import { containsOwnerValidationEvidenceQuote } from './development-validation-acceptance'

type Validation = OwnerDevelopmentDeliveryArtifact['validationEvidence']
interface EvidenceArtifact {
  content: string
  development: boolean
  validation?: Validation
}

export const OWNER_EVIDENCE_REFERENCE_INSTRUCTION = '逐项返回 criterionId（C1 起，按冻结标准顺序）、status、evidence（一句独立判断）、evidenceId。正文用 T 加行号，现有文件用 F 加文件序号，源码行用 F 加文件序号再加 :L 和行号，通过的运行回执用 V 加序号。序号从 1 开始。F 使用冻结 files 的原顺序，V 使用冻结 validationEvidence 的原顺序，删除或失败项占序号但不能引用。T 和源码行按解码内容的换行计数，空行占行号但不能引用。缺证据用 null，met 必须给出有效编号。不要在回复中复写标准、路径、源码、回执 JSON 或 quote。'

// 模型有时省略源码行前的 L；文件范围和行号仍由原快照核对。
export const OWNER_SOURCE_LINE_ID_WITHOUT_PREFIX = /^F[1-9]\d{0,5}:[1-9]\d{0,5}$/

function files(content: string): unknown[] {
  const parsed: unknown = JSON.parse(content)
  if (!parsed || typeof parsed !== 'object' || !('files' in parsed) || !Array.isArray(parsed.files)) throw new Error('Owner证据引用的源码快照无效')
  return parsed.files
}

function lineAt(content: string, index: number): string | undefined {
  const line = content.split(/\r\n|\n|\r/)[index - 1]
  return line?.trim() ? line.slice(0, 1000) : undefined
}

/** 编号仅在当前冻结成果中解释，不查找其他项目、版本、原始文件或外部回执。 */
function resolveOwnerEvidenceId(id: unknown, artifact: EvidenceArtifact, readFiles: () => unknown[]): string {
  if (typeof id !== 'string' || id.length > 26) throw new Error('Owner证据编号无效')
  const normalized = artifact.development && OWNER_SOURCE_LINE_ID_WITHOUT_PREFIX.test(id) ? id.replace(':', ':L') : id
  const match = /^(T|F|V)([1-9]\d{0,5})(?::L([1-9]\d{0,5})(?:-L([1-9]\d{0,5}))?)?$/.exec(normalized)
  if (!match) throw new Error('Owner证据编号无效')
  const [, kind, ordinal, sourceLine, lastSourceLine] = match
  const index = Number(ordinal)
  let quote: string | undefined
  if (kind === 'T' && !artifact.development && !sourceLine) quote = lineAt(artifact.content, index)
  if (kind === 'F' && artifact.development) {
    const entry = readFiles()[index - 1]
    if (entry && typeof entry === 'object' && 'file' in entry && 'newContent' in entry && typeof entry.newContent === 'string') {
      const metadata = entry.file
      if (metadata && typeof metadata === 'object' && 'path' in metadata && typeof metadata.path === 'string'
        && (!('changeType' in metadata) || metadata.changeType !== 'delete')) {
        if (!lastSourceLine) {
          quote = sourceLine ? lineAt(entry.newContent, Number(sourceLine)) : `"path":${JSON.stringify(metadata.path)}`
        } else {
          const first = Number(sourceLine), last = Number(lastSourceLine)
          if (first <= last && last - first < 50) {
            const lines = Array.from(entry.newContent.matchAll(/[^\r\n]*?(?:\r\n|\r|\n|$)/g))
              .filter(line => line[0]).map(line => line[0])
            if (last <= lines.length) {
              const span = lines.slice(first - 1, last).join('').replace(/(?:\r\n|\r|\n)$/, '')
              if (span.trim() && span.length <= 1000) quote = span
            }
          }
        }
      }
    }
  }
  if (kind === 'V' && artifact.development && !sourceLine) {
    const receipt = artifact.validation?.[index - 1]
    if (receipt && containsOwnerValidationEvidenceQuote([receipt], receipt.command)) quote = `"validationId":${JSON.stringify(receipt.validationId)}`
  }
  if (!quote) throw new Error('Owner证据编号在当前成果中无有效依据')
  return quote
}

/** 新回包先恢复宿主绑定的标准和逐字引用，旧记录继续经过原有校验。 */
export function bindOwnerEvidenceRows(
  rows: readonly unknown[], criteria: readonly string[], artifact: EvidenceArtifact,
  reviewerQuotes?: readonly { status: string; quote?: string | null }[],
): readonly unknown[] {
  if (!rows.some(row => row && typeof row === 'object' && Object.hasOwn(row, 'criterionId'))) return rows
  if (rows.length !== criteria.length) throw new Error('Owner验收编号没有完整覆盖冻结标准')
  let snapshotFiles: unknown[] | undefined
  const readFiles = () => snapshotFiles ??= files(artifact.content)
  const seen = new Set<number>()
  const bound = rows.map(row => {
    if (!row || typeof row !== 'object' || Array.isArray(row)
      || Object.keys(row).length !== 4 || !['criterionId', 'status', 'evidence', 'evidenceId'].every(key => Object.hasOwn(row, key))) {
      throw new Error('Owner编号验收行字段不匹配')
    }
    const { criterionId, status, evidence, evidenceId } = row as Record<string, unknown>
    const match = typeof criterionId === 'string' ? /^C([1-9]\d{0,2})$/.exec(criterionId) : null
    const index = Number(match?.[1]) - 1
    const criterion = criteria[index]
    if (!criterion || seen.has(index)) throw new Error('Owner验收编号超出范围或重复')
    seen.add(index)
    let quote: string | { from: 'reviewer' } | null = null
    if (evidenceId === `R${index + 1}` && status === 'met' && reviewerQuotes?.[index]?.status === 'met' && reviewerQuotes[index]?.quote) {
      quote = { from: 'reviewer' }
    } else if (evidenceId !== null) {
      if (typeof evidenceId === 'string' && evidenceId.startsWith('V') && status !== 'met') throw new Error('成功回执不能作为未通过项的源码引用')
      quote = resolveOwnerEvidenceId(evidenceId, artifact, readFiles)
    }
    return { index, criterion, status, evidence, quote }
  })
  return bound.sort((a, b) => a.index - b.index).map(({ index: _index, ...row }) => row)
}
