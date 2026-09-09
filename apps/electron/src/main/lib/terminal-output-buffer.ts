export interface TerminalOutputBuffer { output: string; sequence: number }

export function appendTerminalOutput(buffer: TerminalOutputBuffer, data: string, maxChars: number): TerminalOutputBuffer {
  if (!Number.isSafeInteger(maxChars) || maxChars < 1) throw new Error('终端输出缓冲上限必须为正整数')
  return { output: `${buffer.output}${data}`.slice(-maxChars), sequence: buffer.sequence + 1 }
}
