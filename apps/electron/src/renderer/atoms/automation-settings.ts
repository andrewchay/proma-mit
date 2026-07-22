/** 自动化与设备控制设置页状态。 */

import { atom } from 'jotai'

export interface ComputerUseCapabilities {
  platform: string
  screenshot: boolean
  input: boolean
  frontmostWindow: boolean
  message: string
}

export interface ComputerUsePermissionStatus {
  supported: boolean
  accessibility: boolean
  screenRecording: boolean
  message: string
}

export const computerUseCapabilitiesAtom = atom<ComputerUseCapabilities | null>(null)
export const computerUsePermissionStatusAtom = atom<ComputerUsePermissionStatus | null>(null)
export const automationSettingsLoadingAtom = atom(false)
