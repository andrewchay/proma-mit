/**
 * PromaLogoSettings - Gravitas 品牌 Logo 下载
 *
 * 展示多个 Gravitas Logo 颜色变体网格，用户可下载用作机器人头像。
 */

import * as React from 'react'
import { Download } from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { SettingsSection } from './primitives/SettingsSection'
import { SettingsCard } from './primitives/SettingsCard'
import { Button } from '@/components/ui/button'

// ===== Logo 资源导入（10 变体） =====
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

// ===== 类型 =====

interface LogoVariant {
  id: string
  name: string
  description: string
  src: string
  resourcePath: string
  previewBg: string
}

// ===== Logo 变体定义（10 变体，id 与文件名一致，供 app 图标切换复用） =====

const LOGO_VARIANTS: readonly LogoVariant[] = [
  {
    id: '01-default',
    name: '深炭白标',
    description: '深炭底色，经典默认',
    src: grav01Default,
    resourcePath: 'gravitas-logos/gravitas-01-default.png',
    previewBg: 'bg-[#141416]',
  },
  {
    id: '02-black',
    name: '经典黑',
    description: '纯黑底白标，内敛',
    src: grav02Black,
    resourcePath: 'gravitas-logos/gravitas-02-black.png',
    previewBg: 'bg-neutral-900',
  },
  {
    id: '03-white',
    name: '纯白版',
    description: '白底深标，适合深色界面',
    src: grav03White,
    resourcePath: 'gravitas-logos/gravitas-03-white.png',
    previewBg: 'bg-white',
  },
  {
    id: '04-coral',
    name: '珊瑚橘',
    description: '温暖珊瑚珊瑚橙',
    src: grav04Coral,
    resourcePath: 'gravitas-logos/gravitas-04-coral.png',
    previewBg: 'bg-[#FF6B4A]',
  },
  {
    id: '05-brand-blue',
    name: '品牌蓝',
    description: '沉稳品牌蓝',
    src: grav05BrandBlue,
    resourcePath: 'gravitas-logos/gravitas-05-brand-blue.png',
    previewBg: 'bg-[#2B5CE6]',
  },
  {
    id: '06-periwinkle',
    name: '长春花蓝',
    description: '柔和长春花基调',
    src: grav06Periwinkle,
    resourcePath: 'gravitas-logos/gravitas-06-periwinkle.png',
    previewBg: 'bg-[#8B93E8]',
  },
  {
    id: '07-viva-magenta',
    name: '非凡洋红',
    description: 'Pantone Viva Magenta',
    src: grav07VivaMagenta,
    resourcePath: 'gravitas-logos/gravitas-07-viva-magenta.png',
    previewBg: 'bg-[#BB2649]',
  },
  {
    id: '08-mocha',
    name: '摩卡慕斯',
    description: 'Pantone Mocha Mousse',
    src: grav08Mocha,
    resourcePath: 'gravitas-logos/gravitas-08-mocha.png',
    previewBg: 'bg-[#A47864]',
  },
  {
    id: '09-emerald',
    name: '翡翠绿',
    description: '沉稳翡翠绿',
    src: grav09Emerald,
    resourcePath: 'gravitas-logos/gravitas-09-emerald.png',
    previewBg: 'bg-[#1F8A70]',
  },
  {
    id: '10-gradient',
    name: '渐变色',
    description: '珊瑚→紫渐变，主应用图标',
    src: grav10Gradient,
    resourcePath: 'gravitas-logos/gravitas-10-gradient.png',
    previewBg: 'bg-gradient-to-r from-[#FF6B4A] to-[#7A5CFF]',
  },
] as const

// ===== 组件 =====

function LogoCard({ logo }: { logo: LogoVariant }): React.ReactElement {
  const handleDownload = React.useCallback(async () => {
    try {
      const saved = await window.electronAPI.saveResourceFileAs(
        logo.resourcePath,
        `gravitas-${logo.id}.png`,
      )
      if (saved) {
        toast.success(`${logo.name} 已保存`)
      }
    } catch {
      toast.error('保存失败，请重试')
    }
  }, [logo])

  return (
    <div className="flex flex-col items-center gap-2">
      <div
        className={cn(
          'w-20 h-20 rounded-xl overflow-hidden border border-border/50 flex items-center justify-center',
          logo.previewBg,
        )}
      >
        <img
          src={logo.src}
          alt={logo.name}
          className="w-full h-full object-contain"
          draggable={false}
        />
      </div>
      <div className="text-center">
        <div className="text-xs font-medium">{logo.name}</div>
        <div className="text-[10px] text-muted-foreground">{logo.description}</div>
      </div>
      <Button
        size="sm"
        variant="outline"
        className="w-full gap-1.5 h-7 text-xs"
        onClick={handleDownload}
      >
        <Download size={12} />
        下载
      </Button>
    </div>
  )
}

export function PromaLogoSettings(): React.ReactElement {
  return (
    <>
      <SettingsSection
        title="品牌 Logo"
        description="下载 Gravitas Logo 用作机器人头像，让用户一眼认出你的 AI 助手"
      >
        <div className="grid grid-cols-3 gap-4">
          {LOGO_VARIANTS.map((logo) => (
            <LogoCard key={logo.id} logo={logo} />
          ))}
        </div>
      </SettingsSection>

      <div className="my-6 border-t border-border/50" />

      <SettingsSection
        title="使用提示"
        description="在机器人平台设置头像时参考"
      >
        <SettingsCard divided={false}>
          <div className="px-4 py-3 space-y-1.5 text-sm text-muted-foreground">
            <p>建议使用 PNG 格式，飞书/钉钉头像推荐 200x200 以上。</p>
            <p>主应用图标为渐变色版本，其余变体可用于不同场景。</p>
            <p>渐变版在社交平台头像中辨识度最高。</p>
          </div>
        </SettingsCard>
      </SettingsSection>
    </>
  )
}
