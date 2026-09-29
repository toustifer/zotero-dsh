#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
harvest-inno-reference-audit :: cite_audit.py

三层引文核查器
  L1 存在性  —— 这条引用在真实世界里存在吗？（CrossRef / arXiv）
  L2 一致性  —— 引用字段与权威元数据对得上吗？（标题/作者/年份/出处）
  L3 可信度  —— 这条引用值不值得引？（被引数 / 类型 / 预印本 / 撤稿线索）

用法
  python cite_audit.py --bib refs.bib --out report.md
  python cite_audit.py --doi 10.1109/TRO.2024.1234567 --doi 10.48550/arXiv.2404.12345
  python cite_audit.py --text paper.md --json out.json
  python cite_audit.py --bib refs.bib --offline      # 只做本地结构检查，不发网络请求
"""

from __future__ import annotations

import argparse
import difflib
import io
import json
import re
import sys
import time
from dataclasses import dataclass, field, asdict
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional

try:
    import requests
except ImportError:
    sys.stderr.write("需要 requests：pip install requests\n")
    raise SystemExit(2)

# Windows 控制台默认 GBK，中文报告会炸
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

CROSSREF = "https://api.crossref.org/works"
ARXIV_API = "http://export.arxiv.org/api/query"
TIMEOUT = 20
UA = "harvest-inno-reference-audit/1.0 (mailto:{mailto})"

VERDICTS = ("VERIFIED", "PARTIAL", "MISMATCH", "NOT_FOUND", "NO_IDENTIFIER", "SKIPPED", "ERROR")

# 年份容差：在线先发 / 会议与期刊版年份常差 1
YEAR_TOLERANCE = 1
TITLE_OK = 0.90
TITLE_WEAK = 0.65


# ────────────────────────────── 数据结构 ──────────────────────────────

@dataclass
class Entry:
    """待核查的一条引用。"""
    key: str
    kind: str = "unknown"           # bibtex entry type
    title: str = ""
    authors: List[str] = field(default_factory=list)   # 姓，已规范化
    year: Optional[int] = None
    venue: str = ""
    doi: str = ""
    arxiv: str = ""
    raw: Dict[str, str] = field(default_factory=dict)
    source: str = ""                # 来自哪个文件


@dataclass
class Verdict:
    entry: Entry
    verdict: str = "SKIPPED"
    layer_hits: Dict[str, str] = field(default_factory=dict)
    matched: Optional[Dict[str, Any]] = None
    diffs: List[str] = field(default_factory=list)
    notes: List[str] = field(default_factory=list)
    cited_by: Optional[int] = None
    score: Optional[float] = None


# ────────────────────────────── BibTeX 解析 ──────────────────────────────

_ENTRY_RE = re.compile(r"@(\w+)\s*\{\s*([^,]+),", re.IGNORECASE)


def _split_top_level(text: str) -> List[str]:
    """按顶层逗号切分，忽略花括号内的逗号。"""
    out, buf, depth = [], [], 0
    for ch in text:
        if ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
        if ch == "," and depth == 0:
            out.append("".join(buf))
            buf = []
        else:
            buf.append(ch)
    if buf:
        out.append("".join(buf))
    return out


def _clean(value: str) -> str:
    """剥掉 BibTeX 的包裹花括号 / 引号，压平空白。"""
    v = value.strip().rstrip(",").strip()
    while len(v) >= 2 and ((v[0] == "{" and v[-1] == "}") or (v[0] == '"' and v[-1] == '"')):
        v = v[1:-1].strip()
    v = v.replace("\\&", "&").replace("~", " ")
    v = re.sub(r"\\[a-zA-Z]+\s*", "", v)
    v = re.sub(r"[{}]", "", v)
    return re.sub(r"\s+", " ", v).strip()


def parse_bibtex(text: str, source: str = "") -> List[Entry]:
    """从 BibTeX 文本解析出引用条目。够用为准，不求完备。"""
    entries: List[Entry] = []
    marks = list(_ENTRY_RE.finditer(text))

    for idx, m in enumerate(marks):
        kind, key = m.group(1).lower(), m.group(2).strip()
        body_start = m.end()
        body_end = marks[idx + 1].start() if idx + 1 < len(marks) else len(text)
        body = text[body_start:body_end]

        fields: Dict[str, str] = {}
        for chunk in _split_top_level(body):
            if "=" not in chunk:
                continue
            name, _, value = chunk.partition("=")
            name = name.strip().lower()
            value = _clean(value)
            if name and value:
                fields[name] = value

        authors = [_normalize_family(a) for a in _split_authors(fields.get("author", ""))]

        year = None
        for yk in ("year", "date"):
            if fields.get(yk):
                ym = re.search(r"(19|20)\d{2}", fields[yk])
                if ym:
                    year = int(ym.group(0))
                    break

        venue = fields.get("journal") or fields.get("booktitle") or fields.get("publisher") or ""
        doi = fields.get("doi", "")
        if not doi:
            dm = re.search(r"10\.\d{4,9}/[^\s,}]+", fields.get("url", "") + " " + fields.get("note", ""))
            if dm:
                doi = dm.group(0)
        arxiv = fields.get("eprint", "")
        if not arxiv:
            am = re.search(r"arXiv[:\s]*(\d{4}\.\d{4,5})", " ".join(fields.values()), re.IGNORECASE)
            if am:
                arxiv = am.group(1)
        if doi.startswith("10.48550/arXiv."):
            arxiv = arxiv or doi.rsplit("/", 1)[-1].replace("arXiv.", "")

        entries.append(Entry(
            key=key, kind=kind, title=fields.get("title", ""), authors=authors,
            year=year, venue=venue, doi=doi, arxiv=arxiv, raw=fields, source=source,
        ))
    return entries


def _split_authors(raw: str) -> List[str]:
    if not raw:
        return []
    parts = re.split(r"\s+and\s+", raw)
    return [p.strip() for p in parts if p.strip()]


def _normalize_family(name: str) -> str:
    """从 'Given Family' / 'Family, Given' 里取姓并规范化。"""
    n = name.strip()
    if not n:
        return ""
    if "," in n:
        n = n.split(",")[0]
    else:
        tokens = n.split()
        if len(tokens) >= 2:
            n = tokens[-1]
    n = re.sub(r"[^A-Za-z\u4e00-\u9fff\-]", "", n)
    return n.lower()


# ────────────────────────────── 标识提取 ──────────────────────────────

def extract_from_text(text: str, source: str = "") -> List[Entry]:
    """从 Markdown / 纯文本里扫 DOI、arXiv id、裸 URL。"""
    entries: List[Entry] = []
    seen = set()

    for m in re.finditer(r"10\.\d{4,9}/[^\s\)\]\},;]+", text):
        doi = m.group(0).rstrip(".")
        if doi.lower() in seen:
            continue
        seen.add(doi.lower())
        entries.append(Entry(key=f"doi:{doi}", title="", doi=doi, source=source))

    for m in re.finditer(r"arXiv[:\s]*(\d{4}\.\d{4,5})(v\d+)?", text, re.IGNORECASE):
        aid = m.group(1)
        if ("arxiv:" + aid).lower() in seen:
            continue
        seen.add(("arxiv:" + aid).lower())
        entries.append(Entry(key=f"arxiv:{aid}", title="", arxiv=aid, source=source))

    return entries


# ────────────────────────────── 网络查询 ──────────────────────────────

def _session(mailto: str) -> requests.Session:
    s = requests.Session()
    s.headers.update({"User-Agent": UA.format(mailto=mailto)})
    return s


def crossref_by_doi(sess: requests.Session, doi: str) -> Optional[Dict[str, Any]]:
    for attempt in range(3):
        try:
            r = sess.get(f"{CROSSREF}/{doi}", timeout=TIMEOUT)
            if r.status_code == 200:
                return r.json().get("message", {})
            if r.status_code == 404:
                return None
            if 500 <= r.status_code < 600:
                time.sleep(1.5 * (attempt + 1))
                continue
            return None
        except requests.RequestException:
            time.sleep(1.5 * (attempt + 1))
    return None


def crossref_search(sess: requests.Session, title: str, author: str = "", year: Optional[int] = None) -> List[Dict[str, Any]]:
    if not title:
        return []
    params = {"query.bibliographic": title, "rows": 5}
    if author:
        params["query.author"] = author
    if year:
        params["filter"] = f"from-pub-date:{year - 1},until-pub-date:{year + 1}"
    try:
        r = sess.get(CROSSREF, params=params, timeout=TIMEOUT)
        if r.status_code == 200:
            return r.json().get("message", {}).get("items", [])
    except requests.RequestException:
        pass
    return []


_ARXIV_ENTRY = re.compile(r"<entry>(.*?)</entry>", re.DOTALL)


def arxiv_lookup(sess: requests.Session, aid: str) -> Optional[Dict[str, Any]]:
    try:
        r = sess.get(ARXIV_API, params={"id_list": aid}, timeout=TIMEOUT)
        if r.status_code != 200:
            return None
        blob = _ARXIV_ENTRY.search(r.text)
        if not blob:
            return None
        seg = blob.group(1)
        title = re.search(r"<title>(.*?)</title>", seg, re.DOTALL)
        published = re.search(r"<published>(\d{4})", seg)
        authors = re.findall(r"<name>(.*?)</name>", seg)
        return {
            "title": _clean(title.group(1)) if title else "",
            "year": int(published.group(1)) if published else None,
            "authors": [_normalize_family(a) for a in authors],
            "container_title": "arXiv",
            "type": "posted-content",
            "source": "arxiv",
        }
    except requests.RequestException:
        return None


# ────────────────────────────── 比对 ──────────────────────────────

def _norm_title(t: str) -> str:
    return re.sub(r"[^a-z0-9\u4e00-\u9fff ]", " ", (t or "").lower())


def title_ratio(a: str, b: str) -> float:
    na, nb = _norm_title(a), _norm_title(b)
    if not na or not nb:
        return 0.0
    return difflib.SequenceMatcher(None, na, nb).ratio()


def _crossref_fields(msg: Dict[str, Any]) -> Dict[str, Any]:
    """把 CrossRef message 归一成我们比对用的形状。"""
    title = ""
    if msg.get("title"):
        title = msg["title"][0]
    elif msg.get("short-container-title"):
        title = msg["short-container-title"][0]

    year = None
    for k in ("published-print", "published-online", "published", "issued", "created"):
        dp = (msg.get(k) or {}).get("date-parts") or []
        if dp and dp[0] and dp[0][0]:
            year = int(dp[0][0])
            break

    authors = [_normalize_family(f"{a.get('given','')} {a.get('family','')}".strip())
               for a in (msg.get("author") or [])]

    container = ""
    if msg.get("container-title"):
        container = msg["container-title"][0]

    return {
        "title": title,
        "year": year,
        "authors": [a for a in authors if a],
        "container_title": container,
        "type": msg.get("type", ""),
        "doi": msg.get("DOI", ""),
        "cited_by": msg.get("is-referenced-by-count"),
        "source": "crossref",
    }


def compare(entry: Entry, auth: Dict[str, Any]) -> tuple[str, List[str], float]:
    """返回 (verdict, diffs, title_score)。"""
    diffs: List[str] = []
    ratio = title_ratio(entry.title, auth.get("title", "")) if entry.title else 1.0

    if entry.title and ratio < TITLE_WEAK:
        diffs.append(f"标题严重不符 (相似度 {ratio:.2f})：引用「{entry.title[:70]}」vs 权威「{(auth.get('title') or '')[:70]}」")
    elif entry.title and ratio < TITLE_OK:
        diffs.append(f"标题仅部分相符 (相似度 {ratio:.2f})")

    if entry.year and auth.get("year"):
        if abs(entry.year - auth["year"]) > YEAR_TOLERANCE:
            diffs.append(f"年份不符：引用 {entry.year} vs 权威 {auth['year']}")

    if entry.authors and auth.get("authors"):
        if entry.authors[0] not in auth["authors"]:
            diffs.append(f"第一作者不符：引用「{entry.authors[0]}」vs 权威首作者「{auth['authors'][0]}」")

    hard = [d for d in diffs if d.startswith("标题严重") or d.startswith("第一作者") or d.startswith("年份")]
    if hard:
        return "MISMATCH", diffs, ratio
    if diffs:
        return "PARTIAL", diffs, ratio
    return "VERIFIED", diffs, ratio


# ────────────────────────────── 单条核查 ──────────────────────────────

def audit(entry: Entry, sess: Optional[requests.Session]) -> Verdict:
    v = Verdict(entry=entry)

    if sess is None:
        v.verdict = "SKIPPED"
        v.notes.append("离线模式：未做网络核查")
        return v

    auth: Optional[Dict[str, Any]] = None

    if entry.doi:
        msg = crossref_by_doi(sess, entry.doi)
        if msg:
            auth = _crossref_fields(msg)
    if auth is None and entry.arxiv:
        hit = arxiv_lookup(sess, entry.arxiv)
        if hit:
            auth = hit
            v.notes.append("经 arXiv API 核实（预印本）")
    if auth is None and entry.title:
        for item in crossref_search(sess, entry.title, entry.authors[0] if entry.authors else "", entry.year):
            cand = _crossref_fields(item)
            if title_ratio(entry.title, cand.get("title", "")) >= TITLE_WEAK:
                auth = cand
                v.notes.append("无标识符，按标题检索命中——需人工确认是否同一篇")
                break

    if auth is None:
        v.verdict = "NOT_FOUND" if (entry.doi or entry.arxiv) else "NO_IDENTIFIER"
        if entry.doi:
            v.notes.append(f"CrossRef 查无此 DOI：{entry.doi}")
        elif entry.arxiv:
            v.notes.append(f"arXiv 查无此编号：{entry.arxiv}")
        else:
            v.notes.append("条目无 DOI / arXiv 编号，且标题检索无命中")
        return v

    verdict, diffs, ratio = compare(entry, auth)
    v.verdict = verdict
    v.diffs = diffs
    v.score = round(ratio, 3)
    v.cited_by = auth.get("cited_by")
    v.matched = {k: auth.get(k) for k in ("title", "year", "container_title", "type", "doi", "source")}

    if auth.get("type") == "posted-content":
        v.notes.append("预印本（未同行评审）")
    if v.cited_by == 0:
        v.notes.append("被引 0 —— 新发表或影响面小，引用时确认必要性")
    return v


# ────────────────────────────── 报告 ──────────────────────────────

GLYPH = {
    "VERIFIED": "OK",
    "PARTIAL": "WARN",
    "MISMATCH": "MISMATCH",
    "NOT_FOUND": "MISSING",
    "NO_IDENTIFIER": "NO-ID",
    "SKIPPED": "SKIP",
    "ERROR": "ERROR",
}


def render_markdown(verdicts: List[Verdict], source: str) -> str:
    total = len(verdicts)
    tally: Dict[str, int] = {}
    for v in verdicts:
        tally[v.verdict] = tally.get(v.verdict, 0) + 1

    lines: List[str] = []
    lines.append("# 引文核查报告")
    lines.append("")
    lines.append(f"- 生成时间：{datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
    lines.append(f"- 核查对象：{source or '(命令行)'}")
    lines.append(f"- 条目总数：{total}")
    lines.append("")
    lines.append("## 结论分布")
    lines.append("")
    lines.append("| 判定 | 数量 | 含义 |")
    lines.append("| --- | --- | --- |")
    meaning = {
        "VERIFIED": "存在且字段一致",
        "PARTIAL": "存在，个别字段有出入",
        "MISMATCH": "存在，但标题/作者/年份对不上",
        "NOT_FOUND": "**查无此文献（疑似幻觉引用）**",
        "NO_IDENTIFIER": "无标识符且检索无命中，无法核实",
        "SKIPPED": "未核查（离线）",
        "ERROR": "核查过程出错",
    }
    for k in VERDICTS:
        if tally.get(k):
            lines.append(f"| {k} | {tally[k]} | {meaning[k]} |")
    lines.append("")

    risky = [v for v in verdicts if v.verdict in ("NOT_FOUND", "MISMATCH", "NO_IDENTIFIER")]
    if risky:
        lines.append("## 需要处理（按严重度排序）")
        lines.append("")
        for v in risky:
            lines.append(f"### [{GLYPH[v.verdict]}] {v.entry.key}")
            if v.entry.title:
                lines.append(f"- 引用标题：{v.entry.title}")
            if v.entry.doi:
                lines.append(f"- DOI：{v.entry.doi}")
            if v.entry.arxiv:
                lines.append(f"- arXiv：{v.entry.arxiv}")
            for d in v.diffs:
                lines.append(f"- {d}")
            for n in v.notes:
                lines.append(f"- {n}")
            lines.append("")

    lines.append("## 全量明细")
    lines.append("")
    lines.append("| 判定 | Key | 标题 | 年份 | 被引 | 相似度 |")
    lines.append("| --- | --- | --- | --- | --- | --- |")
    for v in verdicts:
        title = (v.entry.title or (v.matched or {}).get("title") or "")[:60].replace("|", "/")
        year = v.entry.year or (v.matched or {}).get("year") or ""
        cited = "" if v.cited_by is None else v.cited_by
        score = "" if v.score is None else f"{v.score:.2f}"
        lines.append(f"| {GLYPH[v.verdict]} | {v.entry.key} | {title} | {year} | {cited} | {score} |")
    lines.append("")
    return "\n".join(lines)


# ────────────────────────────── 入口 ──────────────────────────────

def main() -> int:
    ap = argparse.ArgumentParser(description="三层引文核查器（harvest-inno-reference-audit）")
    ap.add_argument("--bib", action="append", default=[], help="BibTeX 文件，可重复")
    ap.add_argument("--text", action="append", default=[], help="Markdown/文本，从中提取 DOI 与 arXiv 编号")
    ap.add_argument("--doi", action="append", default=[], help="直接指定 DOI，可重复")
    ap.add_argument("--out", help="输出 Markdown 报告路径")
    ap.add_argument("--json", dest="json_out", help="输出 JSON 结果路径")
    ap.add_argument("--mailto", default="research@example.com", help="CrossRef 礼貌池联系邮箱")
    ap.add_argument("--offline", action="store_true", help="离线：只做本地解析与去重，不发网络请求")
    args = ap.parse_args()

    if not (args.bib or args.text or args.doi):
        ap.error("至少给出 --bib / --text / --doi 之一")

    entries: List[Entry] = []
    for p in args.bib:
        f = Path(p)
        if not f.exists():
            sys.stderr.write(f"[SKIP:file] 不存在：{p}\n")
            continue
        entries.extend(parse_bibtex(f.read_text(encoding="utf-8", errors="replace"), source=str(f)))
    for p in args.text:
        f = Path(p)
        if not f.exists():
            sys.stderr.write(f"[SKIP:file] 不存在：{p}\n")
            continue
        entries.extend(extract_from_text(f.read_text(encoding="utf-8", errors="replace"), source=str(f)))
    for d in args.doi:
        entries.append(Entry(key=f"doi:{d}", doi=d.strip()))

    # 去重：同 DOI / 同 arXiv / 同 key 只留一条
    uniq: Dict[str, Entry] = {}
    for e in entries:
        sig = (e.doi or "").lower() or ("arxiv:" + e.arxiv.lower() if e.arxiv else "") or e.key.lower()
        uniq.setdefault(sig, e)
    entries = list(uniq.values())

    if not entries:
        sys.stderr.write("没有解析到任何引用条目。\n")
        return 1

    sess = None if args.offline else _session(args.mailto)
    verdicts: List[Verdict] = []
    for i, e in enumerate(entries, 1):
        sys.stderr.write(f"[{i}/{len(entries)}] {e.key}\n")
        try:
            verdicts.append(audit(e, sess))
        except Exception as exc:  # 单条失败不拖垮整轮
            v = Verdict(entry=e, verdict="ERROR")
            v.notes.append(f"核查异常：{exc}")
            verdicts.append(v)
        if sess is not None:
            time.sleep(0.12)  # CrossRef 礼貌限速

    report = render_markdown(verdicts, ", ".join(args.bib + args.text + args.doi))
    if args.out:
        Path(args.out).write_text(report, encoding="utf-8")
        print(f"报告已写入：{args.out}")
    else:
        print(report)

    if args.json_out:
        payload = [{"key": v.entry.key, "verdict": v.verdict, "diffs": v.diffs,
                    "notes": v.notes, "score": v.score, "cited_by": v.cited_by,
                    "matched": v.matched, "entry": asdict(v.entry)} for v in verdicts]
        Path(args.json_out).write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
        print(f"JSON 已写入：{args.json_out}")

    risky = sum(1 for v in verdicts if v.verdict in ("NOT_FOUND", "MISMATCH", "NO_IDENTIFIER"))
    print(f"\n合计 {len(verdicts)} 条，需处理 {risky} 条。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
