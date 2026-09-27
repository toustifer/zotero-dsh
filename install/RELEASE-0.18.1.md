## 修了什么

Zotero 10 上面板一直显示"加载失败"，且没有任何可用报错。

根因：Zotero 10 的 `PageData` actor 删掉了 `loadURI` 消息（只剩 `prepareLoad`）。于是 `sendQuery("loadURI")` 不再抛错，而是安静地 resolve 成 `undefined` —— 浏览器停在 `about:blank`，代码却以为导航已提交。

改成 Zotero 10 自己的做法（见 `chrome/content/zotero/HiddenBrowser.mjs`）：

1. `PageData.sendQuery("prepareLoad")`
2. 父进程 `browser.loadURI(Services.io.newURI(url), { triggeringPrincipal: getSystemPrincipal() })`

旧的 `sendQuery("loadURI")` 保留为回退，Zotero 9 行为不变。

## 顺带修掉的两个坑

`register-zotero-addon.py` 现在会检测 Zotero 是否在运行并拒绝写入。Zotero 退出时会用内存里的插件表覆写 `extensions.json`，运行期间写进去的记录会被静默抹掉 —— 现象是"装的时候一切正常，重启后插件没加载"，很难查。（macOS 上别用 `pgrep -x Zotero` 判断：Zotero 的进程名是小写 `zotero`，带 `-x` 的精确匹配是假阴性。）

注册的版本号改为从 xpi 的 `manifest.json` 读取，不再和脚本里的常量两处手改 —— 那两处迟早会漂。

## 安装

macOS / Linux：

```bash
bash install-dsh.sh
```

Windows：

```powershell
pwsh -File install-dsh.ps1
```
