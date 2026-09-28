## 会话为什么被判为 corrupt

面板报：

```
历史加载失败: stored session "zotero-paper-99L7JHSL" is corrupt:
  session event at seq 12 lacks an identified message
```

根因是插件注入上下文的方式不对。DSH 的 `agent.inject()` 签名是 `inject(message: UserMessage)`，落盘成 `user/message` 事件后，`dsh-session` 的校验器会要求 `role` 和 `id`：

```js
const message = type === "user/message" ? record : record?.["message"];
if (typeof message["id"] !== "string" || message["id"] === "")
  throw new Error(`${subject} lacks an identified message`);
```

而这里只传了 `{ content, source }`，写出来的事件没有 `id` 也没有 `role`。**会话当场能用** —— 只有下一次重新加载、重放事件日志时才会暴露，所以这个 bug 藏了很久。

三处 `agent.inject({...})` 全部改成 `createUserMessage({ content, source })`，和 `followup` 走同一条构造路径。

审计了全部 15 个会话，只有那一个坏了（其余 `user/message` 全部合规）；坏的那条事件已就地补上 `id`/`role` 修复，历史内容完整保留。

**就地修复的坑**：不能整文件重压。DSH 要求 zstd 日志**第一帧恰好是一行 header**，剩下每帧一个事件。第一次用 `zstd -19` 整压，DSH 直接起不来：

```
corrupt Zstandard session log: first frame is not exactly one header line
```

现在按帧写：header 一帧，其余每条事件一帧。

## 每送一次选段就撞一次的 ApiSessionCwdConflict

从 Zotero 送选段进面板，日志里每次都多一条：

```
[dsh-zotero] sessionController.create failed (zotero-paper-99L7JHSL):
  session "zotero-paper-99L7JHSL" belongs to "D:\...\Active SLAM\Active view planning...",
  not "C:\Users\15775\.dsh-zotero"
```

根因在 DSH 的 `sessionController.create`（dsh-api-session-controller）：

```js
const cwd = workspace?.path ?? request.cwd ?? this.defaultCwd;
```

不带 workspaceId 也不带 cwd 调用时，请求的 cwd 就落在 **defaultCwd（DSH_HOME）** 上，
再拿去和会话持久化头里的 cwd 比对，不等即抛 `ApiSessionCwdConflict`（`createOrAdopt`）。
而本插件的论文会话 cwd 各自是论文工作区目录（`D:\...\_zcollections\...`），
**没有一个是 DSH_HOME**，所以这个调用必然每次都撞 —— 日志刷满，controller 那一趟白跑。

两处修：

- `ensureLiveAgent` 在没有 workspaceId 要挂时先看 `agents.get()`：已经有 live agent 就
  直接返回，根本不惊动 controller。
- 确实要走 controller 时，cwd 用**会话自己持久化头里的那个**（新增 `persistedCwdOf()`，
  先读 live agent、再走 `sessionPersistence.inspect`），而不是让 controller 落到
  defaultCwd。只有会话还没落盘（真新建）才用调用方给的 cwd。

## 一个坏会话日志会让整棵插件树加载失败

面板报的是：

```
Failed to load plugins
failed to import loader entry f995b8a8 (@deepseek-ai/dsh-client-hmr):
  client-modules: bundle script /plugins/??...&rev=... failed to load
```

看着像前端打包问题，实际是**后端启动就失败了**：

```
dsh: plugin tree failed to load: failed to apply loader entry include (cordis:include):
  failed to apply loader entry workspace (@deepseek-ai/dsh-workspace):
  corrupt Zstandard session log: first frame is not exactly one header line
```

DSH 启动扫描会话库时用 `readFirstZstdLine` 读每个日志的**第一帧**，要求它恰好是一行
header（`assertZstdHeaderFrame`），不满足就 fail closed —— 而**一个坏文件足以让整棵树
起不来**。写入被打断（进程被强杀，退出前正在创建会话）就会留下这样的半帧。它看起来像
间歇性故障，只是因为下一次启动不再撞上那个文件就一切正常。

新增 `heal-sessions.cjs`：启动前扫一遍会话库，把**确定**过不了这道校验的日志整个目录挪进
`sessions-quarantine/`。只挪不删；解不开的一律记为"无法判定"而不是"损坏" —— 宁可漏过一个
也不误杀一个真会话。它按脚本自身位置定位 DSH home（**刻意不读 `DSH_HOME`**：手动运行时会
拿到另一个 harness 的 home，那会把不该动的会话挪走），也支持显式传路径。

安装脚本会把它放到 DSH home 根目录。在启动 DSH 之前调用：

```
node "<DshHome>/heal-sessions.cjs"
```

## 顺手修掉的两个安装器问题

- `install-dsh.ps1` 里 `'presets\research'` 的 `\r` 是一个**真实的回车字节**（0x0D，
  不是转义序列），于是 `Test-Path` 永远失败 —— Windows 上其实从来没装上过 research 预设。
- 安装器取 tarball 用的是"列出第一个"，同一目录里放多个版本就可能装到旧的。改成按版本号
  排序取最新（PowerShell 转 `[version]`，bash 用 `sort -V`），旧的 `0.1.1` 一并删掉。
