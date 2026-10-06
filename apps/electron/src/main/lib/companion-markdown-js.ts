/**
 * Companion 手机端 Markdown 渲染器（单源 JS，注入页面 <script> 使用）
 *
 * 设计约束：
 * - 单文件字符串源码，由 companion-page.ts 注入 HTML，bun test 中用 new Function 执行同一份源码；
 * - 防 XSS 构造：先整体 HTML 转义，再叠加白名单标签（标题/列表/围栏代码/行内码/粗斜体/删除线/仅 http(s) 链接），
 *   输出中不可能出现用户提供的事件属性或脚本标签；
 * - 源码禁止包含反引号与 ${（保证可安全注入页面模板字符串）。
 */

export const COMPANION_MARKDOWN_JS = `
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}

function mdInline(s) {
  var e = escapeHtml(s);
  e = e.replace(/\`([^\\n\`]+)\`/g, '<code>$1</code>');
  e = e.replace(/\\*\\*([^\\n*]+)\\*\\*/g, '<strong>$1</strong>');
  e = e.replace(/(^|[^*])\\*([^*\\n]+)\\*(?!\\*)/g, '$1<em>$2</em>');
  e = e.replace(/~~([^~\\n]+)~~/g, '<del>$1</del>');
  e = e.replace(/\\[([^\\]]+)\\]\\((https?:[^)\\s]+)\\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
  return e;
}

function mdBlock(block) {
  var lines = block.replace(/\\r\\n/g, '\\n').split('\\n');
  var html = [];
  var listStack = null;
  function closeList() {
    if (listStack) { html.push('</' + listStack + '>'); listStack = null; }
  }
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i];
    var h = line.match(/^(#{1,6})\\s+(.*)$/);
    if (h) {
      closeList();
      html.push('<h' + h[1].length + '>' + mdInline(h[2]) + '</h' + h[1].length + '>');
      continue;
    }
    var ul = line.match(/^\\s*[-*]\\s+(.*)$/);
    var ol = line.match(/^\\s*\\d+[.)]\\s+(.*)$/);
    if (ul || ol) {
      var type = ul ? 'ul' : 'ol';
      if (listStack !== type) { closeList(); html.push('<' + type + '>'); listStack = type; }
      html.push('<li>' + mdInline((ul || ol)[1]) + '</li>');
      continue;
    }
    var bq = line.match(/^&gt;\\s?(.*)$/) || line.match(/^>\\s?(.*)$/);
    if (bq) {
      closeList();
      html.push('<blockquote>' + mdInline(bq[1]) + '</blockquote>');
      continue;
    }
    if (/^\\s*(-{3,}|\\*{3,})\\s*$/.test(line)) {
      closeList();
      html.push('<hr>');
      continue;
    }
    if (!line.trim()) { closeList(); continue; }
    closeList();
    html.push('<p>' + mdInline(line) + '</p>');
  }
  closeList();
  return html.join('');
}

function renderMarkdown(src) {
  if (!src) return '';
  var text = String(src);
  var out = [];
  var fenceRe = /\`\`\`([^\\n\`]*)\\n?([\\s\\S]*?)(?:\`\`\`|$)/g;
  var last = 0;
  var m;
  while ((m = fenceRe.exec(text)) !== null) {
    if (m.index > last) out.push(mdBlock(text.slice(last, m.index)));
    var lang = m[1].trim();
    var cls = lang ? ' class="lang-' + escapeHtml(lang) + '"' : '';
    out.push('<pre class="md-code"' + cls + '><code>' + escapeHtml(m[2]) + '</code></pre>');
    last = fenceRe.lastIndex;
    if (!m[0].endsWith('\`\`\`')) break; // 未闭合围栏，剩余内容已在 m[2] 内
  }
  if (last < text.length) out.push(mdBlock(text.slice(last)));
  return out.join('');
}
`

/** 测试用：从源码构建渲染函数 */
export function loadMarkdownRenderer(): (src: string) => string {
  const factory = new Function(`${COMPANION_MARKDOWN_JS}\nreturn renderMarkdown;`)
  return factory() as (src: string) => string
}
