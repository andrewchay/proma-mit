export interface LiveMarkdownHeading {
  level: number
  text: string
  position: number
}

/** 提取 fenced code 之外的 ATX 标题，position 可直接交给 CodeMirror 定位。 */
export function extractLiveMarkdownHeadings(markdown: string): LiveMarkdownHeading[] {
  const headings: LiveMarkdownHeading[] = []
  const lines = markdown.split('\n')
  let offset = 0
  let fence: string | null = null

  for (const line of lines) {
    const fenceMatch = line.match(/^ {0,3}(`{3,}|~{3,})/)
    if (fenceMatch) {
      const marker = fenceMatch[1] ?? ''
      if (!fence) fence = marker
      else if (marker[0] === fence[0] && marker.length >= fence.length) fence = null
      offset += line.length + 1
      continue
    }
    if (!fence) {
      const match = line.match(/^ {0,3}(#{1,6})(?:[ \t]+|$)(.*)$/)
      const text = match?.[2]?.replace(/[ \t]+#+[ \t]*$/, '').trim()
      if (match && text) headings.push({ level: match[1]!.length, text, position: offset })
    }
    offset += line.length + 1
  }
  return headings
}
