import { describe, expect, test } from 'bun:test'
import { applyThemeToDOM } from './theme'

const styles = [
  'landscape-night',
  'vermeer-night',
  'caravaggio-night',
  'vangogh-night',
  'synthwave-night',
] as const

const existingStyles = [
  'ocean-light', 'ocean-dark', 'forest-light', 'forest-dark', 'slate-light',
  'slate-dark', 'ember-light', 'ember-dark', 'porcelain', 'landscape',
] as const

interface Rgb {
  r: number
  g: number
  b: number
}

function hslToRgb(value: string): Rgb {
  const match = /^(\d+) (\d+)% (\d+)%$/.exec(value)
  if (!match) throw new Error(`无法解析 HSL：${value}`)
  const hue = Number(match[1]) / 360
  const saturation = Number(match[2]) / 100
  const lightness = Number(match[3]) / 100
  const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation
  const x = chroma * (1 - Math.abs((hue * 6) % 2 - 1))
  const offset = lightness - chroma / 2
  const sector = Math.floor(hue * 6) % 6
  const rgbTriplets: Array<[number, number, number]> = [
    [chroma, x, 0], [x, chroma, 0], [0, chroma, x],
    [0, x, chroma], [x, 0, chroma], [chroma, 0, x],
  ]
  const channels = rgbTriplets[sector]
  if (!channels) throw new Error(`无效色相：${value}`)
  const [r, g, b] = channels
  return { r: r + offset, g: g + offset, b: b + offset }
}

function luminance(color: Rgb): number {
  const linear = (channel: number): number => channel <= 0.04045
    ? channel / 12.92
    : ((channel + 0.055) / 1.055) ** 2.4
  return 0.2126 * linear(color.r) + 0.7152 * linear(color.g) + 0.0722 * linear(color.b)
}

function contrast(first: string, second: string): number {
  const values = [luminance(hslToRgb(first)), luminance(hslToRgb(second))]
  return (Math.max(...values) + 0.05) / (Math.min(...values) + 0.05)
}

function palette(css: string, style: string): Record<string, string> {
  const block = css.match(new RegExp(`\\.theme-${style} \\{([^}]+)\\}`))?.[1]
  if (!block) throw new Error(`缺少主题：${style}`)
  return Object.fromEntries(
    [...block.matchAll(/--(art-[\w-]+):\s*([\d]+ [\d]+% [\d]+%)\s*;/g)]
      .map(([, key, value]) => [key, value]),
  )
}

function requiredColor(colors: Record<string, string>, key: string): string {
  const color = colors[key]
  if (!color) throw new Error(`缺少颜色：${key}`)
  return color
}

function existingPalette(css: string, style: string): Record<string, string> {
  const block = css.match(new RegExp(`\\.theme-${style} \\{([^}]+)\\}`))?.[1]
  if (!block) throw new Error(`缺少主题：${style}`)
  return Object.fromEntries(
    [...block.matchAll(/--([\w-]+):\s*([\d]+ [\d]+% [\d]+%)\s*;/g)]
      .map(([, key, value]) => [key, value]),
  )
}

describe('主题文字与交互对比度', () => {
  test('现有风格的基础文字、主按钮和聚焦环满足对比阈值', async () => {
    const css = await Bun.file(new URL('../styles/globals.css', import.meta.url)).text()
    for (const style of existingStyles) {
      const colors = existingPalette(css, style)
      expect(contrast(requiredColor(colors, 'foreground'), requiredColor(colors, 'background')), `${style} 正文`).toBeGreaterThanOrEqual(4.5)
      expect(contrast(requiredColor(colors, 'muted-foreground'), requiredColor(colors, 'background')), `${style} 弱化文字`).toBeGreaterThanOrEqual(4.5)
      expect(contrast(requiredColor(colors, 'primary-foreground'), requiredColor(colors, 'primary')), `${style} 主按钮`).toBeGreaterThanOrEqual(4.5)
      expect(contrast(requiredColor(colors, 'ring'), requiredColor(colors, 'background')), `${style} 聚焦环`).toBeGreaterThanOrEqual(3)
    }
  })

  test('正文和弱化文字在主背景及面板上保持可读', async () => {
    const css = await Bun.file(new URL('../styles/globals.css', import.meta.url)).text()
    for (const style of styles) {
      const colors = palette(css, style)
      for (const surface of ['art-background', 'art-panel']) {
        expect(contrast(requiredColor(colors, 'art-foreground'), requiredColor(colors, surface)), `${style} 正文 / ${surface}`).toBeGreaterThanOrEqual(4.5)
        expect(contrast(requiredColor(colors, 'art-muted-foreground'), requiredColor(colors, surface)), `${style} 弱化文字 / ${surface}`).toBeGreaterThanOrEqual(4.5)
        expect(contrast(requiredColor(colors, 'art-signal'), requiredColor(colors, surface)), `${style} 交互色 / ${surface}`).toBeGreaterThanOrEqual(3)
      }
      expect(contrast(requiredColor(colors, 'art-background'), requiredColor(colors, 'art-signal')), `${style} 主按钮文字`).toBeGreaterThanOrEqual(4.5)
    }
  })
})

// 主题切换必须清除上一个特殊风格，避免跨主题变量叠加。

test('从夜间艺术主题切回日间主题和普通暗色时清除旧类名', () => {
  const classes = new Set<string>()
  const original = Object.getOwnPropertyDescriptor(globalThis, 'document')
  const classList = {
    contains: (name: string): boolean => classes.has(name),
    add: (name: string): void => { classes.add(name) },
    remove: (name: string): void => { classes.delete(name) },
    toggle: (name: string, force?: boolean): void => {
      if (force) classes.add(name)
      else classes.delete(name)
    },
  }
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: { documentElement: { classList } },
  })
  try {
    applyThemeToDOM('special', 'vermeer-night', true)
    expect(classes.has('dark')).toBe(true)
    expect(classes.has('theme-vermeer-night')).toBe(true)

    applyThemeToDOM('special', 'landscape', true)
    expect(classes.has('dark')).toBe(false)
    expect(classes.has('theme-vermeer-night')).toBe(false)
    expect(classes.has('theme-landscape')).toBe(true)

    applyThemeToDOM('dark', 'default', true)
    expect(classes.has('dark')).toBe(true)
    expect(classes.has('theme-landscape')).toBe(false)
  } finally {
    if (original) Object.defineProperty(globalThis, 'document', original)
    else Reflect.deleteProperty(globalThis, 'document')
  }
})
