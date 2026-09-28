## 0.18.11 的离线分支是死代码

0.18.11 想解决的是"Zotero 一关，磁盘上的解析缓存也读不到"，方向对，但**判据写错了层**：

```js
try {
  got = await client.scoped(exec?.signal).getItem(itemKey)
} catch (err) {
  /* 离线降级写在这里 */
}
```

而 `getItem` 对"连不上 Zotero"**根本不抛异常**。client.ts 里 `resolveSource()` 的失败被
`.catch()` 转成了返回值，第 605 行直接返回：

```js
const src = await this.resolveSource().catch((err) => ({
  found: false, source: 'none', item: null, error: err.message, hint: err.hint ?? '',
}))
if (src.source === 'none') return src        // ← 到这里就返回了，不会 throw
```

于是 `catch` 永远进不去，用户看到的还是原来那条：

```
条目不存在: 99L7JHSL（Zotero Local API 不可达且未配置 Web API 降级凭据）
```

**修法**：判据改成返回值里的 `source`。

- `source === 'none'` → 够不着 Zotero，**这才是离线入口**，去查 `item-attachments.json`。
- `source` 是别的值 → Zotero 在线但这条不在库里，那是**真的不存在**，不该去翻缓存。

保留 `try/catch` 只作兜底（别的实现可能抛）。

## 实测四种情形（stub client，不是推断）

| 情形 | 结果 |
| :--- | :--- |
| 不可达 + 有缓存（`99L7JHSL`） | 返回全文，`source = cache(offline: Zotero 不可达)`，93230 字符 |
| 不可达 + 要的是没缓存的双语版 `A4BLAVAI` | **回退到有缓存的兄弟附件** `CUILYLGY`，同样返回全文 |
| 不可达 + 该条从没解析过 | 抛 `无法连接 Zotero: fetch failed（该条目没有本地解析缓存，需要 Zotero 在线）` |
| 可达但 key 真不存在 | 抛 `条目不存在: NOPE1234` —— **没有误走缓存** |

第二种是实际会遇到的情形：用户在面板里点的是双语版，而只有原始版有缓存。现在会拿到
原始版正文，并把 `attachmentKey` 如实报成 `CUILYLGY`，调用方看得出换了一份。

plugin 0.2.6 / addon 0.18.12
