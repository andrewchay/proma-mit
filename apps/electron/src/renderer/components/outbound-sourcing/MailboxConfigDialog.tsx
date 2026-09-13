/**
 * MailboxConfigDialog — 邮箱账户配置弹窗
 *
 * IMAP/SMTP 账户与主机配置；密码以 safeStorage 加密持久化，不明文回显。
 * 支持阿里企业邮预置与自定义主机，保存前可测试连接。
 */
import * as React from 'react'
import { Loader2, Plug, Save } from 'lucide-react'
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { ALIBABA_MAIL_PRESET } from './preset'

export interface MailboxConfigDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onSaved: () => void
}

interface FormState {
  label: string
  email: string
  password: string
  imapHost: string
  imapPort: string
  imapTls: boolean
  smtpHost: string
  smtpPort: string
  smtpTls: boolean
  fromName: string
  syncIntervalMinutes: string
}

const EMPTY_FORM: FormState = {
  label: '',
  email: '',
  password: '',
  imapHost: ALIBABA_MAIL_PRESET.imapHost,
  imapPort: String(ALIBABA_MAIL_PRESET.imapPort),
  imapTls: true,
  smtpHost: ALIBABA_MAIL_PRESET.smtpHost,
  smtpPort: String(ALIBABA_MAIL_PRESET.smtpPort),
  smtpTls: true,
  fromName: 'Jack',
  syncIntervalMinutes: '0',
}

export function MailboxConfigDialog({ open, onOpenChange, onSaved }: MailboxConfigDialogProps): React.ReactElement {
  const [form, setForm] = React.useState<FormState>(EMPTY_FORM)
  const [passwordConfigured, setPasswordConfigured] = React.useState(false)
  const [saving, setSaving] = React.useState(false)
  const [testing, setTesting] = React.useState(false)
  const [message, setMessage] = React.useState<string | null>(null)
  const [error, setError] = React.useState<string | null>(null)

  React.useEffect(() => {
    if (!open) return
    setError(null)
    setMessage(null)
    void (async () => {
      try {
        const config = await window.electronAPI.outboundMail.getConfig()
        if (config) {
          setForm({
            label: config.label,
            email: config.email,
            password: '',
            imapHost: config.imapHost,
            imapPort: String(config.imapPort),
            imapTls: config.imapTls,
            smtpHost: config.smtpHost,
            smtpPort: String(config.smtpPort),
            smtpTls: config.smtpTls,
            fromName: config.fromName,
            syncIntervalMinutes: String(config.syncIntervalMinutes),
          })
          setPasswordConfigured(config.passwordConfigured)
        } else {
          setForm(EMPTY_FORM)
          setPasswordConfigured(false)
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : '读取配置失败')
      }
    })()
  }, [open])

  const set = (key: keyof FormState, value: string | boolean): void => {
    setForm((prev) => ({ ...prev, [key]: value }))
  }

  const handleSave = async (testFirst: boolean): Promise<void> => {
    setError(null)
    setMessage(null)
    if (!form.email.trim() || (!passwordConfigured && !form.password.trim())) {
      setError('请填写邮箱地址与密码/授权码')
      return
    }
    if (testFirst) {
      setTesting(true)
      try {
        // 先保存再测试（测试需要已保存的凭据）
        await save()
        const result = await window.electronAPI.outboundMail.testConnection()
        if (result.imapOk && result.smtpOk) {
          setMessage('IMAP 与 SMTP 连接正常')
        } else {
          setError(result.error ?? '连接测试失败')
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : '连接测试失败')
      } finally {
        setTesting(false)
      }
      return
    }
    setSaving(true)
    try {
      await save()
      setMessage('已保存')
      onSaved()
    } catch (err) {
      setError(err instanceof Error ? err.message : '保存失败')
    } finally {
      setSaving(false)
    }
  }

  const save = async (): Promise<void> => {
    await window.electronAPI.outboundMail.saveConfig({
      label: form.label.trim() || undefined,
      email: form.email.trim(),
      password: form.password.trim() || undefined,
      imapHost: form.imapHost.trim(),
      imapPort: Number(form.imapPort) || ALIBABA_MAIL_PRESET.imapPort,
      imapTls: form.imapTls,
      smtpHost: form.smtpHost.trim(),
      smtpPort: Number(form.smtpPort) || ALIBABA_MAIL_PRESET.smtpPort,
      smtpTls: form.smtpTls,
      fromName: form.fromName.trim(),
      syncIntervalMinutes: Number(form.syncIntervalMinutes) || 0,
    })
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>邮箱账户</DialogTitle>
          <DialogDescription>
            配置 IMAP/SMTP 用于收件同步与审批发送。密码经系统加密存储，不会进入 Agent 上下文。
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label>邮箱地址</Label>
              <Input value={form.email} onChange={(e) => set('email', e.target.value)} placeholder="sales@example.com" />
            </div>
            <div className="space-y-1">
              <Label>密码 / 授权码</Label>
              <Input
                type="password"
                value={form.password}
                onChange={(e) => set('password', e.target.value)}
                placeholder={passwordConfigured ? '已配置（留空保持不变）' : '必填'}
              />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label>IMAP 主机</Label>
              <Input value={form.imapHost} onChange={(e) => set('imapHost', e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label>IMAP 端口</Label>
              <Input value={form.imapPort} onChange={(e) => set('imapPort', e.target.value)} />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label>SMTP 主机</Label>
              <Input value={form.smtpHost} onChange={(e) => set('smtpHost', e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label>SMTP 端口</Label>
              <Input value={form.smtpPort} onChange={(e) => set('smtpPort', e.target.value)} />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="flex items-center justify-between rounded-lg border border-border/50 px-3 py-2">
              <Label>IMAP TLS</Label>
              <Switch checked={form.imapTls} onCheckedChange={(v) => set('imapTls', v)} />
            </div>
            <div className="flex items-center justify-between rounded-lg border border-border/50 px-3 py-2">
              <Label>SMTP TLS</Label>
              <Switch checked={form.smtpTls} onCheckedChange={(v) => set('smtpTls', v)} />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label>发信人显示名</Label>
              <Input value={form.fromName} onChange={(e) => set('fromName', e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label>定时同步（分钟，0 关闭）</Label>
              <Input value={form.syncIntervalMinutes} onChange={(e) => set('syncIntervalMinutes', e.target.value)} />
            </div>
          </div>
          {error && <div className="text-[12px] text-red-500">{error}</div>}
          {message && <div className="text-[12px] text-emerald-600">{message}</div>}
        </div>
        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={() => void handleSave(true)} disabled={testing || saving}>
            {testing ? <Loader2 size={14} className="mr-1.5 animate-spin" /> : <Plug size={14} className="mr-1.5" />}
            保存并测试
          </Button>
          <Button onClick={() => void handleSave(false)} disabled={testing || saving}>
            {saving ? <Loader2 size={14} className="mr-1.5 animate-spin" /> : <Save size={14} className="mr-1.5" />}
            保存
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export default MailboxConfigDialog
