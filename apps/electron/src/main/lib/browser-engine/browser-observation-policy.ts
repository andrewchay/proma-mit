/**
 * Browser Engine 结构化 AX 观察策略（纯逻辑，可单测）。
 *
 * 目标：从 CDP `Accessibility.getFullAXTree` 的原始节点中，挑选出对 Agent 有用、
 * 且数量可控的元素列表：
 *  - 可交互角色优先（默认占据 2/3 预算），其余补语义上下文；
 *  - 元素总量和 AX 深度受限，避免整树序列化长时间阻塞；
 *  - 对可交互元素的名字保留更长（对模型更有用）。
 */

export const DEFAULT_BROWSER_OBSERVE_MAX_ELEMENTS = 240
export const MAX_BROWSER_OBSERVE_MAX_ELEMENTS = 400
export const MIN_BROWSER_OBSERVE_MAX_ELEMENTS = 20

const INTERACTIVE_ROLE_RATIO = 2 / 3

const INTERACTIVE_AX_ROLES = new Set([
  'button',
  'checkbox',
  'combobox',
  'gridcell',
  'link',
  'listbox',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'option',
  'radio',
  'searchbox',
  'slider',
  'spinbutton',
  'switch',
  'tab',
  'textbox',
  'treeitem',
])

export interface BrowserAxCandidate {
  backendNodeId: number
  role: string
  name: string
  editable: boolean
}

export function resolveBrowserObserveMaxElements(requested?: number): number {
  if (requested === undefined) return DEFAULT_BROWSER_OBSERVE_MAX_ELEMENTS
  if (!Number.isFinite(requested)) throw new Error('maxElements 必须是有限数字。')
  return Math.max(MIN_BROWSER_OBSERVE_MAX_ELEMENTS, Math.min(MAX_BROWSER_OBSERVE_MAX_ELEMENTS, Math.floor(requested)))
}

export function isInteractiveAxRole(role: string): boolean {
  return INTERACTIVE_AX_ROLES.has(role.toLowerCase())
}

/** contenteditable 等自定义编辑器不一定暴露为标准 textbox role。 */
export function isInteractiveCandidate(candidate: { role: string; editable?: boolean }): boolean {
  return candidate.editable === true || isInteractiveAxRole(candidate.role)
}

/**
 * 优先保留可操作 AX 节点，剩余预算补语义上下文。
 * 默认 240 的分配约为 160 可交互 + 80 上下文。
 */
export function prioritizeBrowserObservationCandidates(candidates: readonly BrowserAxCandidate[], maxElements: number): BrowserAxCandidate[] {
  const interactiveLimit = Math.ceil(maxElements * INTERACTIVE_ROLE_RATIO)
  const interactive: BrowserAxCandidate[] = []
  const context: BrowserAxCandidate[] = []

  for (const candidate of candidates) {
    if (isInteractiveCandidate(candidate)) interactive.push(candidate)
    else context.push(candidate)
  }

  const selectedInteractive = interactive.slice(0, interactiveLimit)
  return [...selectedInteractive, ...context.slice(0, maxElements - selectedInteractive.length)]
}

export function browserObservationNameLimit(role: string): number {
  return isInteractiveAxRole(role) ? 160 : 80
}
