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
