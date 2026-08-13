# Gravitas 浏览器引擎重构 · 垂直切片 TODO

## 目标
在 `/Users/chaihao/LLM/proma-mit` 新建独立 `browser-engine` 模块，验证「多标签 WebContentsView + CDP AX + 真实输入」通路，不改现有 WebBridge。跑通后再接入。

## 进度
- [x] 搭建模块骨架（browser-cdp / browser-policy / browser-observation-policy / browser-key-policy / browser-controller）✅
- [x] S1 引擎：多 tab WebContentsView + debugger.attach + navigate + selectTab/closeTab ✅
- [x] S2 AX Observe：Accessibility.getFullAXTree → 结构化元素 + ref + generation ✅
- [x] S3 CDP 真实输入：Click(dispatchMouseEvent) / Fill(insertText) / Press(dispatchKeyEvent) ✅
- [x] S4 验证：electron 真机跑通「双 tab 切换 + AX Observe + 真实点击填表 + 多标签不丢状态」✅（2.8s 全过）
- [x] 补纯逻辑单测：browser-policy / observation-policy / key-policy 共 33 个用例全过 ✅（bun test）
    - browser-policy.test.ts（URL 规范化/校验，11 例）
    - browser-observation-policy.test.ts（maxElements 钳制 / 可交互判定 / 优先级排序，13 例）
    - browser-key-policy.test.ts（导航键 VK 语义 / 文本插入 / 校验，9 例）
- [x] **替换底层接入（T1-T5）** ✅
    - T1 backend 切换：BrowserEngineBackend 实现 WebAutomationBackend，委托 browserController（多标签 CDP），保留 DOM snapshot 能力
    - T2 门面加多标签：web-bridge-service 新增 observe/createNewTab/listTabs/selectTab/closeTab
    - T3 工具层：新增 WebBridgeObserve + WebBridgeNewTab/ListTabs/SelectTab/CloseTab，tool-registry 注册 + CORE_TOOL_NAMES
    - T4 权限：WebBridgeObserve / WebBridgeListTabs 进 SAFE_TOOLS（只读）；多标签工具走通用确认
    - T5 测试：web-bridge-tools.test.ts mock 补 WebContentsView；新增新工具定义测试；webbridge-backend-slice 门面集成验证全过 ✅
- [x] **元素定位收敛为纯 AX ref** ✅
    - BrowserEngineBackend.click/type 仅接受 AX ref（Observe 的 r{g}-{i}），放弃 element_id/selector DOM 定位
    - WebBridgeClick/Type 工具描述改为引导用 Observe 的 ref；上传 setFileInput 仍用 CSS selector（合法例外）
- [x] **站点信任权限（trustedWebBridgeHosts）** ✅
    - agent-permission-service 新增 noteWebBridgeHost / trustWebBridgeHost / trustCurrentWebBridgeHost / isWebBridgeSiteTrusted
    - WebBridgeDownload 在当前站点被信任时自动放行；Upload 永远逐次确认；导航/点击/输入保持工具白名单
    - web-bridge-service rememberSnapshot 时 noteWebBridgeHost
    - 新增 2 个站点信任单测（trusted 放行 / untrusted 逐次确认），15 权限测试全过
- [ ] **browser-script-policy（受控 DomAction + ExecuteJavaScript）** — 待用户决策，默认不自动接入：
    - `BrowserDomAction`（CSS selector 定位）与「纯 AX ref」决策冲突 → 建议不做。
    - `BrowserExecuteJavaScript` 对爬虫有补充价值，但属"任意 JS"能力、有新安全边界，是**新功能演进**而非收尾。若要则单独立项。
    - 当前引擎已有 `evaluateForTest`（仅测试用，未暴露为工具），可作其雏形。
- [x] **沉淀 Skill**：reference-refactor-workflow 已安装到 `~/.gravitas/agent-workspaces/project/skills/`（SKILL.md + evals/evals.json 3 例）✅

## 累计验证状态（本轮）
- 53 单测全过（browser-engine 33 / web-bridge-tools 5 / permission 15）
- 全仓库 typecheck exit 0
- 门面真机 slice（webbridge-backend-slice）全过
- 无残留进程

## 已实现文件（apps/electron/src/main/lib/browser-engine/）
- `browser-cdp.ts`：CDP 命令封装（超时 Promise.race + 中止 + recoverDebugger 重连）
- `browser-policy.ts`：URL 规范化/校验（loopback / 缺省补 https），无 Electron 依赖可单测
- `browser-observation-policy.ts`：AX 候选收集 + 可交互优先（240=160交互+80上下文）
- `browser-key-policy.ts`：Press 导航键（windowsVirtualKeyCode 语义）+ 文本插入
- `browser-controller.ts`：会话/标签生命周期 + AX observe + CDP 真实输入，enqueueTab 防交错
- `apps/electron/scripts/browser-engine-slice.ts`：垂直切片验证脚本
- npm scripts：`build:slice`（打包）+ `slice`（打包并 electron 运行）

## 关键踩坑记录（重要，供后续接入参考）
1. **enqueueTab 死锁**：fill/click/press/navigate 在 enqueueTab 的 task 内再调用 `this.observe()`（也会 enqueueTab），形成同 commandTail 自我等待死锁。修复：task 内直接用 `observeInternal`（不发队列）。
2. **可编辑判定**：input 的 editable 不能只看 AX property，role 为 textbox/searchbox 即视为可编辑（对标 Proma `isEditableAxNode`）。
3. **ref 代际失效**：每次 observeInternal 会使 generation++、旧 ref 全失效；fill/click 之间必须重新 observe。这是设计行为。
4. **electron 前台执行**：本工具环境对 electron GUI 前台运行会误报 "Command failed"。用 `nohup ... & disown` + 单独 cat 日志捕获；且必须确保只跑一例、端口唯一（多例会竞争 startServer 端口挂起）。

## 下一步（尚未做）
- [ ] 清理 slice 脚本中的诊断 console.log（保留 ok 进度即可）
- [ ] 为纯逻辑模块（browser-policy / observation-policy / key-policy）补 bun 单测（对标项目现有 *.test.ts 风格）
- [ ] 接入现有 web-bridge-tools / web-bridge-service（改 backend 为 browser-engine 驱动）——按 main 计划 S5/S4
- [ ] 新增站点信任权限（trustedWebBridgeHosts）到 agent-permission-service
- [ ] 新增多标签工具（WebBridgeNewTab/ListTabs/SelectTab/CloseTab）到工具层
- [ ] 引入 browser-script-policy（受控 DomAction + ExecuteJavaScript）

## 决策记录
- 目标仓库：/Users/chaihao/LLM/proma-mit = Gravitas
- 垂直切片：独立 browser-engine 模块，不动现有 web-bridge-service
- 权限：后续接入站点信任（对标 ma-proma trustedWebBridgeHosts）
- CDP 引擎：Electron webContents.debugger
