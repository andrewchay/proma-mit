import { nativeImage } from 'electron'
import type { NativeImage } from 'electron'

/** 所有 Dock 图标共用透明留白；原始素材不变，切换与启动不会累计缩放。 */
export function createDockIcon(iconPath: string): NativeImage {
  const source = nativeImage.createFromPath(iconPath)
  if (source.isEmpty()) throw new Error(`[图标] 无法读取图标: ${iconPath}`)

  const canvasSize = 1024
  const contentSize = 824
  const { width, height } = source.getSize()
  const scale = contentSize / Math.max(width, height)
  const resized = source.resize({
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
    quality: 'best',
  })
  const size = resized.getSize()
  const pixels = resized.toBitmap()
  const canvas = Buffer.alloc(canvasSize * canvasSize * 4)
  const left = Math.floor((canvasSize - size.width) / 2)
  const top = Math.floor((canvasSize - size.height) / 2)
  const rowBytes = size.width * 4

  for (let row = 0; row < size.height; row++) {
    pixels.copy(canvas, ((top + row) * canvasSize + left) * 4, row * rowBytes, (row + 1) * rowBytes)
  }

  return nativeImage.createFromBitmap(canvas, { width: canvasSize, height: canvasSize, scaleFactor: 1 })
}
