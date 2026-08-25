/**
 * CJK Bigram 分词器。
 *
 * 借鉴 mycontext 的 tokenize 设计：
 * - CJK 文本切成「单字 + 相邻二字组合」
 * - ASCII 词（英文/数字）按空白/标点切分后原样保留
 * - 单趟扫描，token 顺序与原文一致
 *
 * 为什么需要 bigram：
 * - 中文没有天然词边界，LIKE '%term%' 对单字查询会召回过多噪音
 * - bigram 保留相邻二字组合（如「沙箱」「环境」），提升精度
 * - 单字也保留（如「沙」「箱」），确保单字查询不丢召回
 */

/** CJK 统一汉字 + 扩展 A + 假名 + 谚文 */
const CJK = /[぀-ヿ㐀-䶿一-鿿豈-﫿가-힯]/

/** ASCII 词字符：字母数字下划线连字符等 */
const ASCII_WORD_CHAR = /[A-Za-z0-9_+#.-]/

function isCjk(char: string): boolean {
  return CJK.test(char)
}

/**
 * 把文本切成可检索的 token 列表。
 *
 * 同一函数用于写入与查询，两侧不一致会导致检索静默失效。
 */
export function tokenize(text: string): string[] {
  if (text === '') return []
  const tokens: string[] = []

  // CJK 片段缓冲
  let cjkRun: string[] = []
  const flushCjk = (): void => {
    for (let i = 0; i < cjkRun.length; i += 1) {
      const char = cjkRun[i]
      if (char !== undefined) tokens.push(char)
      const next = cjkRun[i + 1]
      if (char !== undefined && next !== undefined) tokens.push(char + next)
    }
    cjkRun = []
  }

  // ASCII 词缓冲
  let word = ''
  const flushWord = (): void => {
    if (word !== '') {
      tokens.push(word.toLowerCase())
      word = ''
    }
  }

  // 单趟扫描
  for (const char of text) {
    if (isCjk(char)) {
      flushWord()
      cjkRun.push(char)
      continue
    }
    if (ASCII_WORD_CHAR.test(char)) {
      flushCjk()
      word += char
      continue
    }
    // 分隔符
    flushWord()
    flushCjk()
  }
  flushWord()
  flushCjk()

  return tokens
}

/**
 * 去重后的 token 列表（用于写入侧索引）。
 */
export function toIndexTokens(text: string): string[] {
  return [...new Set(tokenize(text))]
}

/**
 * 查询侧：给出从严到宽的两档 token 列表。
 *
 * 严格档：全部 token（含 CJK bigram）
 * 放宽档：去掉 CJK bigram，只留单字与 ASCII 词
 *
 * 为什么需要放宽：
 * - 查询「部署沙箱」含 bigram「署沙」，原文「沙箱环境部署」没有 → 0 命中
 * - 放宽后只剩单字「部」「署」「沙」「箱」→ 至少能召回
 * - 先跑严格档，0 结果时才跑放宽档，精度不降级
 */
export function toQueryTokenTiers(query: string): string[][] {
  const strict = [...new Set(tokenize(query))]
  if (strict.length === 0) return []

  // CJK bigram = 长度 2 且两个字符都是 CJK
  const relaxed = strict.filter(
    (token) => !(token.length === 2 && isCjk(token[0] ?? '') && isCjk(token[1] ?? '')),
  )

  if (relaxed.length === 0 || relaxed.length === strict.length) return [strict]
  return [strict, relaxed]
}
