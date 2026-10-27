# Tailwind 最小用法

何时使用：使用 utility class 完成常规视觉与布局时加载 Tailwind，优先用于间距、Grid/Flex、响应式、颜色、字号、边框、状态和位置；极简、少量样式的原生 HTML 页面可不加载。

用实用类完成所有常规间距、网格、响应式、颜色、排版、边框和状态，例如 `grid md:grid-cols-2 gap-6`、`text-4xl md:text-6xl`。保持语义 HTML（`header`、`main`、`section`、`article`、`aside`）；复杂视觉才在 `<style>` 中保留少量自定义变量、伪元素或动画。不要用手写 CSS 重复 Tailwind 已覆盖的布局能力；插件仅按需使用，并核对来源可信度、版本兼容性和构建方式是否支持。

**收敛重复组合**：同一 utility 组合出现 ≥3 次时，在 `<style>` 定义语义化组件类并全局复用，样式必须与 Tailwind 等价（含 line-height、letter-spacing 等细节）：

```css
.card{background:#fff;border:1px solid #e2e8f0;border-radius:1rem;padding:1.25rem;}
.body{font-size:.875rem;line-height:1.25rem;color:#475569;}
.eyebrow{font-size:.75rem;line-height:1rem;font-weight:600;letter-spacing:.1em;text-transform:uppercase;color:#94a3b8;}
```

页面中写 `class="card"` 代替整串 utility。实测：仅此一步可将 class 属性体积压缩约 25%，整页字节减少约 7%，渲染像素不变。不要为了省字符而合并语义不同的类。
