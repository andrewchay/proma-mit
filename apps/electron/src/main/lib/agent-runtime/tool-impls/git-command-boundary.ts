/**
 * Bash 中高风险 Git 结构的保守词法门禁。
 *
 * 判定顺序是「先做 shell 词法切分，再只看真正会被执行的命令」：
 * 引号内文本、转义、heredoc 正文、注释和普通参数都是数据，不参与判定；
 * 只有命令位（经过 env/sudo/xargs 等前缀与 VAR=值 前缀之后）出现的 git 才会被检查参数。
 * 命令替换 `$(...)`、反引号和 `sh -c "..."` 的脚本体递归按命令分析。
 *
 * 不把它当作通用 shell 解析器：目标是明确拒绝已知的同命令执行通道，
 * 而不是分析或放行任意 shell。其他 Runtime 与不经 Bash 工具的入口不在本模块范围内。
 */

const GIT_LAYOUT_OPTION = /^--(?:git-dir|work-tree|separate-git-dir)(?:=|$)/
const GIT_ENV_ASSIGNMENT = /^GIT_(?:DIR|COMMON_DIR|WORK_TREE|TEMPLATE_DIR|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|INDEX_FILE|SHALLOW_FILE|EXEC_PATH|CONFIG(?:_[A-Z0-9]+)?)=/i
const COMMAND_CONFIG_KEY = /(?:core\.(?:fsmonitor|pager|editor|sshcommand|askpass|hookspath)|credential\.helper|diff\.external|gpg\.program|filter\.[a-z0-9_.-]+\.(?:clean|smudge|process)|include(?:if\.[a-z0-9_.-]+)?\.path)/i
const COMMAND_CONFIG_VALUE = /(?:alias\.[a-z0-9_.-]+|submodule\.[a-z0-9_.-]+\.update)\s*=\s*["']?!/i
const SHELL_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/
/** 这些前缀命令后面的第一个非选项词才是真正的命令。 */
const COMMAND_PREFIXES = new Set(['env', 'sudo', 'doas', 'command', 'builtin', 'exec', 'nohup', 'time', 'nice', 'ionice', 'stdbuf', 'xargs', 'unbuffer'])
/** 这些选项自己带一个值，用于跳过选项值找到 git 子命令。 */
const GIT_VALUE_OPTIONS = new Set(['-C', '-c', '--git-dir', '--work-tree', '--separate-git-dir', '--exec-path', '--namespace', '--config-env', '--super-prefix', '--attr-source', '--shallow-file', '--list-cmds'])
const MAX_NESTING = 4

interface ShellWord {
  value: string
  /** 词里出现过引号/命令替换：值不再是可执行文本的直接拼接。 */
  quoted: boolean
}

interface ShellScan {
  segments: ShellWord[][]
  /** 命令替换与 `sh -c` 脚本体，按命令递归分析。 */
  nested: string[]
}

/** 词法切分：只在引号/转义/heredoc 之外识别分隔符。 */
function scanShell(source: string): ShellScan {
  const segments: ShellWord[][] = []
  const nested: string[] = []
  let words: ShellWord[] = []
  let value = ''
  let hasValue = false
  let quoted = false
  let heredocs: Array<{ delimiter: string; strip: boolean }> = []
  let index = 0

  const flushWord = (): void => {
    if (!hasValue) return
    words.push({ value, quoted })
    value = ''
    hasValue = false
    quoted = false
  }
  const flushSegment = (): void => {
    flushWord()
    if (words.length) {
      segments.push(words)
      words = []
    }
  }
  const append = (text: string, fromQuote = false): void => {
    if (!text) return
    value += text
    hasValue = true
    if (fromQuote) quoted = true
  }
  const lineEnd = (from: number): number => {
    const newline = source.indexOf('\n', from)
    return newline === -1 ? source.length : newline
  }
  const skipSingleQuote = (from: number): number => {
    const end = source.indexOf('\'', from + 1)
    return end === -1 ? source.length : end + 1
  }
  const skipDoubleQuote = (from: number): number => {
    let cursor = from + 1
    while (cursor < source.length) {
      if (source[cursor] === '\\') {
        cursor += 2
        continue
      }
      if (source[cursor] === '"') return cursor + 1
      cursor++
    }
    return source.length
  }
  /** 从开括号位置起读取配对的括号体；体内引号与转义不参与计数。 */
  const readBalanced = (from: number, open: string, close: string): { body: string; next: number } => {
    let depth = 0
    let cursor = from
    while (cursor < source.length) {
      const char = source[cursor]
      if (char === '\\') {
        cursor += 2
        continue
      }
      if (char === '\'') {
        cursor = skipSingleQuote(cursor)
        continue
      }
      if (char === '"') {
        cursor = skipDoubleQuote(cursor)
        continue
      }
      if (char === open) {
        depth++
        cursor++
        continue
      }
      if (char === close) {
        depth--
        cursor++
        if (depth === 0) return { body: source.slice(from + 1, cursor - 1), next: cursor }
        continue
      }
      cursor++
    }
    return { body: source.slice(from + 1), next: source.length }
  }
  /** heredoc 正文整段跳过：它不是命令，里面出现什么词都无所谓。 */
  const consumeHeredocBodies = (from: number): number => {
    let cursor = from
    while (heredocs.length) {
      const pending = heredocs[0]
      if (!pending) break
      const end = lineEnd(cursor)
      const raw = source.slice(cursor, end)
      const candidate = pending.strip ? raw.replace(/^\t+/, '') : raw
      if (candidate.trimEnd() === pending.delimiter) heredocs.shift()
      if (end >= source.length) {
        heredocs = []
        return source.length
      }
      cursor = end + 1
    }
    return cursor
  }
  const readHeredocDelimiter = (from: number): { delimiter: string; strip: boolean; next: number } => {
    let cursor = from + 2
    let strip = false
    if (source[cursor] === '-' || source[cursor] === '~') {
      strip = true
      cursor++
    }
    while (source[cursor] === ' ' || source[cursor] === '\t') cursor++
    if (source[cursor] === '\'' || source[cursor] === '"') {
      const quoteChar = source[cursor]
      const end = quoteChar === '\'' ? skipSingleQuote(cursor) : skipDoubleQuote(cursor)
      const delimiter = source.slice(cursor + 1, end - 1)
      return { delimiter, strip, next: end }
    }
    let delimiter = ''
    while (cursor < source.length && !/[\s;&|<>()]/.test(source[cursor] ?? '')) {
      if (source[cursor] === '\\') {
        delimiter += source[cursor + 1] ?? ''
        cursor += 2
        continue
      }
      delimiter += source[cursor]
      cursor++
    }
    return { delimiter, strip, next: cursor }
  }

  while (index < source.length) {
    const char = source[index] ?? ''

    if (char === '\n') {
      index++
      flushSegment()
      index = consumeHeredocBodies(index)
      continue
    }
    if (char === ' ' || char === '\t' || char === '\r') {
      flushWord()
      index++
      continue
    }
    if (char === '#' && !hasValue) {
      index = lineEnd(index)
      continue
    }
    if (char === '\\') {
      const next = source[index + 1]
      if (next === '\n') {
        index += 2
        continue
      }
      if (next !== undefined) {
        // 转义字符是数据：`git\ init` 不会被执行成两条命令，但值仍然是字面量，标记为被引号化以免误判。
        append(next, true)
        index += 2
        continue
      }
      index++
      continue
    }
    if (char === '\'') {
      const end = skipSingleQuote(index)
      append(source.slice(index + 1, end - 1), true)
      index = end
      continue
    }
    if (char === '"') {
      const end = skipDoubleQuote(index)
      const body = source.slice(index + 1, Math.max(index + 1, end - 1))
      let cursor = 0
      let literal = ''
      while (cursor < body.length) {
        const inner = body[cursor]
        if (inner === '\\' && cursor + 1 < body.length) {
          literal += body[cursor + 1]
          cursor += 2
          continue
        }
        if (inner === '$' && body[cursor + 1] === '(') {
          append(literal)
          literal = ''
          const balanced = readBalanced(index + 1 + cursor + 1, '(', ')')
          nested.push(balanced.body)
          // 命令替换的位置后续文本会整体平移，这里按相对偏移继续推进。
          cursor += balanced.next - (index + 1 + cursor)
          quoted = true
          hasValue = true
          continue
        }
        if (inner === '`') {
          append(literal)
          literal = ''
          const close = body.indexOf('`', cursor + 1)
          nested.push(body.slice(cursor + 1, close === -1 ? body.length : close))
          cursor = close === -1 ? body.length : close + 1
          quoted = true
          hasValue = true
          continue
        }
        literal += inner
        cursor++
      }
      append(literal, true)
      index = end
      continue
    }
    if (char === '$' && source[index + 1] === '(') {
      flushWord()
      const balanced = readBalanced(index + 1, '(', ')')
      nested.push(balanced.body)
      index = balanced.next
      quoted = true
      hasValue = true
      continue
    }
    if (char === '`') {
      flushWord()
      const close = source.indexOf('`', index + 1)
      nested.push(source.slice(index + 1, close === -1 ? source.length : close))
      index = close === -1 ? source.length : close + 1
      quoted = true
      hasValue = true
      continue
    }
    if (char === '<' && source[index + 1] === '<' && source[index + 2] !== '<') {
      const heredoc = readHeredocDelimiter(index)
      heredocs.push({ delimiter: heredoc.delimiter, strip: heredoc.strip })
      index = heredoc.next
      continue
    }
    if (char === '<' || char === '>') {
      // 重定向操作符与其 fd 前缀不是命令词：`2>&1` 不算命令组合。
      if (/\d$/.test(value)) value = value.replace(/\d+$/, '')
      if (!value) hasValue = false
      flushWord()
      index++
      while (index < source.length && /[<>&|]/.test(source[index] ?? '') ) index++
      while (index < source.length && /[\d-]/.test(source[index] ?? '')) index++
      continue
    }
    if (char === ';' || char === '&' || char === '|') {
      index++
      if ((char === '&' && source[index] === '&') || (char === '|' && source[index] === '|')) index++
      flushSegment()
      continue
    }
    if (char === '(' || char === ')' || char === '{' || char === '}') {
      index++
      flushSegment()
      continue
    }
    append(char)
    index++
  }

  flushSegment()
  return { segments, nested }
}

/** 跳过赋值词与前缀命令，返回真正命令词的词表下标。 */
function commandIndex(words: ShellWord[]): { command: number; assignments: ShellWord[] } {
  const assignments: ShellWord[] = []
  let index = 0
  while (index < words.length) {
    const word = words[index]
    if (!word) break
    if (SHELL_ASSIGNMENT.test(word.value)) {
      assignments.push(word)
      index++
      continue
    }
    const basename = word.value.split('/').pop()?.toLowerCase() ?? ''
    if (COMMAND_PREFIXES.has(basename)) {
      index++
      // 前缀命令自己的选项与赋值词一并跳过。
      while (index < words.length) {
        const next = words[index]
        if (!next) break
        if (SHELL_ASSIGNMENT.test(next.value)) {
          assignments.push(next)
          index++
          continue
        }
        if (next.value.startsWith('-')) {
          index++
          continue
        }
        break
      }
      continue
    }
    break
  }
  return { command: index, assignments }
}

function checkGitEnvironmentOverride(assignments: ShellWord[]): string | undefined {
  for (const word of assignments) {
    if (GIT_ENV_ASSIGNMENT.test(word.value)) return 'Bash Git 门禁：不允许命令内的 Git 环境覆盖（目录或 config）'
  }
  return undefined
}

/** 只看 git 自己的选项与子命令；子命令参数（提交信息、路径、grep 模式）是数据。 */
function inspectGitArguments(words: ShellWord[], from: number): { violation?: string; subcommand?: string } {
  let subcommand: string | undefined
  for (let index = from + 1; index < words.length; index++) {
    const value = words[index]?.value ?? ''
    if (!value) continue
    if (!value.startsWith('-')) {
      subcommand ??= value.toLowerCase()
      continue
    }
    if (GIT_LAYOUT_OPTION.test(value)) {
      return { violation: 'Bash Git 门禁：不允许通过命令行指定间接 Git 布局，请在当前工作区内操作' }
    }
    // -c / --config-env 是全局选项：只可能出现在子命令之前，子命令之后的同名参数是子命令自己的参数。
    if (subcommand) {
      if (GIT_VALUE_OPTIONS.has(value)) index++
      continue
    }
    const equals = value.indexOf('=')
    const optionName = equals === -1 ? value : value.slice(0, equals)
    if (optionName === '--config-env') {
      const configValue = equals === -1 ? words[index + 1]?.value ?? '' : value.slice(equals + 1)
      if (equals === -1) index++
      const key = configValue.split('=')[0] ?? ''
      if (COMMAND_CONFIG_KEY.test(key)) return { violation: 'Bash Git 门禁：不允许通过 -c/--config-env 注入命令执行型 Git config' }
      continue
    }
    if (value === '-c') {
      const configValue = words[index + 1]?.value ?? ''
      index++
      if (COMMAND_CONFIG_KEY.test(configValue) || COMMAND_CONFIG_VALUE.test(configValue)) {
        return { violation: 'Bash Git 门禁：不允许通过 -c/--config-env 注入命令执行型 Git config' }
      }
      continue
    }
    if (value.startsWith('-c') && value.length > 2) {
      const configValue = value.slice(2)
      if (COMMAND_CONFIG_KEY.test(configValue) || COMMAND_CONFIG_VALUE.test(configValue)) {
        return { violation: 'Bash Git 门禁：不允许通过 -c/--config-env 注入命令执行型 Git config' }
      }
      continue
    }
    if (GIT_VALUE_OPTIONS.has(value)) {
      index++
      continue
    }
  }
  return subcommand === undefined ? {} : { subcommand }
}

/** 递归分析一层 shell 文本；composed 表示外层已经存在命令组合。 */
function analyzeShell(source: string, composed: boolean, depth: number): string | undefined {
  const scan = scanShell(source)
  const hasComposition = composed || scan.segments.length > 1 || scan.nested.length > 0
  for (const words of scan.segments) {
    const { command, assignments } = commandIndex(words)
    const envViolation = checkGitEnvironmentOverride(assignments)
    if (envViolation) return envViolation
    const commandWord = words[command]
    if (!commandWord) continue
    const basename = commandWord.value.split('/').pop()?.toLowerCase() ?? ''
    const args = words.slice(command + 1)
    if (basename === 'git') {
      const inspected = inspectGitArguments(words, command)
      if (inspected.violation) return inspected.violation
      if (inspected.subcommand === 'init' && hasComposition) {
        return 'Bash Git 门禁：git init 必须单独执行，完成 hooks/config 收口后再运行后续命令'
      }
      continue
    }
    // `sh -c "脚本"` / `bash -lc "脚本"`：脚本字符串仍然会被执行，按命令递归分析。
    if (['sh', 'bash', 'zsh', 'dash', 'ksh'].includes(basename)) {
      const scriptIndex = args.findIndex(word => /^-[a-z]*c$/i.test(word.value))
      const script = scriptIndex === -1 ? undefined : args[scriptIndex + 1]?.value
      if (script?.trim()) {
        const nestedViolation = analyzeShell(script, hasComposition, depth + 1)
        if (nestedViolation) return nestedViolation
      }
    }
    // `eval "git …"`：参数字面值会被重新当成命令执行。
    if (basename === 'eval') {
      const script = args.map(word => word.value).join(' ').trim()
      if (script) {
        const nestedViolation = analyzeShell(script, hasComposition || args.length > 1, depth + 1)
        if (nestedViolation) return nestedViolation
      }
    }
    // `find … -exec git …`：find 会反复派生命令，git 不可能"单独执行"。
    if (basename === 'find') {
      const execIndex = args.findIndex(word => word.value === '-exec' || word.value === '-execdir')
      if (execIndex !== -1) {
        const spawned = args.slice(execIndex + 1)
        const terminator = spawned.findIndex(word => word.value === ';' || word.value === '+')
        const commandWords = terminator === -1 ? spawned : spawned.slice(0, terminator)
        const spawnedCommand = commandWords[0]
        if (spawnedCommand && (spawnedCommand.value.split('/').pop()?.toLowerCase() ?? '') === 'git') {
          const inspected = inspectGitArguments(commandWords, 0)
          if (inspected.violation) return inspected.violation
          if (inspected.subcommand === 'init') {
            return 'Bash Git 门禁：git init 必须单独执行，完成 hooks/config 收口后再运行后续命令'
          }
        }
      }
    }
  }
  if (depth < MAX_NESTING) {
    for (const body of scan.nested) {
      const nestedViolation = analyzeShell(body, hasComposition, depth + 1)
      if (nestedViolation) return nestedViolation
    }
  }
  return undefined
}

/** 返回拒绝原因；未命中受限制结构时返回 undefined。 */
export function findGitCommandBoundaryViolation(command: string): string | undefined {
  if (!command.trim()) return undefined
  return analyzeShell(command, false, 0)
}
