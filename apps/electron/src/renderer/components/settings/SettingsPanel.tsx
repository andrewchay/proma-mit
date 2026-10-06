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
  Info,
  Plug,
  Wrench,
  Bot,
  X,
  Keyboard,
  Users,
  HardDrive,
  ShieldCheck,
  CalendarDays,
  MonitorCog,
  ChevronDown,
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
import { AgentSettings } from "./AgentSettings";
import { BotHubSettings } from "./BotHubSettings";
import { ShortcutSettings } from "./ShortcutSettings";
import { AutomationSettings } from "./AutomationSettings";
import { CalendarSyncSettings } from "./CalendarSyncSettings";
import {
  GeneralAndAppearanceTab,
  AboutAndHelpTab,
  ChannelsTab,
  ToolsAndPromptsTab,
  DataUsageTab,
  PrivacyAuditTab,
  AccountTeamTab,
} from "./MergedSettingsTabs";

/** 设置 Tab 定义 */
interface TabItem {
  id: SettingsTab;
  label: string;
  icon: React.ReactNode;
}

// 4.2 设置整合：原 26 个 Tab 合并为 12 个。
// - 代理/视觉中转并入「模型配置」；外观/语音输入/扩展并入「通用与外观」
// - 提示词并入「工具与提示词」；教程并入「关于与帮助」；远程访问并入「远程连接」Hub
// - 磁盘/迁移/Token 统计合并为「数据与用量」；数据采集/操作审计合并为「隐私与审计」
// - 订阅/企业版/工作区成员合并为「账户与团队」
// - 「目标（Goals）」暂时下线：组件保留于 GoalsSettings.tsx，入口移除，去留待定
/** 设置分组 */
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
      { id: 'general', label: '通用与外观', icon: <Settings size={16} /> },
      { id: 'shortcuts', label: '快捷键管理', icon: <Keyboard size={16} /> },
      { id: 'about', label: '关于与帮助', icon: <Info size={16} /> },
    ],
  },
  {
    id: 'model',
    label: '模型与智能体',
    tabs: [
      { id: 'channels', label: '模型配置', icon: <Radio size={16} /> },
      { id: 'agent', label: 'Agent 配置', icon: <Plug size={16} /> },
      { id: 'tools', label: '工具与提示词', icon: <Wrench size={16} /> },
      { id: 'automation', label: '设备控制', icon: <MonitorCog size={16} /> },
    ],
  },
  {
    id: 'connect',
    label: '连接与同步',
    tabs: [
      { id: 'bots', label: '远程连接', icon: <Bot size={16} /> },
      { id: 'calendar', label: '日历同步', icon: <CalendarDays size={16} /> },
    ],
  },
  {
    id: 'system',
    label: '系统与隐私',
    tabs: [
      { id: 'data', label: '数据与用量', icon: <HardDrive size={16} /> },
      { id: 'privacy', label: '隐私与审计', icon: <ShieldCheck size={16} /> },
      { id: 'account', label: '账户与团队', icon: <Users size={16} /> },
    ],
  },
]

/** 整合后每组 Tab 数量很少，不再默认折叠 */
const DEFAULT_COLLAPSED_GROUPS: Record<string, boolean> = {}

/** 根据标签页 id 渲染对应内容 */
function renderTabContent(tab: SettingsTab): React.ReactElement {
  switch (tab) {
    case 'general':
      return <GeneralAndAppearanceTab />
    case 'shortcuts':
      return <ShortcutSettings />
    case 'about':
      return <AboutAndHelpTab />
    case 'channels':
      return <ChannelsTab />
    case 'agent':
      return <AgentSettings />
    case 'tools':
      return <ToolsAndPromptsTab />
    case 'automation':
      return <AutomationSettings />
    case 'bots':
      return <BotHubSettings />
    case 'calendar':
      return <CalendarSyncSettings />
    case 'data':
      return <DataUsageTab />
    case 'privacy':
      return <PrivacyAuditTab />
    case 'account':
      return <AccountTeamTab />
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
