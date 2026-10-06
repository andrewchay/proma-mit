/**
 * 特殊风格主题的预览装饰插画
 *
 * 每个调色板式主题配一幅定制意象插画（SVG），替代纯色块模拟缩略图，
 * 让配色卡片像「青花瓷」「青绿山水」的图片预览一样有画风。
 * 画布按竖长卡片构图（viewBox 0 0 100 190，slice 铺满裁切）。
 */

import type * as React from 'react'

/** 鼠尾草：米白底 + 灰绿穗状花序 + 沙棕丘影 */
export function SageDecor(): React.ReactElement {
  return (
    <svg className="h-full w-full" viewBox="0 0 100 190" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
      <rect width="100" height="190" fill="#F1EFE7" />
      {/* 远景沙丘弧 */}
      <circle cx="18" cy="208" r="72" fill="#D7C5A1" opacity="0.45" />
      <circle cx="96" cy="220" r="62" fill="#D7C5A1" opacity="0.28" />
      {/* 茎 */}
      <g stroke="#89A8A0" strokeWidth="1.6" fill="none" strokeLinecap="round">
        <path d="M30 190 C 30 152, 28 122, 30 98" />
        <path d="M62 190 C 64 162, 66 142, 64 120" />
        <path d="M84 190 C 84 174, 86 162, 85 148" />
      </g>
      {/* 穗状小叶 */}
      <g fill="#89A8A0">
        <ellipse cx="30" cy="94" rx="4" ry="6.5" opacity="0.95" />
        <ellipse cx="24" cy="103" rx="3.5" ry="5.5" opacity="0.8" transform="rotate(-28 24 103)" />
        <ellipse cx="36" cy="103" rx="3.5" ry="5.5" opacity="0.8" transform="rotate(28 36 103)" />
        <ellipse cx="26" cy="113" rx="3" ry="4.5" opacity="0.6" transform="rotate(-22 26 113)" />
        <ellipse cx="34" cy="113" rx="3" ry="4.5" opacity="0.6" transform="rotate(22 34 113)" />
        <ellipse cx="64" cy="116" rx="3.4" ry="5.4" opacity="0.85" />
        <ellipse cx="59" cy="125" rx="3" ry="4.6" opacity="0.65" transform="rotate(-26 59 125)" />
        <ellipse cx="69" cy="125" rx="3" ry="4.6" opacity="0.65" transform="rotate(26 69 125)" />
        <ellipse cx="85" cy="144" rx="3" ry="4.8" opacity="0.7" />
        <ellipse cx="81" cy="152" rx="2.6" ry="4" opacity="0.5" transform="rotate(-24 81 152)" />
        <ellipse cx="89" cy="152" rx="2.6" ry="4" opacity="0.5" transform="rotate(24 89 152)" />
      </g>
      {/* 基部大叶 */}
      <path d="M30 176 C 18 170, 12 160, 14 148 C 24 154, 30 164, 30 176 Z" fill="#89A8A0" opacity="0.4" />
      <path d="M62 178 C 72 172, 78 162, 76 152 C 66 158, 62 168, 62 178 Z" fill="#89A8A0" opacity="0.32" />
      {/* 沙棕种子点 */}
      <circle cx="46" cy="150" r="1.6" fill="#D7C5A1" opacity="0.9" />
      <circle cx="52" cy="136" r="1.2" fill="#D7C5A1" opacity="0.7" />
      <circle cx="14" cy="52" r="1.5" fill="#D7C5A1" opacity="0.6" />
      <circle cx="88" cy="40" r="1.2" fill="#D7C5A1" opacity="0.5" />
    </svg>
  )
}

/** 蜜桃奶油：粉白底 + 蜜桃果实枝叶 + 浅驼云影 */
export function PeachDecor(): React.ReactElement {
  return (
    <svg className="h-full w-full" viewBox="0 0 100 190" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
      <rect width="100" height="190" fill="#F6E2DB" />
      {/* 浅驼云影 */}
      <circle cx="90" cy="26" r="36" fill="#EAD8C4" opacity="0.6" />
      <circle cx="6" cy="148" r="26" fill="#EAD8C4" opacity="0.45" />
      {/* 主蜜桃 */}
      <circle cx="46" cy="130" r="26" fill="#F0C4A8" />
      <path d="M46 106 C 45 114, 45 120, 46 128" stroke="#DE9C74" strokeWidth="1.4" fill="none" strokeLinecap="round" />
      <path d="M32 120 A 24 24 0 0 1 42 107" stroke="#FBE3D2" strokeWidth="3.4" fill="none" opacity="0.85" strokeLinecap="round" />
      {/* 果柄与叶 */}
      <path d="M46 106 C 46 100, 48 95, 53 90" stroke="#8FAE8B" strokeWidth="1.8" fill="none" strokeLinecap="round" />
      <ellipse cx="63" cy="86" rx="11" ry="4.6" fill="#8FAE8B" transform="rotate(-22 63 86)" />
      <ellipse cx="53" cy="79" rx="9" ry="3.8" fill="#A9C2A2" transform="rotate(-36 53 79)" />
      {/* 小蜜桃 */}
      <circle cx="18" cy="170" r="10" fill="#F0C4A8" opacity="0.92" />
      <path d="M18 161 C 18 158, 19 155, 21 153" stroke="#8FAE8B" strokeWidth="1.2" fill="none" strokeLinecap="round" />
      <ellipse cx="26" cy="151" rx="5.5" ry="2.4" fill="#8FAE8B" transform="rotate(-20 26 151)" />
      {/* 落花点 */}
      <circle cx="80" cy="170" r="2" fill="#E8A87E" opacity="0.7" />
      <circle cx="86" cy="158" r="1.4" fill="#E8A87E" opacity="0.5" />
      <circle cx="12" cy="42" r="1.6" fill="#E8A87E" opacity="0.5" />
      <circle cx="70" cy="46" r="1.2" fill="#E8A87E" opacity="0.45" />
    </svg>
  )
}

/** 千里江山·夜：暮蓝底 + 圆月 + 层叠山峦 + 石青水纹 */
export function LandscapeNightDecor(): React.ReactElement {
  return (
    <svg className="h-full w-full" viewBox="0 0 100 190" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
      <rect width="100" height="190" fill="#0D131A" />
      {/* 星 */}
      <circle cx="18" cy="30" r="1" fill="#66DCC5" opacity="0.7" />
      <circle cx="40" cy="16" r="0.8" fill="#66DCC5" opacity="0.5" />
      <circle cx="56" cy="42" r="0.7" fill="#E5E9F0" opacity="0.4" />
      {/* 月 */}
      <circle cx="78" cy="26" r="16" fill="#66DCC5" opacity="0.12" />
      <circle cx="78" cy="26" r="9.5" fill="#66DCC5" opacity="0.85" />
      {/* 层叠山峦 */}
      <path d="M0 108 L 22 72 L 40 100 L 56 68 L 78 104 L 100 80 L 100 190 L 0 190 Z" fill="#162A2B" opacity="0.9" />
      <path d="M0 132 L 26 102 L 48 128 L 72 100 L 100 126 L 100 190 L 0 190 Z" fill="#1E4B45" opacity="0.85" />
      <path d="M0 160 L 30 134 L 54 156 L 80 132 L 100 150 L 100 190 L 0 190 Z" fill="#0A1016" />
      {/* 石青水纹 */}
      <path d="M10 172 H 58" stroke="#66DCC5" strokeWidth="0.8" opacity="0.35" />
      <path d="M32 181 H 90" stroke="#66DCC5" strokeWidth="0.8" opacity="0.22" />
    </svg>
  )
}

/** 维米尔·夜：暗室 + 亮窗珍珠黄光 + 蓝头巾与珍珠 */
export function VermeerNightDecor(): React.ReactElement {
  return (
    <svg className="h-full w-full" viewBox="0 0 100 190" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
      <rect width="100" height="190" fill="#121214" />
      {/* 窗光晕 */}
      <circle cx="31" cy="41" r="32" fill="#E5C86B" opacity="0.10" />
      {/* 亮窗 */}
      <rect x="14" y="18" width="34" height="46" rx="3" fill="#E5C86B" opacity="0.92" />
      <path d="M31 18 V 64 M14 41 H 48" stroke="#121214" strokeWidth="2.4" opacity="0.75" />
      <rect x="14" y="18" width="34" height="46" rx="3" fill="none" stroke="#8A6F33" strokeWidth="1.2" opacity="0.55" />
      {/* 斜落光束 */}
      <polygon points="14,64 48,64 80,152 34,152" fill="#E5C86B" opacity="0.08" />
      {/* 蓝头巾剪影 */}
      <path d="M52 190 C 50 162, 56 140, 70 132 C 84 124, 92 136, 90 152 C 88 168, 84 180, 84 190 Z" fill="#1E293B" />
      <path d="M68 133 C 79 129, 88 136, 90 148" stroke="#3B5384" strokeWidth="2.2" fill="none" opacity="0.85" strokeLinecap="round" />
      {/* 珍珠耳环 */}
      <circle cx="87" cy="158" r="2.8" fill="#F8F9FA" opacity="0.95" />
      <circle cx="86" cy="157" r="0.9" fill="#FFFFFF" />
    </svg>
  )
}

/** 卡拉瓦乔：明暗对照 + 斜射光束 + 桌沿静物剪影 */
export function CaravaggioNightDecor(): React.ReactElement {
  return (
    <svg className="h-full w-full" viewBox="0 0 100 190" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
      <rect width="100" height="190" fill="#100F11" />
      {/* 斜射光束 */}
      <polygon points="0,0 34,0 96,118 56,132" fill="#D9A45B" opacity="0.13" />
      <polygon points="8,0 26,0 80,106 60,116" fill="#E5C86B" opacity="0.10" />
      {/* 光束中的尘埃 */}
      <circle cx="40" cy="58" r="1" fill="#ECE4D7" opacity="0.5" />
      <circle cx="52" cy="80" r="0.8" fill="#ECE4D7" opacity="0.4" />
      <circle cx="63" cy="100" r="1.1" fill="#ECE4D7" opacity="0.45" />
      <circle cx="34" cy="94" r="0.7" fill="#ECE4D7" opacity="0.35" />
      <circle cx="72" cy="64" r="0.8" fill="#ECE4D7" opacity="0.3" />
      {/* 桌沿与静物剪影 */}
      <rect x="0" y="152" width="100" height="38" fill="#1A1214" />
      <ellipse cx="30" cy="152" rx="17" ry="6" fill="#241C1A" />
      <circle cx="63" cy="147" r="7.5" fill="#241C1A" />
      <path d="M56 143 A 7.5 7.5 0 0 1 63 139.5" stroke="#D9A45B" strokeWidth="1.6" fill="none" opacity="0.5" strokeLinecap="round" />
      <rect x="76" y="136" width="7" height="16" rx="1" fill="#241C1A" />
      <path d="M76 138 H 83" stroke="#D9A45B" strokeWidth="0.9" opacity="0.4" />
    </svg>
  )
}

/** 星月夜：深蓝底 + 旋涡 + 星光黄星月 + 柏树剪影 */
export function VangoghNightDecor(): React.ReactElement {
  return (
    <svg className="h-full w-full" viewBox="0 0 100 190" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
      <rect width="100" height="190" fill="#10162B" />
      {/* 月 */}
      <circle cx="78" cy="28" r="13" fill="#E7C456" opacity="0.16" />
      <circle cx="78" cy="28" r="7" fill="#E7C456" />
      {/* 旋涡 */}
      <path d="M18 62 C 28 44, 56 44, 62 60 C 67 73, 53 83, 43 76 C 35 70, 40 58, 49 61" stroke="#E7C456" strokeWidth="2.4" fill="none" opacity="0.75" strokeLinecap="round" />
      <path d="M8 86 C 28 74, 66 76, 86 90" stroke="#7A93C8" strokeWidth="1.6" fill="none" opacity="0.5" strokeLinecap="round" />
      {/* 星点 */}
      <circle cx="20" cy="20" r="1.6" fill="#E7C456" opacity="0.9" />
      <circle cx="20" cy="20" r="4.2" fill="#E7C456" opacity="0.18" />
      <circle cx="46" cy="16" r="1.1" fill="#E7C456" opacity="0.7" />
      <circle cx="92" cy="58" r="1.3" fill="#E7C456" opacity="0.6" />
      <circle cx="10" cy="108" r="1" fill="#E7C456" opacity="0.5" />
      {/* 山谷波澜 */}
      <path d="M0 130 C 20 120, 44 124, 60 132 C 76 140, 90 138, 100 132" stroke="#1E2D4D" strokeWidth="3" fill="none" strokeLinecap="round" />
      {/* 柏树剪影 */}
      <path d="M18 190 C 16 160, 22 140, 20 122 C 19 112, 24 106, 23 97 C 28 110, 26 126, 30 142 C 33 158, 28 174, 30 190 Z" fill="#0A0E1C" />
    </svg>
  )
}

/** 霓虹合成波：深空底 + 条纹霓虹太阳 + 透视网格 */
export function SynthwaveNightDecor(): React.ReactElement {
  return (
    <svg className="h-full w-full" viewBox="0 0 100 190" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
      <defs>
        <clipPath id="sw-sun-clip">
          <circle cx="50" cy="70" r="24" />
        </clipPath>
      </defs>
      <rect width="100" height="190" fill="#0A0714" />
      {/* 太阳光晕 */}
      <circle cx="50" cy="70" r="34" fill="#F27BC5" opacity="0.12" />
      {/* 条纹霓虹太阳 */}
      <g clipPath="url(#sw-sun-clip)">
        <rect x="26" y="46" width="48" height="48" fill="#F27BC5" />
        <rect x="26" y="57" width="48" height="3" fill="#0A0714" />
        <rect x="26" y="65" width="48" height="4" fill="#0A0714" />
        <rect x="26" y="75" width="48" height="5" fill="#0A0714" />
        <rect x="26" y="86" width="48" height="6" fill="#0A0714" />
      </g>
      {/* 两侧山影 */}
      <path d="M0 112 L 18 92 L 34 112 Z" fill="#1F1435" />
      <path d="M66 112 L 82 96 L 100 112 Z" fill="#1F1435" />
      {/* 地平线 */}
      <path d="M0 112 H 100" stroke="#F27BC5" strokeWidth="1.6" opacity="0.7" />
      {/* 透视网格 */}
      <g stroke="#8A5BD6" strokeWidth="0.8" opacity="0.5" fill="none">
        <path d="M50 112 L 8 190" />
        <path d="M50 112 L 28 190" />
        <path d="M50 112 V 190" />
        <path d="M50 112 L 72 190" />
        <path d="M50 112 L 92 190" />
        <path d="M0 122 H 100" />
        <path d="M0 138 H 100" />
        <path d="M0 160 H 100" />
      </g>
    </svg>
  )
}

/** 薰衣草：暖白底 + 圆粒紫穗丛 + 浅灰紫云影田垄 */
export function LavenderDecor(): React.ReactElement {
  return (
    <svg className="h-full w-full" viewBox="0 0 100 190" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
      <rect width="100" height="190" fill="#F2EEEA" />
      {/* 远处云影 */}
      <circle cx="88" cy="26" r="34" fill="#D7D1DC" opacity="0.6" />
      <circle cx="6" cy="118" r="24" fill="#D7D1DC" opacity="0.4" />
      {/* 田垄弧线 */}
      <path d="M0 172 C 30 164, 70 164, 100 172" stroke="#D7D1DC" strokeWidth="2" fill="none" opacity="0.8" />
      <path d="M0 182 C 30 174, 70 174, 100 182" stroke="#D7D1DC" strokeWidth="1.4" fill="none" opacity="0.55" />
      {/* 茎 */}
      <g stroke="#9c8fbf" strokeWidth="1.5" fill="none" strokeLinecap="round">
        <path d="M30 190 C 30 158, 28 132, 30 108" />
        <path d="M56 190 C 58 164, 60 142, 58 118" />
        <path d="M84 190 C 84 174, 86 160, 85 142" />
      </g>
      {/* 圆粒紫穗 */}
      <g fill="#B9AFD8">
        <circle cx="30" cy="102" r="3.4" opacity="0.95" />
        <circle cx="26" cy="110" r="2.8" opacity="0.8" />
        <circle cx="34" cy="110" r="2.8" opacity="0.8" />
        <circle cx="27.5" cy="118" r="2.4" opacity="0.6" />
        <circle cx="32.5" cy="118" r="2.4" opacity="0.6" />
        <circle cx="58" cy="112" r="3" opacity="0.9" />
        <circle cx="54.5" cy="120" r="2.5" opacity="0.7" />
        <circle cx="61.5" cy="120" r="2.5" opacity="0.7" />
        <circle cx="56" cy="128" r="2.1" opacity="0.5" />
        <circle cx="60" cy="128" r="2.1" opacity="0.5" />
        <circle cx="85" cy="136" r="2.6" opacity="0.8" />
        <circle cx="82" cy="143" r="2.2" opacity="0.6" />
        <circle cx="88" cy="143" r="2.2" opacity="0.6" />
      </g>
      {/* 深紫花心点缀 */}
      <circle cx="30" cy="102" r="1" fill="#81578E" opacity="0.7" />
      <circle cx="58" cy="112" r="0.9" fill="#81578E" opacity="0.6" />
      {/* 细长基叶 */}
      <path d="M30 182 C 20 176, 16 168, 18 158 C 26 164, 30 172, 30 182 Z" fill="#B9AFD8" opacity="0.4" />
      <path d="M56 184 C 66 178, 70 170, 68 160 C 60 166, 56 174, 56 184 Z" fill="#B9AFD8" opacity="0.32" />
      {/* 飞舞小点 */}
      <circle cx="46" cy="76" r="1.4" fill="#B9AFD8" opacity="0.7" />
      <circle cx="14" cy="56" r="1.2" fill="#B9AFD8" opacity="0.55" />
      <circle cx="74" cy="58" r="1" fill="#B9AFD8" opacity="0.45" />
    </svg>
  )
}

/** 调色板式主题 → 预览插画映射（key 与 SPECIAL_STYLES 的 id 对应） */
export const THEME_PREVIEW_DECORS: Record<string, React.ReactElement> = {
  sage: <SageDecor />,
  peach: <PeachDecor />,
  lavender: <LavenderDecor />,
  'landscape-night': <LandscapeNightDecor />,
  'vermeer-night': <VermeerNightDecor />,
  'caravaggio-night': <CaravaggioNightDecor />,
  'vangogh-night': <VangoghNightDecor />,
  'synthwave-night': <SynthwaveNightDecor />,
}
