/**
 * Campaign 工作流产物落盘相关的共享工具函数。
 *
 * 背景：带 `requiredFiles` 的步骤要求 Agent 把结果写成若干「精确文件名」的文件，
 * 但模型有时只在回复里描述内容、并不真正调用 Write 工具，导致产物校验失败。
 * 这里提供两个纯函数：
 *   1. buildArtifactPersistenceDirective —— 生成一段强制的「落盘硬约束」提示词，
 *      追加到步骤 prompt 末尾，促使模型真实调用 Write 工具。
 *   2. splitOutputByFiles —— 兜底时把 Agent 的纯文本输出按文件名标题切分成多节，
 *      供兜底落盘按 requiredFiles 拆分写入。
 */

/**
 * 生成「产物落盘硬约束」提示词。
 *
 * @param dirName 步骤产物目录名（如 `user-analysis`）
 * @param requiredFiles 必须写出的文件名列表（如 `['ta-portrait.md', ...]`）
 */
export function buildArtifactPersistenceDirective(
  dirName: string,
  requiredFiles: string[],
): string {
  const fileList = requiredFiles
    .map((f, i) => `${i + 1}. \`${dirName}/${f}\``)
    .join('\n')

  return `## 产物落盘硬约束（必须严格遵守）

本轮所有分析产出【必须】通过 \`Write\` 工具真实写入文件，**禁止只在回复里描述文件内容而不实际调用 \`Write\` 工具**。仅在对话中输出文字不会通过产物校验。

请分别调用 \`Write\` 工具，把每个文件写入 \`${dirName}/\` 目录（\`file_path\` 使用下方完整相对路径，\`content\` 写该文件的完整正文）：

${fileList}

要求：
- 每个文件至少调用一次 \`Write\` 工具；\`file_path\` 必须包含 \`${dirName}/\` 目录前缀。
- \`content\` 必须是结构化、完整的正文（每个文件正文不少于 300 字），不要只写标题、表格或一两句话。
- 全部写完后再返回 "已完成：XXX" 及产物摘要；摘要不能替代实际写文件。`
}

/**
 * 把 Agent 的纯文本输出按文件名标题切分成多节。
 *
 * 识别形如 `# ta-portrait.md`、`## 文件：ta-portrait.md`、`### search-habits` 的
 * 标题行，并把标题之后的正文归属到对应的 requiredFile。
 *
 * @param output Agent 输出的纯文本
 * @param requiredFiles 目标文件名列表
 * @returns 文件名 → 对应正文 的映射；若无法识别任何分节则返回空 Map
 */
export function splitOutputByFiles(
  output: string,
  requiredFiles: string[],
): Map<string, string> {
  const result = new Map<string, string>()
  if (!output || requiredFiles.length === 0) return result

  const tokens = requiredFiles.map((f) => ({
    file: f,
    full: f.toLowerCase(),
    stem: f.replace(/\.(md|txt)$/i, '').toLowerCase(),
  }))

  const lines = output.split('\n')
  const headingRe = /^#{1,6}\s+(.+?)\s*$/
  const headings: { index: number; file: string | null }[] = []

  for (let i = 0; i < lines.length; i++) {
    const m = headingRe.exec(lines[i] ?? '')
    if (!m) continue
    const title = (m[1] ?? '').toLowerCase()
    let matched: string | null = null
    for (const t of tokens) {
      // 标题里包含「完整文件名」或「去扩展名的文件名」即视为该文件的节
      if (title.includes(t.full) || title.includes(t.stem)) {
        matched = t.file
        break
      }
    }
    headings.push({ index: i, file: matched })
  }

  // 没有任何标题命中 requiredFile，说明无法可靠拆分，交给调用方整体兜底
  if (!headings.some((h) => h.file)) return result

  for (let h = 0; h < headings.length; h++) {
    const cur = headings[h]
    if (!cur?.file) continue
    const next = h + 1 < headings.length ? headings[h + 1]!.index : lines.length
    const body = lines.slice(cur.index + 1, next).join('\n').trim()
    if (body) result.set(cur.file, body)
  }

  return result
}
