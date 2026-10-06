/**
 * 主题意象纹样层
 *
 * 特殊风格主题下，在整个应用之上叠加一层极低透明度的主题专属纹样
 * （鼠尾草穗、蜜桃、青花缠枝、山峦折线、星月旋涡……），
 * 让每个配色像一块有画风的"釉面"，而不只是纯色。
 *
 * - pointer-events-none，不影响任何交互
 * - 透明度 0.04~0.08，长文阅读几乎无感，近看有质感
 * - 普通 浅色/深色/跟随系统 模式不渲染，保持纯净
 */

import * as React from 'react'
import { useAtomValue } from 'jotai'
import { themeModeAtom, themeStyleAtom } from '@/atoms/theme'
import type { ThemeStyle } from '../../../types'

interface TextureDef {
  /** 平铺单元边长（px） */
  size: number
  /** 整层透明度 */
  opacity: number
  /** pattern 内部图形 */
  content: React.ReactNode
}

/** 各主题纹样定义（stroke 用主题主色，深色主题用提亮版） */
const THEME_TEXTURES: Partial<Record<ThemeStyle, TextureDef>> = {
  // 晴空碧海：海浪弧线
  'ocean-light': {
    size: 48,
    opacity: 0.08,
    content: (
      <g fill="none" stroke="#2e6f9e" strokeWidth="1.2" strokeLinecap="round">
        <path d="M0 24 Q 12 15, 24 24 T 48 24" />
        <path d="M0 42 Q 12 33, 24 42 T 48 42" opacity="0.55" />
      </g>
    ),
  },
  'ocean-dark': {
    size: 48,
    opacity: 0.06,
    content: (
      <g fill="none" stroke="#4cacf0" strokeWidth="1.2" strokeLinecap="round">
        <path d="M0 24 Q 12 15, 24 24 T 48 24" />
        <path d="M0 42 Q 12 33, 24 42 T 48 42" opacity="0.55" />
      </g>
    ),
  },
  // 森息：松针小枝
  'forest-light': {
    size: 48,
    opacity: 0.08,
    content: (
      <g fill="none" stroke="#3f8361" strokeWidth="1.2" strokeLinecap="round">
        <path d="M10 42 C 12 30, 18 20, 28 12" />
        <path d="M16 32 L 10 26 M20 26 L 14 18 M26 20 L 22 12" opacity="0.7" />
      </g>
    ),
  },
  'forest-dark': {
    size: 48,
    opacity: 0.06,
    content: (
      <g fill="none" stroke="#46916b" strokeWidth="1.2" strokeLinecap="round">
        <path d="M10 42 C 12 30, 18 20, 28 12" />
        <path d="M16 32 L 10 26 M20 26 L 14 18 M26 20 L 22 12" opacity="0.7" />
      </g>
    ),
  },
  // 云朵舞者 / 莫兰迪夜：云弧
  'slate-light': {
    size: 48,
    opacity: 0.08,
    content: (
      <path d="M8 32 a 8 8 0 0 1 8 -9 a 7 7 0 0 1 13 1 a 6 6 0 0 1 9 5" fill="none" stroke="#9b634b" strokeWidth="1.2" strokeLinecap="round" />
    ),
  },
  'slate-dark': {
    size: 48,
    opacity: 0.06,
    content: (
      <path d="M8 32 a 8 8 0 0 1 8 -9 a 7 7 0 0 1 13 1 a 6 6 0 0 1 9 5" fill="none" stroke="#c9a89e" strokeWidth="1.2" strokeLinecap="round" />
    ),
  },
  // 余烬：上升火星
  'ember-light': {
    size: 48,
    opacity: 0.08,
    content: (
      <g fill="#af5c2c">
        <circle cx="14" cy="34" r="1.6" />
        <circle cx="22" cy="24" r="1.1" opacity="0.75" />
        <circle cx="30" cy="14" r="0.8" opacity="0.5" />
        <path d="M38 40 C 36 34, 38 30, 40 26 C 42 30, 44 34, 42 40 Z" opacity="0.6" />
      </g>
    ),
  },
  'ember-dark': {
    size: 48,
    opacity: 0.06,
    content: (
      <g fill="#d27640">
        <circle cx="14" cy="34" r="1.6" />
        <circle cx="22" cy="24" r="1.1" opacity="0.75" />
        <circle cx="30" cy="14" r="0.8" opacity="0.5" />
        <path d="M38 40 C 36 34, 38 30, 40 26 C 42 30, 44 34, 42 40 Z" opacity="0.6" />
      </g>
    ),
  },
  // 青花瓷：缠枝小瓣花
  porcelain: {
    size: 48,
    opacity: 0.07,
    content: (
      <g fill="none" stroke="#2f4fa8" strokeWidth="1.1" strokeLinecap="round">
        <path d="M4 40 Q 16 30, 24 34 T 44 28" />
        <circle cx="24" cy="16" r="3" />
        <ellipse cx="24" cy="9.5" rx="2" ry="3" opacity="0.75" />
        <ellipse cx="30.5" cy="16" rx="3" ry="2" opacity="0.75" />
        <ellipse cx="17.5" cy="16" rx="3" ry="2" opacity="0.75" />
      </g>
    ),
  },
  // 青绿山水：山尖折线 + 水纹
  landscape: {
    size: 48,
    opacity: 0.07,
    content: (
      <g fill="none" stroke="#2e7d64" strokeWidth="1.1" strokeLinecap="round" strokeLinejoin="round">
        <path d="M4 34 L 15 18 L 23 30 L 33 14 L 44 32" />
        <path d="M10 42 H 38" opacity="0.5" />
      </g>
    ),
  },
  // 鼠尾草：小穗叶
  sage: {
    size: 48,
    opacity: 0.08,
    content: (
      <g fill="none" stroke="#5c6663" strokeWidth="1.1" strokeLinecap="round">
        <path d="M24 42 C 24 34, 24 26, 24 16" />
        <ellipse cx="24" cy="13" rx="2" ry="3.4" fill="#5c6663" stroke="none" opacity="0.85" />
        <ellipse cx="19.5" cy="19" rx="1.8" ry="2.8" fill="#5c6663" stroke="none" opacity="0.6" transform="rotate(-26 19.5 19)" />
        <ellipse cx="28.5" cy="19" rx="1.8" ry="2.8" fill="#5c6663" stroke="none" opacity="0.6" transform="rotate(26 28.5 19)" />
      </g>
    ),
  },
  // 蜜桃奶油：小蜜桃与叶
  peach: {
    size: 48,
    opacity: 0.07,
    content: (
      <g fill="none" stroke="#a45437" strokeWidth="1.1" strokeLinecap="round">
        <circle cx="22" cy="28" r="6.5" />
        <path d="M22 21.5 C 22 19, 22.5 17, 24 15.5" />
        <ellipse cx="29" cy="13.5" rx="4.4" ry="1.9" fill="#a45437" stroke="none" opacity="0.7" transform="rotate(-20 29 13.5)" />
        <path d="M19.5 26 A 5.5 5.5 0 0 1 22 22.5" opacity="0.5" />
      </g>
    ),
  },
  // 薰衣草：小圆粒穗 + 对生细叶
  lavender: {
    size: 48,
    opacity: 0.07,
    content: (
      <g fill="none" stroke="#9c8fbf" strokeWidth="1.1" strokeLinecap="round">
        <path d="M24 42 C 24 34, 24 26, 24 18" />
        <path d="M24 34 C 20 32, 18 28, 18 24" opacity="0.6" />
        <path d="M24 30 C 28 28, 30 24, 30 20" opacity="0.6" />
        <circle cx="24" cy="14" r="2" fill="#9c8fbf" stroke="none" opacity="0.85" />
        <circle cx="20" cy="20" r="1.6" fill="#9c8fbf" stroke="none" opacity="0.6" />
        <circle cx="28" cy="18" r="1.6" fill="#9c8fbf" stroke="none" opacity="0.6" />
      </g>
    ),
  },
  // 千里江山·夜：大山形折线
  'landscape-night': {
    size: 96,
    opacity: 0.05,
    content: (
      <g fill="none" stroke="#66DCC5" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M6 66 L 30 34 L 48 60 L 68 28 L 90 62" />
        <path d="M16 82 H 80" opacity="0.45" />
      </g>
    ),
  },
  // 维米尔·夜：田字亮窗
  'vermeer-night': {
    size: 96,
    opacity: 0.05,
    content: (
      <g fill="none" stroke="#E5C86B" strokeWidth="1.2" strokeLinecap="round">
        <rect x="26" y="26" width="44" height="44" rx="4" />
        <path d="M48 26 V 70 M26 48 H 70" opacity="0.7" />
      </g>
    ),
  },
  // 卡拉瓦乔：斜射光束
  'caravaggio-night': {
    size: 96,
    opacity: 0.05,
    content: (
      <g fill="none" stroke="#D9A45B" strokeWidth="1.2" strokeLinecap="round">
        <path d="M10 10 L 86 82" />
        <path d="M26 8 L 88 66" opacity="0.55" />
      </g>
    ),
  },
  // 星月夜：小旋涡
  'vangogh-night': {
    size: 96,
    opacity: 0.05,
    content: (
      <g fill="none" stroke="#E7C456" strokeWidth="1.3" strokeLinecap="round">
        <path d="M30 52 C 36 40, 56 40, 60 50 C 63 58, 52 63, 46 58 C 41 54, 45 46, 51 48" />
        <circle cx="74" cy="28" r="1.6" fill="#E7C456" stroke="none" />
        <circle cx="22" cy="76" r="1.2" fill="#E7C456" stroke="none" opacity="0.7" />
      </g>
    ),
  },
  // 霓虹合成波：地平网格
  'synthwave-night': {
    size: 96,
    opacity: 0.06,
    content: (
      <g fill="none" stroke="#8A5BD6" strokeWidth="1" strokeLinecap="round">
        <path d="M48 62 L 8 94" />
        <path d="M48 62 L 88 94" />
        <path d="M48 62 V 94" />
        <path d="M4 74 H 92" opacity="0.6" />
        <path d="M4 88 H 92" opacity="0.35" />
      </g>
    ),
  },
}

/** 主题意象纹样层：在特殊风格主题下渲染，其余模式返回 null */
export function ThemeTextureLayer(): React.ReactElement | null {
  const themeMode = useAtomValue(themeModeAtom)
  const themeStyle = useAtomValue(themeStyleAtom)

  const texture = themeMode === 'special' && themeStyle !== 'default'
    ? THEME_TEXTURES[themeStyle]
    : undefined
  if (!texture) return null

  return (
    <div
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 z-[61]"
      style={{ opacity: texture.opacity }}
    >
      <svg className="h-full w-full">
        <defs>
          <pattern id="theme-texture-pattern" width={texture.size} height={texture.size} patternUnits="userSpaceOnUse">
            {texture.content}
          </pattern>
        </defs>
        <rect width="100%" height="100%" fill="url(#theme-texture-pattern)" />
      </svg>
    </div>
  )
}
