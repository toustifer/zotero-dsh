## 修复论文会话上下文串台

切换论文后，顶部当前论文已经是新论文，但具体会话里还带着上一篇论文的上下文。根因是「按工作区取最近会话」时只按 cwd 过滤，没有限制会话必须属于当前论文；于是同一个 Active SLAM 工作区里的其他论文会话可能被复用。

现在只复用 `zotero-paper-<当前条目 key>`（以及它的 `-2`、`-3` 实例），不会再复用工作区里别的论文或泛用会话。没有当前论文专属会话才新建。

复用会话时如果 chat store 没登记或没有上下文时间戳，会重新注入当前论文的 meta 上下文；并同步更新本地 chat store。

另外，Zotero 侧现在会把 PDF 附件 key 归一化为父条目 key，host 侧也会再次兜底。这样标题、Zotero key、PDF 和当前会话始终属于同一篇论文。

实测当前论文 `99L7JHSL` 的模型回复为：
`Active view planning for visual SLAM in outdoor environments based on continuous information modeling` / `99L7JHSL`。

这次还重新构建了 host 与 client 两端；之前只跑 host build 会导致前端轮询代码没有进入 `lib/client.js`。