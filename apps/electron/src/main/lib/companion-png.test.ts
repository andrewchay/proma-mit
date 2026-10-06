import { describe, expect, test } from 'bun:test'
import { inflateSync } from 'node:zlib'
import { renderCompanionIconPng } from './companion-png'

/**
 * Companion 图标 PNG 生成测试：验证 PNG 结构合法（签名/IHDR/IDAT 解压长度/透明圆角）。
 */

function readChunk(buf: Buffer, offset: number): { type: string; data: Buffer } {
  const length = buf.readUInt32BE(offset)
  const type = buf.toString('ascii', offset + 4, offset + 8)
  return { type, data: buf.subarray(offset + 8, offset + 8 + length) }
}

describe('renderCompanionIconPng', () => {
  test.each([192, 512])('生成合法 PNG（%i×%i）', (size) => {
    const png = renderCompanionIconPng(size)
    // 签名
    expect(png.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a')
    // IHDR：宽高正确、8bit RGBA
    const ihdr = readChunk(png, 8)
    expect(ihdr.type).toBe('IHDR')
    expect(ihdr.data.readUInt32BE(0)).toBe(size)
    expect(ihdr.data.readUInt32BE(4)).toBe(size)
    expect(ihdr.data[8]).toBe(8) // bit depth
    expect(ihdr.data[9]).toBe(6) // color type RGBA
    // IDAT 解压后 = 每行 filter 字节 + RGBA 像素
    const idat = readChunk(png, 8 + 12 + ihdr.data.length)
    expect(idat.type).toBe('IDAT')
    const raw = inflateSync(idat.data)
    expect(raw.length).toBe(size * (size * 4 + 1))
    // IEND 收尾
    expect(png.toString('ascii', png.length - 8, png.length - 4)).toBe('IEND')
  })

  test('圆角外透明、中心为白色圆', () => {
    const size = 192
    const png = renderCompanionIconPng(size)
    const ihdr = readChunk(png, 8)
    const idat = readChunk(png, 8 + 12 + ihdr.data.length)
    const raw = inflateSync(idat.data)
    function pixel(x: number, y: number): [number, number, number, number] {
      const rowStart = y * (size * 4 + 1)
      return [raw[rowStart + 1 + x * 4]!, raw[rowStart + 2 + x * 4]!, raw[rowStart + 3 + x * 4]!, raw[rowStart + 4 + x * 4]!]
    }
    // 角落（圆角外）透明
    expect(pixel(0, 0)[3]).toBe(0)
    // 方块区域为主题蓝色（非透明）
    expect(pixel(20, size / 2)[3]).toBe(255)
    // 正中心为白色圆
    const center = pixel(size / 2, size / 2)
    expect(center[0]).toBe(255)
    expect(center[1]).toBe(255)
    expect(center[2]).toBe(255)
  })
})
