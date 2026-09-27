#!/usr/bin/env python3
"""
把 zotero-dsh 注册进一个 Zotero profile —— 用于 Zotero 10 上无法用图形界面安装的场合。

为什么需要它：Zotero 10 只看 extensions.json 里的记录，把 .xpi 丢进 extensions/
目录本身不够（10 之前的版本会扫描目录，10 不会）。本脚本复刻 Zotero 自己的
sideload 行为：把 xpi 放进 extensions/，再按同 profile 里已有 sideload 插件的
记录形状写一条新记录。

关键点：记录形状是从同 profile 里"已经装好的"某个 sideload 插件抄来的，
不是硬编码 —— 不同 Zotero 大版本的 extensions.json schema 会变，
照抄现成的记录比对着文档猜安全。抄不到就退出，不瞎写。

用法：
  python3 register-zotero-addon.py --xpi /path/to/zotero-dsh.xpi
  python3 register-zotero-addon.py --xpi ... --profile-dir "<profile path>"
  python3 register-zotero-addon.py --list          # 只列出 profile 和已装插件

运行前请退出 Zotero：它会覆写 extensions.json。
"""
import argparse
import json
import os
import glob
import sys
import time
import urllib.parse

ADDON_ID = "zotero-dsh@fisfzy.local"
ADDON_VERSION = "0.18.0"
ADDON_NAME = "Zotero DSH"
ADDON_DESC = "Embed DeepSeek Harness chat panel in Zotero."


def candidate_profiles():
    home = os.path.expanduser("~")
    roots = [
        os.path.join(home, "Library", "Application Support", "Zotero", "Profiles"),  # macOS
        os.path.join(home, ".zotero", "zotero"),                                     # Linux
        os.path.join(os.environ.get("APPDATA", ""), "Zotero", "Zotero", "Profiles"), # Windows
    ]
    out = []
    for root in roots:
        if root and os.path.isdir(root):
            out.extend(sorted(p for p in glob.glob(os.path.join(root, "*")) if os.path.isdir(p)))
    return out


def pick_profile(explicit):
    if explicit:
        return os.path.expanduser(explicit)
    cands = candidate_profiles()
    if not cands:
        sys.exit("no Zotero profile found — pass --profile-dir")
    if len(cands) == 1:
        return cands[0]
    print("multiple profiles, pick one with --profile-dir:")
    for c in cands:
        print("  " + c)
    sys.exit(1)


def load(path):
    with open(path, encoding="utf-8") as fh:
        return json.load(fh)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--xpi")
    ap.add_argument("--profile-dir")
    ap.add_argument("--list", action="store_true")
    args = ap.parse_args()

    if args.list:
        for p in candidate_profiles():
            ej = os.path.join(p, "extensions.json")
            n = len(load(ej).get("addons", [])) if os.path.isfile(ej) else 0
            print("%s  (%d addons)" % (p, n))
        return

    if not args.xpi:
        sys.exit("--xpi is required (or use --list)")
    xpi = os.path.abspath(os.path.expanduser(args.xpi))
    if not os.path.isfile(xpi):
        sys.exit("xpi not found: " + xpi)

    profile = pick_profile(args.profile_dir)
    ej = os.path.join(profile, "extensions.json")
    if not os.path.isfile(ej):
        sys.exit("no extensions.json in " + profile)

    doc = load(ej)
    addons = doc.get("addons", [])

    # 从一个已存在的 sideload 记录学形状；抄不到就停手
    template = None
    for a in addons:
        info = a.get("installTelemetryInfo") or {}
        if info.get("method") == "sideload" or a.get("foreignInstall"):
            template = dict(a)
            break
    if template is None:
        template = dict(addons[-1]) if addons else None
    if template is None:
        sys.exit("extensions.json has no record to copy the schema from — install any addon once, then re-run")

    dest = os.path.join(profile, "extensions", ADDON_ID + ".xpi")
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    with open(xpi, "rb") as src, open(dest, "wb") as dst:
        dst.write(src.read())

    now = int(time.time() * 1000)
    rec = dict(template)
    rec.update({
        "id": ADDON_ID,
        "syncGUID": "zoterodsh00001",
        "version": ADDON_VERSION,
        "type": "extension",
        "loader": None,
        "updateURL": "https://raw.githubusercontent.com/toustifer/zotero-dsh/main/packages/zotero-addon/updates.json",
        "installOrigins": None,
        "manifestVersion": 2,
        "defaultLocale": {
            "name": ADDON_NAME,
            "description": ADDON_DESC,
            "creator": "Fisfzy",
            "homepageURL": None,
            "developers": None,
            "translators": None,
            "contributors": None,
        },
        "visible": True,
        "active": True,
        "userDisabled": False,
        "appDisabled": False,
        "embedderDisabled": False,
        "installDate": now,
        "updateDate": now,
        "path": dest,
        "rootURI": "jar:file://" + urllib.parse.quote(dest) + "!/",
        "foreignInstall": True,
        "strictCompatibility": True,
        "locales": [],
        "targetApplications": [{"id": "zotero@zotero.org", "minVersion": "6.999", "maxVersion": "10.*.*"}],
        "targetPlatforms": [],
        "signedState": 0,
        "signedTypes": [],
        "signedDate": None,
        "seen": True,
        "dependencies": [],
        "icons": {},
        "iconURL": None,
        "blocklistState": 0,
        "blocklistURL": None,
        "startupData": None,
        "hidden": False,
        "installTelemetryInfo": {"source": "app-profile", "method": "sideload"},
        "recommendationState": None,
        "location": "app-profile",
    })

    backup = ej + ".bak-dsh"
    if not os.path.exists(backup):
        with open(backup, "w", encoding="utf-8") as fh:
            json.dump(doc, fh, indent=2, ensure_ascii=False)

    doc["addons"] = [a for a in addons if a.get("id") != ADDON_ID] + [rec]
    with open(ej, "w", encoding="utf-8") as fh:
        json.dump(doc, fh, indent=2, ensure_ascii=False)

    print("registered %s -> %s" % (ADDON_ID, dest))
    print("profile: %s (%d addons)" % (profile, len(doc["addons"])))
    print("restart Zotero to load it")


if __name__ == "__main__":
    main()
