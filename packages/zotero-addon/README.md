# zotero-dsh

在 Zotero 中嵌入 DeepSeek Harness（DSH）对话面板。

与 `dsh-zotero` 互补：后者让你在 DSH 里读 Zotero，本插件让你在 Zotero 里用 DSH。

## 结构

```
addon/
  manifest.json                  Zotero 7+ 插件元数据
  bootstrap.js                   生命周期钩子（startup/shutdown/window）
  content/
    dshChat.xhtml                承载 DSH 的 chrome 窗口
    chat.js                      窗口内脚本：解析 URL 并挂载 iframe
    scripts/zotero-dsh.js        宿主模块：菜单注入 + token 解析
build.ps1                       打包 xpi
```

## 快速开始（开发模式）

1. 确认 DSH 在跑：`dsh --profile web`
2. Zotero → 工具 → 开发者 → 从文件安装插件… 选择 `addon/manifest.json`
   （Zotero 7 的入口是 **Tools → Developer → Load Plugin From Manifest**）
3. 重启 Zotero 或热重载插件
4. 菜单 **工具 → DSH 助手** 打开面板

## 鉴权

DSH web 每次启动随机生成 token，且**不持久化**，只打印在启动行：

```
dsh web: http://127.0.0.1:3081/?token=<...>
```

**token 一律现取，绝不复用偏好项里的旧值** —— 这是 0.17.0 修掉的坑：
旧实现只要偏好项里带 token 就直接返回，于是 DSH 一重启，面板就停在 401 页。

现在的解析规则：

1. **base 来自偏好项** `extensions.zotero-dsh.url`（剥掉 token 部分），缺省 `http://127.0.0.1:3081/`
2. **token 从候选日志里现取**，按优先级：`~/.dsh-zotero/web-3081.log`（隔离实例）→ `~/.dsh/restart-web.stdout.log` → `~/.dsh/web.stdout.log`
3. 取每个日志里**最后一条** `dsh web:` 行的 token；超过 512 KB 的日志只扫尾部
4. 候选日志都读不到，才退回偏好项原值（可能已过期，但总比没有地址强）

所以**换实例只改端口**，token 不用管：

```js
Zotero.Prefs.set("extensions.zotero-dsh.url", "http://127.0.0.1:3081/", true)
```

诊断落在 `~/.dsh/zdsh-diag.log`，每次解析都留痕：

```
startup v0.17.0
resolve base=http://127.0.0.1:3081/ token=43ch prefHadToken=false
embed: sendQuery loadURI ok=true
embed probe title="DeepSeek Harness" uri=http://127.0.0.1:3081/?token=***
```

`embed probe` 是落地回读：导航提交成功不等于页面正确（401 页同样返回 ok），
所以挂载后回读 `contentTitle` 再确认一次。


## 已知边界

- DSH 未设置 `X-Frame-Options`，允许被 iframe（已实测）。
- `/api` 有 browser-trust fence（检查 Origin）。若 iframe 内接口被拒，启动 DSH 时加
  `--trusted-host <authority>` 把宿主放行。
- 窗口内 iframe 的会话独立于系统浏览器，token 失效后需重新取。
- 当前只有 Tools 菜单入口；右侧栏 section / 标签页入口尚未做。
