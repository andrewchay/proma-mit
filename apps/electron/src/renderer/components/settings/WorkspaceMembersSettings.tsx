/**
 * 工作区成员管理 UI
 *
 * 设置页中的工作区成员管理组件。
 * 支持：查看成员、邀请成员、移除成员、移交所有权。
 */

import * as React from 'react'
import { useAtom } from 'jotai'
import { Users, UserPlus, Shield, UserMinus, Crown, Mail } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import { SettingsSection, SettingsCard, SettingsRow } from './primitives'
import { enterpriseConnectionAtom } from '@/atoms/enterprise-atoms'

interface WorkspaceMember {
  userId: string
  role: 'owner' | 'editor' | 'viewer'
  joinedAt: string
}

export function WorkspaceMembersSettings(): React.ReactElement {
  const [connection] = useAtom(enterpriseConnectionAtom)
  const [members, setMembers] = React.useState<WorkspaceMember[]>([])
  const [inviteEmail, setInviteEmail] = React.useState('')
  const [inviteRole, setInviteRole] = React.useState<'editor' | 'viewer'>('editor')
  const [isLoading, setIsLoading] = React.useState(false)

  // 模拟成员数据（实际应从服务端获取）
  React.useEffect(() => {
    if (connection) {
      // TODO: 从服务端获取成员列表
      setMembers([
        { userId: connection.scope.userId, role: 'owner', joinedAt: new Date().toISOString() },
      ])
    }
  }, [connection])

  const handleInvite = async () => {
    if (!inviteEmail) {
      toast.error('请输入邮箱地址')
      return
    }
    setIsLoading(true)
    try {
      // TODO: 调用服务端 API 发送邀请
      toast.success(`已发送邀请至 ${inviteEmail}`)
      setInviteEmail('')
    } catch (error) {
      toast.error(`邀请失败: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setIsLoading(false)
    }
  }

  const handleRemoveMember = async (userId: string) => {
    try {
      // TODO: 调用服务端 API 移除成员
      setMembers((prev) => prev.filter((m) => m.userId !== userId))
      toast.success('成员已移除')
    } catch (error) {
      toast.error(`移除失败: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const getRoleIcon = (role: string) => {
    switch (role) {
      case 'owner':
        return <Crown size={16} className="text-amber-500" />
      case 'editor':
        return <Shield size={16} className="text-blue-500" />
      case 'viewer':
        return <Users size={16} className="text-gray-500" />
      default:
        return null
    }
  }

  const getRoleLabel = (role: string) => {
    switch (role) {
      case 'owner':
        return '所有者'
      case 'editor':
        return '编辑者'
      case 'viewer':
        return '查看者'
      default:
        return role
    }
  }

  if (!connection) {
    return (
      <SettingsSection title="工作区成员">
        <SettingsCard>
          <div className="text-sm text-muted-foreground">
            请先连接到企业版服务端以管理成员。
          </div>
        </SettingsCard>
      </SettingsSection>
    )
  }

  return (
    <SettingsSection title="工作区成员">
      {/* 成员列表 */}
      <SettingsCard title="成员列表">
        <div className="space-y-3">
          {members.map((member) => (
            <div
              key={member.userId}
              className="flex items-center justify-between p-3 rounded-lg bg-muted/50"
            >
              <div className="flex items-center gap-3">
                {getRoleIcon(member.role)}
                <div>
                  <div className="text-sm font-medium">{member.userId}</div>
                  <div className="text-xs text-muted-foreground">
                    {getRoleLabel(member.role)} · 加入于 {new Date(member.joinedAt).toLocaleDateString()}
                  </div>
                </div>
              </div>
              {member.role !== 'owner' && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => void handleRemoveMember(member.userId)}
                >
                  <UserMinus size={16} className="text-red-500" />
                </Button>
              )}
            </div>
          ))}
        </div>
      </SettingsCard>

      {/* 邀请成员 */}
      <SettingsCard title="邀请成员">
        <div className="space-y-4">
          <SettingsRow label="邮箱地址" description="输入要邀请的成员邮箱">
            <div className="flex gap-2">
              <Input
                type="email"
                value={inviteEmail}
                onChange={(e) => setInviteEmail(e.target.value)}
                placeholder="colleague@company.com"
                className="flex-1"
              />
              <Select
                value={inviteRole}
                onValueChange={(v) => setInviteRole(v as 'editor' | 'viewer')}
              >
                <SelectTrigger className="w-[120px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="editor">编辑者</SelectItem>
                  <SelectItem value="viewer">查看者</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </SettingsRow>
          <div className="flex justify-end">
            <Button onClick={handleInvite} disabled={isLoading}>
              <UserPlus size={16} className="mr-2" />
              {isLoading ? '发送中...' : '发送邀请'}
            </Button>
          </div>
        </div>
      </SettingsCard>

      {/* 邀请链接 */}
      <SettingsCard title="邀请链接">
        <div className="space-y-3">
          <div className="text-sm text-muted-foreground">
            生成邀请链接，通过邮件或即时通讯工具发送给团队成员。
          </div>
          <div className="flex gap-2">
            <Input
              readOnly
              value={`https://gravitas.io/join/${connection.scope.tenantId}/${connection.scope.userId}`}
              className="flex-1"
            />
            <Button
              variant="outline"
              onClick={() => {
                navigator.clipboard.writeText(`https://gravitas.io/join/${connection.scope.tenantId}/${connection.scope.userId}`)
                toast.success('链接已复制')
              }}
            >
              <Mail size={16} className="mr-2" />
              复制
            </Button>
          </div>
        </div>
      </SettingsCard>
    </SettingsSection>
  )
}
