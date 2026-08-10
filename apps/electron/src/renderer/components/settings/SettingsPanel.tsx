/**
 * SettingsPanel - 设置面板
 *
 * 顶部 Header（标题 + 关闭按钮）+ 下方（左侧导航 + 右侧 ScrollArea 内容区域）。
 * 使用 Jotai atom 管理当前标签页状态。
 */

import * as React from "react";
import { useAtom, useAtomValue } from "jotai";
import { cn } from "@/lib/utils";
import {
  Settings,
  Radio,
  Palette,
  Info,
  Plug,
  Globe,
  BookOpen,
  Wrench,
  Bot,
  GraduationCap,
  X,
  Keyboard,
  Mic,
  Eye,
  HardDriveDownload,
  HardDrive,
  ShieldCheck,
  MonitorCog,
  Puzzle,
  CalendarDays,
  ChevronDown,
  BarChart3,
  Target,
  Layers,
} from "lucide-react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { settingsTabAtom, channelFormDirtyAtom, settingsCloseRequestedAtom } from "@/atoms/settings-tab";
import type { SettingsTab } from "@/atoms/settings-tab";
import { hasUpdateAtom } from "@/atoms/updater";
import { hasEnvironmentIssuesAtom } from "@/atoms/environment";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { ChannelSettings } from "./ChannelSettings";
import { GeneralSettings } from "./GeneralSettings";
import { VisionRelaySettings } from "./VisionRelaySettings";
import { ProxySettings } from "./ProxySettings";
import { AppearanceSettings } from "./AppearanceSettings";
import { AboutSettings } from "./AboutSettings";
import { AgentSettings } from "./AgentSettings";
import { PromptSettings } from "./PromptSettings";
import { ToolSettings } from "./ToolSettings";
import { BotHubSettings } from "./BotHubSettings";
import { TutorialViewer } from "../tutorial/TutorialViewer";
import { ShortcutSettings } from "./ShortcutSettings";
import { VoiceInputSettings } from "./VoiceInputSettings";
import { MigrationSettings } from "./MigrationSettings";
import { StorageSettings } from "./StorageSettings";
import { OperationAuditSettings } from "./OperationAuditSettings";
import { AutomationSettings } from "./AutomationSettings";
import { ExtensionSettings } from './ExtensionSettings'
import { CalendarSyncSettings } from './CalendarSyncSettings'
import { TokenUsageSettings } from './TokenUsageSettings'
import { GoalsSettings } from './GoalsSettings'
import { CapabilityCenterPanel } from './CapabilityCenterPanel'

/** 设置 Tab 定义 */
interface TabItem {
  id: SettingsTab;
  label: string;
  icon: React.ReactNode;
}

/** 基础 Tabs（所有模式都有） */
const BASE_TABS: TabItem[] = [
  { id: "general", label: "通用设置", icon: <Settings size={16} /> },
  { id: "channels", label: "模型配置", icon: <Radio size={16} /> },
  { id: "prompts", label: "提示词管理", icon: <BookOpen size={16} /> },
  { id: "proxy", label: "代理设置", icon: <Globe size={16} /> },
];

/** Agent 模式专属 Tab */
const AGENT_TAB: TabItem = {
  id: "agent",
  label: "Agent 配置",
  icon: <Plug size={16} />,
};
const VISION_TAB: TabItem = {
  id: "vision",
  label: "视觉助手",
  icon: <Eye size={16} />,
};
const TOOLS_TAB: TabItem = {
  id: "tools",
  label: "Chat 工具",
  icon: <Wrench size={16} />,
};
const BOTS_TAB: TabItem = {
  id: "bots",
  label: "远程连接",
  icon: <Bot size={16} />,
};
const TUTORIAL_TAB: TabItem = {
  id: "tutorial",
  label: "Gravitas 教程",
  icon: <GraduationCap size={16} />,
};
const SHORTCUTS_TAB: TabItem = {
  id: "shortcuts",
  label: "快捷键管理",
  icon: <Keyboard size={16} />,
};
const VOICE_INPUT_TAB: TabItem = {
  id: "voice-input",
  label: "语音输入",
  icon: <Mic size={16} />,
};
const OPERATION_AUDIT_TAB: TabItem = {
  id: "operation-audit",
  label: "操作审计",
  icon: <ShieldCheck size={16} />,
};
const AUTOMATION_TAB: TabItem = {
  id: "automation",
  label: "设备控制",
  icon: <MonitorCog size={16} />,
};
const EXTENSIONS_TAB: TabItem = {
  id: 'extensions',
  label: '扩展',
  icon: <Puzzle size={16} />,
};
const CALENDAR_TAB: TabItem = {
  id: 'calendar',
  label: '日历同步',
  icon: <CalendarDays size={16} />,
};
const TOKEN_USAGE_TAB: TabItem = {
  id: 'token-usage',
  label: 'Token 统计',
  icon: <BarChart3 size={16} />,
};
const GOALS_TAB: TabItem = {
  id: 'goals',
  label: '目标（Goals）',
  icon: <Target size={16} />,
};
const CAPABILITIES_TAB: TabItem = {
  id: 'capabilities',
  label: '能力中心',
  icon: <Layers size={16} />,
};

/** 尾部 Tabs */
const TAIL_TABS: TabItem[] = [
  { id: "migration", label: "数据迁移", icon: <HardDriveDownload size={16} /> },
  { id: "storage", label: "磁盘管理", icon: <HardDrive size={16} /> },
  { id: "appearance", label: "外观设置", icon: <Palette size={16} /> },
  { id: "about", label: "关于/更新", icon: <Info size={16} /> },
];

/** 设置分组（4.1 模块合并：21 Tab → 分组导航，低频组默认折叠） */
interface SettingsGroup {
  id: string
  label: string
  tabs: TabItem[]
}

const SETTINGS_GROUPS: SettingsGroup[] = [
  {
    id: 'basic',
    label: '基础配置',
    tabs: [
      BASE_TABS[0]!, // 通用设置
      TAIL_TABS[2]!, // 外观设置
      SHORTCUTS_TAB,
      VOICE_INPUT_TAB,
      TAIL_TABS[3]!, // 关于/更新
    ],
  },
  {
    id: 'model',
    label: '模型与智能体',
    tabs: [
      BASE_TABS[1]!, // 模型配置
      AGENT_TAB,
      VISION_TAB,
      TOOLS_TAB,
      BASE_TABS[2]!, // 提示词管理
      EXTENSIONS_TAB,
      AUTOMATION_TAB, // 设备控制
    ],
  },
  {
    id: 'connect',
    label: '连接与同步',
    tabs: [
      BOTS_TAB,
      BASE_TABS[3]!, // 代理设置
      CALENDAR_TAB,
    ],
  },
  {
    id: 'system',
    label: '系统与隐私',
    tabs: [
      TAIL_TABS[0]!, // 数据迁移
      TAIL_TABS[1]!, // 磁盘管理
      OPERATION_AUDIT_TAB,
      TOKEN_USAGE_TAB,
      GOALS_TAB,
      CAPABILITIES_TAB,
      TUTORIAL_TAB,
    ],
  },
]

/** 默认折叠低频组（系统与隐私） */
const DEFAULT_COLLAPSED_GROUPS: Record<string, boolean> = {
  system: true,
}

/** 根据标签页 id 渲染对应内容 */
function renderTabContent(tab: SettingsTab): React.ReactElement {
  switch (tab) {
    case "general":
      return <GeneralSettings />;
    case "channels":
      return <ChannelSettings />;
    case "prompts":
      return <PromptSettings />;
    case "proxy":
      return <ProxySettings />;
    case "agent":
      return <AgentSettings />;
    case "vision":
      return <VisionRelaySettings />;
    case "tools":
      return <ToolSettings />;
    case "appearance":
      return <AppearanceSettings />;
    case "about":
      return <AboutSettings />;
    case "bots":
      return <BotHubSettings />;
    case "tutorial":
      return <TutorialViewer />;
    case "shortcuts":
      return <ShortcutSettings />;
    case "voice-input":
      return <VoiceInputSettings />;
    case "migration":
      return <MigrationSettings />;
    case "storage":
      return <StorageSettings />;
    case "operation-audit":
      return <OperationAuditSettings />;
    case "automation":
      return <AutomationSettings />;
    case 'extensions':
      return <ExtensionSettings />
    case 'calendar':
      return <CalendarSyncSettings />
    case 'token-usage':
      return <TokenUsageSettings />
    case 'goals':
      return <GoalsSettings />
    case 'capabilities':
      return <CapabilityCenterPanel />
  }
}

interface SettingsPanelProps {
  onClose?: () => void;
}

export function SettingsPanel({
  onClose,
}: SettingsPanelProps): React.ReactElement {
  const [activeTab, setActiveTab] = useAtom(settingsTabAtom);
  const channelFormDirty = useAtomValue(channelFormDirtyAtom);
  const [closeRequested, setCloseRequested] = useAtom(settingsCloseRequestedAtom);
  const hasUpdate = useAtomValue(hasUpdateAtom);
  const hasEnvironmentIssues = useAtomValue(hasEnvironmentIssuesAtom);

  /** 统一的退出拦截对话框状态 */
  type PendingAction = { type: 'tab'; tabId: SettingsTab } | { type: 'close' } | null
  const [pendingAction, setPendingAction] = React.useState<PendingAction>(null)
  const showNavDialog = pendingAction !== null

  /** 执行待处理的操作 */
  const executePendingAction = (): void => {
    if (!pendingAction) return
    if (pendingAction.type === 'tab') {
      setActiveTab(pendingAction.tabId)
    } else {
      onClose?.()
    }
    setPendingAction(null)
  }

  /** 取消待处理的操作 */
  const cancelPendingAction = (): void => {
    setPendingAction(null)
  }

  /** 切换标签页时检测是否有未保存内容 */
  const handleTabChange = (tabId: SettingsTab): void => {
    if (tabId === activeTab) return
    if (activeTab === 'channels' && channelFormDirty) {
      setPendingAction({ type: 'tab', tabId })
      return
    }
    setActiveTab(tabId)
  }

  /** 关闭设置面板时检测是否有未保存内容 */
  const handleClose = (): void => {
    if (activeTab === 'channels' && channelFormDirty) {
      setPendingAction({ type: 'close' })
      return
    }
    onClose?.()
  }

  // Cmd+W 等外部关闭请求：弹出确认对话框
  React.useEffect(() => {
    if (closeRequested && activeTab === 'channels') {
      setPendingAction({ type: 'close' })
      setCloseRequested(false)
    }
  }, [closeRequested, activeTab, setCloseRequested])

  // 设置属于全局应用配置，所有入口统一展示完整导航（分组结构）。
  const allTabs = React.useMemo(() => SETTINGS_GROUPS.flatMap((g) => g.tabs), [])
  const [collapsedGroups, setCollapsedGroups] = React.useState<Record<string, boolean>>(DEFAULT_COLLAPSED_GROUPS)

  // 当前 tab 标题
  const activeTabLabel = allTabs.find((t) => t.id === activeTab)?.label ?? "设置";

  return (
    <div className="flex flex-col h-full">
      {/* 顶部 Header 栏 */}
      <div className="h-12 flex items-center justify-between px-5 border-b border-border/50 flex-shrink-0">
        <h2 className="text-sm font-medium text-foreground">
          {activeTabLabel}
        </h2>
        {onClose && (
          <button
            onClick={handleClose}
            className="rounded-md p-1.5 text-muted-foreground/60 hover:text-foreground hover:bg-muted transition-colors"
          >
            <X size={16} />
          </button>
        )}
      </div>

      {/* 下方主体：左导航 + 右内容 */}
      <div className="flex flex-1 min-h-0">
        {/* 左侧 Tab 导航（分组结构） */}
        <div className="w-[176px] border-r border-border/50 pt-3 px-2 flex-shrink-0 overflow-y-auto">
          <nav className="flex flex-col gap-1">
            {SETTINGS_GROUPS.map((group) => {
              const collapsed = collapsedGroups[group.id] ?? false
              return (
                <div key={group.id} className="flex flex-col gap-0.5">
                  <button
                    type="button"
                    onClick={() => setCollapsedGroups((prev) => ({ ...prev, [group.id]: !collapsed }))}
                    className="flex items-center justify-between px-2 py-1.5 rounded-md text-[11px] font-medium text-foreground/40 hover:text-foreground/70 transition-colors"
                  >
                    <span>{group.label}</span>
                    <ChevronDown size={12} className={cn('transition-transform duration-150', collapsed && '-rotate-90')} />
                  </button>
                  {!collapsed && group.tabs.map((tab) => (
                    <button
                      key={tab.id}
                      onClick={() => handleTabChange(tab.id)}
                      className={cn(
                        "flex items-center gap-2 pl-4 pr-3 py-1.5 rounded-md text-sm transition-colors",
                        activeTab === tab.id
                          ? "bg-muted text-foreground font-medium"
                          : "text-muted-foreground hover:bg-muted/50 hover:text-foreground",
                      )}
                    >
                      <span className="text-foreground/45">{tab.icon}</span>
                      <span>{tab.label}</span>
                      {tab.id === "about" && (hasUpdate || hasEnvironmentIssues) && (
                        <span className="w-2 h-2 rounded-full bg-red-500" />
                      )}
                    </button>
                  ))}
                </div>
              )
            })}
          </nav>
        </div>

        {/* 右侧内容区域 */}
        <ScrollArea className="flex-1">
          <div className="px-6 py-4">{renderTabContent(activeTab)}</div>
        </ScrollArea>
      </div>

      {/* 退出拦截弹窗（侧边栏导航 / X 关闭 / Cmd+W） */}
      <AlertDialog open={showNavDialog} onOpenChange={(open) => { if (!open) cancelPendingAction() }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>放弃未保存的更改？</AlertDialogTitle>
            <AlertDialogDescription>
              当前渠道配置尚未保存，确定要离开吗？
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={cancelPendingAction}>留在当前页</AlertDialogCancel>
            <AlertDialogAction onClick={executePendingAction}>放弃并离开</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
