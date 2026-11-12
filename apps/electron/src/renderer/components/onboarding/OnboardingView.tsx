/** 首次使用引导。 */
import { useEffect, useMemo, useState } from 'react'
import { useAtom, useAtomValue, useSetAtom } from 'jotai'
import { ArrowLeft, ArrowRight, Check, CheckCircle2, GraduationCap, HardDriveDownload, KeyRound, Layers3, MessageSquare, Sparkles, TerminalSquare } from 'lucide-react'
import type { Channel } from '@gravitas/shared'
import { Button } from '@/components/ui/button'
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { ScrollArea } from '@/components/ui/scroll-area'
import { TutorialViewer } from '@/components/tutorial/TutorialViewer'
import { EnvironmentCheckPanel } from '@/components/environment/EnvironmentCheckPanel'
import { SubscriptionOnboarding } from '@/components/subscription/SubscriptionOnboarding'
import { ChannelForm } from '@/components/settings/ChannelForm'
import { agentChannelIdsAtom } from '@/atoms/agent-atoms'
import { channelsAtom } from '@/atoms/chat-atoms'
import { isShellEnvironmentOkAtom } from '@/atoms/environment'
import { detectIsWindows } from '@/lib/platform'
import { migrationImportDialogOpenAtom } from '@/atoms/migration-atoms'

interface OnboardingViewProps { onComplete: () => void }
type Step = 'welcome' | 'model' | 'environment' | 'account'

export function OnboardingView({ onComplete }: OnboardingViewProps) {
  const [showTutorial, setShowTutorial] = useState(false)
  const [step, setStep] = useState<Step>('welcome')
  const [editingModel, setEditingModel] = useState(false)
  const [channels, setChannels] = useState<Channel[]>([])
  const [finishing, setFinishing] = useState(false)
  const [finishError, setFinishError] = useState(false)
  const isWindows = useMemo(() => detectIsWindows(), [])
  const shellOk = useAtomValue(isShellEnvironmentOkAtom)
  const [agentChannelIds, setAgentChannelIds] = useAtom(agentChannelIdsAtom)
  const setGlobalChannels = useSetAtom(channelsAtom)
  const setMigrationImportDialogOpen = useSetAtom(migrationImportDialogOpenAtom)
  const steps: { id: Step; label: string }[] = [
    { id: 'welcome', label: '欢迎' }, { id: 'model', label: '连接模型' },
    ...(isWindows ? [{ id: 'environment' as const, label: '环境检测' }] : []),
    { id: 'account', label: '完成设置' },
  ]
  const stepIndex = steps.findIndex((item) => item.id === step)
  const enabledChannels = channels.filter((channel) => channel.enabled && channel.models.some((model) => model.enabled))

  const refreshChannels = async () => {
    try {
      const list = await window.electronAPI.listChannels()
      setChannels(list)
      setGlobalChannels(list)
    } catch (error) { console.error('[引导] 加载模型配置失败:', error) }
  }
  useEffect(() => { if (step === 'model') void refreshChannels() }, [step])

  const handleFinish = async () => {
    if (finishing) return
    setFinishing(true)
    setFinishError(false)
    try {
      await window.electronAPI.updateSettings({ onboardingCompleted: true })
      onComplete()
    } catch (error) {
      console.error('[引导] 保存完成状态失败:', error)
      setFinishError(true)
      setFinishing(false)
    }
  }
  const syncAgentChannel = async (channel: Channel, eligible: boolean) => {
    if (!eligible || agentChannelIds.includes(channel.id)) return
    const ids = [...agentChannelIds, channel.id]
    setAgentChannelIds(ids)
    await window.electronAPI.updateSettings({ agentChannelIds: ids }).catch((error) => {
      console.error('[引导] 保存 Agent 渠道失败:', error)
    })
  }

  return (
    <div className="flex h-screen min-h-0 flex-col bg-background text-foreground">
      <header className="flex min-h-16 shrink-0 items-center justify-between gap-4 border-b border-border/50 px-6 pt-2 sm:px-10">
        <span className="text-sm font-semibold tracking-tight">Gravitas</span>
        <nav aria-label="设置进度" className="flex items-center gap-2 overflow-x-auto">
          {steps.map((item, index) => <div key={item.id} className="flex shrink-0 items-center gap-2">
            {index > 0 && <span className="hidden h-px w-5 bg-border sm:block" />}
            <span aria-current={index === stepIndex ? 'step' : undefined} className={`flex items-center gap-1.5 text-xs font-medium ${index === stepIndex ? 'text-foreground' : 'text-muted-foreground'}`}>
              <span className={`flex h-6 w-6 items-center justify-center rounded-full ${index === stepIndex ? 'bg-primary text-primary-foreground' : 'bg-muted'}`}>{index < stepIndex ? <Check size={13} /> : index + 1}</span>
              <span className="hidden sm:inline">{item.label}</span>
            </span>
          </div>)}
        </nav>
        <button onClick={() => void handleFinish()} disabled={finishing || editingModel} className="shrink-0 text-xs text-muted-foreground hover:text-foreground disabled:opacity-40">跳过设置</button>
      </header>
      <main className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto grid min-h-full max-w-7xl lg:grid-cols-2">
          <section className="flex flex-col px-6 py-10 sm:px-12 lg:py-14">
            {step === 'welcome' && <div className="my-auto max-w-xl">
              <p className="mb-4 text-xs font-semibold tracking-[0.2em] text-primary">YOUR AI WORKSPACE</p>
              <h1 className="text-4xl font-semibold tracking-tight sm:text-5xl">欢迎使用 Gravitas</h1>
              <p className="mt-5 text-base leading-7 text-muted-foreground">一个属于你的 AI 工作台。从连接模型开始，让对话、Agent 和项目一起为你工作。</p>
              <p className="mb-3 mt-10 text-xs font-semibold tracking-wider text-muted-foreground">接下来</p>
              <div className="space-y-2">
                <OverviewRow number="01" title="连接你的 AI 模型" detail="使用自己的 API Key 或支持的订阅" />
                {isWindows && <OverviewRow number="02" title="检查运行环境" detail="确认 Agent 所需的 Windows 环境" />}
                <OverviewRow number={isWindows ? '03' : '02'} title="按需设置账户" detail="可跳过，之后随时在设置中更改" />
              </div>
              <div className="mt-8 flex flex-wrap gap-2">
                <Button variant="outline" size="sm" onClick={() => setMigrationImportDialogOpen(true)}><HardDriveDownload size={15} /> 导入已有配置</Button>
                <Button variant="ghost" size="sm" onClick={() => setShowTutorial(true)}><GraduationCap size={15} /> 查看教程</Button>
              </div>
            </div>}
            {step === 'model' && <div className="w-full max-w-xl">
              <p className="mb-4 text-xs font-semibold tracking-[0.2em] text-primary">AI MODEL</p>
              <h1 className="text-3xl font-semibold tracking-tight">连接你的 AI 模型</h1>
              <p className="mt-4 text-sm leading-6 text-muted-foreground">选择供应商，填写凭据并添加模型。Gravitas 使用你配置的服务；模型和渠道之后都可以在设置中管理。</p>
              {editingModel ? <div className="mt-7 rounded-2xl bg-card p-5 shadow-sm ring-1 ring-border/50">
                <ChannelForm channel={null} onSaved={() => { setEditingModel(false); void refreshChannels() }} onCancel={() => setEditingModel(false)} onAgentEligibilityChange={syncAgentChannel} />
              </div> : <div className="mt-8 space-y-3">
                {enabledChannels.length > 0 && <div className="flex items-start gap-3 rounded-2xl bg-primary/10 p-4 text-sm"><CheckCircle2 className="mt-0.5 shrink-0 text-primary" size={19} /><div><strong>已配置 {enabledChannels.length} 个渠道</strong><p className="mt-1 text-muted-foreground">{enabledChannels.map((channel) => channel.name).join('、')}</p></div></div>}
                <button onClick={() => setEditingModel(true)} className="flex w-full items-center gap-4 rounded-2xl bg-card p-5 text-left shadow-sm ring-1 ring-border/50 transition hover:ring-primary/50">
                  <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary"><KeyRound size={20} /></span>
                  <span className="flex-1"><strong className="block text-sm">添加模型配置</strong><span className="mt-1 block text-xs leading-5 text-muted-foreground">支持 API Key，以及 ChatGPT 和 GitHub Copilot 订阅登录</span></span><ArrowRight size={17} className="text-muted-foreground" />
                </button>
                <p className="px-1 text-xs leading-5 text-muted-foreground">还没有凭据？可以先进入工作台，之后在「设置 → 模型配置」中添加。</p>
              </div>}
            </div>}
            {step === 'environment' && <div className="w-full max-w-xl">
              <p className="mb-4 text-xs font-semibold tracking-[0.2em] text-primary">ENVIRONMENT</p><h1 className="text-3xl font-semibold tracking-tight">检查运行环境</h1>
              <p className="mt-4 text-sm leading-6 text-muted-foreground">Windows 上的 Agent 需要 Git Bash 或 WSL。你可以现在检查，也可以稍后处理。</p>
              <div className="mt-8 rounded-2xl bg-card p-5 shadow-sm ring-1 ring-border/50"><EnvironmentCheckPanel autoDetectOnMount /></div>
            </div>}
            {step === 'account' && <div className="w-full max-w-xl">
              <p className="mb-4 text-xs font-semibold tracking-[0.2em] text-primary">READY WHEN YOU ARE</p><h1 className="text-3xl font-semibold tracking-tight">准备好开始了</h1>
              <p className="mt-4 text-sm leading-6 text-muted-foreground">账户设置是可选的。免费版可使用通用能力，专业版提供更多领域能力包。</p>
              <div className="mt-8 rounded-2xl bg-card p-5 shadow-sm ring-1 ring-border/50"><SubscriptionOnboarding compact showLater={false} /></div>
            </div>}
          </section>
          <aside className="hidden min-h-full items-center justify-center bg-muted/40 p-12 lg:flex"><div className="w-full max-w-md">
            <div className="relative overflow-hidden rounded-[2rem] bg-primary p-8 text-primary-foreground shadow-xl"><div className="absolute -right-14 -top-16 h-48 w-48 rounded-full bg-white/10" /><div className="relative">
              <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-white/15"><Sparkles size={23} /></div>
              <p className="mt-12 text-xs font-medium tracking-[0.18em] opacity-70">MAKE SPACE FOR IDEAS</p><h2 className="mt-3 text-3xl font-semibold leading-tight">从一个想法，<br />到真正完成。</h2><p className="mt-4 max-w-xs text-sm leading-6 opacity-75">对话、探索、执行与整理，都在同一个工作空间里。</p>
            </div></div>
            <div className="mt-5 grid grid-cols-3 gap-3 text-center text-xs text-muted-foreground">
              <div className="rounded-xl bg-card p-4 shadow-sm"><MessageSquare className="mx-auto mb-2 text-primary" size={19} />对话</div><div className="rounded-xl bg-card p-4 shadow-sm"><TerminalSquare className="mx-auto mb-2 text-primary" size={19} />Agent</div><div className="rounded-xl bg-card p-4 shadow-sm"><Layers3 className="mx-auto mb-2 text-primary" size={19} />项目</div>
            </div><p className="mt-6 text-center text-xs leading-5 text-muted-foreground">配置保存在本机。你可以随时返回设置调整。</p>
          </div></aside>
        </div>
      </main>
      <footer className="flex shrink-0 items-center justify-between gap-4 border-t border-border/50 bg-background px-6 py-4 sm:px-10">
        {stepIndex > 0 && !editingModel ? <Button variant="ghost" onClick={() => setStep(steps[stepIndex - 1].id)}><ArrowLeft size={16} /> 上一步</Button> : <span />}
        <div className="flex items-center gap-4">{finishError && <span role="alert" className="text-xs text-destructive">保存失败，请重试。</span>}
          {!editingModel && (step === 'account' ? <Button onClick={() => void handleFinish()} disabled={finishing}>{finishing ? '正在保存…' : '进入 Gravitas'} <ArrowRight size={16} /></Button> : <Button onClick={() => setStep(steps[stepIndex + 1].id)}>{step === 'welcome' ? '开始设置' : step === 'model' && enabledChannels.length === 0 ? '稍后配置' : step === 'environment' && !shellOk ? '稍后处理' : '继续'} <ArrowRight size={16} /></Button>)}
        </div>
      </footer>
      <Sheet open={showTutorial} onOpenChange={setShowTutorial}><SheetContent side="right" className="w-[560px] p-0 sm:max-w-[560px]"><SheetHeader className="border-b px-6 pb-4 pt-6"><SheetTitle className="flex items-center gap-2"><GraduationCap size={18} className="text-primary" />Gravitas 使用教程</SheetTitle></SheetHeader><ScrollArea className="h-[calc(100vh-80px)]"><div className="px-6 py-4"><TutorialViewer /></div></ScrollArea></SheetContent></Sheet>
    </div>
  )
}

function OverviewRow({ number, title, detail }: { number: string; title: string; detail: string }) {
  return <div className="flex items-center gap-4 rounded-xl bg-card px-4 py-3 shadow-sm ring-1 ring-border/40"><span className="text-xs font-semibold text-primary">{number}</span><span><strong className="block text-sm">{title}</strong><span className="text-xs text-muted-foreground">{detail}</span></span></div>
}
