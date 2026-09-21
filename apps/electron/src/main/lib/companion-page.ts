/**
 * Companion 移动端单页
 *
 * 单文件 HTML（内联 CSS/JS，vanilla，无构建步骤），由 companion-server 直接返回；
 * 页面本身不含任何数据，所有数据经认证 API 获取。
 *
 * 视图：配对（一次性配对码换 token）→ 会话列表（待确认徽标）→ 会话详情（SSE 实时流 + 权限/AskUser 卡片）。
 * token 存 localStorage；任何 401 都会清除 token 回到配对视图。
 */

export function getCompanionPageHtml(): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>Gravitas Companion</title>
<style>
:root { --bg:#0d1117; --card:#161b22; --card2:#1c2330; --text:#e6edf3; --muted:#8b949e; --accent:#4c8dff; --green:#3fb950; --red:#f85149; --border:#2d333b; }
* { box-sizing:border-box; margin:0; padding:0; }
body { font-family:-apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif; background:var(--bg); color:var(--text); font-size:15px; }
.container { max-width:640px; margin:0 auto; padding:16px; min-height:100vh; display:flex; flex-direction:column; }
h1 { font-size:20px; margin-bottom:4px; }
.sub { color:var(--muted); font-size:13px; }
.view { display:none; flex:1; flex-direction:column; }
.view.active { display:flex; }
.card { background:var(--card); border-radius:12px; padding:16px; margin-top:12px; box-shadow:0 1px 4px rgba(0,0,0,.4); }
input, textarea { width:100%; background:var(--card2); color:var(--text); border:1px solid var(--border); border-radius:8px; padding:12px; font-size:16px; outline:none; }
input:focus, textarea:focus { border-color:var(--accent); }
.btn { display:inline-block; background:var(--accent); color:#fff; border:none; border-radius:8px; padding:12px 18px; font-size:15px; font-weight:600; cursor:pointer; margin-top:12px; width:100%; }
.btn.secondary { background:var(--card2); color:var(--text); border:1px solid var(--border); }
.btn.deny { background:var(--red); }
.btn.allow { background:var(--green); }
.btn.small { width:auto; padding:6px 12px; font-size:13px; margin-top:0; }
.session-item { background:var(--card); border-radius:12px; padding:14px 16px; margin-top:10px; cursor:pointer; display:flex; justify-content:space-between; align-items:center; }
.session-item .dot { width:8px; height:8px; border-radius:50%; background:var(--muted); margin-right:8px; flex-shrink:0; }
.session-item .dot.running { background:var(--green); animation:pulse 1.2s infinite; }
@keyframes pulse { 50% { opacity:.4; } }
.badge { background:var(--red); color:#fff; border-radius:10px; padding:2px 8px; font-size:12px; font-weight:700; }
#messages { flex:1; overflow-y:auto; padding:8px 0; }
.msg { margin-top:10px; max-width:88%; }
.msg.user { margin-left:auto; }
.msg .bubble { background:var(--card); border-radius:12px; padding:10px 14px; white-space:pre-wrap; word-break:break-word; }
.msg.user .bubble { background:var(--accent); }
.msg.assistant .bubble { background:var(--card); }
.msg.tool .bubble { background:var(--card2); color:var(--muted); font-size:13px; }
.req-card { background:var(--card); border:1px solid var(--accent); border-radius:12px; padding:14px; margin-top:12px; }
.req-card h3 { font-size:15px; margin-bottom:6px; }
.req-card .desc { color:var(--muted); font-size:13px; margin-bottom:10px; white-space:pre-wrap; word-break:break-word; }
.req-card .cmd { background:var(--card2); border-radius:8px; padding:8px; font-family:ui-monospace,monospace; font-size:12px; margin-bottom:10px; white-space:pre-wrap; word-break:break-all; }
.req-actions { display:flex; gap:10px; }
.req-actions .btn { margin-top:0; }
.opt-btn { display:block; width:100%; text-align:left; background:var(--card2); color:var(--text); border:1px solid var(--border); border-radius:8px; padding:10px 12px; margin-top:8px; font-size:14px; cursor:pointer; }
#inputbar { display:flex; gap:8px; padding-top:10px; }
#inputbar textarea { flex:1; resize:none; height:44px; }
.topbar { display:flex; align-items:center; gap:10px; padding-bottom:8px; }
.back { background:none; border:none; color:var(--accent); font-size:22px; cursor:pointer; padding:0 4px; }
.header { display:flex; justify-content:space-between; align-items:center; }
.empty { color:var(--muted); text-align:center; margin-top:40px; }
.err { color:var(--red); font-size:13px; margin-top:8px; }
</style>
</head>
<body>
<div class="container">

  <div id="view-pair" class="view active">
    <h1>Gravitas Companion</h1>
    <p class="sub">在桌面端 设置 → 远程访问 生成配对码</p>
    <div class="card">
      <input id="pair-code" inputmode="numeric" maxlength="6" placeholder="6 位配对码" autocomplete="one-time-code">
      <button class="btn" id="pair-btn">配对</button>
      <div class="err" id="pair-err"></div>
    </div>
  </div>

  <div id="view-list" class="view">
    <div class="header"><h1>会话</h1><span id="pending-badge"></span></div>
    <p class="sub" id="list-status">加载中…</p>
    <div id="sessions"></div>
  </div>

  <div id="view-chat" class="view">
    <div class="topbar">
      <button class="back" id="back-btn">‹</button>
      <div style="flex:1;min-width:0"><h1 id="chat-title" style="font-size:16px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">会话</h1></div>
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
(function () {
  'use strict';
  var TOKEN_KEY = 'companion-token';
  var state = { token: localStorage.getItem(TOKEN_KEY) || '', currentSession: null, es: null, pending: {}, lastEventId: '0' };

  function $(id) { return document.getElementById(id); }
  function show(name) {
    ['pair', 'list', 'chat'].forEach(function (v) { $('view-' + v).classList.toggle('active', v === name); });
  }

  function api(method, path, body) {
    return fetch(path, {
      method: method,
      headers: Object.assign({ 'Content-Type': 'application/json' }, state.token ? { Authorization: 'Bearer ' + state.token } : {}),
      body: body ? JSON.stringify(body) : undefined,
    }).then(function (res) {
      if (res.status === 401 && path !== '/api/pair') { logout(); throw new Error('登录已失效'); }
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
      loadSessions();
    }).catch(function (e) { $('pair-err').textContent = e.message; });
  };

  // ---- 会话列表 ----
  function loadSessions() {
    show('list');
    api('GET', '/api/sessions').then(function (res) { return res.json(); }).then(function (data) {
      $('list-status').textContent = data.sessions.length ? '' : '暂无会话';
      var box = $('sessions');
      box.innerHTML = '';
      data.sessions.forEach(function (s) {
        var item = document.createElement('div');
        item.className = 'session-item';
        item.innerHTML = '<span style="display:flex;align-items:center;min-width:0"><span class="dot"></span><span style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + escapeHtml(s.title || s.id) + '</span></span>';
        item.onclick = function () { openChat(s.id, s.title || s.id); };
        box.appendChild(item);
      });
      refreshPendingBadge();
    }).catch(function (e) { $('list-status').textContent = e.message; });
  }

  function refreshPendingBadge() {
    api('GET', '/api/pending').then(function (res) { return res.json(); }).then(function (data) {
      state.pending = {};
      data.permissions.forEach(function (p) { state.pending[p.requestId] = p; });
      data.askUsers.forEach(function (a) { state.pending[a.requestId] = a; });
      var n = data.permissions.length + data.askUsers.length;
      $('pending-badge').innerHTML = n ? '<span class="badge">' + n + ' 待确认</span>' : '';
    }).catch(function () { /* 静默 */ });
  }

  // ---- 会话详情 ----
  function openChat(sessionId, title) {
    state.currentSession = sessionId;
    $('chat-title').textContent = title;
    $('messages').innerHTML = '';
    $('requests').innerHTML = '';
    $('chat-err').textContent = '';
    show('chat');
    closeStream();
    api('GET', '/api/sessions/' + encodeURIComponent(sessionId) + '/messages').then(function (res) { return res.json(); }).then(function (data) {
      (data.messages || []).forEach(function (m) { appendMessage(m.role, m.content); });
      $('messages').scrollTop = $('messages').scrollHeight;
      openStream(sessionId);
    }).catch(function (e) { $('chat-err').textContent = e.message; });
  }

  function openStream(sessionId) {
    var url = '/api/events?token=' + encodeURIComponent(state.token) + '&lastEventId=' + state.lastEventId;
    state.es = new EventSource(url);
    state.es.addEventListener('agent-stream', function (ev) {
      try { handleEnvelope(JSON.parse(ev.data)); } catch (e) { /* 忽略坏帧 */ }
    });
    state.es.onerror = function () { /* EventSource 自动重连（带原 lastEventId），无需处理 */ };
  }

  function handleEnvelope(envelope) {
    state.lastEventId = envelope.id || state.lastEventId;
    if (envelope.sessionId !== state.currentSession) return;
    var payload = envelope.payload;
    if (payload.kind === 'proma_event') {
      var type = payload.event.type;
      if (type === 'permission_request') showPermissionCard(payload.event.request);
      if (type === 'ask_user_request') showAskUserCard(payload.event.request);
      if (type === 'permission_resolved') removeCard('perm-' + payload.event.requestId);
      if (type === 'goal_updated') return;
    }
    if (payload.kind === 'agent_event') {
      var e = payload.event;
      if (e.type === 'text_delta' || e.type === 'text_complete') appendStreamingText(e.text);
      if (e.type === 'tool_start') appendMessage('tool', '⚙ ' + (e.displayName || e.toolName));
      if (e.type === 'tool_result' && e.isError) appendMessage('tool', '⚠ 工具出错: ' + String(e.result).slice(0, 300));
    }
  }

  var streamBuffer = '';
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
    last.querySelector('.bubble').textContent = streamBuffer;
    $('messages').scrollTop = $('messages').scrollHeight;
  }

  function appendMessage(role, content) {
    if (!content) return;
    streamBuffer = '';
    var div = document.createElement('div');
    div.className = 'msg ' + role;
    div.innerHTML = '<div class="bubble"></div>';
    div.querySelector('.bubble').textContent = content;
    $('messages').appendChild(div);
    $('messages').scrollTop = $('messages').scrollHeight;
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
        api('POST', '/api/permission/' + encodeURIComponent(req.requestId), { behavior: btn.dataset.act }).catch(function () {});
      };
    });
    $('requests').appendChild(div);
  }

  function showAskUserCard(req) {
    if ($('ask-' + req.requestId)) return;
    var div = document.createElement('div');
    div.className = 'req-card';
    div.id = 'ask-' + req.requestId;
    var html = '<h3>❓ ' + escapeHtml((req.toolInput && req.toolInput.questions && req.toolInput.questions[0] && req.toolInput.questions[0].question) || 'Agent 需要你的回答') + '</h3>';
    var questions = (req.toolInput && req.toolInput.questions) || [];
    var firstQ = questions[0] || {};
    (firstQ.options || []).forEach(function (opt) {
      html += '<button class="opt-btn" data-label="' + escapeHtml(opt.label || '') + '">' + escapeHtml(opt.label || '') + (opt.description ? '<br><span style="color:var(--muted);font-size:12px">' + escapeHtml(opt.description) + '</span>' : '') + '</button>';
    });
    div.innerHTML = html;
    div.querySelectorAll('.opt-btn').forEach(function (btn) {
      btn.onclick = function () {
        var answers = {};
        questions.forEach(function (q) { answers[q.header || q.question || 'answer'] = btn.dataset.label; });
        api('POST', '/api/ask-user/' + encodeURIComponent(req.requestId), { answers: answers }).catch(function () {});
      };
    });
    $('requests').appendChild(div);
  }

  function removeCard(id) {
    var card = $(id);
    if (card) card.remove();
    refreshPendingBadge();
  }

  // ---- 发送 / 停止 ----
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
  $('back-btn').onclick = function () { closeStream(); loadSessions(); };

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  // ---- 启动 ----
  if (state.token) { loadSessions(); } else { show('pair'); }
  setInterval(refreshPendingBadge, 30000);
})();
</script>
</body>
</html>`
}
