## 这一版解决什么

之前的 dsh-zotero 只会「你点一下，它读一下」：模型不知道你此刻在 Zotero 里选中哪篇，也不知道那篇的 PDF 落在磁盘哪里。你得先把论文送进去，它才开始工作 —— 否则它只能反问，或者更糟：拿记忆里的论文硬答。

这一版把这件事变成**每一轮都成立的上下文**：

- Zotero 半边在选中变化时（节流 1.5 秒）把当前条目的标题、作者、年份、所在集合、PDF 磁盘路径、当前页码推给 DSH 的 `POST /focus`。
- DSH 半边用 `systemPrompt.context` 注册一个 `zotero:focus` 段，文本在**每次组装时重新求值**。换一篇选中的论文，模型下一步就看到了 —— 不需要点按钮，也不用重开会话。
- 没选中任何东西时返回空串，组装层会把空段丢掉，所以不会往提示词里塞垃圾。超过两小时没动过也当作你已经离开那篇。

实测（模型回答原文）：

> 以上全部来自本轮运行时上下文里的「当前论文 · 用户在 Zotero 里正选中这一条」那一段，我没有调用任何工具，也没有去文件系统核实这个路径。
>
> 那条 PDF 路径本身是给你核对用的，按规矩我不能拿它当读取入口 —— 要读正文我得走 zotero_read_pdf / zotero_read_fulltext / zotero_retrieve。

## 科研预设

包里多了一份 `presets/research/`：一个 DSH agent preset（「科研模式」），装配照抄内置的 `standard`，换掉人格段落。

人格里写死了三件事，都是文献工作里代价最高的失误点：

1. **Zotero 资料一律走 zotero_* 工具**，不许用文件系统去翻 Zotero 的存储目录 —— 那些路径是内部实现，翻到 PDF 也不知道它对应哪条。
2. **引用纪律**：转述必须能指回章节名 / offset / 批注 key；原文、批注、一般知识三者不要混；没读到就说没读到，不许按标题"补全"正文。
3. **调研走 harvest 四步**（scout → extract → verify → audit），不许用一次网页搜索当结论。

安装脚本会把它拷进 `<DshHome>/.agent-presets/research`，**已存在就不覆盖** —— 那是给人改的东西。

## 安装

macOS / Linux：

```bash
bash install-dsh.sh
```

Windows：

```powershell
pwsh -File install-dsh.ps1
```

两端的 Zotero 插件（`zotero-dsh.xpi`）也要更新 —— 选中项的推送在那一半。

## 附带修掉的

- `zotero-dsh` 的 `version` 常量不再硬编码。之前升级后日志里还打着旧版本号，看日志的人会误判"新代码没生效"（我自己就被骗过一次）。
- 界面文案改写器的占位符替换漏了根元素本身 —— React 新挂进来的 composer 元素自带 `data-placeholder`，而 `querySelectorAll` 只查后代，于是新会话永远显示旧占位符。
