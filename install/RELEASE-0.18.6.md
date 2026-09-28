## 修了什么

面板有时会卡在「加载中...」，DSH 区域一片空白。

根因是两个 `load()` 在并发跑。Zotero 会在条目切换、面板重排时反复调 `renderPane`，每次都起一次嵌入流程；而 `unmountEmbedded` 是个**全局清扫**——它按 `browser[data-zotero-dsh-embed]` 把文档里所有嵌入浏览器都删掉，包括另一个正在跑的实例刚建的那个。于是两边都拿不到标题，各自跑满 5 轮 probe，最后那次再把状态栏写回「加载中」。

日志里的样子是一堆交织的 probe 编号（`probe#0 #1 #2 #3` 混着出现），最后跟一条 `embed final title=""`。

现在每次 `load()` 发一个代号：

- 旧的在每个 `await` 点检查自己是否已被取代，是就把自己建的 browser 摘掉、直接返回；
- 被取代的那次**不许再写状态栏** —— 它会把后来者刚写好的「已连接」盖回「加载中」。

部署后 Mac 的日志立刻干净了：`embed gen=1 superseded before load` 紧跟着 `embed final title="DeepSeek Harness"`。

## 升级

两端 Zotero 都要更新 `zotero-dsh.xpi`。
