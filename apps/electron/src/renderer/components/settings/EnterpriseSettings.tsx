/**
 * EnterpriseSettings - 企业版连接设置
 *
 * 管理开源版 Electron 与企业版服务端的连接。
 * 支持：连接到服务端、数据迁移、连接状态查看。
 */

import * as React from 'react'
import { useAtom } from 'jotai'
import { HardDriveDownload, Server, Link2, Unlink, CheckCircle2, AlertCircle, ChevronRight } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { SettingsSection, SettingsCard, SettingsRow } from './primitives'
import { enterpriseConnectionAtom } from '@/atoms/enterprise-atoms'

interface MigrationProgress {
  phase: string
  total: number
  current: number
  status: 'pending' | 'running' | 'done' | 'error'
}

export function EnterpriseSettings(): React.ReactElement {
  const [connection, setConnection] = useAtom(enterpriseConnectionAtom)
  const [serverUrl, setServerUrl] = React.useState('')
  const [authMode, setAuthMode] = React.useState<'none' | 'local' | 'oidc'>('none')
  const [username, setUsername] = React.useState('')
  const [password, setPassword] = React.useState('')
  const [isConnecting, setIsConnecting] = React.useState(false)
  const [isMigrating, setIsMigrating] = React.useState(false)
  const [migrationProgress, setMigrationProgress] = React.useState<MigrationProgress | null>(null)

  const handleConnect = async () => {
    if (!serverUrl) {
      toast.error('请输入服务端地址')
      return
    }
    if (authMode === 'local' && (!username || !password)) {
      toast.error('请输入用户名和密码')
      return
    }

    setIsConnecting(true)
    try {
      const result = await window.electronAPI.connectToServer({
        serverUrl,
        authMode,
        username: username || undefined,
        password: password || undefined,
      })
      setConnection({
        serverUrl: result.serverUrl,
        authMode: result.authMode as 'none' | 'local' | 'oidc',
        scope: result.scope,
      })
      toast.success('连接成功')
    } catch (error) {
      toast.error(`连接失败: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setIsConnecting(false)
    }
  }

  const handleDisconnect = () => {
    window.electronAPI.disconnectFromServer()
    setConnection(null)
    toast.success('已断开连接')
  }

  const handleMigrate = async () => {
    if (!connection) {
      toast.error('请先连接到服务端')
      return
    }
    setIsMigrating(true)
    setMigrationProgress({ phase: '准备中', total: 5, current: 0, status: 'running' })

    try {
      const phases = [
        { name: '渠道', key: 'channels' },
        { name: '工作区', key: 'workspaces' },
        { name: 'MCP 配置', key: 'mcpConfigs' },
        { name: '会话', key: 'sessions' },
        { name: '消息', key: 'messages' },
      ]

      for (let i = 0; i < phases.length; i++) {
        setMigrationProgress({
          phase: phases[i]!.name,
          total: phases.length,
          current: i,
          status: 'running',
        })
        // 实际迁移通过 IPC 调用
        await window.electronAPI.migrateToServer({ phase: phases[i]!.key })
      }

      setMigrationProgress({ phase: '完成', total: 5, current: 5, status: 'done' })
      toast.success('数据迁移完成')
    } catch (error) {
      setMigrationProgress((prev) =>
        prev ? { ...prev, status: 'error' } : null,
      )
      toast.error(`迁移失败: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setIsMigrating(false)
    }
  }

  return (
    <SettingsSection title="企业版">
      {/* 连接状态 */}
      <SettingsCard>
        <div className="flex items-center gap-3 mb-4">
          <div className={`p-2 rounded-lg ${connection ? 'bg-green-500/10 text-green-500' : 'bg-muted text-muted-foreground'}`}>
            {connection ? <Link2 size={20} /> : <Unlink size={20} />}
          </div>
          <div>
            <div className="text-sm font-medium">
              {connection ? '已连接到企业版服务端' : '未连接'}
            </div>
            {connection && (
              <div className="text-xs text-muted-foreground">
                {connection.serverUrl} · {connection.authMode} · {connection.scope.userId}
              </div>
            )}
          </div>
        </div>
      </SettingsCard>

      {/* 连接配置 */}
      {!connection && (
        <SettingsCard title="连接到服务端">
          <SettingsRow label="服务端地址" description="企业版服务端 URL，如 http://localhost:3000">
            <Input
              value={serverUrl}
              onChange={(e) => setServerUrl(e.target.value)}
              placeholder="http://localhost:3000"
              className="max-w-md"
            />
          </SettingsRow>

          <SettingsRow label="认证模式" description="选择与服务端匹配的认证方式">
            <Select value={authMode} onValueChange={(v) => setAuthMode(v as 'none' | 'local' | 'oidc')}>
              <SelectTrigger className="max-w-md">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">无认证（试用模式）</SelectItem>
                <SelectItem value="local">本地账号</SelectItem>
                <SelectItem value="oidc">OIDC（企业 SSO）</SelectItem>
              </SelectContent>
            </Select>
          </SettingsRow>

          {authMode === 'local' && (
            <>
              <SettingsRow label="用户名">
                <Input
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  placeholder="admin"
                  className="max-w-md"
                />
              </SettingsRow>
              <SettingsRow label="密码">
                <Input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="••••••"
                  className="max-w-md"
                />
              </SettingsRow>
            </>
          )}

          <div className="flex justify-end mt-4">
            <Button onClick={handleConnect} disabled={isConnecting}>
              {isConnecting ? '连接中...' : '连接'}
            </Button>
          </div>
        </SettingsCard>
      )}

      {/* 已连接：操作按钮 */}
      {connection && (
        <SettingsCard title="操作">
          <div className="flex flex-col gap-3">
            <Button
              variant="outline"
              onClick={handleMigrate}
              disabled={isMigrating}
              className="justify-start"
            >
              <HardDriveDownload size={16} className="mr-2" />
              {isMigrating ? '迁移中...' : '迁移本地数据到服务端'}
            </Button>

            {migrationProgress && (
              <div className="bg-muted rounded-lg p-3">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-sm">{migrationProgress.phase}</span>
                  <span className="text-xs text-muted-foreground">
                    {migrationProgress.current}/{migrationProgress.total}
                  </span>
                </div>
                <div className="w-full bg-background rounded-full h-2">
                  <div
                    className={`h-2 rounded-full transition-all ${
                      migrationProgress.status === 'error'
                        ? 'bg-red-500'
                        : migrationProgress.status === 'done'
                          ? 'bg-green-500'
                          : 'bg-primary'
                    }`}
                    style={{
                      width: `${(migrationProgress.current / migrationProgress.total) * 100}%`,
                    }}
                  />
                </div>
              </div>
            )}

            <Button
              variant="outline"
              onClick={handleDisconnect}
              className="justify-start text-red-500 hover:text-red-600 hover:bg-red-500/10"
            >
              <Unlink size={16} className="mr-2" />
              断开连接
            </Button>
          </div>
        </SettingsCard>
      )}

      {/* 说明 */}
      <SettingsCard title="关于企业版">
        <div className="text-sm text-muted-foreground space-y-2">
          <p>
            企业版提供团队协作、集中管理、审计合规等企业级功能。
            开源版数据可以无缝迁移到企业版。
          </p>
          <ul className="list-disc list-inside space-y-1">
            <li>团队协作：工作区共享、成员邀请</li>
            <li>集中管理：统一渠道配置、权限控制</li>
            <li>审计合规：操作审计、hash 链验证</li>
            <li>数据主权：私有部署、本地存储</li>
          </ul>
        </div>
      </SettingsCard>
    </SettingsSection>
  )
}
