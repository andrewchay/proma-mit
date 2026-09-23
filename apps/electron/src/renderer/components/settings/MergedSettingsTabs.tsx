/**
 * MergedSettingsTabs - 设置面板合并 Tab 容器
 *
 * 4.2 设置整合：把原来多个低频独立 Tab 合并为一个 Tab 内的堆叠区块或内部 Tabs。
 * 各子组件保持独立实现且自带标题，这里只负责布局组合，不复制业务逻辑。
 */

import type * as React from 'react'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { ChannelSettings } from './ChannelSettings'
import { ProxySettings } from './ProxySettings'
import { VisionRelaySettings } from './VisionRelaySettings'
import { GeneralSettings } from './GeneralSettings'
import { AppearanceSettings } from './AppearanceSettings'
import { VoiceInputSettings } from './VoiceInputSettings'
import { ExtensionSettings } from './ExtensionSettings'
import { AboutSettings } from './AboutSettings'
import { TutorialViewer } from '../tutorial/TutorialViewer'
import { ToolSettings } from './ToolSettings'
import { PromptSettings } from './PromptSettings'
import { StorageSettings } from './StorageSettings'
import { MigrationSettings } from './MigrationSettings'
import { TokenUsageSettings } from './TokenUsageSettings'
import { TelemetrySettingsPanel } from './TelemetrySettingsPanel'
import { OperationAuditSettings } from './OperationAuditSettings'
import { SubscriptionSettings } from './SubscriptionSettings'
import { EnterpriseSettings } from './EnterpriseSettings'
import { WorkspaceMembersSettings } from './WorkspaceMembersSettings'

/** 堆叠多个子设置区块：子组件自带标题，这里只负责垂直间距 */
function MergedStack({ children }: { children: React.ReactNode }): React.ReactElement {
  return <div className="flex flex-col gap-8">{children}</div>
}

/** 通用与外观：通用设置 + 外观 + 语音输入 + 扩展（灵动岛等桌面体验） */
export function GeneralAndAppearanceTab(): React.ReactElement {
  return (
    <MergedStack>
      <GeneralSettings />
      <AppearanceSettings />
      <VoiceInputSettings />
      <ExtensionSettings />
    </MergedStack>
  )
}

/** 关于与帮助：关于/更新 + 教程 */
export function AboutAndHelpTab(): React.ReactElement {
  return (
    <MergedStack>
      <AboutSettings />
      <TutorialViewer />
    </MergedStack>
  )
}

/** 工具与提示词：Chat 工具 + 提示词管理（内容较多，用内部 Tabs 切换） */
export function ToolsAndPromptsTab(): React.ReactElement {
  return (
    <Tabs defaultValue="tools" className="w-full">
      <TabsList>
        <TabsTrigger value="tools">Chat 工具</TabsTrigger>
        <TabsTrigger value="prompts">提示词管理</TabsTrigger>
      </TabsList>
      <TabsContent value="tools" className="mt-4">
        <ToolSettings />
      </TabsContent>
      <TabsContent value="prompts" className="mt-4">
        <PromptSettings />
      </TabsContent>
    </Tabs>
  )
}

/** 模型配置 + 网络代理 + 视觉中转：代理服务于模型请求，视觉中转本质是模型路由 */
export function ChannelsTab(): React.ReactElement {
  return (
    <MergedStack>
      <ChannelSettings />
      <ProxySettings />
      <VisionRelaySettings />
    </MergedStack>
  )
}

/** 数据与用量：磁盘管理 + 数据迁移 + Token 统计 */
export function DataUsageTab(): React.ReactElement {
  return (
    <MergedStack>
      <StorageSettings />
      <MigrationSettings />
      <TokenUsageSettings />
    </MergedStack>
  )
}

/** 隐私与审计：数据采集 + 操作审计 */
export function PrivacyAuditTab(): React.ReactElement {
  return (
    <MergedStack>
      <TelemetrySettingsPanel />
      <OperationAuditSettings />
    </MergedStack>
  )
}

/** 账户与团队：订阅与账户 + 企业版连接 + 工作区成员 */
export function AccountTeamTab(): React.ReactElement {
  return (
    <MergedStack>
      <SubscriptionSettings />
      <EnterpriseSettings />
      <WorkspaceMembersSettings />
    </MergedStack>
  )
}
