import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { PlatformAdapterError } from '../platform-adapter'
import { saveWechatDirectCredential } from './wechat-direct-credential'
import { clearWechatTokenCache, type WechatTokenTransport } from './wechat-direct-token-service'
import {
  WECHAT_MEDIA_LIMITS,
  WECHAT_MEDIA_LIMITS_SOURCE,
  buildMediaMultipart,
  detectImageFormat,
  ensureWechatMedia,
  findReusableWechatMedia,
  listWechatMediaAssets,
  mediaAssetKey,
  precheckWechatMedia,
  type WechatMediaTransport,
} from './wechat-direct-media-service'
import { clearNewMediaRecordsForTests, closeNewMediaDb } from '../new-media-sqlite-store'

let testDir = ''
const APP_ID = 'wx1234567890abcdef'
const APP_SECRET = 'a1b2c3d4e5f60718293a4b5c6d7e8f90'
const REF = 'ref-media'

beforeAll(() => { testDir = mkdtempSync(join(tmpdir(), 'gravitas-nm-media-')); process.env.PROMA_TEST_CONFIG_DIR = testDir })
afterEach(async () => { clearWechatTokenCache(); await clearNewMediaRecordsForTests() })
afterAll(() => { clearWechatTokenCache(); closeNewMediaDb(); delete process.env.PROMA_TEST_CONFIG_DIR; rmSync(testDir, { recursive: true, force: true }) })

/** 构造带正确魔数的最小图片字节。 */
function fakeImage(format: 'jpg' | 'png' | 'gif' | 'bmp', size = 16): Uint8Array {
  const bytes = new Uint8Array(size)
  if (format === 'jpg') { bytes[0] = 0xff; bytes[1] = 0xd8; bytes[2] = 0xff }
  if (format === 'png') { bytes[0] = 0x89; bytes[1] = 0x50; bytes[2] = 0x4e; bytes[3] = 0x47 }
  if (format === 'gif') { bytes[0] = 0x47; bytes[1] = 0x49; bytes[2] = 0x46; bytes[3] = 0x38 }
  if (format === 'bmp') { bytes[0] = 0x42; bytes[1] = 0x4d }
  return bytes
}

function tokenTransport(): WechatTokenTransport {
  return async () => ({ status: 200, text: async () => JSON.stringify({ access_token: 'TOKEN-MEDIA', expires_in: 7200 }) })
}

/** 记录上传调用的假传输层。 */
function mediaTransport(responses: Array<{ body: unknown; status?: number }>) {
  const calls: Array<{ url: string; body: Uint8Array; headers: Record<string, string> }> = []
  const transport: WechatMediaTransport = async (input) => {
    calls.push({ url: input.url, body: input.body, headers: input.headers })
    const next = responses[Math.min(calls.length - 1, responses.length - 1)]
    return { status: next?.status ?? 200, text: async () => JSON.stringify(next?.body ?? {}) }
  }
  return { transport, calls }
}

function configureCredential(): void {
  saveWechatDirectCredential(REF, { appId: APP_ID, appSecret: APP_SECRET }, { accessToken: '' })
}

describe('P2-03 素材预检', () => {
  test('按魔数识别格式，不信任扩展名', () => {
    expect(detectImageFormat(fakeImage('jpg'))).toBe('jpg')
    expect(detectImageFormat(fakeImage('png'))).toBe('png')
    expect(detectImageFormat(fakeImage('gif'))).toBe('gif')
    expect(detectImageFormat(fakeImage('bmp'))).toBe('bmp')
    expect(detectImageFormat(new TextEncoder().encode('PK\u0003\u0004not-an-image'))).toBeUndefined()
    expect(detectImageFormat(new Uint8Array([0xff]))).toBeUndefined()
  })

  test('扩展名与实际内容不符时按内容拒绝', () => {
    const result = precheckWechatMedia({ fileName: '假装是图片.jpg', bytes: new TextEncoder().encode('这不是图片'), type: 'image', mode: 'permanent' })
    expect(result.ok).toBe(false)
    expect(result.problems.join()).toContain('无法识别图片格式')
  })

  test('超出上限与空文件都被拒绝，并一次列出全部问题', () => {
    const tooBig = precheckWechatMedia({ fileName: 'big.png', bytes: fakeImage('png', WECHAT_MEDIA_LIMITS.image.permanent.maxBytes + 1), type: 'image', mode: 'permanent' })
    expect(tooBig.ok).toBe(false)
    expect(tooBig.problems.join()).toContain('超出该类型上限')

    const empty = precheckWechatMedia({ fileName: 'empty.png', bytes: new Uint8Array(0), type: 'image', mode: 'permanent' })
    expect(empty.ok).toBe(false)
    expect(empty.problems.join()).toContain('素材内容为空')
    // 空内容同时触发格式无法识别，说明返回的是全部问题而不是只报第一个
    expect(empty.problems.length).toBeGreaterThan(1)
  })

  test('缩略图只支持永久素材，模式组合错误被拒绝', () => {
    const result = precheckWechatMedia({ fileName: 'thumb.png', bytes: fakeImage('png'), type: 'thumb', mode: 'temporary' })
    expect(result.ok).toBe(false)
    expect(result.problems[0]).toContain('缩略图只支持永久素材')

    const inline = precheckWechatMedia({ fileName: 'inline.png', bytes: fakeImage('png'), type: 'thumb', mode: 'inline' })
    expect(inline.ok).toBe(false)
  })

  test('临时与内联模式的体积上限低于永久素材', () => {
    expect(WECHAT_MEDIA_LIMITS.image.temporary.maxBytes).toBeLessThan(WECHAT_MEDIA_LIMITS.image.permanent.maxBytes + 1)
    expect(WECHAT_MEDIA_LIMITS.image.inline.maxBytes).toBeLessThan(WECHAT_MEDIA_LIMITS.image.permanent.maxBytes)
    // 限制数值必须标注来源与核对时间，避免被当作平台承诺
    expect(WECHAT_MEDIA_LIMITS_SOURCE.source).toContain('需在真机验收时重新核对')
    expect(WECHAT_MEDIA_LIMITS_SOURCE.verifiedAt).toBeTruthy()
    const inlineTooBig = precheckWechatMedia({ fileName: 'inline.png', bytes: fakeImage('png', WECHAT_MEDIA_LIMITS.image.inline.maxBytes + 1), type: 'image', mode: 'inline' })
    expect(inlineTooBig.ok).toBe(false)
  })
})

describe('P2-03 素材上传与复用', () => {
  test('上传成功记录 media_id 与血缘，不保存本地绝对路径', async () => {
    configureCredential()
    const { transport, calls } = mediaTransport([{ body: { media_id: 'MEDIA-1', url: 'https://mmbiz.qpic.cn/x' } }])
    const { asset, reused } = await ensureMedia({ bytes: fakeImage('png', 24), media: transport, fileName: '/Users/someone/私密路径/封面.png' })

    expect(reused).toBe(false)
    expect(asset.currentMediaId).toBe('MEDIA-1')
    expect(asset.currentUrl).toBe('https://mmbiz.qpic.cn/x')
    expect(asset.type).toBe('image')
    expect(asset.mode).toBe('permanent')
    expect(asset.format).toBe('png')
    expect(asset.byteLength).toBe(24)
    expect(asset.sha256).toHaveLength(64)
    // 只保留文件名，绝不保存本地绝对路径
    expect(asset.sourceFileName).toBe('封面.png')
    expect(JSON.stringify(asset)).not.toContain('/Users/someone')
    // 血缘：平台下发过的 media_id 可追溯
    expect(asset.uploads[0]).toMatchObject({ mediaId: 'MEDIA-1', status: 'uploaded' })

    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toContain('/cgi-bin/material/add_material?type=image&access_token=')
    expect(calls[0]?.headers['content-type']).toContain('multipart/form-data; boundary=')
    // 请求体里只有素材内容，不含 AppSecret
    expect(Buffer.from(calls[0]?.body ?? new Uint8Array()).toString('latin1')).not.toContain(APP_SECRET)
  })

  test('临时素材走 media/upload 并记录有效期', async () => {
    configureCredential()
    const { transport, calls } = mediaTransport([{ body: { media_id: 'MEDIA-TEMP' } }])
    const now = 1_700_000_000_000
    const { asset } = await ensureMedia({ bytes: fakeImage('jpg', 20), media: transport, mode: 'temporary', now })

    expect(calls[0]?.url).toContain('/cgi-bin/media/upload?type=image&access_token=')
    expect(asset.mode).toBe('temporary')
    expect(asset.currentExpiresAt).toBe(now + 3 * 24 * 60 * 60 * 1000)
    expect(asset.uploads[0]?.expiresAt).toBeDefined()
  })
})

describe('P2-03 素材复用与失败追溯', () => {
  test('相同内容第二次直接复用，不再出网', async () => {
    configureCredential()
    const bytes = fakeImage('png', 32)
    const response = { body: { media_id: 'MEDIA-REUSE' } }
    let uploads = 0
    const media: WechatMediaTransport = async () => {
      uploads += 1
      return { status: 200, text: async () => JSON.stringify(response.body) }
    }

    const first = await ensureMedia({ bytes, media })
    expect(first.reused).toBe(false)
    expect(first.asset.currentMediaId).toBe('MEDIA-REUSE')
    expect(first.asset.format).toBe('png')
    expect(first.asset.sourceFileName).toBe('封面.png')
    expect(JSON.stringify(first.asset)).not.toContain('/Users/someone')

    const second = await ensureMedia({ bytes, media })
    expect(second.reused).toBe(true)
    expect(second.asset.id).toBe(first.asset.id)
    expect(uploads).toBe(1)

    // 复用键必须区分账号、类型与模式
    expect(mediaAssetKey({ accountId: 'acc-1', type: 'image', mode: 'permanent', sha256: 'x' }))
      .not.toBe(mediaAssetKey({ accountId: 'acc-2', type: 'image', mode: 'permanent', sha256: 'x' }))
  })

  test('未连接或缺少凭据时不复用，且按需强制重传', async () => {
    configureCredential()
    const bytes = fakeImage('png', 48)
    const media: WechatMediaTransport = async () => ({ status: 200, text: async () => JSON.stringify({ media_id: 'MEDIA-2' }) })
    await ensureMedia({ bytes, media })

    const reusable = await findReusableWechatMedia({ accountId: 'acc-1', type: 'image', mode: 'permanent', sha256: hashOf(bytes) })
    expect(reusable?.currentMediaId).toBe('MEDIA-2')
    // 临时素材不存在时不可复用
    expect(await findReusableWechatMedia({ accountId: 'acc-1', type: 'image', mode: 'temporary', sha256: hashOf(bytes) })).toBeUndefined()

    const forced = await ensureMedia({ bytes, media, forceUpload: true })
    expect(forced.reused).toBe(false)
    expect(forced.asset.uploads.length).toBe(2)
  })

  test('平台错误被映射为可执行原因，并写入失败追溯', async () => {
    configureCredential()
    const cases: Array<{ errcode: number; expect: RegExp }> = [
      { errcode: 40005, expect: /不支持该文件格式/ },
      { errcode: 40006, expect: /超出平台上限/ },
      { errcode: 48001, expect: /没有素材接口权限/ },
    ]
    for (const item of cases) {
      const media: WechatMediaTransport = async () => ({ status: 200, text: async () => JSON.stringify({ errcode: item.errcode, errmsg: 'x' }) })
      const error: Error = await ensureMedia({ bytes: fakeImage('png', 12 + item.errcode), media }).then(
        () => { throw new Error('预期上传失败') },
        (caught: Error) => caught,
      )
      expect(error.message).toMatch(item.expect)
      expect(error.message).toContain(String(item.errcode))
    }
    const assets = await listWechatMediaAssets('acc-1')
    // 失败也要留痕，便于诊断而不是静默丢弃
    expect(assets.length).toBeGreaterThan(0)
    expect(assets[0]?.uploads[0]?.status).toBe('failed')
    expect(assets[0]?.uploads[0]?.errorCode).toBeDefined()
  })

  test('预检未通过时不出网，也不产生素材记录', async () => {
    configureCredential()
    const uploads: string[] = []
    const media: WechatMediaTransport = async (input) => { uploads.push(input.url); return { status: 200, text: async () => '{}' } }
    await expect(ensureMedia({ bytes: new TextEncoder().encode('not an image'), media })).rejects.toThrow(/素材预检未通过/)
    expect(uploads).toHaveLength(0)
    expect(await listWechatMediaAssets()).toEqual([])
  })

  test('multipart 内容与微信接口约定一致，且不含凭据', () => {
    const body = buildMediaMultipart({ fileName: '封面.png', bytes: fakeImage('png', 8), boundary: 'BOUNDARY' })
    const text = Buffer.from(body).toString('latin1')
    expect(text).toContain('--BOUNDARY\r\n')
    expect(text).toContain('name="media"')
    expect(text).toContain(`filename="${encodeURIComponent('封面.png')}"`)
    expect(text.trimEnd().endsWith('--BOUNDARY--')).toBe(true)
    expect(text).not.toContain(APP_SECRET)
  })
})

function hashOf(bytes: Uint8Array): string {
  return new Bun.CryptoHasher('sha256').update(bytes).digest('hex')
}

/** 统一的调用封装：token 与媒体各自注入独立传输层。 */
async function ensureMedia(input: {
  bytes: Uint8Array
  media: WechatMediaTransport
  forceUpload?: boolean
  mode?: 'temporary' | 'permanent' | 'inline'
  now?: number
  fileName?: string
}) {
  return ensureWechatMedia({
    credentialRef: REF,
    accountId: 'acc-1',
    fileName: input.fileName ?? '封面.png',
    bytes: input.bytes,
    type: 'image',
    mode: input.mode ?? 'permanent',
    forceUpload: input.forceUpload,
    now: input.now,
    dependencies: { token: { transport: tokenTransport() }, mediaTransport: input.media },
  })
}
