# 安装

两步，都用[最新 Release](https://github.com/toustifer/zotero-dsh/releases/latest)上的**预构建产物**。
**不用编译**，不用 pnpm，不用 TypeScript，不用 DSH 源码。

## 前提

- **Zotero 7 / 9 / 10**
- **一个跑得起来的 DSH Web 实例**
- **macOS 额外一步**：Zotero 10 只认 `extensions.json` 里的记录，把 xpi 丢进
  `extensions/` 目录本身不会被加载 —— 见下面「macOS / Zotero 10」。

- **Zotero 7**
- **一个跑得起来的 DSH Web 实例**：`npm i -g @deepseek-ai/dsh`，然后 `dsh web`。
  没有 DSH，Zotero 侧没有可嵌入的东西

## 第一步 · Zotero 侧

下载 `zotero-dsh.xpi`，然后在 Zotero 里：

**工具 → 插件 → 右上角齿轮 → Install Plugin From File…** → 选中 xpi → 重启 Zotero

重启后点开任意条目，右侧栏会有 DSH 图标。面板里的地址解析是自动的：base 取自偏好项，
token 每次都从 DSH 实例的日志里现取，所以 DSH 重启不会让它失效。

## 第二步 · DSH 侧

先下两个文件到**同一个目录**：`dsh-zotero-0.2.0.tgz` 加上对应平台的安装脚本 ——
**Windows 用 `install-dsh.ps1`，macOS / Linux 用 `install-dsh.sh`**。

### Windows

```powershell
pwsh -File install-dsh.ps1
```

脚本只做三件事：

1. 把预构建的插件解到 `~/.dsh/plugins/dsh-zotero`
2. 在 profile 的 `node_modules/@dsh-external/` 下建一个 junction 指过去
3. 往 profile 的 `cordis.patch.yml` 补一次加载锚点（已经补过就跳过）

装到别的 profile：

```powershell
pwsh -File install-dsh.ps1 -Profile zotero
```

### macOS / Linux

```bash
bash install-dsh.sh
```

脚本做四件事：解包到 `~/.dsh/plugins/dsh-zotero`、装它唯一的运行依赖 `pdfjs-dist`、
在 profile 的 `node_modules/@dsh-external/` 下建符号链接、往 `cordis.patch.yml`
补一次加载锚点。

装到别的 profile、或 DSH 装在非默认位置：

```bash
bash install-dsh.sh --profile zotero
bash install-dsh.sh --home /custom/dsh-home
```

### 然后重启 DSH 实例

```bash
dsh web
```

## 装完之后

问 DSH 关于你 Zotero 库的事，它会调用 `zotero_*` 系列工具；DSH 的右侧栏会多出一个
Zotero 面板，论文、集合、标注、精读都能在里面走。

## 常见问题

**`-Profile` 报 profile not found**
先为那个 profile 启动一次 DSH，让它把目录建出来，再跑脚本。

**重跑 `dsh plugin install` 之后插件不见了**
pnpm 会重建 profile 的 `node_modules`，junction 被抹掉。**重跑一次安装脚本即可。**

**Zotero 面板显示 401**
DSH 实例不在跑，或者它的日志不在脚本预期的位置。解析顺序是
`~/.dsh-zotero/web-3081.log` → `~/.dsh/restart-web.stdout.log` → `~/.dsh/web.stdout.log`，
各自取最后一条 `dsh web:` 行。诊断写在 `~/.dsh/zdsh-diag.log`。

## macOS / Zotero 10

在 macOS 上真机装过一次，有两个和 Windows 不同的地方。

**一、Zotero 10 不扫描 `extensions/` 目录。** 把 xpi 放进去不算数，必须在
`extensions.json` 里有一条记录。图形界面装当然可以，但要脚本化就用：

```bash
python3 register-zotero-addon.py --xpi zotero-dsh.xpi
```

它的做法是**从同一个 profile 里已有的一条 sideload 记录抄 schema**，而不是对着文档
猜 —— 各大版本的 `extensions.json` 字段会变。抄不到就退出，不瞎写。先跑
`--list` 可以看它认出了哪些 profile、各自装了几个插件。

**跑之前请退出 Zotero**：它会覆写 `extensions.json`。

**二、Local API 的开关要写进 `user.js`，不能写 `prefs.js`。**
`prefs.js` 自己带着警告：「If you make changes to this file while the application is
running, the changes will be overwritten when the application exits」——
我第一次就是这么丢的。

```bash
cat >> "$HOME/Library/Application Support/Zotero/Profiles/<profile>/user.js" <<'EOF'
user_pref("extensions.zotero.httpServer.enabled", true);
user_pref("extensions.zotero.httpServer.localAPI.enabled", true);
EOF
```

不开的话 `zotero_*` 全部报 "Local API is not enabled"，Zotero 侧的面板也只能
显示空的。验证：`curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:23119/api/users/0/items?limit=1`
应该回 200。

**三、peer 依赖。** 宿主代码 import `@deepseek-ai/dsh-tools` / `dsh-llm` /
`schemastery` / `cordis`，这些是 peer，tarball 里没有。`install-dsh.sh`
会把它们从 `$DSH_HOME/profiles/node_modules/@deepseek-ai/` 链过去 —— 缺这一步启动直接
`ERR_MODULE_NOT_FOUND`。第一次在 Mac 上就是卡在这里。

实测环境：macOS 26.6.2 arm64 · Node 26.8.1 · DSH 0.1.5-rc.1 · Zotero 10.0.4。

## 跨机：让另一台机器用同一个 DSH

**DSH 只能绑 loopback，这条路是封死的。** 试过 `--host 0.0.0.0`，它直接拒绝：

```
error: --host 0.0.0.0 is intentionally not supported yet for safety:
it would expose remote code execution to the network; use 127.0.0.1 instead
```

（`--host` 的 schema 也只接受 `127.0.0.1` 与 `0.0.0.0`，填具体网卡地址会被判定为非法配置。）
所以跨机访问走 **SSH 隧道** —— 这也正好保证只有一个 DSH 实例：另一台机器是**转发进来**，
而不是自己再起一个。

在要用它的那台机器上：

```bash
ssh -N -L 127.0.0.1:13081:127.0.0.1:3080 <user>@<dsh-host>
```

然后浏览器开 `http://127.0.0.1:13081/?token=<那台机器上那个 token>`。

**端口约定**：Zotero 研究工作台统一用 **3081**（`dsh web --port 3081 --no-open`）。
Windows 那边如果同时开着 3080，那是另一件事（当前会话的宿主），别混。

放进 `~/.ssh/config` 更省事：

```
Host mac-dsh
    HostName 100.72.122.75
    User stifer
    LocalForward 127.0.0.1:13081 127.0.0.1:3080
    ExitOnForwardFailure yes
    ServerAliveInterval 15
    ServerAliveCountMax 3
    RequestTTY no
```

```bash
ssh -N mac-dsh        # 挂上隧道，之后开 http://127.0.0.1:13081/
```

**为什么 DSH 那台必须是 Mac**：`dsh-zotero` 要读 Zotero 的 Local API，而那个接口同样
只绑 loopback（`127.0.0.1:23119`，实测 Zotero 不接受任何其它地址）。两者必须同机。

## 为什么不用 `dsh plugin install`

这个包还没发到 npm。而且它的构建依赖 DSH 内部的 `@deepseek-ai/*` 包（部分是 peer、
部分根本没发包），从源码装需要先有 DSH 环境再手动 link 一遍——`pnpm install` 在干净机器上
会直接 404。所以这里发预构建产物，把整条构建链跳过。

想自己构建的话看根 [README](../README.md) 的开发一节。
