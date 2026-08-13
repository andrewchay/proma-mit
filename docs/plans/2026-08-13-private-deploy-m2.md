# M2 Web 工作台补全实施计划

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

## 执行进度（全部完成 ✅ 2026-08-13）
- [x] **M2.1** nav 增加 health/registry 入口 + cookie 认证适配 + 视图函数（commit `beeeb9aa`）
- [x] **M2.2** 会话管理：rename/archive/cancel 按钮（复用服务端 updateSession/cancelTask）
- [x] **M2.3** 端到端验收：真实 server health 返回贵慢重准、registry PUT+GET 正常、会话 API 可达；server 119 pass/0 fail

## 工程教训（重要）
`dashboard.ts` 是超长**反引号模板字符串**（单文件内嵌 HTML+JS）。用 Edit 工具增量修改该文件时，Edit 的 old_string 匹配极易在超长行上出错，导致模板字符串内的 `</script></html>` 被重复/误插（健康文件应收尾 1 次）。**正确做法：用 Python/Bash 做行级精确插入**（锚定 `loadSamples`/`refresh()` 等唯一行），每次改动后验证 `grep -c '/script><'` == 1。此经验已记入 `agentic-os-handoff.md` §2.7。

**Goal:** 让私有部署的 Web 工作台（`/agent/ui`，单文件无构建 dashboard）补全 health/registry 视图 + 会话管理（改标题/归档）、并适配 M1 引入的 cookie 认证——使浏览器登录后无需手动填 Bearer token 即可操作全部核心能力。

**Architecture:** 对 `apps/server/src/dashboard.ts` 的单 HTML 做**追加式增强**（不重写、保持无构建依赖）：
- nav 新增「健康度」「Agent 注册」两个入口
- `loadHealth()`（GET /agent/health）、`loadRegistry()`（GET /agent/registry）
- 会话条目加「改标题」「归档」「取消执行」三个操作：`PATCH /agent/sessions/{id}`（rename/archive）、`DELETE /agent/sessions/{id}`（cancelTask，服务端已有）
- 认证适配：cookie 会话（M1）同源自动携带，去掉 dashboard 对 Bearer token 的强依赖（保留 token 输入框仅供 API 场景）

**Tech Stack:** 单 HTML + vanilla JS（无构建）；复用服务端已有 API（health/registry/cancelTask/updateSession，均已验证存在）。

---

## 依赖与现状（已核实）

- `GET /agent/health` → `{health:{cost,latency,volume,accuracy,budget}}`
- `GET /agent/registry` → `{cards:[{cardId,source,name,role,capabilities,...}]}`（operator/admin）
- `PATCH /agent/sessions/{id}` → 改 title/archived（`store.updateSession`，返回 `{session}`）
- `DELETE /agent/sessions/{id}` → `taskRunner.cancelTask(taskId)`（服务端取消已存在）
- `GET /agent/sessions` → 会话列表（含 title/sessionId）
- dashboard 现有 `headers()` 依赖 `#token` 输入框的 Bearer；M1 后应优先 cookie（同源 fetch 自动带）

## Task M2.1：nav 增加 health/registry 入口 + cookie 认证适配

**Files:**
- Modify: `apps/server/src/dashboard.ts`

**Step 1（在现有 npm 内 HTML 的 nav 中追加）：**
在 `<nav>...</nav>` 中 `评估数据集` 按钮后追加：
```html
<button onclick="loadHealth()">健康度</button><button onclick="loadRegistry()">Agent 注册</button>
```

**Step 2（cookie 认证适配）：** 修改 `headers()`：
```js
// cookie 会话优先（同源自动携带）；#token 仅作手动 API 认证兜底
const headers=(omitToken=false)=>{const t=$('#token')?.value.trim();const h={'content-type':'application/json'};if(t&&!omitToken)h.authorization='Bearer '+t;return h};
```
登录后同源 fetch 自动带 cookie → `auth` resolver 的 cookie 分支识别 → 无需 token。

**Step 3（新增两个视图函数，追加到 script）：**
```js
// —— 健康度（贵慢重准） ——
async function loadHealth(){setTab('健康度');try{const h=JSON.parse(await api('/agent/health')).health;const g=x=>x==='good'?'#d7ff5f':x==='warn'?'#ff875f':'#ff5f5f';let html='<div class="card"><h2>健康度 · 贵慢重准</h2>'
+'<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">'
+'<div><b style="color:'+g(h.latency.grade)+'">慢 · '+h.latency.p95Ms+'ms</b><span class="muted"> target '+h.latency.targetMs+'ms</span></div>'
+'<div><b style="color:'+g(h.accuracy.grade)+'">准 · '+(h.accuracy.successRate*100).toFixed(1)+'%</b><span class="muted"> 成功率</span></div>'
+'<div><b>贵 · $'+(h.cost.monthlyMicroUsd/1e6).toFixed(2)+'</b><span class="muted"> 本月</span></div>'
+'<div><b>重 · '+h.volume.totalRuns+' runs / '+(h.volume.totalTokens/1e3).toFixed(1)+'k tokens</b></div>'
+'</div>';if(h.budget.monthlyLimitMicroUsd!=null)html+='<div style="margin-top:12px"><span class="muted">预算已用 </span><b>'+(h.budget.usedPercent)+'%</b><div style="background:#3b403b;height:8px;border-radius:4px;margin-top:4px"><div style="background:'+(h.budget.usedPercent>=80?'#ff875f':'#d7ff5f')+';height:8px;border-radius:4px;width:'+Math.min(h.budget.usedPercent,100)+'%"></div></div></div>';viz(html)}catch(e){viz('<div class="card"><h2>健康度</h2>'+es(e)+'</div>')}}
// —— Agent 注册表 ——
async function loadRegistry(){setTab('Agent 注册');try{const r=JSON.parse(await api('/agent/registry'));const cards=r.cards||[];const list=cards.map(c=>'<div class="item"><b>'+es(c.name)+'</b> · '+es(c.role)+'<br><span class="muted">'+es(c.cardId)+' · '+es(c.source)+' · caps: '+es(c.capabilities?.join(','))+'</span></div>').join('')||'<span class="muted">暂无 Agent 注册</span>';viz('<div class="card"><h2>Agent 注册表（'+cards.length+'）</h2><div class="list">'+list+'</div></div>')}catch(e){viz('<div class="card"><h2>Agent 注册</h2>'+es(e)+'</div>')}}
```

**Step 4:** 打开 `/agent/ui`（登录后 cookie 认证）验证 nav 出现两按钮、点击分别显示健康度/注册表。
**Step 5:** 提交 `apps/server/src/dashboard.ts`。

## Task M2.2：会话管理（改标题/归档/取消执行）

**Files:**
- Modify: `apps/server/src/dashboard.ts`

**Step 1（新增会话操作函数）：**
```js
async function renameSession(id){const t=prompt('新标题：');if(!t)return;try{await api('/agent/sessions/'+encodeURIComponent(id),{method:'PATCH',body:JSON.stringify({title:t})});refresh()}catch(e){show(String(e))}}
async function archiveSession(id){try{await api('/agent/sessions/'+encodeURIComponent(id),{method:'PATCH',body:JSON.stringify({archived:true})});refresh()}catch(e){show(String(e))}}
async function cancelSession(id){if(!confirm('取消该会话的进行中任务？'))return;try{await api('/agent/sessions/'+encodeURIComponent(id),{method:'DELETE'});show('已触发取消');refresh()}catch(e){show(String(e))}}
```

**Step 2（renderSessions 会话条目加操作按钮）：**
```js
function renderSessions(items){$('#sessions').innerHTML=items.filter(x=>!x.archived).map(x=>'<div class="item" onclick="pick('+JSON.stringify(x.sessionId).replaceAll('"','&quot;')+')">'+escape(x.title)+'<br><span class="muted">'+escape(x.sessionId)+'</span><div style="margin-top:6px"><button class="mini" onclick="event.stopPropagation();renameSession(\''+x.sessionId+'\')">改名</button> <button class="mini" onclick="event.stopPropagation();archiveSession(\''+x.sessionId+'\')">归档</button> <button class="mini" onclick="event.stopPropagation();cancelSession(\''+x.sessionId+'\')">取消</button></div></div>').join('')||'<span class="muted">暂无会话</span>'}
```
（在 CSS 中补 `.mini{background:#30352f;color:var(--acid);border:0;padding:4px 8px;border-radius:4px;font:inherit;cursor:pointer;margin-right:4px}`）

**Step 3:** 登录后建会话，验证改名/归档/取消按钮可用。
**Step 4:** 提交。

## Task M2.3：端到端验收

**Step 1:** 真实 server（local 模式）起：登录 → `/agent/ui` → 点「健康度」显示贵慢重准 → 点「Agent 注册」显示注册表（可先 upsert 一条卡片）→ 建会话 → 改名/归档 → DELETE 取消。
**Step 2:** 回归：server 全量 `bun test` 无回归（dashboard 是纯 HTML 字符串，不影响 server 逻辑，但确认无构建错误）。
**Step 3:** 更新 `docs/private-deployment-minimal.md` M2 勾选、`docs/plans/2026-08-13-private-deploy-m2.md` 进度。

## 排除
- 不做完整会话分页/搜索（单文件 dashboard 保持精简，P6-1 完整版留 SaaS 轨道）。
- 不对 dashboard.ts 做构建工具化（维持无构建内嵌，降低部署复杂度）。
- 不新增服务端 API（cancelTask/updateSession/health/registry 全部已存在）。
