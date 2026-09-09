import * as React from 'react'
import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'
import type { TerminalOutputEvent } from '@gravitas/shared'
import '@xterm/xterm/css/xterm.css'

const TERMINAL_FONT = [
  'ui-monospace', 'SFMono-Regular', 'Menlo', 'Monaco', 'Consolas',
  '"MesloLGS NF"', '"JetBrains Mono Nerd Font"', 'monospace',
].join(', ')

interface TerminalTabContentProps {
  terminalId: string
  sessionId: string
  visible: boolean
}

/** xterm 视图始终保持挂载；右侧工作区切换 Tab 只改变可见性，不销毁 PTY。 */
export function TerminalTabContent({ terminalId, sessionId, visible }: TerminalTabContentProps): React.ReactElement {
  const hostRef = React.useRef<HTMLDivElement>(null)

  React.useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const terminal = new Terminal({
      cursorBlink: true,
      convertEol: true,
      fontFamily: TERMINAL_FONT,
      fontSize: 13,
      lineHeight: 1.25,
      scrollback: 5_000,
      theme: { background: '#111113', foreground: '#e6e6e9', cursor: '#e6e6e9', selectionBackground: '#3f3f46' },
    })
    const fitAddon = new FitAddon()
    terminal.loadAddon(fitAddon)
    terminal.open(host)
    let disposed = false
    let restoring = true
    let lastSequence = 0
    const pending: TerminalOutputEvent[] = []

    const fit = (): void => {
      if (host.clientWidth <= 0 || host.clientHeight <= 0 || host.offsetParent === null) return
      try {
        fitAddon.fit()
        void window.electronAPI.resizeTerminal({ terminalId, cols: terminal.cols, rows: terminal.rows }).catch(() => {})
      } catch { /* 字体尚未完成测量时等待下一次布局变化 */ }
    }
    const observer = new ResizeObserver(fit)
    observer.observe(host)
    const inputSubscription = terminal.onData((data) => {
      void window.electronAPI.writeTerminal({ terminalId, data }).catch(console.error)
    })
    const renderOutput = (event: TerminalOutputEvent): void => {
      if (event.sequence <= lastSequence) return
      terminal.write(event.data, () => { lastSequence = event.sequence })
    }
    const disposeOutput = window.electronAPI.onTerminalOutput((event) => {
      if (event.terminalId !== terminalId) return
      if (restoring) pending.push(event)
      else renderOutput(event)
    })
    const disposeExit = window.electronAPI.onTerminalExit((event) => {
      if (event.terminalId === terminalId) terminal.write(`\r\n\x1b[90m终端已退出（${event.exitCode}）\x1b[0m\r\n`)
    })

    const create = async (): Promise<void> => {
      try {
        fitAddon.fit()
        await window.electronAPI.createTerminal({ terminalId, sessionId, cols: Math.max(2, terminal.cols), rows: Math.max(1, terminal.rows) })
        if (disposed) return
        const snapshot = await window.electronAPI.getTerminalSnapshot(terminalId)
        terminal.write(snapshot.output, () => {
          if (disposed) return
          lastSequence = snapshot.sequence
          restoring = false
          pending.sort((left, right) => left.sequence - right.sequence).forEach(renderOutput)
          pending.length = 0
          fit()
          terminal.focus()
        })
      } catch (error) {
        restoring = false
        terminal.write(`\r\n\x1b[31m无法启动终端：${error instanceof Error ? error.message : String(error)}\x1b[0m\r\n`)
      }
    }
    void create()

    return () => {
      disposed = true
      observer.disconnect()
      inputSubscription.dispose()
      disposeOutput()
      disposeExit()
      terminal.dispose()
      void window.electronAPI.killTerminal(terminalId).catch(() => {})
    }
  }, [sessionId, terminalId])

  React.useEffect(() => {
    if (!visible) return
    const frame = requestAnimationFrame(() => hostRef.current?.focus())
    return () => cancelAnimationFrame(frame)
  }, [visible])

  return (
    <div className={visible ? 'h-full w-full overflow-hidden bg-[#111113] p-2' : 'hidden'}>
      <div ref={hostRef} className="h-full min-h-0 w-full min-w-0" />
    </div>
  )
}
