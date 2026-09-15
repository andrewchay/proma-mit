import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { generateKeyPairSync, createSign } from 'node:crypto'
import { buildEntitlementSigningPayload } from './subscription/entitlement-signature'
import type { EntitlementSnapshot } from '@gravitas/shared'
import { stableNoteId } from '@gravitas/core/services/knowledge'

/**
 * 知识库写盘安全测试。
 *
 * 写操作会修改用户磁盘上的 Markdown，因此路径校验是最关键的一环。
 * 这里重点验证路径逃逸被阻断 —— 这是"删除用户其他文件"类事故的唯一防线。
 *
 * 测试全部在临时目录内进行。
 */

let tempDir: string
let vaultDir: string
const originalEnv = { ...process.env }

/**
 * 写盘测试需要 knowledge-pro 权益：写用户 Markdown 属于付费能力。
 * 这里用临时密钥对签发一份合法快照，而不是放宽生产验签逻辑。
 */
const keyPair = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
})

function writeEntitlement(root: string, capabilities: string[]): void {
  const base: EntitlementSnapshot = {
    accountId: 'test',
    planId: 'pro',
    capabilities: capabilities as EntitlementSnapshot['capabilities'],
    status: 'active',
    lastVerifiedAt: new Date().toISOString(),
    validUntil: new Date(Date.now() + 86_400_000).toISOString(),
    signature: '',
    keyId: 'test-1',
  }
  const signature = createSign('RSA-SHA256')
    .update(buildEntitlementSigningPayload(base), 'utf8')
    .sign(keyPair.privateKey, 'base64url')

  const dir = join(root, 'subscription')
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'entitlement-cache.json'),
    JSON.stringify({ snapshot: { ...base, signature }, cachedAt: Date.now() }),
  )
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'knowledge-write-'))
  process.env.PROMA_TEST_CONFIG_DIR = tempDir
  process.env.GRAVITAS_SUBSCRIPTION_ENTITLEMENT_PUBLIC_KEY_PEM = keyPair.publicKey
  vaultDir = join(tempDir, 'vault')
  mkdirSync(vaultDir, { recursive: true })
  // 默认授予 knowledge-pro，使既有用例聚焦于写盘与安全校验本身
  writeEntitlement(tempDir, ['knowledge-pro'])
})

afterEach(() => {
  process.env = { ...originalEnv }
  rmSync(tempDir, { recursive: true, force: true })
})

/** 载入一个已注册好 Vault 的服务实例 */
async function loadWithVault() {
  const svc = await import(`./knowledge-service?t=${Math.random()}`)
  const vault = svc.createKnowledgeVault({
    name: 'test',
    path: vaultDir,
    type: 'folder',
    enabled: true,
  })
  return { svc, vaultId: vault.id as string }
}

async function loadWriteService() {
  return import(`./knowledge-write-service?t=${Math.random()}`)
}

describe('路径逃逸防护', () => {
  test('拒绝上级目录引用', async () => {
    const { vaultId } = await loadWithVault()
    const write = await loadWriteService()
    const svc = await import(`./knowledge-service?t=${Math.random()}`)
    const vault = svc.getKnowledgeVault(vaultId)!

    expect(() => write.resolveSafePath(vault, '../../../etc/passwd')).toThrow('上级目录')
    expect(() => write.resolveSafePath(vault, 'a/../../outside.md')).toThrow('上级目录')
    expect(() => write.resolveSafePath(vault, '..')).toThrow('上级目录')
  })

  test('绝对路径被当作 vault 内相对路径，不逃逸到系统目录', async () => {
    const { vaultId } = await loadWithVault()
    const write = await loadWriteService()
    const svc = await import(`./knowledge-service?t=${Math.random()}`)
    const vault = svc.getKnowledgeVault(vaultId)!

    // 前导斜杠被剔除后拼到 vault 根下，因此得到 <vault>/etc/passwd，
    // 而不是系统 /etc/passwd。这是刻意的：绝对路径不应成为逃逸通道。
    const resolved = write.resolveSafePath(vault, '/etc/passwd')
    expect(resolved).toBe(join(vaultDir, 'etc', 'passwd'))
    expect(resolved.startsWith(vaultDir)).toBe(true)
  })

  test('带盘符的 Windows 绝对路径被拒绝', async () => {
    const { vaultId } = await loadWithVault()
    const write = await loadWriteService()
    const svc = await import(`./knowledge-service?t=${Math.random()}`)
    const vault = svc.getKnowledgeVault(vaultId)!

    // Windows 上 path.resolve(vault, 'C:\\...') 会返回 C:\... 而逃逸，
    // 因此在解析前直接拒绝盘符
    expect(() => write.resolveSafePath(vault, 'C:\\Windows\\system32')).toThrow('盘符')
    expect(() => write.resolveSafePath(vault, 'c:/Windows')).toThrow('盘符')
  })

  test('拒绝空路径', async () => {
    const { vaultId } = await loadWithVault()
    const write = await loadWriteService()
    const svc = await import(`./knowledge-service?t=${Math.random()}`)
    const vault = svc.getKnowledgeVault(vaultId)!
    expect(() => write.resolveSafePath(vault, '')).toThrow('不能为空')
  })

  test('允许 vault 内的多级子目录', async () => {
    const { vaultId } = await loadWithVault()
    const write = await loadWriteService()
    const svc = await import(`./knowledge-service?t=${Math.random()}`)
    const vault = svc.getKnowledgeVault(vaultId)!

    const resolved = write.resolveSafePath(vault, 'a/b/c.md')
    expect(resolved.startsWith(vaultDir)).toBe(true)
  })

  test('前缀相同的兄弟目录不被误判为 vault 内', async () => {
    const { vaultId } = await loadWithVault()
    const write = await loadWriteService()
    const svc = await import(`./knowledge-service?t=${Math.random()}`)
    const vault = svc.getKnowledgeVault(vaultId)!

    // 构造 /tmp/xxx/vault-evil，它以前缀 /tmp/xxx/vault 开头
    const evilDir = `${vaultDir}-evil`
    mkdirSync(evilDir, { recursive: true })
    const sneaky = join('..', `${'vault'}-evil`, 'x.md')
    expect(() => write.resolveSafePath(vault, sneaky)).toThrow('上级目录')
  })
})

describe('文件名净化', () => {
  test('移除非法字符', async () => {
    const write = await loadWriteService()
    expect(write.sanitizeFileName('a/b:c*d?e"f<g>h|i')).toBe('abcdefghi')
  })

  test('空标题被拒绝', async () => {
    const write = await loadWriteService()
    expect(() => write.sanitizeFileName('')).toThrow('不能为空')
    expect(() => write.sanitizeFileName('///')).toThrow('不能为空')
  })

  test('拒绝 . 与 ..', async () => {
    const write = await loadWriteService()
    expect(() => write.sanitizeFileName('.')).toThrow('不合法')
    expect(() => write.sanitizeFileName('..')).toThrow('不合法')
  })
})

describe('原子写入', () => {
  test('写入后内容正确', async () => {
    const write = await loadWriteService()
    const target = join(tempDir, 'atomic.md')
    write.atomicWrite(target, '内容')
    expect(readFileSync(target, 'utf-8')).toBe('内容')
  })

  test('不残留临时文件', async () => {
    const write = await loadWriteService()
    const dir = join(tempDir, 'atomic-dir')
    write.atomicWrite(join(dir, 'n.md'), 'x')
    const { readdirSync } = await import('node:fs')
    const files = readdirSync(dir)
    expect(files).toEqual(['n.md'])
  })

  test('覆盖已有文件', async () => {
    const write = await loadWriteService()
    const target = join(tempDir, 'overwrite.md')
    writeFileSync(target, 'old')
    write.atomicWrite(target, 'new')
    expect(readFileSync(target, 'utf-8')).toBe('new')
  })

  test('自动创建父目录', async () => {
    const write = await loadWriteService()
    const target = join(tempDir, 'deep', 'nested', 'n.md')
    write.atomicWrite(target, 'x')
    expect(existsSync(target)).toBe(true)
  })
})

describe('稳定笔记 id', () => {
  test('同路径产生同 id', () => {
    expect(stableNoteId('v1', 'a/b.md')).toBe(stableNoteId('v1', 'a/b.md'))
  })

  test('不同 vault 产生不同 id', () => {
    expect(stableNoteId('v1', 'a.md')).not.toBe(stableNoteId('v2', 'a.md'))
  })

  test('路径分隔符归一化（Windows 反斜杠）', () => {
    expect(stableNoteId('v1', 'a\\b.md')).toBe(stableNoteId('v1', 'a/b.md'))
  })

  test('前导斜杠被忽略', () => {
    expect(stableNoteId('v1', '/a.md')).toBe(stableNoteId('v1', 'a.md'))
  })

  test('id 长度固定 16 位十六进制', () => {
    expect(stableNoteId('v1', 'x.md')).toMatch(/^[0-9a-f]{16}$/)
  })
})

describe('knowledge-pro 门禁', () => {
  test('无权益时新建笔记被拒绝', async () => {
    // 清掉 beforeEach 写入的权益
    rmSync(join(tempDir, 'subscription'), { recursive: true, force: true })
    const { vaultId } = await loadWithVault()
    const write = await loadWriteService()

    expect(() => write.createNoteFile({ vaultId, title: 't', content: 'x' })).toThrow('knowledge-pro')
    // 磁盘上不应产生文件
    expect(existsSync(join(vaultDir, 't.md'))).toBe(false)
  })

  test('权益被篡改（无签名）时拒绝写入', async () => {
    const dir = join(tempDir, 'subscription')
    writeFileSync(
      join(dir, 'entitlement-cache.json'),
      JSON.stringify({
        snapshot: {
          accountId: 'test',
          planId: 'pro',
          capabilities: ['knowledge-pro'],
          status: 'active',
          lastVerifiedAt: new Date().toISOString(),
          signature: '',
          keyId: 'test-1',
        },
      }),
    )
    const { vaultId } = await loadWithVault()
    const write = await loadWriteService()
    expect(() => write.createNoteFile({ vaultId, title: 't' })).toThrow('knowledge-pro')
  })

  test('权益过期时拒绝写入', async () => {
    const base: EntitlementSnapshot = {
      accountId: 'test',
      planId: 'pro',
      capabilities: ['knowledge-pro'],
      status: 'active',
      lastVerifiedAt: new Date(Date.now() - 30 * 86_400_000).toISOString(),
      validUntil: new Date(Date.now() - 86_400_000).toISOString(),
      signature: '',
      keyId: 'test-1',
    }
    const signature = createSign('RSA-SHA256')
      .update(buildEntitlementSigningPayload(base), 'utf8')
      .sign(keyPair.privateKey, 'base64url')
    writeFileSync(
      join(tempDir, 'subscription', 'entitlement-cache.json'),
      JSON.stringify({ snapshot: { ...base, signature }, cachedAt: Date.now() }),
    )

    const { vaultId } = await loadWithVault()
    const write = await loadWriteService()
    expect(() => write.createNoteFile({ vaultId, title: 't' })).toThrow('knowledge-pro')
  })

  test('只授予其他能力时不放行', async () => {
    writeEntitlement(tempDir, ['influencer', 'academic'])
    const { vaultId } = await loadWithVault()
    const write = await loadWriteService()
    expect(() => write.createNoteFile({ vaultId, title: 't' })).toThrow('knowledge-pro')
  })

  test('四个写操作都受门禁保护', async () => {
    const { vaultId } = await loadWithVault()
    const write = await loadWriteService()
    // 先用有效权益建一个笔记
    write.createNoteFile({ vaultId, title: 'n', content: 'x' })

    // 撤销权益后逐一验证
    rmSync(join(tempDir, 'subscription'), { recursive: true, force: true })
    expect(() => write.createNoteFile({ vaultId, title: 't2' })).toThrow('knowledge-pro')
    expect(() => write.updateNoteFile({ vaultId, relativePath: 'n.md', content: 'y' })).toThrow('knowledge-pro')
    expect(() => write.renameNoteFile({ vaultId, relativePath: 'n.md', newTitle: 'm' })).toThrow('knowledge-pro')
    expect(() => write.deleteNoteFile(vaultId, 'n.md')).toThrow('knowledge-pro')

    // 原文件未被改动
    expect(readFileSync(join(vaultDir, 'n.md'), 'utf-8')).toContain('x')
  })

  test('只读操作不受门禁限制（免费版可索引）', async () => {
    const { vaultId } = await loadWithVault()
    const write = await loadWriteService()
    write.createNoteFile({ vaultId, title: 'n', content: 'x' })

    rmSync(join(tempDir, 'subscription'), { recursive: true, force: true })
    // 读取原文与 stat 属于只读，应继续可用
    expect(write.readNoteFile(vaultId, 'n.md')).not.toBeNull()
    expect(write.statNoteFile(vaultId, 'n.md')).not.toBeNull()
  })
})

describe('笔记文件操作', () => {
  test('创建笔记写入标题与正文', async () => {
    const { vaultId } = await loadWithVault()
    const write = await loadWriteService()

    const result = write.createNoteFile({
      vaultId,
      title: '我的笔记',
      content: '正文内容',
    })

    expect(result.relativePath).toBe('我的笔记.md')
    const content = readFileSync(result.absolutePath, 'utf-8')
    expect(content).toContain('# 我的笔记')
    expect(content).toContain('正文内容')
  })

  test('默认不覆盖已存在的笔记', async () => {
    const { vaultId } = await loadWithVault()
    const write = await loadWriteService()
    const input = { vaultId, title: '重复', content: 'first' }
    write.createNoteFile(input)

    expect(() => write.createNoteFile(input)).toThrow('已存在')
    // 原内容未被改动
    expect(readFileSync(join(vaultDir, '重复.md'), 'utf-8')).toContain('first')
  })

  test('显式要求时可覆盖', async () => {
    const { vaultId } = await loadWithVault()
    const write = await loadWriteService()
    write.createNoteFile({ vaultId, title: 'n', content: 'old' })
    write.createNoteFile({ vaultId, title: 'n', content: 'new', overwrite: true })
    expect(readFileSync(join(vaultDir, 'n.md'), 'utf-8')).toContain('new')
  })

  test('可创建到子目录', async () => {
    const { vaultId } = await loadWithVault()
    const write = await loadWriteService()
    const result = write.createNoteFile({
      vaultId,
      title: '子目录笔记',
      directory: 'projects',
      content: 'x',
    })
    expect(result.relativePath).toBe('projects/子目录笔记.md')
    expect(existsSync(result.absolutePath)).toBe(true)
  })

  test('更新保留原标题', async () => {
    const { vaultId } = await loadWithVault()
    const write = await loadWriteService()
    write.createNoteFile({ vaultId, title: '原标题', content: 'old' })

    write.updateNoteFile({ vaultId, relativePath: '原标题.md', content: 'new' })
    const content = readFileSync(join(vaultDir, '原标题.md'), 'utf-8')
    expect(content).toContain('# 原标题')
    expect(content).toContain('new')
    expect(content).not.toContain('old')
  })

  test('更新不存在的笔记报错', async () => {
    const { vaultId } = await loadWithVault()
    const write = await loadWriteService()
    expect(() =>
      write.updateNoteFile({ vaultId, relativePath: 'nope.md', content: 'x' }),
    ).toThrow('不存在')
  })

  test('重命名同时改文件名与标题', async () => {
    const { vaultId } = await loadWithVault()
    const write = await loadWriteService()
    write.createNoteFile({ vaultId, title: '旧名', content: '正文' })

    write.renameNoteFile({ vaultId, relativePath: '旧名.md', newTitle: '新名' })

    expect(existsSync(join(vaultDir, '旧名.md'))).toBe(false)
    const content = readFileSync(join(vaultDir, '新名.md'), 'utf-8')
    expect(content).toContain('# 新名')
    expect(content).toContain('正文')
  })

  test('重命名到已存在的笔记被拒绝', async () => {
    const { vaultId } = await loadWithVault()
    const write = await loadWriteService()
    write.createNoteFile({ vaultId, title: 'a', content: 'x' })
    write.createNoteFile({ vaultId, title: 'b', content: 'y' })

    expect(() =>
      write.renameNoteFile({ vaultId, relativePath: 'a.md', newTitle: 'b' }),
    ).toThrow('已存在')
    // 两个文件都还在
    expect(existsSync(join(vaultDir, 'a.md'))).toBe(true)
    expect(existsSync(join(vaultDir, 'b.md'))).toBe(true)
  })

  test('删除笔记文件', async () => {
    const { vaultId } = await loadWithVault()
    const write = await loadWriteService()
    write.createNoteFile({ vaultId, title: '待删', content: 'x' })

    write.deleteNoteFile(vaultId, '待删.md')
    expect(existsSync(join(vaultDir, '待删.md'))).toBe(false)
  })

  test('删除不存在的文件报错', async () => {
    const { vaultId } = await loadWithVault()
    const write = await loadWriteService()
    expect(() => write.deleteNoteFile(vaultId, 'nope.md')).toThrow('不存在')
  })

  test('删除操作不触碰 vault 外的同名文件', async () => {
    const { vaultId } = await loadWithVault()
    const write = await loadWriteService()

    // 在 vault 外放一个文件
    const outsideFile = join(tempDir, 'outside.md')
    writeFileSync(outsideFile, 'do not touch')

    expect(() => write.deleteNoteFile(vaultId, '../outside.md')).toThrow('上级目录')
    expect(existsSync(outsideFile)).toBe(true)
    expect(readFileSync(outsideFile, 'utf-8')).toBe('do not touch')
  })

  test('未知 vault 报错', async () => {
    const write = await loadWriteService()
    expect(() => write.createNoteFile({ vaultId: 'nope', title: 't' })).toThrow('Vault 不存在')
  })
})

describe('读取笔记原文', () => {
  test('返回原文与解析结果', async () => {
    const { vaultId } = await loadWithVault()
    const write = await loadWriteService()
    write.createNoteFile({
      vaultId,
      title: '读取测试',
      content: '正文 [[链接]]',
      frontmatter: { tags: ['x'] },
    })

    const result = write.readNoteFile(vaultId, '读取测试.md')
    expect(result).not.toBeNull()
    expect(result!.rawContent).toContain('# 读取测试')
    expect(result!.parsed.title).toBe('读取测试')
  })

  test('文件不存在返回 null 而非抛错', async () => {
    const { vaultId } = await loadWithVault()
    const write = await loadWriteService()
    expect(write.readNoteFile(vaultId, 'nope.md')).toBeNull()
  })

  test('stat 返回大小与修改时间', async () => {
    const { vaultId } = await loadWithVault()
    const write = await loadWriteService()
    write.createNoteFile({ vaultId, title: 'stat', content: 'x' })

    const stat = write.statNoteFile(vaultId, 'stat.md')
    expect(stat).not.toBeNull()
    expect(stat!.size).toBeGreaterThan(0)
    expect(Number.isNaN(new Date(stat!.modifiedAt).getTime())).toBe(false)
  })
})

describe('保存后内容不漂移', () => {
  test('读取 → 保存 → 再读取，内容保持一致', async () => {
    const { vaultId } = await loadWithVault()
    const write = await loadWriteService()

    write.createNoteFile({
      vaultId,
      title: '漂移测试',
      content: '第一段\n\n第二段 with [[链接]]',
      frontmatter: { tags: ['a', 'b'] },
    })

    const first = readFileSync(join(vaultDir, '漂移测试.md'), 'utf-8')
    const parsed = write.readNoteFile(vaultId, '漂移测试.md')!

    // 用解析结果重新保存（模拟 UI 的「打开 → 保存」）
    write.updateNoteFile({
      vaultId,
      relativePath: '漂移测试.md',
      content: parsed.parsed.content.replace(/^#\s+.+\n\n/, ''),
      frontmatter: { tags: ['a', 'b'] },
    })

    const second = readFileSync(join(vaultDir, '漂移测试.md'), 'utf-8')
    expect(second).toBe(first)
  })
})
