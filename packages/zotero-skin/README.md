# dsh-zotero-skin

把 DSH Web GUI 的 `--dsw-*` 语义 token 重绑到 **Zotero 官方色板**，让 3081 那个「Zotero 科研版」实例看起来像 Zotero。

## 色值出处（全部取自一手源码，非印象）

| 来源 | 取到什么 |
|---|---|
| [`zotero/zotero` `scss/themes/_light.scss`](https://github.com/zotero/zotero/blob/main/scss/themes/_light.scss) | `color-background #fff`、`color-toolbar #f9f9f9`、`color-sidepane #f2f2f2`、`color-panedivider #dadada`、`color-border #00000026`、`fill-primary/secondary/tertiary` = `#000000d9/8c/40`、`accent-blue #4072e5`、`color-scrollbar rgb(194,194,194)` |
| [`scss/themes/_dark.scss`](https://github.com/zotero/zotero/blob/main/scss/themes/_dark.scss) | `color-background #1e1e1e`、`color-toolbar #272727`、`color-sidepane #303030`、`color-panedivider #404040`、`color-button #404040`、`fill-primary/secondary/tertiary` = `#ffffffe5/8c/4d`、`color-invalid #ff7078` |
| [`scss/abstracts/_variables.scss`](https://github.com/zotero/zotero/blob/main/scss/abstracts/_variables.scss) | 圆角 3/4/6px、字号 13px、Segoe UI 字族（DSH 默认字族已含 Segoe UI，未覆盖） |
| Zotero logo | 品牌红 `#cc2936`（rgb 204,41,54）—— 用于 `brand-primary` / `button-primary-fill` / `brand-text` |

## 映射要点

- `bg-base` / `bg-layer-1/2/3` ← Zotero 的 `color-background` / `color-toolbar` / `color-sidepane` / `color-button`。**浅色是「白内容区 + #f2f2f2 侧栏」**的对比，这是 Zotero 最直观的识别特征。
- `label-primary/secondary/tertiary` ← Zotero 的 `fill-primary/secondary/tertiary`。Zotero 这套本就是**带 alpha 的黑/白**，天然适配 DSH 的层级文字。
- `brand-primary` / `button-primary-fill` ← 品牌红 `#cc2936`（Zotero 的身份色）。
- `specific-sidebar-nav-item-active` + `-active-accent` ← `#4072e5` 低透明底 + 纯色左侧强调条，复刻 **Zotero 收藏夹树的选中样式**。
- `link` ← `accent-blue #4072e5`；深色下改用 `accent-azure #66adff` 保证对比度。

## 实现路径与取舍

走 **`webserver/index-inject` 的 `{ kind: 'style' }` 行**（渲染成 `<head>` 里的 `<style>`），不是 `ctx.theme.overrideTokens`。

原因：`overrideTokens` 是客户端半边 API，需要 tsdown 产出的 `window.__ModuleLoader__` CJS bundle；而 token 样式表本身是客户端插件在运行时注入的 JS 字符串，**必然排在 head 注入行之后**。因此本皮肤的每条声明都带 `!important` 才压得过基线调色板。

**已知副作用**：此后任何用 `overrideTokens` 注册的主题都盖不过本皮肤；要换肤需先摘掉本插件。

## 安装（3081 实例）

已挂在 `C:\Users\15775\.dsh-zotero\profiles\zotero\package.json`：

```json
"dsh": { "profile": { "bundles": [ ..., "dsh-zotero-skin" ] } },
"dependencies": { "dsh-zotero-skin": "link:C:/Users/15775/.dsh/plugins/dsh-zotero-skin" }
```

改完 `lib/index.js` 后重启实例即可（本插件无构建步骤，直接是 ESM）。

## 验证

浏览器里读计算样式：

```
dark=true
--dsw-alias-bg-base            #1e1e1e      (Zotero color-background dark)
--dsw-alias-bg-layer-2         #272727      (Zotero color-toolbar dark)
--dsw-alias-label-primary      #ffffffe5    (Zotero fill-primary dark)
--dsw-alias-brand-primary      #cc2936      (Zotero 品牌红)
--dsw-specific-sidebar-fill    #303030      (Zotero color-sidepane dark)
body background                rgb(30,30,30)
```
