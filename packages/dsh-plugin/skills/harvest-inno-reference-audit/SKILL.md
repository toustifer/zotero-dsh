---
name: harvest-inno-reference-audit
description: harvest 流水线的学术引用核查分支。对论文的参考文献做三层核查——存在性（这条引用真的存在吗）、一致性（标题/作者/年份/出处对得上吗）、可信度（值不值得引）。自带 cite_audit.py 核查器，接 CrossRef / arXiv 权威元数据，并与 Zotero 库内真实条目三方比对。当用户说「核查引用」「查参考文献」「引用是不是编的」「审稿式检查引文」「投稿前查引文」「reference audit」时使用。
whenToUse: 引文核查, 参考文献核实, 幻构引用检测, 引用一致性检查, 投稿前引文检查, reference audit, 查引用真假, bib 核查
---

# 引文核查（harvest 学术分支）

通用 harvest 回答的是「这个主题网上有什么」；本分支回答的是「**我稿子里这些引用，是真的吗**」。

两者共用同一套四步管道，只是把「信息源」换成了「引用条目」，把「可信度审计」换成了「引文真伪判定」。

## 何时走这条分支

- 论文 / 综述 / 开题报告投稿或送审前的参考文献自查
- 怀疑某条引用是模型或记忆编出来的（幻构引用）
- 引用列表与正文标注对不上
- 需要判断某条引用是预印本还是同行评审
- 从 .bib / Zotero 集合批量体检

**不走这条分支**：只想查某篇论文讲了什么（走 `zotero-scholar`）；想调研某方向现状（走通用 harvest 四步）。

## 三层核查

| 层 | 问题 | 判据 |
| --- | --- | --- |
| L1 存在性 | 这条文献在真实世界里存在吗 | CrossRef `works/{doi}` 返回 200 还是 404；arXiv `id_list` 有无条目 |
| L2 一致性 | 引用字段与权威元数据对得上吗 | 标题相似度、首作者姓、年份（容差 1 年）、出处 |
| L3 可信度 | 这条引用值不值得引 | 被引数、文献类型、是否预印本、是否撤稿线索 |

判定语义（七种，互斥）：

- `VERIFIED` —— 存在且字段一致，可以放心引
- `PARTIAL` —— 存在，个别次要字段有出入
- `MISMATCH` —— **存在，但标题 / 作者 / 年份对不上**，通常是引错了文献，最危险的类型之一
- `NOT_FOUND` —— **查无此文献**，幻构引用的强信号
- `NO_IDENTIFIER` —— 无 DOI / arXiv 编号且标题检索无命中，无法核实（这是「查不了」，不是「有问题」）
- `SKIPPED` —— 离线模式未核查
- `ERROR` —— 核查过程本身出错，需重试

## 主流程（走 harvest 四步）

### 1. scout —— 把待核查的引用收齐

来源有三处，按用户给的线索选：

- 文件：`.bib` / `.tex` / `.md` / `.txt`
- Zotero 库：`zotero_collections` → `zotero_library_search` / `zotero_get_item` 拿条目与 DOI
- 会话上下文：用户贴的一段参考文献

先把总量摸清再动手。几十条以上就明确告诉用户预计耗时。

### 2. extract —— 拉权威元数据与引用上下文

两件事并行做：

- **权威元数据**：交给 `scripts/cite_audit.py`，它自己打 CrossRef / arXiv，带重试与礼貌限速。
- **引用上下文**：找出正文里引用这条文献的那句话。这是 L2 之外的一层——**引用可能存在、字段也对，但被误表述了**（overclaim）。用 `harvest_extract` 或 `zotero_retrieve` 抓原文段落来比对。

### 3. verify —— 出核查结论

跑核查器：

```bash
python <SKILL_DIR>/scripts/cite_audit.py \
  --bib refs.bib \
  --out 引文核查报告.md \
  --json 引文核查结果.json \
  --mailto <你的邮箱>
```

其它入参形式：

- `--text paper.md` —— 从正文扫 DOI 与 arXiv 编号
- `--doi 10.1038/nature14539` —— 直接点名核查，可重复
- `--offline` —— 不发网络请求，只做解析、去重与结构检查

对 `MISMATCH` 的条目，必须回到权威条目确认到底哪边错了，不要只看脚本结论就下判词——有时是引用列表写错，有时是正文标错了。

对 `NO_IDENTIFIER` 的条目，用 `zotero_library_search`（`qmode=everything`）在本地库里再找一遍；库里能找到就升级为可核实。

### 4. audit —— 出五维可信度矩阵并定稿

对**被引处的事实性断言**（不只是元数据）跑 `harvest_verify`：把「论文 X 声称 Y」写成断言，看是否有第二条独立来源支撑。若该断言只在这一篇里出现且无法交叉验证，明确标注「单一来源」。

最后按 `harvest_audit` 出五维矩阵。判为弃用的来源不得出现在正式稿里。

## 报告纪律

- **每条结论必须能指回具体位置**：bib key、DOI、或正文的行 / 段。
- **区分三种东西**：权威元数据（CrossRef / arXiv 原文）、脚本判定、你的推断。不要把推断写成判定。
- **数值与方向不要转述**：被引数、年份、作者顺序一律回原文确认。
- 查不到就说查不到，写成 `NOT_FOUND` 或 `NO_IDENTIFIER`，不要用「大概存在」糊过去。
- 接口失败记 `[SKIP:平台]` 后继续，不阻塞整轮。

## 进阶：更重的科研工具

需要时再上，不要默认全开——它们有成本：

- **格式规范化与 BibTeX 导出**：`scripts/vendor/academic_citation_skill.py`，支持 APA 7th / MLA 9th / Chicago 17th / GB/T 7714-2015 / IEEE / Harvard 六种格式，含 `FormatConverter.export_bibtex`、`import_from_bibtex`、`get_library_stats`。核查通过后再做格式统一。
- **库内三方比对**：`zotero_get_item` 拿到 Zotero 里的真实条目，与 CrossRef 返回交叉确认。两处都对上，可信度最高。
- **第二模型复核**：`.workbuddy` 下的 `oracle` 技能（需先移植）可调第二个模型独立复核高风险的 `MISMATCH` 条目。

## 红线

- 不得在未实际查询的情况下判定某条引用「存在」。没有网络就没有结论，只能 `SKIPPED`。
- 不得把 `NO_IDENTIFIER` 说成「有问题」——查不了不等于假。
- 不得替用户改稿子。核查报告是产出，改哪里由用户定。
- 报告里每条来源都要带可点击 URL 或 DOI。
- 大批量（超过 50 条）先报总数与预估耗时，再开工。

## 依赖

- Python 3 + `requests`（本机：`D:\ProgramData\anaconda3\python.exe`，已装 requests 2.34.2）
- 网络可达 `api.crossref.org` 与 `export.arxiv.org`；不可达时退 `--offline`
