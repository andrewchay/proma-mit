# Chat 输入框上下键历史回溯失效 — 修复记录

> 2026-08-06

## 症状
在 Chat 面板的输入框里按 `↑`/`↓` 方向键，无法像终端那样回溯到之前发过的消息。

## 根因
`ChatInput.tsx` 中构造历史条目的数据源是 `currentMessagesAtom`：

```ts
const currentMessages = useAtomValue(currentMessagesAtom)
const historyEntries = React.useMemo(
  () => currentMessages.filter((m) => m.role === 'user').map((m) => m.content),
  [currentMessages],
)
```

但**整个 renderer 中 `currentMessagesAtom` 从未被赋值**（全仓库 grep 只有定义处 + ChatInput 引用处），是历史遗留的死代码。Chat 面板的真实消息实际由 `ChatView` 的 **React local state `messages`** 管理。因此 `historyEntries` 恒为空数组，`navigateInputHistory` 直接返回 `undefined`，方向键历史回溯完全失效。

## 修复
- `ChatView.tsx`：渲染 `<ChatInput>` 时新增传入 `messages={messages}`（真实消息列表，正序 旧→新）。
- `ChatInput.tsx`：新增 `messages?: ChatMessage[]` prop，构造 `historyEntries` 时优先用 `messages ?? currentMessages`（保留 `currentMessagesAtom` 作为回退，不动原有引用）。
- Agent 面板（`AgentView.tsx`）不受影响：它的 `historyEntries` 来自真实的 `persistedSDKMessages`。

## 未改动的相关点
- `rich-text-input.tsx` 的键盘处理与 `navigateInputHistory` 逻辑本身正确（有单测覆盖），无需改动。
- `currentMessagesAtom` 保留为回退来源，未清理（最小变更）。

---

# 补充修复：方向键回溯需多次按键 / 向下「恢复成空」交互不畅

> 2026-08-06（同议题续报）

## 新症状
Chat 面板输入框：向上一条条找回历史正常；但向下逐级返回时，**第一下 ↓ 往往被当成单纯的『光标移动』吃掉**，需要连按多次才能一步步走回，最后走到草稿态变成空，体验很差。用户直观感受是「向下没法恢复」。

## 根因
`navigateInputHistory` 纯函数状态机本身是**正确的**（已补多级上下、草稿恢复等单测覆盖，见 `input-history.test.ts`，5 例全绿）。

问题在**组件层的光标边界判定**：`rich-text-input.tsx` 的 `handleKeyDown` 里，`↑`/`↓` 触发历史导航的前提是 `isAtStart`/`isAtEnd`（光标必须在文档首/尾）。但每次 `onChange` 驱动 `setContent` 后，TipTap 会把**光标重置到文档开头**，导致：
- `↓` 时 `isAtEnd` 不成立 → 第一下只移动光标、不导航；
- 多行历史时更严重，用户要按多次才走一级。

## 修复（`rich-text-input.tsx`）
引入 `inHistoryNav = historyStateRef.current.index !== -1`：
- **一旦进入历史回溯（index 非 -1），`↑`/`↓` 无条件触发历史导航**，不再依赖光标是否在首/尾。
- 仅在草稿态（index === -1）下保留 `isAtStart`/`isAtEnd` 边界判定，避免干扰正常的多行光标移动。

效果：向上逐级找回、向下逐级返回都一次按键即可，走到最末恢复草稿（空输入框下即空）。状态机与光标视觉解耦，无需额外光标 hack。
