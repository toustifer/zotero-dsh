# zotero-dsh

把 [Zotero](https://www.zotero.org/) 和 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 接起来，双向。

> `dsh-zotero` 是「DSH 里的 Zotero」，`zotero-dsh` 是「Zotero 里的 DSH」。
> 这个仓库装的是后者，并且把两个方向放在一起。
> 姊妹项目：[Fisfzy/dsh-zotero](https://github.com/Fisfzy/dsh-zotero)（DSH 侧，独立仓库）。

## 目录

| 包 | 方向 | 做什么 |
| --- | --- | --- |
| `packages/zotero-addon` | Zotero → DSH | 在 Zotero 右侧栏里嵌入真正的 DSH 界面 |
| `packages/dsh-plugin` | DSH → Zotero | 在 DSH 里检索、精读、标注、整理论文 |

**不想编译？** 两步装完：[下载 xpi 装进 Zotero] + [跑一次安装脚本]，
都从 [最新 Release](https://github.com/toustifer/zotero-dsh/releases/latest) 取预构建产物。
详见 [install/README.md](install/README.md)。

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

### 在 PDF 里选中文字送进 DSH

在 Zotero 自己的阅读器里选中一段话，气泡里会多出两个按钮：

- **送入 DSH** —— 只把选段推进该论文的会话上下文，你接着自己写问题
  （对应 VSCode 聊天里 "Add to Chat" 的语义）
- **问 DSH** —— 顺带追一轮，让它直接解读这段

会话按 `itemKey` **懒开**：没打开过面板也能送，第一段送进来时会自动带上论文元数据。
实现走 `renderTextSelectionPopup` 事件 + `POST /quote`，不劫持 Zotero 的任何原生行为。

**选段会出现在 DSH 输入框正上方。** DSH 侧注册在 `conversation.input.dock` 槽的引用卡
显示刚送进来的那段话，点「附到问题」经 `inputActions.setDraft` 追加进草稿 ——
DSH 唯一一个"把外部文本写进输入框"的公开接口。只加引用，不替你发送，
和 VSCode 聊天里的 "Add to Chat" 是同一件事。送入的同一段话同时也注入了该论文会话的
上下文，所以模型两处都看得到。

### 安装

从 [最新 Release](https://github.com/toustifer/zotero-dsh/releases/latest) 下载 `zotero-dsh.xpi`，
Zotero 里走 **工具 → 插件 → 齿轮 → Install Plugin From File…**，重启即可 —— 不需要先跑
"Load Plugin From Manifest" 那套开发流程。

### 自己打包

```powershell
pwsh -File packages/zotero-addon/build.ps1
```

产出 `packages/zotero-addon/zotero-dsh.xpi`。

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

从 [最新 Release](https://github.com/toustifer/zotero-dsh/releases/latest) 下载 `install-dsh.ps1`
和 `dsh-zotero-0.1.1.tgz`，放同一个目录，然后：

```powershell
pwsh -File install-dsh.ps1
```

脚本只做三件事：解包到 `~/.dsh/plugins/dsh-zotero`、在 profile 的 `node_modules`
下建 junction、往 `cordis.patch.yml` 补一次加载锚点。**不编译。** 细节见
[install/README.md](install/README.md)。

### 自己构建

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
