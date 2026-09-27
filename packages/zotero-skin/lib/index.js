/**
 * dsh-zotero-skin — host half.
 *
 * 把 DSH Web GUI 的 --dsw-* 语义 token 重绑到 Zotero 官方色板。
 * 色值逐条取自 zotero/zotero 仓库：
 *   scss/themes/_light.scss 与 _dark.scss（accent-* / fill-* / color-* / tag-*）
 *   品牌红 #cc2936 = Zotero logo 红（rgb 204,41,54）
 *
 * 为什么走 index-inject 的 style 行，而不是 ctx.theme.overrideTokens：
 * 后者需要一个客户端 bundle（tsdown 产出的 window.__ModuleLoader__ CJS 包装）。
 * style 行是 webserver 的结构化注入面（kind:'style'，落在 <head>），
 * 而 token 样式表是客户端插件在运行时注入的 JS 字符串、必然排在本行之后，
 * 因此这里每条声明都带 !important 才压得过基线调色板。
 * 副作用：此后任何用 overrideTokens 注册的主题都盖不过本皮肤。
 */
export const name = 'dsh-zotero-skin'

const LIGHT = `
  /* 浅色：Zotero scss/themes/_light.scss */
    --dsw-alias-bg-base:#ffffff !important;
    --dsw-alias-bg-layer-1:#ffffff !important;
    --dsw-alias-bg-layer-2:#f9f9f9 !important;
    --dsw-alias-bg-layer-3:#f2f2f2 !important;
    --dsw-alias-bg-overlay:#f6f6f6 !important;
    --dsw-alias-bg-skeleton:#0000000a !important;
    --dsw-alias-bg-multi-select:#4072e51a !important;
    --dsw-alias-border-l1:#00000026 !important;
    --dsw-alias-border-l2:#00000026 !important;
    --dsw-alias-border-l3:#dadada !important;
    --dsw-alias-border-l4:#dadada !important;
    --dsw-alias-label-primary:#000000d9 !important;
    --dsw-alias-label-secondary:#0000008c !important;
    --dsw-alias-label-tertiary:#00000040 !important;
    --dsw-alias-label-dimmed:#00000040 !important;
    --dsw-alias-label-caption:#0000008c !important;
    --dsw-alias-label-primary-foreground:#ffffff !important;
    --dsw-alias-brand-primary:#cc2936 !important;
    --dsw-alias-brand-primary-invert:#ffffff !important;
    --dsw-alias-brand-text:#cc2936 !important;
    --dsw-alias-link:#4072e5 !important;
    --dsw-alias-interactive-bg-hover:#4072e51a !important;
    --dsw-alias-interactive-bg-active:#4072e530 !important;
    --dsw-alias-interactive-bg-hover-accent:#4072e51a !important;
    --dsw-alias-interactive-bg-hover-solid:#4072e51a !important;
    --dsw-alias-button-primary-fill:#cc2936 !important;
    --dsw-alias-button-primary-hover:#b02330 !important;
    --dsw-alias-button-primary-dimmed:#cc293666 !important;
    --dsw-alias-scrollbar-bg-l1:rgb(194,194,194) !important;
    --dsw-alias-scrollbar-bg-l2:rgb(194,194,194) !important;
    --dsw-alias-scrollbar-hover-l1:rgb(125,125,125) !important;
    --dsw-alias-scrollbar-hover-l2:rgb(125,125,125) !important;
    --dsw-alias-state-error-primary:#b81d29 !important;
    --dsw-alias-state-success-primary:#39bf68 !important;
    --dsw-alias-state-warn-primary:#faa700 !important;
    --dsw-alias-markdown-tag:#0000000d !important;
    --dsw-alias-markdown-citation:#4072e5 !important;
    --dsw-alias-markdown-inline-code:#0000000d !important;
    --dsw-alias-markdown-code-block:#f2f2f2 !important;
    --dsw-alias-markdown-code-block-banner:#f9f9f9 !important;
    --dsw-specific-sidebar-fill:#f2f2f2 !important;
    --dsw-specific-sidebar-nav-item-hover:#4072e50f !important;
    --dsw-specific-sidebar-nav-item-active:#4072e51a !important;
    --dsw-specific-sidebar-nav-item-active-accent:#4072e5 !important;
    --dsw-specific-tip:#f9f9f9 !important;
    --dsw-specific-menu:#ffffff !important;
    --dsw-specific-selector:#ffffff !important;
`

const DARK = `
  /* 深色：Zotero scss/themes/_dark.scss */
    --dsw-alias-bg-base:#1e1e1e !important;
    --dsw-alias-bg-layer-1:#1e1e1e !important;
    --dsw-alias-bg-layer-2:#272727 !important;
    --dsw-alias-bg-layer-3:#303030 !important;
    --dsw-alias-bg-overlay:#282828 !important;
    --dsw-alias-bg-skeleton:#ffffff0d !important;
    --dsw-alias-bg-multi-select:#4072e573 !important;
    --dsw-alias-border-l1:#ffffff2e !important;
    --dsw-alias-border-l2:#ffffff2e !important;
    --dsw-alias-border-l3:#404040 !important;
    --dsw-alias-border-l4:#404040 !important;
    --dsw-alias-label-primary:#ffffffe5 !important;
    --dsw-alias-label-secondary:#ffffff8c !important;
    --dsw-alias-label-tertiary:#ffffff4d !important;
    --dsw-alias-label-dimmed:#ffffff4d !important;
    --dsw-alias-label-caption:#ffffff8c !important;
    --dsw-alias-label-primary-foreground:#ffffff !important;
    --dsw-alias-brand-primary:#cc2936 !important;
    --dsw-alias-brand-primary-invert:#ffffff !important;
    --dsw-alias-brand-text:#ff7078 !important;
    --dsw-alias-link:#66adff !important;
    --dsw-alias-interactive-bg-hover:#4072e54d !important;
    --dsw-alias-interactive-bg-active:#4072e573 !important;
    --dsw-alias-interactive-bg-hover-accent:#4072e54d !important;
    --dsw-alias-interactive-bg-hover-solid:#4072e54d !important;
    --dsw-alias-button-primary-fill:#cc2936 !important;
    --dsw-alias-button-primary-hover:#e04a55 !important;
    --dsw-alias-button-primary-dimmed:#cc293666 !important;
    --dsw-alias-scrollbar-bg-l1:rgb(117,117,117) !important;
    --dsw-alias-scrollbar-bg-l2:rgb(117,117,117) !important;
    --dsw-alias-scrollbar-hover-l1:rgb(158,158,158) !important;
    --dsw-alias-scrollbar-hover-l2:rgb(158,158,158) !important;
    --dsw-alias-state-error-primary:#ff7078 !important;
    --dsw-alias-state-success-primary:#39bf68d9 !important;
    --dsw-alias-state-warn-primary:#faa700cc !important;
    --dsw-alias-markdown-tag:#ffffff0f !important;
    --dsw-alias-markdown-citation:#66adff !important;
    --dsw-alias-markdown-inline-code:#ffffff0f !important;
    --dsw-alias-markdown-code-block:#272727 !important;
    --dsw-alias-markdown-code-block-banner:#1e1e1e !important;
    --dsw-specific-sidebar-fill:#303030 !important;
    --dsw-specific-sidebar-nav-item-hover:#4072e530 !important;
    --dsw-specific-sidebar-nav-item-active:#4072e573 !important;
    --dsw-specific-sidebar-nav-item-active-accent:#4072e5 !important;
    --dsw-specific-tip:#272727 !important;
    --dsw-specific-menu:#282828 !important;
    --dsw-specific-selector:#282828 !important;
`

const CSS = '/* dsh-zotero-skin — Zotero palette over DSH design tokens */'
  + 'body{' + LIGHT + '}'
  + 'body[data-ds-dark-theme]{' + DARK + '}'

/**
 * 注册一张样式行。webserver 把 kind:'style' 的行渲染成 <head> 里的 <style>。
 * @param ctx - 宿主上下文。
 */
/**
 * 界面文案改写脚本。
 *
 * 为什么是脚本而不是样式：DSH 的界面文案是各客户端插件里硬编码的中文字面量，
 * 没有 i18n 覆盖点，CSS 也改不了文本内容。index-inject 的 `kind:'script'` 行
 * 是唯一一个能跑在页面里的注入面（和 style 行同源，落在 <head>）。
 *
 * 只改**文本节点的值**，不换元素：React 重渲染会把它的文本写回去，观察器随即
 * 再改一次。替换表按整段精确匹配，所以幂等 —— 改过的文本不再命中键，观察器被
 * 自己的改动唤醒也不会来回抖。
 */
export const TEXT_SCRIPT = "(() => {\n  // DSH 的界面文案是硬编码的，没有 i18n 覆盖点。这里在 index.html 里注入一段\n  // 文本改写器：只改**文本节点的值**，不换元素 —— React 重渲染会把它自己的文本\n  // 写回去，MutationObserver 随即再改一次，所以两边不会打架。\n  // 替换表用整段精确匹配，所以天然幂等：改过的文本不再命中键。\n  var TEXT_MAP = {\n    '探索未至之境': '读深一篇论文',\n    '描述你想要构建的内容, / 调用指令, @ 文件或对话': '问当前选中的论文，或让它去调研…'\n  };\n  var TITLE_PREFIX = 'Zotero · ';\n\n  function fixText(root) {\n    if (!root) return;\n    var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);\n    var n;\n    while ((n = walker.nextNode())) {\n      var t = n.nodeValue;\n      if (!t) continue;\n      var key = t.trim();\n      if (Object.prototype.hasOwnProperty.call(TEXT_MAP, key)) {\n        n.nodeValue = t.replace(key, TEXT_MAP[key]);\n      }\n    }\n  }\n\n  function fixOne(el) {\n    var v = el.getAttribute && el.getAttribute('data-placeholder');\n    if (v && Object.prototype.hasOwnProperty.call(TEXT_MAP, v)) {\n      el.setAttribute('data-placeholder', TEXT_MAP[v]);\n    }\n  }\n  function fixPlaceholders(root) {\n    if (!root) return;\n    // 先看 root 自己：React 新挂进来的那个 composer 元素本身就带 data-placeholder，\n    // 而 querySelectorAll 只查后代，漏掉它就等于新会话永远显示旧占位符。\n    if (root.nodeType === 1) fixOne(root);\n    if (!root.querySelectorAll) return;\n    var els = root.querySelectorAll('[data-placeholder]');\n    for (var i = 0; i < els.length; i++) fixOne(els[i]);\n  }\n\n  function fixTitle() {\n    var t = document.title || '';\n    if (!t || t.indexOf(TITLE_PREFIX) === 0) return;\n    document.title = TITLE_PREFIX + t;\n  }\n\n  function fixAll(root) {\n    try { fixText(root || document.documentElement); } catch (e) {}\n    try { fixPlaceholders(root || document.documentElement); } catch (e) {}\n    try { fixTitle(); } catch (e) {}\n  }\n\n  function start() {\n    fixAll();\n    new MutationObserver(function (records) {\n      for (var i = 0; i < records.length; i++) {\n        var r = records[i];\n        if (r.type === 'characterData') { fixAll(r.target.parentNode || document.documentElement); continue; }\n        if (r.type === 'attributes') { fixPlaceholders(r.target); continue; }\n        for (var j = 0; j < r.addedNodes.length; j++) fixAll(r.addedNodes[j]);\n      }\n      fixTitle();\n    }).observe(document.documentElement, {\n      childList: true, subtree: true, characterData: true,\n      attributes: true, attributeFilter: ['data-placeholder'],\n    });\n  }\n\n  if (document.readyState === 'loading') {\n    document.addEventListener('DOMContentLoaded', start);\n  } else {\n    start();\n  }\n})();"

export function apply(ctx) {
  ctx.on('webserver/index-inject', (rows) => {
    rows.push({ kind: 'style', text: CSS })
    rows.push({ kind: 'script', placement: 'head', text: TEXT_SCRIPT })
  })
  try {
    ctx.logger?.info?.('dsh-zotero-skin: Zotero palette + UI copy rows registered')
  } catch { /* 日志是尽力而为 */ }
}
