# Mermaid 最小用法

何时使用：仅当页面需要稳定生成的流程图、时序图、状态图、类图、架构关系或用户旅程时加载 Mermaid；简单的 2–4 步线性说明可用普通 HTML 阶段卡，纯层级知识结构应优先用 MindElixir。

仅在图形本身承担解释任务时加载 Mermaid。优先选与关系匹配的图种：有分支或回路的业务步骤用 `flowchart`，参与者之间按时间推进的消息用 `sequenceDiagram`，状态迁移用 `stateDiagram-v2`；不要把项目清单或层级目录硬画成流程图。一个图只讲一个机制，控制在约 8–16 个节点内；节点文案用短语，不把段落塞入节点。复杂图拆成两张或改为「结论 + 图」，不要缩小到无法阅读。

**显式控制初始化与渲染。** 按所选版本和构建格式加载 Mermaid，在库可用后配置 `mermaid.initialize({ startOnLoad: false, ... })` 与主题，再在目标节点就绪后调用 `mermaid.run()`。同步脚本、`defer` 或模块导入均可采用，但必须保证依赖顺序，避免自动与手动渲染重复执行。初始化应早于首次渲染，不将某个页面的事件时序当作所有加载方式的通用限制。

初始化统一使用 `theme: "base"`、`securityLevel: "strict"` 和页面主题变量。深色页面必须同时配置深色节点面板、文字、边线、连线与子图背景，不能只改页面 CSS；例如 `primaryColor: '#18212d'`、`primaryTextColor: '#f4f7fb'`、`primaryBorderColor: '#7f8b9b'`、`lineColor: '#4da3ff'`、`clusterBkg: '#18212d99'`。流程图空间不够时可在图源码中写 `config: layout: elk`，并保留横向滚动的舞台容器；不要把 SVG 固定成像素宽高。移动端允许图形横向滚动，但标题、结论与图注必须留在正常页面流中。

**最小流程案例（假定 Mermaid 已可用，示例脚本放在图源码元素之后）：**

```html
<pre class="mermaid">flowchart LR
  A[提交] --> B{审核通过？}
  B -->|否| A
  B -->|是| C[发布]
</pre>
<script>
  // 确保库已可用；先配置主题，再渲染上方已就绪的节点。
  mermaid.initialize({
    startOnLoad: false, theme: 'base', securityLevel: 'strict',
    themeVariables: {
      primaryColor: '#18212d', primaryTextColor: '#f4f7fb',
      primaryBorderColor: '#7f8b9b', lineColor: '#4da3ff', clusterBkg: '#18212d99'
    }
  });
  mermaid.run({ querySelector: '.mermaid' });
</script>
```

时序图只需把首行改成 `sequenceDiagram`，再用 `编辑->>AI: 提交 Brief` 这类语句表达先后关系。复杂流程需要 ELK 布局时，才在 Mermaid YAML 配置头中加入 `layout: elk`。
