import { createCipheriv, createDecipheriv, createHash, randomUUID, timingSafeEqual } from 'node:crypto'

/**
 * 微信第三方平台消息加解密与签名验证。
 *
 * 实现微信服务端消息加解密约定：
 * - EncodingAESKey（43 字符 Base64URL 字符）补一个 '=' 后 Base64 解码得到 32 字节 AES-256 密钥；
 * - AES-256-CBC，IV 取密钥前 16 字节，PKCS7 填充（微信约定按 32 字节块，与标准 CBC 填充兼容）；
 * - 明文结构：random(16) + msg_len(4 字节网络序) + msg + receiveId；
 * - 签名：sha1(sort(token, timestamp, nonce, encrypt).join(''))。
 *
 * 安全约定：本模块的函数绝不把密钥、明文或 ticket 写入错误信息。
 */

export interface WechatCallbackCryptoMaterial {
  /** 公众号后台配置的 Token（用于签名）。 */
  token: string
  /** 43 字符 EncodingAESKey。 */
  encodingAesKey: string
}

/** 派生 AES 密钥与 IV； EncodingAESKey 校验失败会抛错且不回显内容。 */
export function deriveAesKey(material: WechatCallbackCryptoMaterial): { key: Buffer; iv: Buffer } {
  if (!/^[A-Za-z0-9]{43}$/.test(material.encodingAesKey)) {
    throw new Error('EncodingAESKey 格式不正确：应为 43 位字母数字')
  }
  const key = Buffer.from(`${material.encodingAesKey}=`, 'base64')
  if (key.byteLength !== 32) {
    throw new Error('EncodingAESKey 解码后必须得到 32 字节密钥')
  }
  return { key, iv: key.subarray(0, 16) }
}

/** 微信回调签名：sha1(字典序拼接)。 */
export function computeWechatCallbackSignature(input: { token: string; timestamp: string; nonce: string; encrypt: string }): string {
  return createHash('sha1').update([input.token, input.timestamp, input.nonce, input.encrypt].sort().join('')).digest('hex')
}

/**
 * 验证回调签名（恒定时间比较）。
 */
export function verifyWechatCallbackSignature(input: { token: string; timestamp: string; nonce: string; encrypt: string; signature: string }): boolean {
  if (!input.signature) return false
  const expected = computeWechatCallbackSignature(input)
  const a = Buffer.from(expected)
  const b = Buffer.from(input.signature)
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

function pkcs7Pad(data: Buffer, blockSize = 32): Buffer {
  const padding = blockSize - (data.length % blockSize)
  return Buffer.concat([data, Buffer.alloc(padding, padding)])
}

function pkcs7Unpad(data: Buffer, blockSize = 32): Buffer {
  const padding = data[data.length - 1] ?? 0
  if (padding < 1 || padding > blockSize || padding > data.length) {
    throw new Error('消息填充无效：可能不是微信加密消息或密钥不匹配')
  }
  for (let index = data.length - padding; index < data.length; index += 1) {
    if (data[index] !== padding) throw new Error('消息填充无效：可能不是微信加密消息或密钥不匹配')
  }
  return data.subarray(0, data.length - padding)
}

/** 加密一条微信消息（用于测试与回包场景）。 */
export function encryptWechatMessage(input: WechatCallbackCryptoMaterial & { message: string; receiveId: string; random?: Buffer }): string {
  const { key, iv } = deriveAesKey(input)
  const random = input.random ?? Buffer.from(randomUUID().replace(/-/g, '').slice(0, 16), 'utf8')
  const msg = Buffer.from(input.message, 'utf-8')
  const length = Buffer.alloc(4)
  length.writeUInt32BE(msg.length, 0)
  const plain = Buffer.concat([random, length, msg, Buffer.from(input.receiveId, 'utf-8')])
  const cipher = createCipheriv('aes-256-cbc', key, iv)
  cipher.setAutoPadding(false)
  return Buffer.concat([cipher.update(pkcs7Pad(plain)), cipher.final()]).toString('base64')
}

export interface DecryptedWechatMessage {
  message: string
  receiveId: string
}

/** 解密一条微信加密消息；任何失败都不回显密钥或明文。 */
export function decryptWechatMessage(input: WechatCallbackCryptoMaterial & { encrypt: string }): DecryptedWechatMessage {
  const { key, iv } = deriveAesKey(input)
  let cipherText: Buffer
  try {
    cipherText = Buffer.from(input.encrypt, 'base64')
  } catch {
    throw new Error('密文不是合法的 Base64')
  }
  if (cipherText.length === 0 || cipherText.length % 16 !== 0) {
    throw new Error('密文长度无效')
  }
  const decipher = createDecipheriv('aes-256-cbc', key, iv)
  decipher.setAutoPadding(false)
  let plain: Buffer
  try {
    plain = Buffer.concat([decipher.update(cipherText), decipher.final()])
  } catch {
    throw new Error('消息解密失败：密钥不匹配或密文被篡改')
  }
  let unpadded: Buffer
  try {
    unpadded = pkcs7Unpad(plain)
  } catch (error) {
    throw error instanceof Error ? error : new Error('消息填充无效')
  }
  if (unpadded.length < 20) throw new Error('解密后的消息结构不完整')
  const msgLength = unpadded.readUInt32BE(16)
  if (msgLength <= 0 || 20 + msgLength > unpadded.length) {
    throw new Error('解密后的消息长度字段无效')
  }
  const message = unpadded.subarray(20, 20 + msgLength).toString('utf-8')
  const receiveId = unpadded.subarray(20 + msgLength).toString('utf-8')
  return { message, receiveId }
}

/** 从回调 XML 中提取单个 CDATA 字段（微信回调结构固定，无需完整 XML 解析器）。 */
export function extractXmlCdataField(xml: string, field: string): string | undefined {
  const match = new RegExp(`<${field}>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?</${field}>`, 'i').exec(xml)
  return match?.[1]
}

/** 从解密后的明文 XML 中提取 ComponentVerifyTicket。 */
export function extractComponentVerifyTicket(decryptedXml: string): string | undefined {
  return extractXmlCdataField(decryptedXml, 'ComponentVerifyTicket')
}
