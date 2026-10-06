/**
 * Companion PWA 图标生成
 *
 * 纯像素数学生成 PNG（圆角方块 + 白色圆心），零依赖、结果确定、可单测。
 * 图标随 companion-server 路由返回（/icon-192.png、/icon-512.png），供 PWA manifest 引用。
 */

import { deflateSync } from 'node:zlib'

/** 主题色（与页面 --accent 一致） */
const ACCENT: [number, number, number] = [0x4c, 0x8d, 0xff]
/** 圆角半径占边长比例 */
const CORNER_RADIUS_RATIO = 0.18
/** 白色圆半径占边长比例 */
const CIRCLE_RADIUS_RATIO = 0.28

// ===== CRC32（PNG chunk 校验） =====

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    }
    table[n] = c >>> 0
  }
  return table
})()

function crc32(data: Buffer): number {
  let crc = 0xffffffff
  for (let i = 0; i < data.length; i++) {
    crc = CRC_TABLE[(crc ^ data[i]!) & 0xff]! ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length, 0)
  const typeBuf = Buffer.from(type, 'ascii')
  const crcBuf = Buffer.alloc(4)
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0)
  return Buffer.concat([length, typeBuf, data, crcBuf])
}

/** 生成 size×size 的圆角方块图标 PNG */
export function renderCompanionIconPng(size: number): Buffer {
  const radius = size * CORNER_RADIUS_RATIO
  const circleR = size * CIRCLE_RADIUS_RATIO
  const cx = size / 2
  const cy = size / 2

  // 原始扫描线：每行前置 filter 字节 0
  const raw = Buffer.alloc(size * (size * 4 + 1))
  for (let y = 0; y < size; y++) {
    const rowStart = y * (size * 4 + 1)
    raw[rowStart] = 0
    for (let x = 0; x < size; x++) {
      const offset = rowStart + 1 + x * 4
      // 圆角方块判定：距四个圆心的最小距离 <= radius
      const nearestX = Math.min(Math.max(x, radius), size - radius)
      const nearestY = Math.min(Math.max(y, radius), size - radius)
      const inSquare = (x - nearestX) ** 2 + (y - nearestY) ** 2 <= radius * radius
      // 白色圆判定
      const inCircle = (x - cx) ** 2 + (y - cy) ** 2 <= circleR * circleR
      if (inSquare) {
        const color = inCircle ? [255, 255, 255] : ACCENT
        raw[offset] = color[0]!
        raw[offset + 1] = color[1]!
        raw[offset + 2] = color[2]!
        raw[offset + 3] = 255
      }
      // 方块外保持透明（0）
    }
  }

  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // color type: RGBA
  ihdr[10] = 0 // compression
  ihdr[11] = 0 // filter
  ihdr[12] = 0 // interlace

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}
