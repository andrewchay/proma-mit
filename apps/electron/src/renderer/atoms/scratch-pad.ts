/**
 * Scratch Pad Atoms — 便签内容状态
 *
 * 内容持久化到 ~/.gravitas/scratch-pad.md，由 main.tsx 的
 * ScratchPadPersistence 统一负责加载与自动保存。
 */

import { atom } from 'jotai'

/** Scratch Pad 编辑内容（HTML 字符串，供 TipTap 编辑器使用） */
export const scratchPadContentAtom = atom<string>('')

/** Scratch Pad 内容是否已从磁盘加载 */
export const scratchPadLoadedAtom = atom<boolean>(false)

/**
 * 便签是否占据主区。
 *
 * 刻意不用 appModeAtom 表达：appMode 决定侧边栏渲染哪一份会话列表
 * （chat / agent），设成第三个取值会让列表整个消失。便签是叠加在主区上的
 * 独立视图，侧边栏应保持进入前的会话列表。
 */
export const scratchPadOpenAtom = atom<boolean>(false)
