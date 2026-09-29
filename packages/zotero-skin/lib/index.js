/**
 * dsh-zotero-skin — host half.
 *
 * 把 DSH Web GUI 的 --dsw-* 语义 token 重绑到 Zotero 官方色板。
 * 并注入链接拦截与右键菜单脚本，支持在系统默认浏览器中打开链接与复制。
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

export const TEXT_SCRIPT = "(() => {\n  var API = '/@dsh-external/dsh-zotero/api';\n  var TEXT_MAP = {\n    '探索未至之境': '读深一篇论文',\n    '描述你想要构建的内容, / 调用指令, @ 文件或对话': '问当前选中的论文，或让它去调研…'\n  };\n  var TITLE_PREFIX = 'Zotero · ';\n\n  function fixText(root) {\n    if (!root) return;\n    var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);\n    var n;\n    while ((n = walker.nextNode())) {\n      var t = n.nodeValue;\n      if (!t) continue;\n      var key = t.trim();\n      if (Object.prototype.hasOwnProperty.call(TEXT_MAP, key)) {\n        n.nodeValue = t.replace(key, TEXT_MAP[key]);\n      }\n    }\n  }\n  function fixOne(el) {\n    var v = el.getAttribute && el.getAttribute('data-placeholder');\n    if (v && Object.prototype.hasOwnProperty.call(TEXT_MAP, v)) {\n      el.setAttribute('data-placeholder', TEXT_MAP[v]);\n    }\n  }\n  function fixPlaceholders(root) {\n    if (!root) return;\n    if (root.nodeType === 1) fixOne(root);\n    if (!root.querySelectorAll) return;\n    var els = root.querySelectorAll('[data-placeholder]');\n    for (var i = 0; i < els.length; i++) fixOne(els[i]);\n  }\n  function fixTitle() {\n    var t = document.title || '';\n    if (!t || t.indexOf(TITLE_PREFIX) === 0) return;\n    document.title = TITLE_PREFIX + t;\n  }\n  function fixAll(root) {\n    try { fixText(root || document.documentElement); } catch (e) {}\n    try { fixPlaceholders(root || document.documentElement); } catch (e) {}\n    try { fixTitle(); } catch (e) {}\n  }\n\n  function showToast(msg) {\n    var t = document.getElementById('dshz-toast');\n    if (!t) {\n      t = document.createElement('div');\n      t.id = 'dshz-toast';\n      t.style.cssText = 'position:fixed;bottom:64px;left:50%;transform:translateX(-50%);background:rgba(30,30,30,0.9);color:#fff;padding:6px 14px;border-radius:6px;font:11.5px/1.4 system-ui,sans-serif;z-index:999999;pointer-events:none;box-shadow:0 4px 12px rgba(0,0,0,0.3);transition:opacity .18s;opacity:0;';\n      document.body.appendChild(t);\n    }\n    t.textContent = msg;\n    t.style.opacity = '1';\n    clearTimeout(t._timer);\n    t._timer = setTimeout(function () { t.style.opacity = '0'; }, 1700);\n  }\n\n  function copyText(s, okMsg) {\n    function fallback() {\n      var ta = document.createElement('textarea');\n      ta.value = s;\n      ta.style.cssText = 'position:fixed;opacity:0;';\n      document.body.appendChild(ta);\n      ta.select();\n      try { document.execCommand('copy'); } catch (e) {}\n      document.body.removeChild(ta);\n      showToast(okMsg);\n    }\n    if (navigator.clipboard && navigator.clipboard.writeText) {\n      navigator.clipboard.writeText(s).then(function () { showToast(okMsg); }).catch(fallback);\n    } else { fallback(); }\n  }\n\n  function openSystem(url) {\n    if (!url) return;\n    function fallback(reason) {\n      // 端点不可达时退到 window.open。Zotero 内嵌 browser 里它可能被忽略，\n      // 但比什么都不做强；用户至少能从 toast 知道该手动右键复制。\n      var opened = null;\n      try { opened = window.open(url, '_blank', 'noopener'); } catch (e) {}\n      if (opened) showToast('已在浏览器中打开');\n      else showToast(reason + '，请用右键「复制链接地址」');\n    }\n    try {\n      fetch(API + '/open-external', {\n        method: 'POST',\n        headers: { 'Content-Type': 'application/json' },\n        body: JSON.stringify({ url: url })\n      }).then(function (r) {\n        if (!r.ok) return fallback('打开失败(HTTP ' + r.status + ')');\n        return r.json().then(function (j) {\n          if (j && j.ok) showToast('已在默认浏览器中打开');\n          else fallback('打开失败：' + String((j && j.error) || '未知'));\n        });\n      }).catch(function (e) {\n        fallback('打开失败：' + String(e && e.message ? e.message : e));\n      });\n    } catch (e) {\n      fallback('打开失败');\n    }\n  }\n\n  function setupLinkAndContextHandlers() {\n    document.addEventListener('click', function (e) {\n      var a = e.target.closest && e.target.closest('a');\n      if (!a) return;\n      var href = a.getAttribute('href');\n      if (!href || !/^https?:\\/\\//i.test(href)) return;\n      e.preventDefault();\n      e.stopPropagation();\n      openSystem(href);\n    }, true);\n\n    var menu = document.getElementById('dshz-context-menu');\n    if (!menu) {\n      menu = document.createElement('div');\n      menu.id = 'dshz-context-menu';\n      menu.style.cssText = 'position:fixed;display:none;background:#282828;color:#eee;border:1px solid rgba(255,255,255,.15);border-radius:6px;padding:4px 0;font:12px system-ui,sans-serif;box-shadow:0 6px 16px rgba(0,0,0,.4);z-index:999999;min-width:150px;';\n      document.body.appendChild(menu);\n    }\n    var activeUrl = '';\n    var activeSel = '';\n    function closeMenu() { menu.style.display = 'none'; }\n    document.addEventListener('click', function (e) { if (!menu.contains(e.target)) closeMenu(); });\n    // capture 阶段监听：Zotero 内嵌 browser 与其它脚本也可能监听 contextmenu，\n    // 冒泡阶段拿到时宿主默认菜单可能已经弹出来了。\n    document.addEventListener('contextmenu', function (e) {\n      var a = e.target.closest && e.target.closest('a');\n      var href = a && a.getAttribute('href');\n      activeUrl = (href && /^https?:\\/\\//i.test(href)) ? href : '';\n      var sel = window.getSelection();\n      activeSel = sel ? String(sel.toString()).trim() : '';\n      // 兜底：有的版本里 <a> 包在自定义元素里，closest 走不出来，用坐标做命中测试。\n      if (!activeUrl && document.caretRangeFromPoint) {\n        try {\n          var rr = document.caretRangeFromPoint(e.clientX, e.clientY);\n          var el0 = rr && rr.startContainer\n            ? (rr.startContainer.nodeType === 1 ? rr.startContainer : rr.startContainer.parentElement)\n            : null;\n          var hit = el0 && el0.closest ? el0.closest('a') : null;\n          var hh = hit && hit.getAttribute('href');\n          if (hh && /^https?:\\/\\//i.test(hh)) activeUrl = hh;\n        } catch (err) {}\n      }\n      if (!activeUrl && !activeSel) { closeMenu(); return; }\n      e.preventDefault();\n      menu.innerHTML = '';\n      function item(label, fn) {\n        var d = document.createElement('div');\n        d.textContent = label;\n        d.style.cssText = 'padding:6px 14px;cursor:pointer;';\n        d.onmouseenter = function () { d.style.background = '#383838'; };\n        d.onmouseleave = function () { d.style.background = 'transparent'; };\n        d.onclick = function () { fn(); closeMenu(); };\n        menu.appendChild(d);\n      }\n      if (activeUrl) {\n        item('在浏览器中打开', function () { openSystem(activeUrl); });\n        item('复制链接地址', function () { copyText(activeUrl, '已复制链接'); });\n      }\n      if (activeSel) item('复制文字', function () { copyText(activeSel, '已复制文字'); });\n      var x = e.clientX, y = e.clientY;\n      if (x + 170 > window.innerWidth) x = window.innerWidth - 175;\n      if (y + 110 > window.innerHeight) y = window.innerHeight - 115;\n      menu.style.left = x + 'px';\n      menu.style.top = y + 'px';\n      menu.style.display = 'block';\n    }, true);\n  }\n\n  // ── 工作区徽章：把\"这篇论文的复现工作区在哪\"常驻显示在画面右下角 ──\n  function setupWorkspaceBadge() {\n    var box = document.getElementById('dshz-ws-badge');\n    if (!box) {\n      box = document.createElement('div');\n      box.id = 'dshz-ws-badge';\n      box.style.cssText = 'position:fixed;right:12px;bottom:12px;max-width:min(420px,52vw);background:rgba(28,28,30,.92);color:#e8e8e8;border:1px solid rgba(255,255,255,.14);border-radius:8px;padding:7px 11px;font:11px/1.5 ui-monospace,SFMono-Regular,Consolas,monospace;box-shadow:0 6px 20px rgba(0,0,0,.38);z-index:99998;cursor:pointer;display:none;backdrop-filter:blur(6px);';\n      box.title = '点击复制工作区路径';\n      document.body.appendChild(box);\n    }\n    var lastKey = '';\n    var current = null;\n\n    box.addEventListener('click', function () {\n      if (!current) return;\n      copyText(current.copyValue, '已复制：' + current.copyValue);\n    });\n\n    function render(info) {\n      var head = document.createElement('div');\n      head.style.cssText = 'display:flex;align-items:center;gap:6px;';\n      var dot = document.createElement('span');\n      dot.textContent = info.remote ? '🖥' : '📂';\n      dot.style.cssText = 'flex:0 0 auto;';\n      var name = document.createElement('span');\n      name.textContent = info.title || info.tail || '工作区';\n      name.style.cssText = 'flex:1 1 auto;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#fff;';\n      head.appendChild(dot);\n      head.appendChild(name);\n\n      var sub = document.createElement('div');\n      sub.textContent = info.label;\n      sub.style.cssText = 'margin-top:2px;color:' + (info.exists ? '#9fd3a0' : '#e0a35c') + ';overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';\n      if (!info.exists) sub.title = '本地锚点目录尚未创建';\n\n      box.innerHTML = '';\n      box.appendChild(head);\n      box.appendChild(sub);\n      box.style.display = 'block';\n      current = {\n        copyValue: info.remote ? info.remote.path : info.dir\n      };\n    }\n\n    async function tick() {\n      try {\n        var f = await fetch(API + '/focus').then(function (r) { return r.json(); });\n        var key = f && f.focus && f.focus.itemKey ? String(f.focus.itemKey) : '';\n        if (!key) { box.style.display = 'none'; lastKey = ''; return; }\n        var w = await fetch(API + '/workspace-info?itemKey=' + encodeURIComponent(key))\n          .then(function (r) { return r.json(); });\n        if (!w || !w.ok) { box.style.display = 'none'; return; }\n        lastKey = key;\n        render(w);\n      } catch (e) {\n        box.style.display = 'none';\n      }\n    }\n\n    tick();\n    setInterval(tick, 4000);\n  }\n\n  function start() {\n    fixAll();\n    setupLinkAndContextHandlers();\n    setupWorkspaceBadge();\n    new MutationObserver(function (records) {\n      for (var i = 0; i < records.length; i++) {\n        var r = records[i];\n        if (r.type === 'characterData') { fixAll(r.target.parentNode || document.documentElement); continue; }\n        if (r.type === 'attributes') { fixPlaceholders(r.target); continue; }\n        for (var j = 0; j < r.addedNodes.length; j++) fixAll(r.addedNodes[j]);\n      }\n      fixTitle();\n    }).observe(document.documentElement, {\n      childList: true, subtree: true, characterData: true,\n      attributes: true, attributeFilter: ['data-placeholder'],\n    });\n  }\n\n  if (document.readyState === 'loading') {\n    document.addEventListener('DOMContentLoaded', start);\n  } else {\n    start();\n  }\n})();"

export function apply(ctx) {
  ctx.on('webserver/index-inject', (rows) => {
    rows.push({ kind: 'style', text: CSS })
    rows.push({ kind: 'script', placement: 'head', text: TEXT_SCRIPT })
  })
  try {
    ctx.logger?.info?.('dsh-zotero-skin: Zotero palette + UI copy + link + workspace badge registered')
  } catch { /* 日志是尽力而为 */ }
}