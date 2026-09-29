# 引文核查判据（audit rubric）

本文件是 `harvest-inno-reference-audit` 的判定依据。跑脚本之前读一遍，判 `MISMATCH` 与 `NOT_FOUND` 时更要读。

## 一、幻构引用的六种形态

模型或记忆编出来的引用不是只有「整条不存在」一种。按危害从高到低：

| 形态 | 表现 | 检测手段 |
| --- | --- | --- |
| **凭空捏造** | 标题、作者、DOI 全不存在 | DOI 返回 404 → `NOT_FOUND` |
| **张冠李戴** | DOI 真、标题假，或标题真、DOI 指向别人 | L2 标题相似度 < 0.65 → `MISMATCH` |
| **作者幻觉** | 文献真但作者名是模型补出来的 | 首作者姓不在权威作者列表 → `MISMATCH` |
| **年份漂移** | 文献真但年份错（常错在预印本与正刊之间） | 年份差 > 1 → `MISMATCH`；差 1 年记 `PARTIAL` |
| **出处错配** | 期刊 / 会议名写错（把 arXiv 写成 CVPR） | 比对 container-title；单列不升级为 MISMATCH，记 `PARTIAL` |
| **过度声称** | 引用本身完全真实，但正文说的不是论文结论 | 脚本查不出，必须走 harvest_extract 抓原文段落 |

前五种脚本能抓；**第六种只能靠读原文**。这是本技能为什么还要接 harvest 的原因。

## 二、各层判据与阈值

### L1 存在性

- 有 DOI：`GET https://api.crossref.org/works/{doi}`。200 = 存在；404 = 不存在。
- 有 arXiv 编号：`GET http://export.arxiv.org/api/query?id_list={id}`。返回 entry = 存在。
- **arXiv DOI 的特殊处理**：`10.48550/arXiv.XXXX.XXXXX` 是 DataCite 注册的，CrossRef 常常查不到。脚本会自动剥出 arXiv 编号改走 arXiv API，并标注「预印本」。看到这条标注不要当成异常。

### L2 一致性

- **标题相似度**：归一化（小写、去标点、压空白）后做 `difflib.SequenceMatcher`。
  - 大于等于 0.90 → 通过
  - 0.65 到 0.90 → `PARTIAL`，人工看一眼
  - 小于 0.65 → `MISMATCH`
  - 阈值设这么高是因为跨语言、含副标题、LaTeX 命令残留都会拉低相似度——宁可多报几条让人看。
- **年份**：容差 1 年。会议论文常有「arXiv 先发年」与「会议年」两个年份，差 1 年属正常。差 2 年以上必须查。
- **第一作者**：比姓（family name），全小写。只比第一位——多位作者时顺序在 bib 与权威库里常有出入，比全序列会大量误报。
- **出处**：只在两边都有值时比对，作为 `PARTIAL` 的辅助证据，不单独升级为 `MISMATCH`。

### L3 可信度

- `is-referenced-by-count` = 0：新发表或影响面小。**不是问题，但引用时要能说清为什么引它。**
- `type` = `posted-content`：预印本，未同行评审。投稿时若要引它，确认是否已有正刊版本。
- 撤稿线索：CrossRef 的 `update-to` 字段会标记 retraction。脚本目前只取基础字段，怀疑某条被撤稿时手工查 `https://api.crossref.org/works/{doi}` 的完整响应。

## 三、已知的假阳性和假阴性

**会误报为 MISMATCH 的**：

- 中文文献（CrossRef 对中文期刊覆盖差，标题匹配率低）
- 学位论文、技术报告、标准文档（多不在 CrossRef）
- 书籍章节（container-title 常与 bib 的 booktitle 不一致）

**会漏报的**：

- 完全真实但被过度声称的引用（形态六）
- 作者列表被增删（只比第一作者）
- DOI 指向正确文献但卷期页码错（脚本不比 volume / issue / page）

## 四、处理决策树

```
NOT_FOUND  → 手工在 Google Scholar / 会议官网再搜一次标题
             搜到 → 是 DOI 写错，更新 bib
             搜不到 → 按幻构引用处理，从稿子里删或换成真文献

MISMATCH   → 打开权威条目的摘要
             内容对得上 → bib 的标题/作者写错了，改正 bib
             内容对不上 → 引错了文献，需要换引用

NO_IDENTIFIER → 先 zotero_library_search qmode=everything 在本库找
             找到 → 补上 DOI，升为可核实
             没找到 → 标注「无法核实」，不要写成「有问题」

PARTIAL    → 逐字段看 diff，通常直接接受
```

## 五、报告写法

每条结论三种成分要分清，别混：

- **权威元数据**：CrossRef / arXiv 原文返回的，直接引用
- **脚本判定**：`NOT_FOUND` / `MISMATCH` 等，标明由脚本给出
- **你的推断**：例如「这条应该是把 2016 的会议版和 2022 的期刊版混了」，标明是推断

示例：

> `drifted2016` 判 `MISMATCH`（脚本）：DOI `10.1038/nature16961` 在 CrossRef 存在，标题为 Mastering the game of Go with deep neural networks and tree search，2016 年，首作者 Silver。引用端写的是「A Totally Wrong Title…」、2022 年、首作者 Zhang。推断（未验证）：该条可能是另一篇文献的 DOI 被误贴。
