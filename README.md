# zotero-dsh

把 [Zotero](https://www.zotero.org/) 和 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 接起来，双向。

> `dsh-zotero` 是「DSH 里的 Zotero」，`zotero-dsh` 是「Zotero 里的 DSH」。
> 这个仓库装的是后者，并且把两个方向放在一起。

## 目录

| 包 | 方向 | 做什么 |
| --- | --- | --- |
| `packages/zotero-addon` | Zotero → DSH | 在 Zotero 右侧栏里嵌入真正的 DSH 界面 |
| `packages/dsh-plugin` | DSH → Zotero | 在 DSH 里检索、精读、标注、整理论文 |

---

## Zotero 里的 DSH — `packages/zotero-addon`

Zotero 7 插件。在条目详情面板的右侧栏注册一个 section，里面用 XUL `<browser>`
内嵌 DSH 的 Web 界面 —— 不是截图，不是消息转发，是在 Zotero 里跑一个真的 DSH 会话。

几个必须踩对的点（源码里都有注释）：

- 必须 `createXULElement("browser")`，配 `remote` + `maychangeremoteness` + `disableglobalhistory`，
  否则静默失败或者直接把 Zotero 搞崩
- 导航只能走 browsingContext 的 `PageData` actor 的 `sendQuery("loadURI")`，
  直接调 `browser.loadURI()` 会 `NS_ERROR_FAILURE`
- DSH 每次启动都换 token，且不持久化。所以 **base 来自偏好项，token 一律现取** ——
  从实例日志里读最后一条 `dsh web:` 行的 token。旧实现信任偏好项里的 token，
  于是 DSH 一重启，面板就停在 401 页

### 安装

1. 先让一个 DSH Web 实例跑起来，比如：
   ```
   dsh web
   ```
   启动行会打印 `dsh web: http://127.0.0.1:3080/?token=<...>`

2. Zotero → 工具 → 开发者 → **Load Plugin From Manifest…**，选
   `packages/zotero-addon/addon/manifest.json`

3. 重启 Zotero，点开任意条目的右侧栏里的 DSH 图标

### 打包

```powershell
pwsh -File packages/zotero-addon/build.ps1
```

产出 `packages/zotero-addon/zotero-dsh.xpi`，可直接拖进 Zotero 安装。

---

## DSH 里的 Zotero — `packages/dsh-plugin`

DSH 插件（`@dsh-external/dsh-zotero`）。注册 12 个 agent 工具和一个右侧栏面板：

- **检索与阅读**：Local API 搜索、条目详情、集合树、PDF/全文读取
- **全文解析**：MinerU 通道（公式、表格保留），带缓存
- **精读与翻译**：整篇总结、定向提问、逐段翻译、批量处理
- **标注与笔记**：读 PDF 高亮与批注，回写 Markdown 笔记
- **论文 ↔ 工作区映射**：区/组两级；组可以映射到真实目录，于是同一篇论文从
  不同 idea 打开会落到不同的工作目录
- **证据检索**：索引 + 查询规划 + 重排，回答带出处

### 安装

还没发到 npm，从源码装：

```bash
git clone https://github.com/toustifer/zotero-dsh
cd zotero-dsh/packages/dsh-plugin
pnpm install && node scripts/build.mjs
```

然后把 `packages/dsh-plugin` 链到 DSH profile 的
`node_modules/@dsh-external/dsh-zotero`，并在 profile 的 `cordis.patch.yml`
里插入包名锚点 —— 具体写法见包内 `cordis.patch.yml` 的注释。

### 构建

```bash
cd packages/dsh-plugin
pnpm install        # 需要 DSH 环境提供的 @deepseek-ai/* peer 依赖
node scripts/build.mjs
```

---

## 关系图

```
Zotero  ──[zotero-addon: 右侧栏嵌入]──►  DSH
   ▲                                      │
   └──────[dsh-plugin: 工具 + 面板]───────┘
```

两侧各走各的路，互不依赖：Zotero 侧只认一个 URL，DSH 侧只认 Zotero 的 Local API。

## 开发

两个包互相独立，没有共享构建。

```bash
# Zotero 侧：改 addon/ 后重新打包，Zotero 里热重载或重启
pwsh -File packages/zotero-addon/build.ps1

# DSH 侧：改 src/ 后重建，重启 DSH 实例
cd packages/dsh-plugin && node scripts/build.mjs
```

## 已知边界

- Zotero 侧的 token 解析按优先级扫候选日志，换实例只需改端口，不用改 token
- DSH 侧的面板依赖 DSH 的 `sidebar.workspaces` 相关槽位，DSH 大版本升级可能需要跟进
- 论文 ↔ 工作区映射存在本地 JSON，不进 Zotero 数据库

## 许可

AGPL-3.0-only。见 [LICENSE](LICENSE)。

DSH 侧源自 [llm-for-zotero](https://github.com/ethen8181/llm-for-zotero) 的重构，
后者以 AGPL-3.0 发布，因此本仓库整体采用同一许可。
