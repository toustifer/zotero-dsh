## Zotero 一关，磁盘上的解析缓存也读不到了

现象是工具调用"不稳"：

```
zotero_read_fulltext · CUILYLGY        ← 调了两次
zotero_health · {}
Glob **/*                               ← 模型开始自己翻缓存目录
```

模型在思考里写 "Zotero Local API is now unreachable / Zotero Desktop is closed"，
然后绕过工具层去找 `cache/mineru/CUILYLGY/full.md`。

真因在 `ensureParsed`（tools-m2.ts）。它**第一件事就是问 Zotero**：

```js
const got = itemKey ? await client.scoped(exec?.signal).getItem(itemKey) : null  // 无条件
...
const cached = readCachedMd(cfg, attKey)   // 才轮到缓存，而 attKey 来自上面的返回
```

而缓存目录是按**附件 key** 落盘的（`mineru/<attachmentKey>/full.md`），附件 key
又只能问 Zotero 要。于是 Zotero 一不在（关掉改库、重启、崩了），全文明明就在磁盘上
躺着，工具却只能报错 —— `zotero_read_fulltext` / `zotero_retrieve` / `zotero_summarize`
三个都走这条路径，一起废掉。

### 修法：一份不依赖 Zotero 的映射

新增 `mineru/item-attachments.json`，记 `itemKey → [attachmentKey]`。每次成功查询时
顺手记一笔；Local API 不可达时，就用它去找缓存：

- 命中 → 照常返回全文，`source` 标成 `cache(offline: Zotero 不可达)`，调用方一眼看得出
  这是从盘上读的。
- 没命中（这篇从没解析过）→ 把原始错误抛出去，并补一句"该条目没有本地解析缓存，
  需要 Zotero 在线"，让模型知道没有退路、不要瞎试。

覆盖的是**已经解析过**的论文，这也正是高频场景：读过的文献不会因为 Zotero 重启就读不了。

索引文件对老库是空的，所以安装后第一次查询才逐条补上；也可以直接从 `zotero.sqlite`
把已有的 `itemAttachments` 映射一次性灌进去（只读，不需要关 Zotero）。

### 顺带

- `requestTimeoutMs` 默认 15s 保持不变：Zotero 不在时 TCP 是立刻 ECONNREFUSED，不是等超时。
- 错误提示本身没问题（原本就写着"Zotero Desktop 未运行"），缺的是**退路**，所以这次补的是退路。
