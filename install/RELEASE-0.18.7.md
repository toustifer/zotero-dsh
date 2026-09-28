## 那次会话为什么慢

一轮「这句话什么意思」，实际打了 11 次工具调用，其中 5 次是白打的：

| 调用 | 结果 | 原因 |
| --- | --- | --- |
| `zotero_get_item CUILYLGY` | 条目不存在 | **key 是 PDF 附件，不是论文条目** |
| `zotero_retrieve CUILYLGY` | 条目不存在 | 同上 |
| `zotero_health` | fetch failed | 当时 Zotero 没开（现在正常） |
| `glob **/*` | 空 | 论文工作区目录本来就是空的 |
| `search_fulltext` ×3 | error | MCP 那侧的抖动，重试也没好 |

## 主因：选段送的是附件 key

Zotero 阅读器的 selection 事件里的 `reader.itemID` 指的是**正在读的那个 PDF 附件**，不是论文条目。插件直接把它的 key 当论文 key 送了出去，于是选段文件里写着 `Zotero key：CUILYLGY`——那是附件，条目其实是 `99L7JHSL`。模型拿着附件 key 去查条目，两次都只能得到「条目不存在」，然后才改走 MCP 那条路。

两头都修了：

- **Zotero 侧**顺着 `parentItem` 换成条目再送，附件 key 另存一栏（要精确定位到哪个 PDF 时还有用）。
- **`client.getItem`** 拿到附件也会跟一步 `parentItem`。这一层是兜底——历史选段、模型自己从别处拼出来的附件 key，都能用。

实测：`GET /api/item?key=CUILYLGY` 现在返回 `found=true, key=99L7JHSL, title=Active view planning for visual SLAM...`。

## 另外两处

科研预设里补了两条：选段的 key 现在是条目 key、工具会自动跟到父条目不用自己查；以及**论文工作区目录一开始是空的**，那是放自己产出的地方，别用 `glob` 去里面翻上下文——论文正文只在 Zotero 里。

## 还没动的

`search_fulltext` 的连续失败来自 zotero-mcp-plugin 那一侧，不是这套插件；`zotero_health` 那次失败只是 Zotero 没启动，现在 23119 正常应答。
