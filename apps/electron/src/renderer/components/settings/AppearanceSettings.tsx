/**
 * AppearanceSettings - 外观设置页
 *
 * 特殊风格选择 + 主题模式切换（浅色/深色/跟随系统/特殊风格）。
 * 通过 Jotai atom 管理状态，持久化到 ~/.proma/settings.json。
 */

import * as React from 'react'
import { useAtom, useAtomValue } from 'jotai'
import { Check } from 'lucide-react'
import { toast } from 'sonner'
import {
  SettingsSection,
  SettingsCard,
  SettingsRow,
  SettingsSegmentedControl,
} from './primitives'
import {
  themeModeAtom,
  themeStyleAtom,
  systemIsDarkAtom,
  updateThemeMode,
  updateThemeStyle,
  applyThemeToDOM,
} from '@/atoms/theme'
import {
  markdownFontSizeAtom,
  updateMarkdownFontSize,
} from '@/atoms/markdown-font-size'
import { cn } from '@/lib/utils'
import { detectIsWindows } from '@/lib/platform'
import type { ThemeMode, ThemeStyle, MarkdownFontSize } from '../../../types'

// ===== Logo 资源导入（用于图标选择器） =====
import grav01Default from '@/assets/bots/gravitas-logos/gravitas-01-default.png'
import grav02Black from '@/assets/bots/gravitas-logos/gravitas-02-black.png'
import grav03White from '@/assets/bots/gravitas-logos/gravitas-03-white.png'
import grav04Coral from '@/assets/bots/gravitas-logos/gravitas-04-coral.png'
import grav05BrandBlue from '@/assets/bots/gravitas-logos/gravitas-05-brand-blue.png'
import grav06Periwinkle from '@/assets/bots/gravitas-logos/gravitas-06-periwinkle.png'
import grav07VivaMagenta from '@/assets/bots/gravitas-logos/gravitas-07-viva-magenta.png'
import grav08Mocha from '@/assets/bots/gravitas-logos/gravitas-08-mocha.png'
import grav09Emerald from '@/assets/bots/gravitas-logos/gravitas-09-emerald.png'
import grav10Gradient from '@/assets/bots/gravitas-logos/gravitas-10-gradient.png'
import grav11Porcelain from '@/assets/bots/gravitas-logos/gravitas-11-porcelain.png'
import grav12Impressionist from '@/assets/bots/gravitas-logos/gravitas-12-impressionist.png'
import grav13Landscape from '@/assets/bots/gravitas-logos/gravitas-13-landscape.png'

// ===== 主题预览图片导入 =====
import themeCloudDancer from '@/assets/theme-previews/theme-cloud-dancer.webp'
import themeOceanLight from '@/assets/theme-previews/theme-ocean-light.webp'
import themeForestMorning from '@/assets/theme-previews/theme-forest-morning.webp'
import themeOceanDark from '@/assets/theme-previews/theme-ocean-dark.webp'
import themeForestNight from '@/assets/theme-previews/theme-forest-night.webp'
import themeMorandiNight from '@/assets/theme-previews/theme-morandi-night.webp'
import themeEmberLight from '@/assets/theme-previews/theme-ember-light.webp'
import themeEmberDark from '@/assets/theme-previews/theme-ember-dark.webp'
import themePorcelain from '@/assets/theme-previews/theme-porcelain.webp'
import themeLandscape from '@/assets/theme-previews/theme-landscape.webp'

/** 主题选项 */
const THEME_OPTIONS = [
  { value: 'light', label: '浅色' },
  { value: 'dark', label: '深色' },
  { value: 'system', label: '跟随系统' },
  { value: 'special', label: '特殊风格' },
]

/** Markdown 字号选项 */
const MARKDOWN_FONT_SIZE_OPTIONS = [
  { value: 'small', label: '小' },
  { value: 'medium', label: '中' },
  { value: 'large', label: '大' },
]

/** 特殊风格 ID（排除 default） */
type SpecialStyleId = Exclude<ThemeStyle, 'default'>

/** 特殊风格定义：图片与实际界面预览二选一。 */
interface SpecialStyleBase {
  id: SpecialStyleId
  name: string
  variant: 'light' | 'dark'
}

interface ImageStyle extends SpecialStyleBase {
  image: string
  preview?: never
  objectPosition?: string
  imageScale?: number
}

interface PaletteStyle extends SpecialStyleBase {
  preview: { background: string; panel: string; accent: string; text: string }
  image?: never
}

type SpecialStyle = ImageStyle | PaletteStyle

const SPECIAL_STYLES: readonly SpecialStyle[] = [
  {
    id: 'slate-light',
    name: '云朵舞者',
    variant: 'light',
    image: themeCloudDancer,
    imageScale: 1.3,
  },
  {
    id: 'ocean-light',
    name: '晴空碧海',
    variant: 'light',
    image: themeOceanLight,
  },
  {
    id: 'forest-light',
    name: '森息晨光',
    variant: 'light',
    image: themeForestMorning,
    imageScale: 1.45,
  },
  {
    id: 'ocean-dark',
    name: '苍穹暮色',
    variant: 'dark',
    image: themeOceanDark,
  },
  {
    id: 'forest-dark',
    name: '森息夜语',
    variant: 'dark',
    image: themeForestNight,
  },
  {
    id: 'slate-dark',
    name: '莫兰迪夜',
    variant: 'dark',
    image: themeMorandiNight,
    imageScale: 1.15,
    objectPosition: '44% 58%',
  },
  {
    id: 'ember-light',
    name: '余烬晨光',
    variant: 'light',
    image: themeEmberLight,
  },
  {
    id: 'ember-dark',
    name: '余烬暗夜',
    variant: 'dark',
    image: themeEmberDark,
  },
  {
    id: 'porcelain',
    name: '青花瓷',
    variant: 'light',
    image: themePorcelain,
  },
  {
    id: 'landscape',
    name: '青绿山水',
    variant: 'light',
    image: themeLandscape,
  },
  { id: 'landscape-night', name: '千里江山·夜', variant: 'dark',
    preview: { background: '#0D131A', panel: '#162A2B', accent: '#66DCC5', text: '#E5E9F0' } },
  { id: 'vermeer-night', name: '维米尔·夜', variant: 'dark',
    preview: { background: '#121214', panel: '#1E293B', accent: '#E5C86B', text: '#F8F9FA' } },
  { id: 'caravaggio-night', name: '卡拉瓦乔', variant: 'dark',
    preview: { background: '#100F11', panel: '#241C1A', accent: '#D9A45B', text: '#ECE4D7' } },
  { id: 'vangogh-night', name: '梵高·星夜', variant: 'dark',
    preview: { background: '#10162B', panel: '#1E2D4D', accent: '#E7C456', text: '#E8ECF7' } },
  { id: 'synthwave-night', name: '霓虹合成波', variant: 'dark',
    preview: { background: '#0A0714', panel: '#1F1435', accent: '#F27BC5', text: '#E9E5F6' } },
]

/** 图片主题的名称遮罩；调色板主题的名称直接使用预览色。 */
const STYLE_MASK_COLORS: Record<SpecialStyleId, { bg: string; text: string }> = {
  'slate-light':  { bg: 'hsl(18, 20%, 67%)',  text: 'hsl(18, 20%, 88%)' },
  'ocean-light':  { bg: 'hsl(205, 50%, 50%)', text: 'hsl(205, 50%, 82%)' },
  'forest-light': { bg: 'hsl(150, 35%, 38%)', text: 'hsl(150, 35%, 75%)' },
  'ocean-dark':   { bg: 'rgba(0,0,0,0.8)', text: 'hsl(205, 50%, 82%)' },
  'forest-dark':  { bg: 'rgba(0,0,0,0.8)', text: 'hsl(150, 35%, 75%)' },
  'slate-dark':   { bg: 'rgba(0,0,0,0.8)', text: 'hsl(18, 20%, 88%)' },
  'ember-light':  { bg: 'hsl(22, 60%, 52%)',  text: 'hsl(22, 60%, 88%)' },
  'ember-dark':   { bg: 'rgba(0,0,0,0.8)', text: 'hsl(22, 60%, 65%)' },
  'porcelain':    { bg: 'hsl(222, 58%, 44%)', text: 'hsl(218, 40%, 86%)' },
  'landscape':    { bg: 'hsl(165, 48%, 34%)', text: 'hsl(90, 18%, 82%)' },
  'landscape-night': { bg: '#111820', text: '#E5E9F0' },
  'vermeer-night': { bg: '#111820', text: '#E5E9F0' },
  'caravaggio-night': { bg: '#111820', text: '#E5E9F0' },
  'vangogh-night': { bg: '#111820', text: '#E5E9F0' },
  'synthwave-night': { bg: '#111820', text: '#E5E9F0' },


}

/** 图标变体定义 */
interface IconVariant {
  id: string
  name: string
  src: string
  previewBg: string
}

const ICON_VARIANTS: readonly IconVariant[] = [
  { id: 'default', name: '默认', src: '', previewBg: 'bg-neutral-900' },
  { id: '01-default', name: '深炭白标', src: grav01Default, previewBg: 'bg-[#141416]' },
  { id: '02-black', name: '经典黑', src: grav02Black, previewBg: 'bg-neutral-900' },
  { id: '03-white', name: '纯白版', src: grav03White, previewBg: 'bg-white' },
  { id: '04-coral', name: '珊瑚橘', src: grav04Coral, previewBg: 'bg-[#FF6B4A]' },
  { id: '05-brand-blue', name: '品牌蓝', src: grav05BrandBlue, previewBg: 'bg-[#2B5CE6]' },
  { id: '06-periwinkle', name: '长春花蓝', src: grav06Periwinkle, previewBg: 'bg-[#8B93E8]' },
  { id: '07-viva-magenta', name: '非凡洋红', src: grav07VivaMagenta, previewBg: 'bg-[#BB2649]' },
  { id: '08-mocha', name: '摩卡慕斯', src: grav08Mocha, previewBg: 'bg-[#A47864]' },
  { id: '09-emerald', name: '翡翠绿', src: grav09Emerald, previewBg: 'bg-[#1F8A70]' },
  { id: '10-gradient', name: '渐变色', src: grav10Gradient, previewBg: 'bg-gradient-to-r from-[#FF6B4A] to-[#7A5CFF]' },
  { id: '11-porcelain', name: '青花瓷', src: grav11Porcelain, previewBg: 'bg-[#F5F5F5]' },
  { id: '12-impressionist', name: '印象派', src: grav12Impressionist, previewBg: 'bg-[#E8D5B7]' },
  { id: '13-landscape', name: '青绿山水', src: grav13Landscape, previewBg: 'bg-[#D4C4A8]' },
] as const

function normalizeAppIconVariantId(variantId: string): string {
  const legacyVariantIds: Record<string, string> = {
    black: '02-black',
    white: '03-white',
    coral: '04-coral',
    blue: '05-brand-blue',
    'veri-peri': '06-periwinkle',
    periwinkle: '06-periwinkle',
    magenta: '07-viva-magenta',
    mocha: '08-mocha',
    emerald: '09-emerald',
    gradient: '10-gradient',
  }
  return legacyVariantIds[variantId] ?? variantId
}

/** 根据平台返回缩放快捷键提示 */
const isMac = navigator.userAgent.includes('Mac')
const ZOOM_HINT = isMac
  ? '使用 ⌘+ 放大、⌘- 缩小、⌘0 恢复默认大小'
  : '使用 Ctrl++ 放大、Ctrl+- 缩小、Ctrl+0 恢复默认大小'

export function AppearanceSettings(): React.ReactElement {
  const [themeMode, setThemeMode] = useAtom(themeModeAtom)
  const [themeStyle, setThemeStyle] = useAtom(themeStyleAtom)
  const systemIsDark = useAtomValue(systemIsDarkAtom)
  const [markdownFontSize, setMarkdownFontSize] = useAtom(markdownFontSizeAtom)

  /** 切换主题模式 */
  const handleThemeChange = React.useCallback((value: string) => {
    const mode = value as ThemeMode
    setThemeMode(mode)
    updateThemeMode(mode)
    // 切换回普通模式时，重置特殊风格
    if (mode !== 'special') {
      setThemeStyle('default')
      updateThemeStyle('default')
      applyThemeToDOM(mode, 'default', systemIsDark)
    }
  }, [setThemeMode, setThemeStyle, systemIsDark])

  /** 选择特殊风格 */
  const handleStyleSelect = React.useCallback((style: ThemeStyle) => {
    // 同时切换到特殊风格模式
    setThemeMode('special')
    setThemeStyle(style)
    updateThemeMode('special')
    updateThemeStyle(style)
    applyThemeToDOM('special', style, systemIsDark)
  }, [setThemeMode, setThemeStyle, systemIsDark])

  /** 切换 Markdown 字号 */
  const handleMarkdownFontSizeChange = React.useCallback((value: string) => {
    const size = value as MarkdownFontSize
    setMarkdownFontSize(size)
    updateMarkdownFontSize(size)
  }, [setMarkdownFontSize])

  return (
    <div className="space-y-6">
      <SettingsSection
        title="外观设置"
        description="自定义应用的视觉风格"
      >
        <SettingsCard>
          {/* 主题模式 - 最上面 */}
          <SettingsSegmentedControl
            label="主题模式"
            description="选择应用的配色方案"
            value={themeMode}
            onValueChange={handleThemeChange}
            options={THEME_OPTIONS}
          />

          {/* 按明暗分组，方便选择适合长时间工作的主题。 */}
          <div className="px-4 py-3 space-y-4">
            {(['light', 'dark'] as const).map((variant) => (
              <div key={variant} className="space-y-2">
                <div className="text-sm font-medium text-foreground">
                  {variant === 'light' ? '日间配色' : '夜间与艺术主题'}
                </div>
                {variant === 'dark' && (
                  <p className="text-xs text-muted-foreground">
                    从《千里江山图》《戴珍珠耳环的少女》、卡拉瓦乔的明暗法与《星月夜》提取光色。
                  </p>
                )}
                <div className="grid grid-cols-[repeat(auto-fill,minmax(99px,1fr))] gap-3">
                  {SPECIAL_STYLES.filter((style) => style.variant === variant).map((style) => (
                    <StyleCard
                      key={style.id}
                      style={style}
                      isSelected={themeMode === 'special' && themeStyle === style.id}
                      onSelect={() => handleStyleSelect(style.id)}
                    />
                  ))}
                </div>
              </div>
            ))}
          </div>

          <SettingsRow
            label="界面缩放"
            description={ZOOM_HINT}
          />

          <SettingsSegmentedControl
            label="Markdown 字号"
            description="调整 AI 回复与 Markdown 编辑器的正文字号"
            value={markdownFontSize}
            onValueChange={handleMarkdownFontSizeChange}
            options={MARKDOWN_FONT_SIZE_OPTIONS}
          />
        </SettingsCard>
      </SettingsSection>

      <AppIconPicker />
    </div>
  )
}

/** 应用图标选择器 */
function AppIconPicker(): React.ReactElement {
  const [activeIcon, setActiveIcon] = React.useState<string>('default')
  const [isLoading, setIsLoading] = React.useState(false)

  // 初始化时读取当前设置
  React.useEffect(() => {
    window.electronAPI.getSettings().then((settings) => {
      setActiveIcon(normalizeAppIconVariantId(settings.appIconVariant ?? 'default'))
    })
  }, [])

  const isWindows = React.useMemo(() => detectIsWindows(), [])

  const handleIconSelect = React.useCallback(async (variantId: string) => {
    if (isWindows) {
      toast.error('Windows 系统暂不支持更换应用图标')
      return
    }
    if (variantId === activeIcon || isLoading) return
    setIsLoading(true)
    try {
      const success = await window.electronAPI.setAppIcon(variantId)
      if (success) {
        setActiveIcon(variantId)
        toast.success('应用图标已更换')
      } else {
        toast.error('图标切换失败')
      }
    } catch {
      toast.error('图标切换失败')
    } finally {
      setIsLoading(false)
    }
  }, [activeIcon, isLoading, isWindows])

  return (
    <SettingsSection
      title="应用图标"
      description="自定义 Dock 栏中的应用图标样式"
    >
      <SettingsCard divided={false}>
        <div className="px-4 py-3">
          <div className="grid grid-cols-7 gap-3">
            {ICON_VARIANTS.map((variant) => (
              <IconCard
                key={variant.id}
                variant={variant}
                isSelected={activeIcon === variant.id}
                onSelect={() => handleIconSelect(variant.id)}
              />
            ))}
          </div>
        </div>
      </SettingsCard>
    </SettingsSection>
  )
}

/** 图标选项卡片 */
function IconCard({
  variant,
  isSelected,
  onSelect,
}: {
  variant: IconVariant
  isSelected: boolean
  onSelect: () => void
}): React.ReactElement {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        'relative flex flex-col items-center gap-1.5 rounded-lg p-2 transition-all',
        isSelected
          ? 'ring-2 ring-primary bg-primary/5'
          : 'hover:bg-muted/50'
      )}
    >
      <div
        className={cn(
          'w-12 h-12 rounded-xl overflow-hidden border border-border/50 flex items-center justify-center',
          variant.previewBg,
        )}
      >
        {variant.id === 'default' ? (
          // 默认图标用 CSS 模拟 Gravitas logo 形状
          <div className="flex items-end gap-[2px] -rotate-12">
            {[1, 0.85, 0.7, 0.55, 0.4, 0.25].map((opacity, i) => (
              <div
                key={i}
                className="rounded-[1px]"
                style={{
                  width: i === 0 ? 4 : 3,
                  height: i === 0 ? 14 : 14 - i * 1.5,
                  backgroundColor: `rgba(255,255,255,${opacity})`,
                }}
              />
            ))}
          </div>
        ) : (
          <img
            src={variant.src}
            alt={variant.name}
            className="w-full h-full object-contain"
            draggable={false}
          />
        )}
      </div>
      <span className="text-[10px] font-medium text-muted-foreground leading-tight text-center">
        {variant.name}
      </span>
      {isSelected && (
        <div className="absolute -top-0.5 -right-0.5 size-4 rounded-full bg-primary flex items-center justify-center">
          <Check className="size-2.5 text-primary-foreground" />
        </div>
      )}
    </button>
  )
}

/** 特殊风格卡片 - 竖长条图片预览 */
function StyleCard({
  style,
  isSelected,
  onSelect,
}: {
  style: SpecialStyle
  isSelected: boolean
  onSelect: () => void
}): React.ReactElement {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-label={`选择${style.name}主题`}
      aria-pressed={isSelected}
      className={cn(
        'relative rounded-lg overflow-hidden',
        'w-full h-[183px]',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-1',
        isSelected
          ? 'ring-2 ring-primary shadow-lg shadow-primary/20'
          : 'ring-1 ring-border/50 hover:ring-border'
      )}
    >
      {style.preview ? (
        <div className="absolute inset-0 p-2 text-left" style={{ background: style.preview.background }} aria-hidden="true">
          <div className="flex h-full gap-1 rounded-md p-1.5 shadow-lg" style={{ background: style.preview.panel }}>
            <div className="w-3 shrink-0 rounded-sm opacity-65" style={{ background: style.preview.background }} />
            <div className="flex min-w-0 flex-1 flex-col gap-2 pt-1">
              <div className="h-1.5 w-3/4 rounded-full opacity-80" style={{ background: style.preview.text }} />
              <div className="h-1 w-full rounded-full opacity-45" style={{ background: style.preview.text }} />
              <div className="h-1 w-4/5 rounded-full opacity-45" style={{ background: style.preview.text }} />
              <div className="mt-2 h-12 rounded-md p-1.5" style={{ background: style.preview.background }}>
                <div className="h-1 w-3/4 rounded-full" style={{ background: style.preview.accent }} />
                <div className="mt-1 h-1 w-1/2 rounded-full opacity-60" style={{ background: style.preview.text }} />
              </div>
              <div className="mt-auto mb-6 h-4 w-full rounded-md border" style={{ borderColor: style.preview.accent }} />
            </div>
          </div>
        </div>
      ) : (
        <div className="w-full h-full" style={style.imageScale ? { transform: `scale(${style.imageScale})` } : undefined}>
          <img src={style.image} alt="" loading="lazy" decoding="async" className="w-full h-full object-cover"
            style={style.objectPosition ? { objectPosition: style.objectPosition } : undefined} draggable={false} />
        </div>
      )}
      <div
        className="absolute bottom-0 left-0 right-0 h-5 flex items-end justify-center pb-0.5"
        style={{ background: style.preview?.panel ?? STYLE_MASK_COLORS[style.id].bg }}
      >
        <span
          className="text-xs font-medium"
          style={{ color: style.preview?.text ?? STYLE_MASK_COLORS[style.id].text }}
        >
          {style.name}
        </span>
      </div>
      {isSelected && (
        <div className="absolute top-1 right-1 size-4 rounded-full bg-primary flex items-center justify-center z-10">
          <Check className="size-2.5 text-primary-foreground" />
        </div>
      )}
    </button>
  )
}
