/**
 * Companion 移动端单页
 *
 * 单文件 HTML（内联 CSS/JS，vanilla，无构建步骤），由 companion-server 直接返回；
 * 页面本身不含任何数据，所有数据经认证 API 获取。
 *
 * 视图：配对 → 会话列表（按工作区分组、按更新时间排序、运行中指示）→ 会话详情
 * （SDK 同源历史 + SSE 实时流 + 权限/AskUser 卡片 + 活动指示）。
 * 横屏（宽度 ≥700px）呈现左右双栏（列表 | 会话），尽量还原桌面布局。
 * token 存 localStorage；任何 401 都会清除 token 回到配对视图。
 */

import { COMPANION_MARKDOWN_JS } from './companion-markdown-js'

/** Service Worker 源码（Web Push；需 HTTPS 安全上下文） */
export function getCompanionServiceWorkerJs(): string {
  return `
self.addEventListener('push', function (event) {
  var data = {};
  try { data = event.data.json(); } catch (e) { /* 忽略非 JSON 载荷 */ }
  event.waitUntil(self.registration.showNotification(data.title || 'Gravitas', {
    body: data.body || '',
    tag: 'companion',
    renotify: true,
    data: { url: data.url || '/companion' },
  }));
});

self.addEventListener('notificationclick', function (event) {
  event.notification.close();
  var url = (event.notification.data && event.notification.data.url) || '/companion';
  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (list) {
    for (var i = 0; i < list.length; i++) {
      if (list[i].url.indexOf('/companion') !== -1) return list[i].focus();
    }
    return self.clients.openWindow(url);
  }));
});
`
}

export function getCompanionPageHtml(): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>Gravitas Companion</title>
<link rel="manifest" href="/manifest.webmanifest">
<link rel="apple-touch-icon" href="/icon-192.png">
<meta name="theme-color" content="#0d1117">
<style>
:root { --bg:#0d1117; --card:#161b22; --card2:#1c2330; --text:#e6edf3; --muted:#8b949e; --accent:#4c8dff; --green:#3fb950; --red:#f85149; --border:#2d333b; }
* { box-sizing:border-box; margin:0; padding:0; }
html, body { height:100%; }
body { font-family:-apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif; background:var(--bg); color:var(--text); font-size:15px; overflow:hidden; }
#layout { display:flex; height:100vh; max-width:1200px; margin:0 auto; }
.pane { display:none; flex-direction:column; min-width:0; flex:1; padding:14px; overflow:hidden; }
.pane.active { display:flex; }

/* ---- 竖屏：单栏 ---- */
@media (max-width: 699px), (orientation: portrait) {
  #layout { display:block; }
  .pane { height:100vh; }
}

/* ---- 横屏：双栏（还原桌面布局） ---- */
@media (min-width: 700px) and (orientation: landscape) {
  #layout { display:flex; }
  #pane-list { display:flex; flex:0 0 300px; border-right:1px solid var(--border); }
  #pane-chat { display:flex; flex:1; }
  #pane-pair { display:none; }
  #pane-pair.active { display:flex; position:absolute; inset:0; background:var(--bg); z-index:10; }
  .back { display:none; }
}

h1 { font-size:18px; margin-bottom:2px; }
.sub { color:var(--muted); font-size:13px; }
.card { background:var(--card); border-radius:12px; padding:16px; margin-top:12px; box-shadow:0 1px 4px rgba(0,0,0,.4); }
input, textarea { width:100%; background:var(--card2); color:var(--text); border:1px solid var(--border); border-radius:8px; padding:12px; font-size:16px; outline:none; }
input:focus, textarea:focus { border-color:var(--accent); }
.btn { display:inline-block; background:var(--accent); color:#fff; border:none; border-radius:8px; padding:12px 18px; font-size:15px; font-weight:600; cursor:pointer; margin-top:12px; width:100%; }
.btn.secondary { background:var(--card2); color:var(--text); border:1px solid var(--border); }
.btn.deny { background:var(--red); }
.btn.allow { background:var(--green); }
.btn.small { width:auto; padding:6px 12px; font-size:13px; margin-top:0; }
.btn:disabled { opacity:.5; cursor:default; }

/* 会话列表：工作区分组 */
#session-scroll { flex:1; overflow-y:auto; min-height:0; }
.ws-header { color:var(--muted); font-size:12px; font-weight:600; text-transform:uppercase; letter-spacing:.04em; margin:16px 4px 4px; }
.ws-header:first-child { margin-top:4px; }
.session-item { background:var(--card); border-radius:10px; padding:12px 14px; margin-top:8px; cursor:pointer; display:flex; align-items:center; gap:8px; }
.session-item:hover { background:var(--card2); }
.session-item.current { outline:1px solid var(--accent); }
.session-item .dot { width:8px; height:8px; border-radius:50%; background:var(--muted); flex-shrink:0; }
.session-item .dot.running { background:var(--green); animation:pulse 1.2s infinite; }
@keyframes pulse { 50% { opacity:.35; } }
.session-item .title { flex:1; min-width:0; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.session-item .time { color:var(--muted); font-size:12px; flex-shrink:0; }
.badge { background:var(--red); color:#fff; border-radius:10px; padding:2px 8px; font-size:12px; font-weight:700; }
.header { display:flex; justify-content:space-between; align-items:center; padding-bottom:8px; }

/* 会话详情 */
.topbar { display:flex; align-items:center; gap:10px; padding-bottom:8px; border-bottom:1px solid var(--border); }
.back { background:none; border:none; color:var(--accent); font-size:22px; cursor:pointer; padding:0 4px; }
#run-indicator { color:var(--green); font-size:12px; white-space:nowrap; }
#run-indicator .dot { display:inline-block; width:7px; height:7px; border-radius:50%; background:var(--green); animation:pulse 1s infinite; margin-right:4px; }
#messages { flex:1; overflow-y:auto; padding:8px 0; min-height:0; }
.msg { margin-top:10px; max-width:88%; }
.msg.user { margin-left:auto; }
.msg .bubble { background:var(--card); border-radius:12px; padding:10px 14px; white-space:pre-wrap; word-break:break-word; }
.msg.user .bubble { background:var(--accent); }
.msg.assistant .bubble { background:var(--card); }
.msg .bubble p { margin:0 0 8px; } .msg .bubble p:last-child { margin-bottom:0; }
.msg .bubble h1,.msg .bubble h2,.msg .bubble h3,.msg .bubble h4 { font-size:15px; margin:10px 0 6px; }
.msg .bubble ul,.msg .bubble ol { margin:4px 0 8px; padding-left:20px; }
.msg .bubble li { margin:2px 0; }
.msg .bubble blockquote { border-left:3px solid var(--border); padding:2px 10px; color:var(--muted); margin:6px 0; }
.msg .bubble code { background:var(--card2); border-radius:4px; padding:1px 5px; font-family:ui-monospace,monospace; font-size:13px; }
.msg .bubble pre.md-code { background:#0a0e14; border:1px solid var(--border); border-radius:8px; padding:10px 12px; overflow-x:auto; margin:8px 0; }
.msg .bubble pre.md-code code { background:none; padding:0; white-space:pre; }
.msg .bubble a { color:var(--accent); }
.msg .bubble hr { border:none; border-top:1px solid var(--border); margin:10px 0; }
.msg.tool .bubble { background:var(--card2); color:var(--muted); font-size:13px; }
.req-card { background:var(--card); border:1px solid var(--accent); border-radius:12px; padding:14px; margin-top:12px; }
.req-card h3 { font-size:15px; margin-bottom:6px; }
.req-card .desc { color:var(--muted); font-size:13px; margin-bottom:10px; white-space:pre-wrap; word-break:break-word; }
.req-card .cmd { background:var(--card2); border-radius:8px; padding:8px; font-family:ui-monospace,monospace; font-size:12px; margin-bottom:10px; white-space:pre-wrap; word-break:break-all; }
.req-actions { display:flex; gap:10px; }
.req-actions .btn { margin-top:0; }
.opt-btn { display:block; width:100%; text-align:left; background:var(--card2); color:var(--text); border:1px solid var(--border); border-radius:8px; padding:10px 12px; margin-top:8px; font-size:14px; cursor:pointer; }
.opt-btn:disabled { opacity:.5; }
#inputbar { display:flex; gap:8px; padding-top:10px; }
#inputbar textarea { flex:1; resize:none; height:44px; }
.empty { color:var(--muted); text-align:center; margin-top:40px; }
.err { color:var(--red); font-size:13px; margin-top:8px; min-height:16px; }
</style>
</head>
<body>
<div id="layout">

  <div id="pane-pair" class="pane active">
    <h1>Gravitas Companion</h1>
    <p class="sub">在桌面端 设置 → 连接与同步 → 远程访问 生成配对码</p>
    <div class="card">
      <input id="pair-code" inputmode="numeric" maxlength="6" placeholder="6 位配对码" autocomplete="one-time-code">
      <button class="btn" id="pair-btn">配对</button>
      <div class="err" id="pair-err"></div>
    </div>
  </div>

  <div id="pane-list" class="pane">
    <div class="header">
      <div><h1>会话</h1><span class="sub" id="list-status"></span></div>
      <div style="display:flex;align-items:center;gap:8px">
        <span id="pending-badge"></span>
        <button class="btn secondary small" id="refresh-btn">刷新</button>
      </div>
    </div>
    <div id="session-scroll"></div>
    <div id="push-entry" style="display:none;align-items:center;gap:10px;padding-top:10px;border-top:1px solid var(--border)">
      <button class="btn secondary small" id="push-btn">启用推送通知</button>
      <span class="sub" id="push-status"></span>
    </div>
  </div>

  <div id="pane-chat" class="pane">
    <div class="topbar">
      <button class="back" id="back-btn">‹</button>
      <div style="flex:1;min-width:0"><h1 id="chat-title" style="font-size:16px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">会话</h1></div>
      <span id="run-indicator" style="display:none"><span class="dot"></span>运行中</span>
      <button class="btn secondary small" id="stop-btn">停止</button>
    </div>
    <div id="messages"></div>
    <div id="requests"></div>
    <div id="inputbar">
      <textarea id="chat-input" placeholder="发送消息…"></textarea>
      <button class="btn" style="width:auto" id="send-btn">发送</button>
    </div>
    <div class="err" id="chat-err"></div>
  </div>

</div>
<script>
${COMPANION_MARKDOWN_JS}
</script>
<script>
(function () {
  'use strict';
  var TOKEN_KEY = 'companion-token';
  var state = {
    token: localStorage.getItem(TOKEN_KEY) || '',
    currentSession: null,
    es: null,
    lastEventId: '0',
    workspaces: [],        // [{id,name}] 按更新时间排序
    lastActivityAt: 0,     // 最近一次收到流式事件的时间（活动指示用）
  };

  function $(id) { return document.getElementById(id); }
  function show(name) {
    ['pair', 'list', 'chat'].forEach(function (v) { $('pane-' + v).classList.toggle('active', v === name); });
  }
  // 横屏下列表与聊天双栏并存：切换到聊天时不隐藏列表
  function isLandscape() { return window.matchMedia('(min-width:700px) and (orientation:landscape)').matches; }

  function api(method, path, body) {
    return fetch(path, {
      method: method,
      headers: Object.assign({ 'Content-Type': 'application/json' }, state.token ? { Authorization: 'Bearer ' + state.token } : {}),
      body: body ? JSON.stringify(body) : undefined,
    }).then(function (res) {
      if (res.status === 401 && path !== '/api/pair') { logout(); throw new Error('登录已失效，请重新配对'); }
      return res;
    });
  }

  function logout() {
    state.token = '';
    localStorage.removeItem(TOKEN_KEY);
    closeStream();
    show('pair');
  }
  function closeStream() { if (state.es) { state.es.close(); state.es = null; } }

  function relativeTime(ts) {
    if (!ts) return '';
    var diff = Date.now() - ts;
    if (diff < 60000) return '刚刚';
    if (diff < 3600000) return Math.floor(diff / 60000) + ' 分钟前';
    if (diff < 86400000) return Math.floor(diff / 3600000) + ' 小时前';
    if (diff < 172800000) return '昨天';
    return Math.floor(diff / 86400000) + ' 天前';
  }

  // ---- 配对 ----
  $('pair-btn').onclick = function () {
    var code = $('pair-code').value.trim();
    $('pair-err').textContent = '';
    api('POST', '/api/pair', { code: code }).then(function (res) {
      if (!res.ok) return res.json().then(function (e) { throw new Error(e.error || '配对失败'); });
      return res.json();
    }).then(function (data) {
      state.token = data.token;
      localStorage.setItem(TOKEN_KEY, data.token);
      loadWorkspaces().then(loadSessions);
    }).catch(function (e) { $('pair-err').textContent = e.message; });
  };

  // ---- 工作区与 会话列表（分组 + 排序） ----
  function loadWorkspaces() {
    return api('GET', '/api/workspaces').then(function (res) { return res.json(); }).then(function (data) {
      state.workspaces = data.workspaces || [];
    }).catch(function () { state.workspaces = []; });
  }

  /** 复刻桌面侧栏排序：工作区按「组内最近会话时间」降序，无会话回退工作区自身时间（LeftSidebar 同规则） */
  function orderGroupKeys(groups) {
    var lastActivity = {};
    Object.keys(groups).forEach(function (key) {
      var latest = 0;
      groups[key].forEach(function (s) { if ((s.updatedAt || 0) > latest) latest = s.updatedAt || 0; });
      lastActivity[key] = latest;
    });
    var keys = Object.keys(groups).slice();
    keys.sort(function (a, b) {
      var aWs = state.workspaces.filter(function (w) { return w.id === a; })[0];
      var bWs = state.workspaces.filter(function (w) { return w.id === b; })[0];
      var aTime = lastActivity[a] || (aWs && aWs.updatedAt) || 0;
      var bTime = lastActivity[b] || (bWs && bWs.updatedAt) || 0;
      if (aTime !== bTime) return bTime - aTime;
      return ((bWs && bWs.updatedAt) || 0) - ((aWs && aWs.updatedAt) || 0);
    });
    return keys;
  }

  function loadSessions() {
    show('list');
    api('GET', '/api/sessions').then(function (res) { return res.json(); }).then(function (data) {
      var sessions = (data.sessions || []).slice().sort(function (a, b) { return (b.updatedAt || 0) - (a.updatedAt || 0); });
      renderSessionGroups(sessions);
      refreshPendingBadge();
    }).catch(function (e) { $('list-status').textContent = e.message; });
  }

  function renderSessionGroups(sessions) {
    var box = $('session-scroll');
    box.innerHTML = '';
    $('list-status').textContent = sessions.length ? sessions.length + ' 个会话' : '暂无会话';

    // 未归组会话收集到 'none'；组顺序按工作区列表（更新时间新→旧），未命名工作区排最前
    var groups = {};
    sessions.forEach(function (s) {
      var key = s.workspaceId || 'none';
      (groups[key] = groups[key] || []).push(s);
    });
    // 组顺序复刻桌面侧栏：按组内最近会话时间降序；'none' 组排最前便于看到未归组会话
    var orderedKeys = orderGroupKeys(groups);
    if (groups.none) {
      orderedKeys = ['none'].concat(orderedKeys.filter(function (k) { return k !== 'none'; }));
    }

    orderedKeys.forEach(function (key) {
      var ws = state.workspaces.filter(function (w) { return w.id === key; })[0];
      var header = document.createElement('div');
      header.className = 'ws-header';
      header.textContent = (key === 'none' ? '未分组' : (ws ? ws.name : '未知工作区')) + ' · ' + groups[key].length;
      box.appendChild(header);

      groups[key].forEach(function (s) {
        var item = document.createElement('div');
        item.className = 'session-item' + (s.id === state.currentSession ? ' current' : '');
        var dot = document.createElement('span');
        dot.className = 'dot' + (s.running ? ' running' : '');
        var title = document.createElement('span');
        title.className = 'title';
        title.textContent = s.title || s.id;
        var time = document.createElement('span');
        time.className = 'time';
        time.textContent = relativeTime(s.updatedAt);
        item.appendChild(dot); item.appendChild(title); item.appendChild(time);
        item.onclick = function () { openChat(s.id, s.title || s.id); };
        box.appendChild(item);
      });
    });
  }

  $('refresh-btn').onclick = function () { loadSessions(); };

  // ---- 会话详情 ----
  function openChat(sessionId, title) {
    state.currentSession = sessionId;
    $('chat-title').textContent = title;
    $('messages').innerHTML = '';
    $('requests').innerHTML = '';
    $('chat-err').textContent = '';
    $('run-indicator').style.display = 'none';
    if (isLandscape()) { show('chat'); $('pane-list').classList.add('active'); }
    else { show('chat'); }
    closeStream();
    api('GET', '/api/sessions/' + encodeURIComponent(sessionId) + '/messages').then(function (res) { return res.json(); }).then(function (data) {
      (data.messages || []).forEach(function (m) {
        if (m.role === 'tool') appendMessage('tool', '⚙ ' + m.text);
        else appendMessage(m.role, m.text);
      });
      $('messages').scrollTop = $('messages').scrollHeight;
      openStream(sessionId);
      loadSessions(); // 刷新列表的高亮与运行状态（横屏下侧栏可见）
    }).catch(function (e) { $('chat-err').textContent = e.message; });
  }

  function openStream(sessionId) {
    var url = '/api/events?token=' + encodeURIComponent(state.token) + '&lastEventId=' + state.lastEventId;
    state.es = new EventSource(url);
    state.es.addEventListener('agent-stream', function (ev) {
      try { handleEnvelope(JSON.parse(ev.data)); } catch (e) { /* 忽略坏帧 */ }
    });
    state.es.onerror = function () { /* EventSource 自动重连 */ };
  }

  /** 活动指示：4 秒内有事件即显示“运行中” */
  function touchActivity() {
    state.lastActivityAt = Date.now();
    $('run-indicator').style.display = 'inline';
  }
  setInterval(function () {
    if (Date.now() - state.lastActivityAt > 4000) $('run-indicator').style.display = 'none';
  }, 1000);

  function handleEnvelope(envelope) {
    state.lastEventId = envelope.id || state.lastEventId;
    if (envelope.sessionId !== state.currentSession) return;
    var payload = envelope.payload;
    if (payload.kind === 'proma_event') {
      flushStreaming();
      var type = payload.event.type;
      if (type === 'permission_request') showPermissionCard(payload.event.request);
      if (type === 'ask_user_request') showAskUserCard(payload.event.request);
      if (type === 'permission_resolved') removeCard('perm-' + payload.event.requestId);
      if (type === 'ask_user_resolved') removeCard('ask-' + payload.event.requestId);
      if (type === 'goal_updated') return;
      touchActivity();
    }
    if (payload.kind === 'agent_event') {
      touchActivity();
      var e = payload.event;
      if (e.type === 'text_delta' || e.type === 'text_complete') {
        appendStreamingText(e.text);
      } else {
        flushStreaming();
        if (e.type === 'tool_start') appendMessage('tool', '⚙ ' + (e.displayName || e.toolName));
        if (e.type === 'tool_result' && e.isError) appendMessage('tool', '⚠ 工具出错: ' + String(e.result).slice(0, 300));
      }
    }
  }

  var streamBuffer = '';
  var lastMdRenderAt = 0;
  function appendStreamingText(text) {
    streamBuffer += text;
    var last = $('messages').lastChild;
    if (!last || last.dataset.streaming !== '1') {
      var div = document.createElement('div');
      div.className = 'msg assistant';
      div.dataset.streaming = '1';
      div.innerHTML = '<div class="bubble"></div>';
      $('messages').appendChild(div);
      last = div;
    }
    // Markdown 重新渲染节流（150ms），避免长输出的 O(n²) 重复解析
    var now = Date.now();
    if (now - lastMdRenderAt > 150) {
      lastMdRenderAt = now;
      last.querySelector('.bubble').innerHTML = renderMarkdown(streamBuffer);
      $('messages').scrollTop = $('messages').scrollHeight;
    }
  }

  /** 流式结束/切换事件时冲刷未渲染的 Markdown 缓冲 */
  function flushStreaming() {
    if (!streamBuffer) return;
    var last = $('messages').lastChild;
    if (last && last.dataset.streaming === '1') {
      last.querySelector('.bubble').innerHTML = renderMarkdown(streamBuffer);
      streamBuffer = '';
      last.dataset.streaming = '0';
    }
  }

  function appendMessage(role, content) {
    if (!content) return;
    streamBuffer = '';
    var div = document.createElement('div');
    div.className = 'msg ' + role;
    div.innerHTML = '<div class="bubble"></div>';
    var bubble = div.querySelector('.bubble');
    if (role === 'assistant') bubble.innerHTML = renderMarkdown(content);
    else bubble.textContent = content;
    $('messages').appendChild(div);
    $('messages').scrollTop = $('messages').scrollHeight;
  }

  // ---- 待确认徽标 ----
  function refreshPendingBadge() {
    api('GET', '/api/pending').then(function (res) { return res.json(); }).then(function (data) {
      var n = data.permissions.length + data.askUsers.length;
      $('pending-badge').innerHTML = n ? '<span class="badge">' + n + ' 待确认</span>' : '';
    }).catch(function () { /* 静默 */ });
  }

  // ---- 权限 / AskUser 卡片 ----
  function showPermissionCard(req) {
    if ($('perm-' + req.requestId)) return;
    var div = document.createElement('div');
    div.className = 'req-card';
    div.id = 'perm-' + req.requestId;
    var html = '<h3>🔑 权限请求：' + escapeHtml(req.toolName || '') + '</h3>'
      + '<div class="desc">' + escapeHtml(req.description || '') + '</div>';
    if (req.command) html += '<div class="cmd">' + escapeHtml(req.command) + '</div>';
    html += '<div class="req-actions">'
      + '<button class="btn deny" data-act="deny">拒绝</button>'
      + '<button class="btn allow" data-act="allow">允许（仅本次）</button>'
      + '</div>';
    div.innerHTML = html;
    div.querySelectorAll('button').forEach(function (btn) {
      btn.onclick = function () {
        btn.disabled = true;
        api('POST', '/api/permission/' + encodeURIComponent(req.requestId), { behavior: btn.dataset.act })
          .then(function (res) {
            if (!res.ok) return res.json().then(function (e) { throw new Error(e.error || '应答失败'); });
            removeCard('perm-' + req.requestId);
          })
          .catch(function (e) { $('chat-err').textContent = e.message; btn.disabled = false; });
      };
    });
    $('requests').appendChild(div);
  }

  function showAskUserCard(req) {
    if ($('ask-' + req.requestId)) return;
    var div = document.createElement('div');
    div.className = 'req-card';
    div.id = 'ask-' + req.requestId;
    var questions = (req.toolInput && req.toolInput.questions) || [];
    var firstQ = questions[0] || {};
    var html = '<h3>❓ ' + escapeHtml(firstQ.question || 'Agent 需要你的回答') + '</h3>';
    (firstQ.options || []).forEach(function (opt) {
      html += '<button class="opt-btn" data-label="' + escapeHtml(opt.label || '') + '">' + escapeHtml(opt.label || '') + (opt.description ? '<br><span style="color:var(--muted);font-size:12px">' + escapeHtml(opt.description) + '</span>' : '') + '</button>';
    });
    div.innerHTML = html;
    div.querySelectorAll('.opt-btn').forEach(function (btn) {
      btn.onclick = function () {
        var answers = {};
        questions.forEach(function (q) { answers[q.header || q.question || 'answer'] = btn.dataset.label; });
        btn.disabled = true;
        api('POST', '/api/ask-user/' + encodeURIComponent(req.requestId), { answers: answers })
          .then(function (res) {
            if (!res.ok) return res.json().then(function (e) { throw new Error(e.error || '应答失败'); });
            removeCard('ask-' + req.requestId);
          })
          .catch(function (e) { $('chat-err').textContent = e.message; btn.disabled = false; });
      };
    });
    $('requests').appendChild(div);
  }

  function removeCard(id) {
    var card = $(id);
    if (card) card.remove();
    refreshPendingBadge();
  }

  // ---- 发送 / 停止 / 返回 ----
  $('send-btn').onclick = function () {
    var text = $('chat-input').value.trim();
    if (!text || !state.currentSession) return;
    $('chat-err').textContent = '';
    api('POST', '/api/sessions/' + encodeURIComponent(state.currentSession) + '/messages', { text: text }).then(function (res) {
      if (!res.ok) return res.json().then(function (e) { throw new Error(e.error || '发送失败'); });
      appendMessage('user', text);
      $('chat-input').value = '';
    }).catch(function (e) { $('chat-err').textContent = e.message; });
  };
  $('stop-btn').onclick = function () {
    if (!state.currentSession) return;
    api('POST', '/api/sessions/' + encodeURIComponent(state.currentSession) + '/stop', {}).then(loadSessions).catch(function () {});
  };
  $('back-btn').onclick = function () { closeStream(); state.currentSession = null; loadSessions(); };

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  // ---- Web Push（需 HTTPS 安全上下文；HTTP 局域网下自动隐藏） ----
  function urlBase64ToUint8Array(base64) {
    var padding = '='.repeat((4 - (base64.length % 4)) % 4);
    var base64Str = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/');
    var raw = atob(base64Str);
    var arr = new Uint8Array(raw.length);
    for (var i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
    return arr;
  }

  async function enablePush() {
    $('push-status').textContent = '正在注册…';
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
      $('push-status').textContent = '此浏览器不支持推送';
      return;
    }
    try {
      var permission = await Notification.requestPermission();
      if (permission !== 'granted') { $('push-status').textContent = '通知权限未授予'; return; }
      var reg = await navigator.serviceWorker.register('/sw.js');
      await navigator.serviceWorker.ready;
      var vapidRes = await api('GET', '/api/push/vapid');
      var vapid = (await vapidRes.json()).publicKey;
      var sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(vapid) });
      var res = await api('POST', '/api/push/subscribe', { subscription: sub.toJSON() });
      if (!res.ok) throw new Error('订阅登记失败');
      localStorage.setItem('companion-push', '1');
      $('push-status').textContent = '推送已开启';
    } catch (e) {
      // HTTP 明文环境下 serviceWorker 不可用，属预期降级（建议 Tailscale Serve）
      $('push-status').textContent = '推送不可用（需 HTTPS，建议 Tailscale Serve）';
    }
  }

  async function maybeShowPushEntry() {
    // 仅 HTTPS 安全上下文展示入口；HTTP 下推送本就不可用
    if (!window.isSecureContext || !('serviceWorker' in navigator)) return;
    $('push-entry').style.display = 'flex';
    if (localStorage.getItem('companion-push') === '1' && Notification.permission === 'granted') {
      $('push-status').textContent = '推送已开启';
    }
  }
  $('push-btn').onclick = function () { void enablePush(); };

  // ---- 启动 ----
  if (state.token) { loadWorkspaces().then(loadSessions); maybeShowPushEntry(); } else { show('pair'); }
  setInterval(refreshPendingBadge, 30000);
})();
</script>
</body>
</html>`
}
