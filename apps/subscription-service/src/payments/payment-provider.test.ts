import { describe, expect, test } from 'bun:test'
import { AlipayProvider, WechatPayProvider } from './payment-provider'

describe('payment providers', () => {
  test('WechatPayProvider 创建支付意图并验签回调', async () => {
    const provider = new WechatPayProvider({ appId: 'wx-app', mchId: 'mch-1', apiV3Key: 'key', privateKeyPem: '', serialNo: '', notifyUrl: '' })
    const intent = await provider.createPaymentIntent({ orderId: 'order-1', amountCny: 6800, subject: 'Gravitas Pro' })
    expect(intent.qrCodeContent).toContain('wechat://pay')
    expect(provider.verifyCallback({ verified: true })).toBe(true)
    expect(provider.verifyCallback({ verified: false })).toBe(false)
  })

  test('AlipayProvider 创建支付意图并验签回调', async () => {
    const provider = new AlipayProvider({ appId: 'ali-app', privateKeyPem: '', alipayPublicKeyPem: '', notifyUrl: '' })
    const intent = await provider.createPaymentIntent({ orderId: 'order-2', amountCny: 6800, subject: 'Gravitas Pro' })
    expect(intent.redirectUrl).toContain('alipay://pay')
    expect(provider.verifyCallback({ verified: true })).toBe(true)
    expect(provider.verifyCallback({ verified: false })).toBe(false)
  })
})
