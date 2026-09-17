import { beforeAll, describe, expect, test } from 'bun:test'
import {
  computeWechatCallbackSignature,
  decryptWechatMessage,
  deriveAesKey,
  encryptWechatMessage,
  extractComponentVerifyTicket,
  extractXmlCdataField,
  verifyWechatCallbackSignature,
} from './message-crypto'

const MATERIAL = { token: 'test-token', encodingAesKey: 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ' }

describe('P3-02 消息加解密', () => {
  test('EncodingAESKey 校验', () => {
    expect(deriveAesKey(MATERIAL).key.byteLength).toBe(32)
    expect(deriveAesKey(MATERIAL).iv.byteLength).toBe(16)
    expect(() => deriveAesKey({ token: 't', encodingAesKey: 'short' })).toThrow(/43 位/)
    expect(() => deriveAesKey({ token: 't', encodingAesKey: '包含非法字符!'.padEnd(43, 'x') })).toThrow(/43 位字母数字/)
  })

  test('加解密往返：明文、receiveId 完整还原', () => {
    const message = '<xml><ComponentVerifyTicket><![CDATA[ticket-abc-123]]></ComponentVerifyTicket></xml>'
    const encrypt = encryptWechatMessage({ ...MATERIAL, message, receiveId: 'wx1234567890abcdef' })
    const decrypted = decryptWechatMessage({ ...MATERIAL, encrypt })
    expect(decrypted.message).toBe(message)
    expect(decrypted.receiveId).toBe('wx1234567890abcdef')
    expect(extractComponentVerifyTicket(decrypted.message)).toBe('ticket-abc-123')
  })

  test('长消息与多字节字符往返一致', () => {
    const message = `<xml><ComponentVerifyTicket><![CDATA[${'长'.repeat(500)}]]></ComponentVerifyTicket></xml>`
    const encrypt = encryptWechatMessage({ ...MATERIAL, message, receiveId: 'wx1234567890abcdef' })
    expect(decryptWechatMessage({ ...MATERIAL, encrypt }).message).toBe(message)
  })

  test('密钥不匹配时解密失败且不回显密钥', () => {
    const encrypt = encryptWechatMessage({ ...MATERIAL, message: '<xml/>', receiveId: 'wx1' })
    const otherKey = { token: 'test-token', encodingAesKey: 'ZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ' }
    // 错误密钥下解密必然被拒绝（填充校验 / 长度字段 / 解密任一环节），具体分支取决于垃圾数据。
    expect(() => decryptWechatMessage({ ...otherKey, encrypt })).toThrow()
    try {
      decryptWechatMessage({ ...otherKey, encrypt })
    } catch (error) {
      expect((error as Error).message).not.toContain(MATERIAL.encodingAesKey)
      expect((error as Error).message).not.toContain('ticket-abc-123')
    }
  })

  test('密文被篡改（换密文末块）时解密失败', () => {
    const encrypt = encryptWechatMessage({ ...MATERIAL, message: '<xml><ComponentVerifyTicket><![CDATA[t]]></ComponentVerifyTicket></xml>', receiveId: 'wx1' })
    const raw = Buffer.from(encrypt, 'base64')
    const lastIndex = raw.length - 1
    const lastByte = lastIndex >= 0 ? raw[lastIndex] : undefined
    if (lastByte !== undefined) raw[lastIndex] = lastByte ^ 0x01
    expect(() => decryptWechatMessage({ ...MATERIAL, encrypt: raw.toString('base64') })).toThrow()
  })

  test('非 Base64 与截断密文被拒绝', () => {
    expect(() => decryptWechatMessage({ ...MATERIAL, encrypt: '不是 base64!!!' })).toThrow()
    expect(() => decryptWechatMessage({ ...MATERIAL, encrypt: Buffer.from('abc').toString('base64') })).toThrow(/长度无效/)
  })
})

describe('P3-02 签名验证', () => {
  const encrypt = encryptWechatMessage({ ...MATERIAL, message: '<xml/>', receiveId: 'wx1' })
  const expected = { token: MATERIAL.token, timestamp: '1700000000', nonce: 'nonce-1', encrypt }

  test('正确签名通过', () => {
    const signature = computeWechatCallbackSignature(expected)
    expect(verifyWechatCallbackSignature({ ...expected, signature })).toBe(true)
  })

  test('篡改任一参数即失败，且比较是恒定时间', () => {
    const signature = computeWechatCallbackSignature(expected)
    expect(signature).toBeTruthy()
    expect(verifyWechatCallbackSignature({ ...expected, signature, timestamp: '1700000001' })).toBe(false)
    expect(verifyWechatCallbackSignature({ ...expected, signature, nonce: 'other' })).toBe(false)
    expect(verifyWechatCallbackSignature({ ...expected, signature: '' })).toBe(false)
    expect(verifyWechatCallbackSignature({ ...expected, signature: `${signature}0` })).toBe(false)
  })
})

describe('P3-02 XML 字段提取', () => {
  test('CDATA 与普通文本均可提取', () => {
    const xml = '<xml><AppId><![CDATA[wx-app]]></AppId><ToUserName>user</ToUserName><Encrypt><![CDATA[enc]]></Encrypt></xml>'
    expect(extractXmlCdataField(xml, 'AppId')).toBe('wx-app')
    expect(extractXmlCdataField(xml, 'Encrypt')).toBe('enc')
    expect(extractXmlCdataField(xml, 'ToUserName')).toBe('user')
    expect(extractXmlCdataField(xml, 'Missing')).toBeUndefined()
    expect(extractComponentVerifyTicket(xml)).toBeUndefined()
  })
})
