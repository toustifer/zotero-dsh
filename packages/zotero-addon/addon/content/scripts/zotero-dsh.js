/**
 * Zotero DSH — host module.
 *
 * 1. resolve the DSH web URL (port + auth token)
 * 2. register the right-hand item-pane section (sidenav button -> DSH panel)
 * 3. register a Tools-menu entry as a secondary entry point
 */

var ZoteroDSH = {
  id: "zotero-dsh@fisfzy.local",
  // 由 bootstrap.js 经 loadSubScript 的 sandbox 注入；兜底值只是给脱壳运行留的。
  version: (typeof addonVersion !== "undefined" && addonVersion) || "0.0.0",

  PREF_URL: "extensions.zotero-dsh.url",
  MENU_ID: "zotero-dsh-tools-item",
  MENU_TARGET: "main/menubar/tools",
  SECTION_ID: "zotero-dsh-pane",
  NAMESPACED_PANE_ID: "zotero-dsh\\@fisfzy\\.local-zotero-dsh-pane",
  SIDENAV_ICON: "chrome://zotero-dsh/content/icons/dsh-20.svg",
  HEADER_ICON: "chrome://zotero-dsh/content/icons/dsh-20.svg",
  CHAT_WINDOW_TYPE: "zotero-dsh:chat",
  CHAT_URL: "chrome://zotero-dsh/content/dshChat.xhtml",
  DEFAULT_BASE: "http://127.0.0.1:3081/",
  TOKEN_RE: /[?&]token=[A-Za-z0-9_\-]+/g,

  /**
   * dsh 每次重启都换 token，所以 token 只能现取，不能信 pref 里的旧值。
   * 候选日志按优先级排列：隔离实例（3081）在前，默认实例兜底。
   */
  TOKEN_LOGS: [
    [".dsh-zotero", "web-3081.log"],
    [".dsh", "restart-web.stdout.log"],
    [".dsh", "web.stdout.log"],
  ],

  /** 单次扫描日志的上限：只读尾部，避免长跑实例的日志把面板拖住。 */
  TOKEN_SCAN_BYTES: 512 * 1024,

  _menuRegistered: false,
  _sectionRegistered: false,

  log(msg) {
    Zotero.debug("[zotero-dsh] " + msg);
    this.diag(msg);
  },

  _diagQueue: Promise.resolve(),

  /** 独立落盘诊断：不依赖 Zotero 的 debug 输出通道，且串行化避免并发覆盖。 */
  diag(msg) {
    const line = new Date().toISOString() + " | " + msg + "\n";
    this._diagQueue = this._diagQueue.then(async () => {
      try {
        const home = Services.dirsvc.get("Home", Components.interfaces.nsIFile).path;
        const p = PathUtils.join(home, ".dsh", "zdsh-diag.log");
        let old = "";
        try { old = await IOUtils.readUTF8(p); } catch (e) {}
        await IOUtils.writeUTF8(p, old + line);
      } catch (e) {}
    });
    return this._diagQueue;
  },

  /**
   * register() 内部的 itempane refresh 通知在 startup 阶段会被丢弃
   * （itemDetails.notify 要求 this.item 存在），之后没有事件再触发，
   * 自定义 section 就一直不生成。这里主动补触发，renderCustomSections 按
   * updateID 去重，幂等安全。
   */
  forcePaneSync() {
    [2000, 5000, 9000, 15000, 24000, 35000].forEach((d) => setTimeout(() => {
      try {
        const w = Zotero.getMainWindow();
        if (!w) { this.diag("forceSync t+" + d + ": no main window"); return; }
        let n = 0;
        const named = w.document.querySelectorAll("item-details");
        if (named.length) {
          for (const el of named) {
            if (typeof el.renderCustomSections === "function") { el.renderCustomSections(); n++; }
          }
        }
        if (!n) {
          const all = w.document.querySelectorAll("*");
          for (const el of all) {
            if (typeof el.renderCustomSections === "function") { el.renderCustomSections(); n++; }
          }
        }
        this.diag("forceSync t+" + d + ": named=" + named.length + " invoked=" + n);
        this.unhideMyButton(w, d);
      } catch (e) { this.diag("forceSync t+" + d + " failed: " + e); }
    }, d));
  },

  /**
   * Zotero 在「未查看条目」时切到默认布局模式（itemPane.js 里
   * toggleDefaultStatus(!isViewingItem)），该模式只显示内置 7 个 pane，
   * 第三方注册的一律 hidden。这里把我们的按钮单独放出来。
   */
  unhideMyButton(win, delay) {
    try {
      const names = win.document.querySelectorAll("item-pane-sidenav");
      const key = this.NAMESPACED_PANE_ID;
      names.forEach((nav) => {
        let btn = null;
        const cands = nav.querySelectorAll(".btn[data-pane]");
        for (const c of cands) { if (c.getAttribute("data-pane") === key) { btn = c; break; } }
        if (!btn) {
          this.diag("unhide t+" + delay + ": btn absent nav(defaultStatus=" + nav._defaultStatus + ")");
          return;
        }
        const before = btn.parentElement.hidden;
        if (before) {
          btn.parentElement.hidden = false;
          this.diag("unhide t+" + delay + ": UNHID (defaultStatus=" + nav._defaultStatus + ")");
        } else {
          this.diag("unhide t+" + delay + ": already visible");
        }
      });
    } catch (e) { this.diag("unhide failed: " + e); }
  },

  /** 直接问 sidenav：按钮在不在、是不是被 hidden。 */
  probeSidenav(win) {
    [3000, 8000, 16000, 26000].forEach((delay) => setTimeout(() => this._probeOnce(win, delay), delay));
  },

  _probeOnce(win, delay) {
    {
      const tag = "t+" + delay + "ms ";
      try {
        const doc = win.document;
        const nav = doc.querySelector("item-pane-sidenav");
        if (!nav) { this.diag(tag + "item-pane-sidenav NOT FOUND"); return; }
        const btns = nav.querySelectorAll(".btn");
        const ids = Array.prototype.map.call(btns, (b) => b.dataset.pane).join(",");
        this.diag(tag + "buttons=" + btns.length + " => " + ids);
        this.diag(tag + "_defaultStatus=" + nav._defaultStatus);
        if (typeof nav.getEnabledPane === "function") {
          this.diag(tag + "getEnabledPane=" + nav.getEnabledPane(this.SECTION_ID));
        }
        // sidenav 按钮的 data-pane 是 "<pluginID>-<paneID>"，不是裸 paneID ——
        // 用精确匹配永远查不到，日志里那句 "button MISSING" 一直是假的。
        const t = nav.querySelector('[data-pane$="' + this.SECTION_ID + '"]');
        if (t) {
          this.diag(tag + "button EXISTS hidden=" + t.parentElement.hidden);
        } else {
          this.diag(tag + "button MISSING from sidenav");
        }
        const paneEl = doc.querySelector('item-pane-custom-section[data-pane-id="' + this.SECTION_ID + '"]')
          || doc.querySelector("item-pane-custom-section");
        this.diag(tag + "customSectionEl=" + !!paneEl
          + (paneEl ? " data-sidenav-options=" + String(paneEl.dataset.sidenavOptions) : ""));
      } catch (e) { this.diag(tag + "probe failed: " + e); }
    }
  },

  /* ---------- URL / token ---------- */

  appendToken(base, token) {
    const sep = base.indexOf("?") === -1 ? "?" : "&";
    return base + sep + "token=" + token;
  },

  /** 读一个日志的尾部；超大文件只取最后 TOKEN_SCAN_BYTES 字节。 */
  async readLogTail(logPath) {
    const limit = this.TOKEN_SCAN_BYTES;
    try {
      const st = await IOUtils.stat(logPath);
      if (typeof st.size === "number" && st.size > limit) {
        const bytes = await IOUtils.read(logPath, { offset: st.size - limit, maxBytes: limit });
        // 从中间切开的首字节可能不是字符边界，容忍替换字符即可。
        return new TextDecoder("utf-8").decode(bytes);
      }
    } catch (e) { /* stat 失败就退回整读 */ }
    return await IOUtils.readUTF8(logPath);
  },

  /**
   * 取当前实例的 token：逐个候选日志找最后一条 `dsh web:` 行。
   * 第一个读到的就用 —— 3081 优先，所以隔离实例不会被默认实例的 token 顶掉。
   */
  async readTokenFromLog() {
    var home = null;
    try {
      home = Services.dirsvc.get("Home", Components.interfaces.nsIFile).path;
    } catch (e) { return null; }
    for (const entry of this.TOKEN_LOGS) {
      const logPath = PathUtils.join(home, entry[0], entry[1]);
      try {
        const txt = await this.readLogTail(logPath);
        const hits = txt.match(this.TOKEN_RE);
        if (hits && hits.length) return hits[hits.length - 1].replace(/^[?&]token=/, "");
      } catch (e) { /* 该日志不存在或不可读，试下一个 */ }
    }
    this.log("no token found in any candidate log");
    return null;
  },

  /** pref 里存的是完整地址，剥掉 token 只留 base（含端口）。 */
  baseFromUrl(url) {
    if (!url) return null;
    const cut = String(url).search(/[?&]token=/);
    const base = cut === -1 ? String(url) : String(url).slice(0, cut);
    return base || null;
  },

  /**
   * base 用 pref（没有就 DEFAULT_BASE），token 一律现取。
   * 旧实现只要 pref 里带 token 就直接返回，于是 dsh 一重启 token 就过期，
   * 面板停在 401 页 —— 这里是那次修复。
   */
  /** base 与 token 分开拿：内嵌面板要完整 URL，POST /quote 要能自己拼路径。 */
  async resolveParts() {
    var saved = null;
    try { saved = Zotero.Prefs.get(this.PREF_URL, true); } catch (e) {}
    const base = this.baseFromUrl(saved) || this.DEFAULT_BASE;
    const token = await this.readTokenFromLog();
    // 只记长度，不落盘 token 本身。
    this.log("resolve base=" + base + " token=" + (token ? token.length + "ch" : "MISSING")
      + " prefHadToken=" + Boolean(saved && saved.indexOf("token=") !== -1));
    return { base, token, savedUrl: saved || null };
  },

  async resolveDSHUrl() {
    const { base, token, savedUrl } = await this.resolveParts();
    if (token) return this.appendToken(base, token);
    // 日志读不到时退回 pref 原值，可能已过期，但总比没有地址强。
    return savedUrl || base;
  },

  /** base + 插件 API 路径 + 现取的 token。 */
  async apiUrl(endpoint) {
    const { base, token } = await this.resolveParts();
    const root = String(base).replace(/\/+$/, "");
    return root + endpoint + (token ? "?token=" + token : "");
  },

  /* ---------- item pane section ---------- */

  registerItemPane() {
    try {
      if (!Zotero.ItemPaneManager || typeof Zotero.ItemPaneManager.registerSection !== "function") {
        this.log("ItemPaneManager unavailable");
        return false;
      }
      const ret = Zotero.ItemPaneManager.registerSection({
        paneID: this.SECTION_ID,
        pluginID: this.id,
        header: {
          l10nID: "zotero-dsh-panel-head",
          icon: this.HEADER_ICON,
        },
        sidenav: {
          l10nID: "zotero-dsh-panel-sidenav",
          icon: this.SIDENAV_ICON,
        },
        onInit: ({ setEnabled, body }) => {
          setEnabled(true);
          try {
            const pane = body && body.closest ? body.closest("item-pane-custom-section") : null;
            this.diag("onInit: setEnabled done; paneEl=" + !!pane
              + " sidenavOptions=" + (pane ? String(pane.dataset.sidenavOptions) : "n/a"));
          } catch (e) { this.diag("onInit probe failed: " + e); }
        },
        onItemChange: ({ setEnabled, item }) => {
          setEnabled(true);
          try { this.updatePaperBar(item); } catch (e) { this.diag("updatePaperBar failed: " + e); }
        },
        onRender: (args) => this.renderPane(args),
        onDestroy: (args) => {
          try {
            const f = args.body.querySelector("iframe[data-zotero-dsh]");
            if (f) f.remove();
          } catch (e) {}
        },
      });
      this._sectionRegistered = ret !== false;
      this.log("registerSection returned: " + JSON.stringify(ret));
      return this._sectionRegistered;
    } catch (e) {
      this.log("registerSection failed: " + e);
      return false;
    }
  },

  /* ---------- current paper bar ---------- */

  /** 面板顶部显示当前选中的论文。itemKey 同时也是后续会话映射的键。 */
  updatePaperBar(item) {
    const bar = this._paperBar;
    if (!bar) { return; }
    if (!item) { bar.textContent = "当前论文: (未选中)"; bar.setAttribute("title", ""); return; }
    let title = "", key = "", year = "";
    try { title = item.getField("title") || ""; } catch (e) {}
    try { key = item.key || ""; } catch (e) {}
    try { year = item.getField("date") ? String(item.getField("date")).slice(0, 4) : ""; } catch (e) {}
    if (!title) {
      // 可能是附件/笔记，退回父条目或显示类型
      try {
        const parent = item.parentItem;
        if (parent) { title = parent.getField("title") || ""; key = parent.key || key; }
      } catch (e) {}
    }
    if (!title) { try { title = item.getDisplayTitle ? item.getDisplayTitle() : ""; } catch (e) {} }
    const label = title ? (year ? "[" + year + "] " + title : title) : "(无标题条目)";
    bar.textContent = "当前论文: " + label;
    bar.setAttribute("title", label + (key ? "\nitemKey: " + key : ""));
    this._currentPaperKey = key || null;
    this.diag("paper: " + (key || "?"));
    // 选到哪篇，就为哪篇备好工作区 —— 不必手动点按钮。
    if (key) this.autoWorkspace(key);
  },

  /* ---------- embedded browser mode ---------- */

  /**
   * 在面板里嵌入真正的 DSH 界面。
   *
   * 三个必须同时满足的条件（缺任何一个都会静默失败或让 Zotero 崩溃）：
   *   1. createXULElement("browser")，不是 createElementNS / createElement
   *   2. type=content + remote=true + maychangeremoteness=true
   *   3. 导航必须走 browsingContext 的 PageData actor 的 sendQuery("loadURI")，
   *      直接调 browser.loadURI() 会 NS_ERROR_FAILURE
   * 这是 Zotero 自家 HiddenBrowser 的做法（chrome/content/zotero/HiddenBrowser.mjs）。
   */
  async mountEmbedded(doc, holder, url) {
    const br = doc.createXULElement("browser");
    br.setAttribute("type", "content");
    br.setAttribute("remote", "true");
    br.setAttribute("maychangeremoteness", "true");
    br.setAttribute("disableglobalhistory", "true");
    // 用视口高度自适应：item pane 高度不确定，vh 能保证在任何窗口尺寸下都撑满
    br.setAttribute("style", "display:block;flex:1 1 auto;width:100%;height:72vh;min-height:420px;border:0;background:#fff;");
    br.setAttribute("data-zotero-dsh-embed", "1");
    holder.appendChild(br);
    // 等 custom element 完成 construct，browsingContext 才可用
    await new Promise((r) => setTimeout(r, 500));
    const bc = br.browsingContext;
    if (!bc || !bc.currentWindowGlobal) {
      this.diag("embed: browsingContext not ready");
      return { ok: false, error: "browsingContext 未就绪" };
    }
    const actor = bc.currentWindowGlobal.getActor("PageData");

    // 两条导航路径，平台上确实不同：
    //   Zotero 9  —— PageData 的 sendQuery("loadURI") 直接完成导航
    //   Zotero 10 —— 改成先 sendQuery("prepareLoad")，再由**父进程**调
    //                browser.loadURI(newURI(url), { triggeringPrincipal })
    //                （见 HiddenBrowser.mjs：内容进程发起的加载被限制在它自己能
    //                 加载的 URL 上）。只走旧路在 10 上会返回 undefined 并停在
    //                about:blank —— 实测就是这个症状。
    let ok;
    try {
      const prepared = await actor.sendQuery("prepareLoad");
      if (prepared) {
        br.loadURI(Services.io.newURI(url), {
          triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
        });
        ok = true;
        this.diag("embed: prepareLoad + loadURI (zotero 10 path)");
      } else {
        this.diag("embed: prepareLoad returned false, falling back");
      }
    } catch (e) {
      this.diag("embed: prepareLoad path failed (" + e + "), falling back to sendQuery");
    }
    if (ok !== true) {
      ok = await actor.sendQuery("loadURI", { uri: url });
      this.diag("embed: sendQuery loadURI ok=" + ok);
    }
    // 导航提交成功不等于页面正确（401 页同样返回 ok），所以落地后回读标题。
    // 另外：DSH 重启期间这里必然拿到 "Problem loading page"，而面板不会自己恢复 ——
    // 所以看到错误页就退避重试，最多几轮。
    const isFailed = (title) => /Problem loading page|Server Not Found|Unable to connect|连接失败|无法连接/i.test(String(title || ""));
    let lastTitle = "";
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await new Promise((r) => setTimeout(r, attempt === 0 ? 2000 : 4000));
      let title = "";
      let cur = "";
      try { title = br.contentTitle || ""; } catch (e) {}
      try { cur = br.currentURI ? br.currentURI.spec : ""; } catch (e) {}
      lastTitle = title;
      this.diag("embed probe#" + attempt + " title=" + JSON.stringify(title)
        + " uri=" + String(cur).replace(/token=[^&]*/, "token=***"));
      if (title && !isFailed(title)) break;
      if (isFailed(title)) {
        // 实例多半还在重启：重新读一次 token（重启会换），再导航。
        try {
          const fresh = await this.resolveDSHUrl();
          if (fresh) url = fresh;
        } catch (e) {}
        try {
          const a2 = br.browsingContext && br.browsingContext.currentWindowGlobal
            ? br.browsingContext.currentWindowGlobal.getActor("PageData")
            : null;
          if (a2) {
            let sent = false;
            try {
              if (await a2.sendQuery("prepareLoad")) {
                br.loadURI(Services.io.newURI(url), {
                  triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
                });
                sent = true;
              }
            } catch (e) { /* fall through */ }
            if (!sent) await a2.sendQuery("loadURI", { uri: url });
            this.diag("embed retry#" + attempt + " navigation sent");
          }
        } catch (e) {
          this.diag("embed retry#" + attempt + " failed: " + e);
        }
      }
    }
    this.diag("embed final title=" + JSON.stringify(lastTitle));
    return { ok: !!ok, browser: br };
  },

  unmountEmbedded(doc) {
    try {
      doc.querySelectorAll("browser[data-zotero-dsh-embed]").forEach((b) => b.remove());
    } catch (e) {}
  },

  renderPane({ doc, body }) {
    if (!body) return;
    if (body.querySelector("[data-zotero-dsh-wrap]")) return;
    body.textContent = "";
    const NS = "http://www.w3.org/1999/xhtml";
    const el = (t, css, s2) => {
      const n = doc.createElementNS(NS, t);
      if (css) n.setAttribute("style", css);
      if (s2 != null) n.textContent = s2;
      return n;
    };

    const wrap = el("div", "height:100%;min-height:420px;display:flex;flex-direction:column;gap:6px;padding:8px;box-sizing:border-box;");
    wrap.setAttribute("data-zotero-dsh-wrap", "1");

    // 当前论文条：Zotero 侧就知道在看哪篇，后续用它做会话映射的键
    const paperBar = el("div", "flex:0 0 auto;font:10.5px/1.5 system-ui,sans-serif;padding:4px 7px;border-radius:4px;background:rgba(127,127,127,.10);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;");
    paperBar.textContent = "当前论文: (未选中)";
    this._paperBar = paperBar;
    wrap.appendChild(paperBar);

    // 选段回执：Zotero 侧自己渲染，不依赖 iframe 里的 DSH 会话被打开。
    // 送入成功后才显示，写明页码与前几十字；再送一段就替换。
    const quoteBar = el("div", "display:none;flex:0 0 auto;font:10px/1.5 system-ui,sans-serif;padding:4px 7px;border-radius:4px;background:rgba(64,114,229,.14);border-inline-start:3px solid #4072e5;overflow:hidden;");
    this._quoteBar = quoteBar;
    wrap.appendChild(quoteBar);

    // 为当前论文开一个工作区：记录与复现的落脚点。有 PDF 才建得出来。
    const wsRow = el("div", "display:flex;align-items:center;gap:6px;flex:0 0 auto;");
    const wsBtn = el("button", "font:10px system-ui;padding:2px 8px;border-radius:4px;cursor:pointer;", "为这篇论文建工作区");
    const wsState = el("span", "font:10px system-ui;opacity:.65;flex:1 1 auto;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;", "");
    wsBtn.addEventListener("click", () => this.makePaperWorkspace());
    wsRow.appendChild(wsBtn);
    wsRow.appendChild(wsState);
    this._paperWsBtn = wsBtn;
    this._paperWsState = wsState;
    wrap.appendChild(wsRow);

    const head = el("div", "display:flex;align-items:center;gap:6px;flex:0 0 auto;");
    head.appendChild(el("div", "font:12px system-ui;font-weight:600;", "DSH"));
    const status = el("div", "font:10px system-ui;opacity:.6;flex:1 1 auto;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;");
    head.appendChild(status);
    const cfgBtn = el("button", "font:10px system-ui;padding:2px 8px;border-radius:4px;cursor:pointer;", "设置");
    const reloadBtn = el("button", "font:10px system-ui;padding:2px 8px;border-radius:4px;cursor:pointer;", "重载");
    head.appendChild(cfgBtn); head.appendChild(reloadBtn);
    wrap.appendChild(head);

    const cfg = el("div", "display:none;flex-direction:column;gap:5px;flex:0 0 auto;font:10px system-ui;");
    const urlIn = el("input", "font:10px ui-monospace,monospace;padding:4px 6px;border-radius:4px;");
    urlIn.setAttribute("placeholder", "带 token 的完整地址");
    const saveBtn = el("button", "font:10px system-ui;padding:3px 10px;border-radius:4px;cursor:pointer;align-self:flex-start;", "保存并重载");
    cfg.appendChild(el("div", null, "DSH 地址")); cfg.appendChild(urlIn); cfg.appendChild(saveBtn);
    wrap.appendChild(cfg);

    const holder = el("div", "flex:1 1 auto;display:flex;flex-direction:column;min-height:400px;");
    wrap.appendChild(holder);
    body.appendChild(wrap);

    const load = async () => {
      try { this.unmountEmbedded(doc); } catch (e) {}
      holder.textContent = "";
      let u = null;
      try { u = await this.resolveDSHUrl(); } catch (e) { this.diag("resolve failed: " + e); }
      if (!u) {
        status.textContent = "未配置地址";
        try { urlIn.value = ""; } catch (e) {}
        cfg.style.display = "flex";
        return;
      }
      try { urlIn.value = u; } catch (e) {}
      status.textContent = "加载中...";
      const r = await this.mountEmbedded(doc, holder, u);
      status.textContent = r.ok ? "已连接" : ("加载失败: " + (r.error || "unknown"));
    };

    cfgBtn.addEventListener("click", () => {
      cfg.style.display = cfg.style.display === "flex" ? "none" : "flex";
      if (cfg.style.display === "flex") { try { urlIn.focus(); } catch (e) {} }
    });
    reloadBtn.addEventListener("click", () => { load(); });
    saveBtn.addEventListener("click", () => {
      const v = urlIn.value.trim();
      if (!v) return;
      try { Services.prefs.setStringPref("extensions.zotero-dsh.url", v); } catch (e) {}
      try { Zotero.Prefs.set("extensions.zotero-dsh.url", v, true); } catch (e) {}
      cfg.style.display = "none";
      load();
    });

    load();
  },
  unregisterItemPane() {
    try {
      if (Zotero.ItemPaneManager && typeof Zotero.ItemPaneManager.unregisterSection === "function") {
        Zotero.ItemPaneManager.unregisterSection(this.SECTION_ID);
      }
    } catch (e) {}
    this._sectionRegistered = false;
  },

  /* ---------- standalone window ---------- */

  openDSHChat(win) {
    const existing = Services.wm.getMostRecentWindow(this.CHAT_WINDOW_TYPE);
    if (existing && !existing.closed) { existing.focus(); return existing; }
    const target = win || Zotero.getMainWindow();
    return target.openDialog(this.CHAT_URL, "zotero-dsh-chat",
      "chrome,centerscreen,resizable,width=1000,height=820", {});
  },

  /* ---------- tools menu (secondary entry) ---------- */

  registerMenu() {
    try {
      if (!Zotero.MenuManager || typeof Zotero.MenuManager.registerMenu !== "function") {
        this.log("MenuManager unavailable");
        return false;
      }
      const id = Zotero.MenuManager.registerMenu({
        menuID: this.MENU_ID,
        pluginID: this.id,
        target: this.MENU_TARGET,
        menus: [{
          menuType: "menuitem",
          label: "DSH 助手",
          onCommand: () => ZoteroDSH.openDSHChat(Zotero.getMainWindow()),
        }],
      });
      this._menuRegistered = !!id;
      this.log("registerMenu -> " + id);
      return this._menuRegistered;
    } catch (e) {
      this.log("registerMenu failed: " + e);
      return false;
    }
  },

  unregisterMenu() {
    try {
      if (Zotero.MenuManager && typeof Zotero.MenuManager.unregisterMenu === "function") {
        Zotero.MenuManager.unregisterMenu(this.MENU_ID);
      }
    } catch (e) {}
    this._menuRegistered = false;
  },

  injectMenuFallback(win) {
    try {
      const doc = win.document;
      if (doc.getElementById(this.MENU_ID)) return;
      const popup = doc.getElementById("menu_ToolsPopup");
      if (!popup) return;
      const item = doc.createXULElement("menuitem");
      item.id = this.MENU_ID;
      item.setAttribute("label", "DSH 助手");
      item.addEventListener("command", () => ZoteroDSH.openDSHChat(win));
      popup.appendChild(item);
    } catch (e) {}
  },

  removeMenuFallback(win) {
    try {
      const el = win.document.getElementById(this.MENU_ID);
      if (el) el.remove();
    } catch (e) {}
  },

  /* ---------- PDF selection -> DSH ---------- */

  /**
   * 在阅读器里选中文字时，往气泡里加两个按钮。
   *
   * 「送入 DSH」= VSCode 聊天里 "Add to Chat" 的语义：只把选段推进该论文的会话上下文，
   * 用户接着自己写问题。「问 DSH」= 顺带追一轮，让模型直接回应这段。
   * 会话按 itemKey 懒开 —— 在 Zotero 里读到哪里选中就送，不必先打开面板。
   */
  registerSelectionActions() {
    try {
      if (!Zotero.Reader || typeof Zotero.Reader.registerEventListener !== "function") {
        this.log("Reader API unavailable; selection actions off");
        return false;
      }
      this._selectionHandler = (event) => {
        try {
          const doc = event.doc;
          const append = event.append;
          const annotation = event.params && event.params.annotation;
          if (!doc || typeof append !== "function" || !annotation) return;
          const text = String(annotation.text || "");
          if (!text.trim()) return;

          const page = String(annotation.pageLabel || "");
          const reader = event.reader;
          const itemID = reader && reader.itemID;
          const item = itemID ? Zotero.Items.get(itemID) : null;
          const itemKey = item ? String(item.key || "") : "";
          if (!itemKey) { this.diag("selection: no itemKey for reader item"); return; }

          // Zotero 没有行号。能给的最接近定位是「页码 + 页内矩形」：
          // sortIndex 是 Zotero 内部排序键（pageIndex|y|x，补零），rects 是 PDF 点单位。
          // 两者都原样带上，落盘时可复现。
          const locator = this.locatorOf(annotation, reader);

          const style = "font:11px system-ui;padding:2px 8px;margin-inline-start:4px;border-radius:4px;cursor:pointer;";
          const mk = (label, ask) => {
            const btn = doc.createElement("button");
            btn.textContent = label;
            btn.setAttribute("style", style);
            btn.addEventListener("click", (ev) => {
              ev.preventDefault();
              ev.stopPropagation();
              this.sendQuote({ itemKey, page, text, ask, locator });
            });
            return btn;
          };
          append(mk("送入 DSH", false));
          append(mk("问 DSH", true));
        } catch (e) {
          this.diag("selection popup failed: " + e);
        }
      };
      Zotero.Reader.registerEventListener("renderTextSelectionPopup", this._selectionHandler, this.id);
      this.log("selection actions registered");
      return true;
    } catch (e) {
      this.log("registerSelectionActions failed: " + e);
      return false;
    }
  },

  unregisterSelectionActions() {
    // 注意：unregisterEventListener 的第二个参数是 handler 本身，不是 pluginID。
    try {
      if (this._selectionHandler) {
        Zotero.Reader.unregisterEventListener("renderTextSelectionPopup", this._selectionHandler);
      }
    } catch (e) {}
    this._selectionHandler = null;
  },

  /* ---------- 当前选中的论文 → DSH ---------- */

  /**
   * 把「用户此刻在 Zotero 里选中哪条」推给 DSH。
   *
   * 为什么需要：DSH 那边注入提示词上下文只能读我们推上去的东西 —— 它够不到
   * Zotero 的选中状态。没有这条推送，模型每次都得先问"你指的是哪篇"，或者更糟：
   * 拿记忆里的论文硬答。这条推送就是让"当前论文"变成模型每轮都能看到的事实。
   *
   * 节流 1.5s：按住方向键在条目列表里连翻会连发 select，不节流会把 DSH 打满。
   */
  registerFocusWatcher() {
    try {
      if (!Zotero.Notifier || typeof Zotero.Notifier.registerObserver !== "function") {
        this.log("Notifier unavailable; focus watcher off");
        return false;
      }
      this._focusObserver = {
        notify: (event) => {
          if (event !== "select") return;
          this.scheduleFocusPush();
        },
      };
      // 只收 item 的 select。collection / tab 的选中不是"在读哪篇论文"。
      Zotero.Notifier.registerObserver(this._focusObserver, ["item"], this.id);
      this.log("focus watcher registered");
      // 补一次启动时的状态：Zotero 早就开着、用户也已经选好了，不会再产生 select 事件。
      setTimeout(() => this.scheduleFocusPush(), 3000);
      return true;
    } catch (e) {
      this.log("registerFocusWatcher failed: " + e);
      return false;
    }
  },

  unregisterFocusWatcher() {
    try {
      if (this._focusObserver) Zotero.Notifier.unregisterObserver(this._focusObserver);
    } catch (e) {}
    this._focusObserver = null;
    if (this._focusTimer) {
      try { clearTimeout(this._focusTimer); } catch (e) {}
      this._focusTimer = null;
    }
  },

  scheduleFocusPush() {
    if (this._focusTimer) return;
    this._focusTimer = setTimeout(() => {
      this._focusTimer = null;
      this.pushFocus().catch((e) => this.diag("pushFocus failed: " + e));
    }, 1500);
  },

  /** 从当前选中项抽字段推给 /focus。选中附件/笔记/空时什么都不做（保留上一次）。 */
  async pushFocus() {
    let payload = null;
    try {
      const win = Zotero.getMainWindow();
      const pane = win && win.ZoteroPane;
      const items = (pane && pane.getSelectedItems) ? pane.getSelectedItems() : [];
      // 附件和笔记也满足 isRegularItem() === false，要的是论文条目本身。
      const item = (items || []).find((it) => it && typeof it.isRegularItem === "function" && it.isRegularItem());
      if (!item) return;
      payload = this.focusPayloadOf(item);
    } catch (e) {
      this.diag("pushFocus: cannot read selection: " + e);
      return;
    }
    if (!payload || !payload.itemKey) return;

    // 同一条目 + 同一页重复推没有意义。
    const sig = payload.itemKey + "|" + payload.page;
    if (sig === this._focusSig) return;

    let url = null;
    try { url = await this.apiUrl("/@dsh-external/dsh-zotero/api/focus"); } catch (e) {}
    if (!url) return;
    this._focusSig = sig;
    try {
      const xhr = await Zotero.HTTP.request("POST", url, {
        body: JSON.stringify(payload),
        headers: { "Content-Type": "application/json" },
        responseType: "json",
        timeout: 15000,
      });
      this.diag("focus pushed key=" + payload.itemKey + " page=" + (payload.page || "-")
        + " status=" + (xhr ? xhr.status : "?"));
    } catch (e) {
      // 推失败就忘掉签名，下一次 select 还会再试 —— 否则 DSH 重启期间的失败会
      // 让这条记录一直卡在"推过了"的状态里。
      this._focusSig = null;
      this.diag("focus push failed: " + e);
    }
  },

  focusPayloadOf(item) {
    try {
      const creators = [];
      try {
        for (const c of item.getCreators() || []) {
          const name = c.lastName
            ? (c.lastName + (c.firstName ? " " + c.firstName : ""))
            : String(c.name || "");
          if (name) creators.push(name);
        }
      } catch (e) {}

      let collection = "";
      try {
        const cols = item.getCollections() || [];
        if (cols.length) {
          const c = Zotero.Collections.get(cols[0]);
          collection = c ? String(c.name || "") : "";
        }
      } catch (e) {}

      let attachmentPath = "";
      try {
        for (const id of item.getAttachments() || []) {
          const att = Zotero.Items.get(id);
          if (att && typeof att.isPDFAttachment === "function" && att.isPDFAttachment()) {
            attachmentPath = String(att.getFilePath() || "");
            break;
          }
        }
      } catch (e) {}

      const date = String(item.getField("date") || "");
      const yearMatch = date.match(/\d{4}/);

      return {
        itemKey: String(item.key || ""),
        title: String(item.getField("title") || ""),
        creators,
        year: yearMatch ? yearMatch[0] : "",
        collection,
        attachmentPath,
        page: this.currentReaderPage(item),
      };
    } catch (e) {
      this.diag("focusPayloadOf failed: " + e);
      return null;
    }
  },

  /**
   * 当前 reader 翻到第几页。
   *
   * Zotero 的 reader 状态是私有 API（Zotero.Reader._readers），版本之间会动，
   * 所以整段包在 try 里：取不到就返回空串，宁可少一个字段也不猜一个页码。
   */
  currentReaderPage(item) {
    try {
      const readers = Zotero.Reader && Zotero.Reader._readers;
      if (!Array.isArray(readers)) return "";
      const mine = readers.filter((r) => {
        if (!r) return false;
        if (r.itemID === item.id) return true;
        return !!(r._item && r._item.id === item.id);
      });
      if (!mine.length) return "";
      const state = mine[0].state || mine[0]._state || null;
      if (state && typeof state.pageIndex === "number") return String(state.pageIndex + 1);
      return "";
    } catch (e) {
      return "";
    }
  },

  /**
   * 从临时注解里抽出可复现的位置信息。
   *
   * Zotero 的注解没有行号 —— 它的定位单位是「页 + PDF 点矩形」。这里把矩形换算成
   * 相对页顶的百分比，读起来比裸坐标直观；同时保留 sortIndex 与原始 rects 供精确定位。
   */
  locatorOf(annotation, reader) {
    const out = {
      pageLabel: "",
      pageIndex: null,
      totalPages: null,
      lines: null,
      yTop: null,
      yBottom: null,
      lineHeight: null,
      xLeft: null,
      xRight: null,
      rects: null,
      sortIndex: "",
    };
    try {
      const raw = String(annotation.pageLabel || "");
      // 实测见过 pageLabel 被填成 "7510314" 这种长数字串（PDF 自己的页码解析失败），
      // 那种值当没有；短标签（"3"、"xii"）才是真的页码。
      out.pageLabel = /^[0-9]{6,}$/.test(raw) ? "" : raw;

      const pos = annotation.position;
      if (pos && typeof pos === "object") {
        if (typeof pos.pageIndex === "number") out.pageIndex = pos.pageIndex;
        const rects = Array.isArray(pos.rects) ? pos.rects : null;
        if (rects && rects.length) {
          out.rects = rects;
          let yTop = Infinity, yBottom = -Infinity, xLeft = Infinity, xRight = -Infinity;
          for (const r of rects) {
            if (!Array.isArray(r) || r.length < 4) continue;
            yTop = Math.min(yTop, Number(r[1]));
            yBottom = Math.max(yBottom, Number(r[3]));
            xLeft = Math.min(xLeft, Number(r[0]));
            xRight = Math.max(xRight, Number(r[2]));
          }
          if (Number.isFinite(yTop)) out.yTop = Math.round(yTop * 10) / 10;
          if (Number.isFinite(yBottom)) out.yBottom = Math.round(yBottom * 10) / 10;
          if (Number.isFinite(xLeft)) out.xLeft = Math.round(xLeft * 10) / 10;
          if (Number.isFinite(xRight)) out.xRight = Math.round(xRight * 10) / 10;
          // Zotero 没有行号，但每个矩形就是一行 —— 矩形的数量就是选区跨的行数，
          // 相邻矩形的高差就是行高。这是最接近"第几行"的可得信息。
          out.lines = rects.length;
          if (rects.length >= 2) {
            const a = rects[0], b = rects[1];
            if (Array.isArray(a) && Array.isArray(b)) {
              const d = Math.abs(Number(a[1]) - Number(b[1]));
              if (d > 0.5) out.lineHeight = Math.round(d * 100) / 100;
            }
          }
        }
      }
      out.sortIndex = String(annotation.sortIndex || "");
      const state = reader && reader.state;
      if (state && Array.isArray(state.pageLabels)) out.totalPages = state.pageLabels.length;
      if (out.pageIndex === null && state && typeof state.pageIndex === "number") out.pageIndex = state.pageIndex;
    } catch (e) { this.diag("locator failed: " + e); }
    this.diag("locator lines=" + out.lines + " page=" + out.pageIndex + " label=" + JSON.stringify(out.pageLabel)
      + " y=" + out.yTop + ".." + out.yBottom + " lh=" + out.lineHeight + " sort=" + out.sortIndex
      + " rects=" + (out.rects ? out.rects.length : 0));
    return out;
  },

  /**
   * 选中即确保工作区存在。
   *
   * 只对"这次会话里第一次见到的条目"发请求，避免每次重渲染都打一遍；host 侧
   * createWorkspace 本身幂等，重复调用只会拿到 created=false。
   */
  autoWorkspace(key) {
    if (!key) return;
    if (!this._wsSeen) this._wsSeen = new Set();
    if (this._wsSeen.has(key)) return;
    this._wsSeen.add(key);
    this.ensurePaperWorkspace(key, { silent: true });
  },

  /** 请求 host 为某篇论文建工作区（有 PDF 才建得出来）。 */
  async ensurePaperWorkspace(key, opts) {
    const silent = !!(opts && opts.silent);
    let url = null;
    try { url = await this.apiUrl("/@dsh-external/dsh-zotero/api/papers/workspace"); } catch (e) {}
    if (!url) return null;
    try {
      const xhr = await Zotero.HTTP.request("POST", url, {
        body: JSON.stringify({ itemKey: key }),
        headers: { "Content-Type": "application/json" },
        responseType: "json",
        timeout: 20000,
      });
      const data = (xhr && xhr.response) || null;
      const ok = !!(data && data.ok);
      this.diag("paper ws " + key + " ok=" + ok + (data && data.error ? " err=" + data.error : "")
        + (data && data.created === false ? " (already)" : ""));
      if (ok && data.created === false) return data;
      if (ok) {
        const tail = String(data.path || "").split("\\").slice(-1)[0];
        if (this._paperWsState) this._paperWsState.textContent = "工作区：" + tail;
        if (!silent) this.notify("工作区已建好");
      } else if (!silent) {
        this.notify("建工作区失败：" + String((data && data.error) || ""));
        if (this._paperWsState) this._paperWsState.textContent = String((data && data.error) || "建失败");
      }
      return data;
    } catch (e) {
      this.diag("paper ws failed: " + e);
      if (!silent && this._paperWsState) this._paperWsState.textContent = "请求失败";
      return null;
    }
  },

  /** 按钮入口：手动重建（例如刚给条目补了 PDF）。 */
  async makePaperWorkspace() {
    const key = this._currentPaperKey;
    const state = this._paperWsState;
    const btn = this._paperWsBtn;
    if (!key) { if (state) state.textContent = "先选中一篇论文"; return; }
    if (btn) btn.disabled = true;
    if (state) state.textContent = "正在建…";
    if (this._wsSeen) this._wsSeen.delete(key)
    await this.ensurePaperWorkspace(key, { silent: false });
    if (btn) btn.disabled = false;
  },

  /** 把选段 POST 给 dsh-zotero 的 /quote。 */
  async sendQuote(payload) {
    let url = null;
    try { url = await this.apiUrl("/@dsh-external/dsh-zotero/api/quote"); } catch (e) {}
    if (!url) { this.notify("DSH 地址未就绪，先确认实例在跑"); return; }
    this.notify(payload.ask ? "已送入 DSH，正在请它解读…" : "选段已送入 DSH");
    try {
      const xhr = await Zotero.HTTP.request("POST", url, {
        body: JSON.stringify(payload),
        headers: { "Content-Type": "application/json" },
        responseType: "json",
        timeout: 20000,
      });
      const data = xhr && xhr.response;
      this.diag("quote sent itemKey=" + payload.itemKey + " chars=" + String(payload.text || "").length
        + " ask=" + !!payload.ask + " status=" + (xhr ? xhr.status : "?")
        + " ok=" + (data && data.ok) + (data && data.error ? " error=" + data.error : ""));
      if (data && data.ok === false && data.error) {
        this.showQuoteError(data.error);
        this.notify("送入失败：" + data.error);
      } else {
        this.showQuoteReceipt({ page: payload.page, text: payload.text, ask: payload.ask });
      }
    } catch (e) {
      this.diag("quote failed: " + e);
      this.showQuoteError(String(e));
      this.notify("送入失败：" + String(e).slice(0, 80));
    }
  },

  /** 在面板顶部画出最近一次送入的选段。 */
  showQuoteReceipt(info) {
    const bar = this._quoteBar;
    if (!bar) return;
    const text = String(info.text || "").replace(/\s+/g, " ").trim();
    const head = info.page ? "已送入 DSH · 第 " + info.page + " 页" : "已送入 DSH";
    const tail = info.ask ? " · 已追问" : "";
    bar.textContent = "";
    const line1 = bar.ownerDocument.createElementNS("http://www.w3.org/1999/xhtml", "div");
    line1.setAttribute("style", "font-weight:600;opacity:.9;");
    line1.textContent = head + tail;
    const line2 = bar.ownerDocument.createElementNS("http://www.w3.org/1999/xhtml", "div");
    line2.setAttribute("style", "opacity:.75;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;");
    line2.setAttribute("title", text);
    line2.textContent = text.slice(0, 90) + (text.length > 90 ? "…" : "");
    bar.appendChild(line1);
    bar.appendChild(line2);
    bar.setAttribute("style", "display:block;flex:0 0 auto;font:10px/1.5 system-ui,sans-serif;padding:4px 7px;border-radius:4px;background:rgba(64,114,229,.14);border-inline-start:3px solid #4072e5;overflow:hidden;");
  },

  showQuoteError(message) {
    const bar = this._quoteBar;
    if (!bar) return;
    bar.textContent = "送入失败：" + String(message).slice(0, 120);
    bar.setAttribute("style", "display:block;flex:0 0 auto;font:10px/1.5 system-ui,sans-serif;padding:4px 7px;border-radius:4px;background:rgba(204,41,54,.16);border-inline-start:3px solid #cc2936;overflow:hidden;");
  },

  /** 轻量提示：进度窗口，不打断阅读。 */
  notify(text) {
    try {
      const pw = new Zotero.ProgressWindow({ closeOnClick: true });
      pw.changeHeadline("Zotero DSH");
      pw.addDescription(text);
      pw.show();
      pw.startCloseTimer(2600);
    } catch (e) { this.diag("notify failed: " + e); }
  },

  /* ---------- lifecycle ---------- */

  hooks: {
    async onStartup() {
      ZoteroDSH.log("startup v" + ZoteroDSH.version);
      ZoteroDSH.registerItemPane();
      ZoteroDSH.registerMenu();
      ZoteroDSH.registerSelectionActions();
      ZoteroDSH.registerFocusWatcher();
      ZoteroDSH.forcePaneSync();
      // onMainWindowLoad 在本机没被触发，改为主动轮询主窗口。
      [6000, 15000, 28000, 42000].forEach((d) => setTimeout(() => {
        try {
          const w = Zotero.getMainWindow();
          ZoteroDSH.diag("timer t+" + d + " getMainWindow=" + !!w);
          if (w) ZoteroDSH._probeOnce(w, d);
        } catch (e) { ZoteroDSH.diag("timer t+" + d + " failed: " + e); }
      }, d));
    },

    onMainWindowLoad(win) {
      if (!ZoteroDSH._menuRegistered) ZoteroDSH.injectMenuFallback(win);
      ZoteroDSH.probeSidenav(win);
    },

    onMainWindowUnload(win) {
      ZoteroDSH.removeMenuFallback(win);
    },

    onShutdown() {
      ZoteroDSH.log("shutdown");
      ZoteroDSH.unregisterItemPane();
      ZoteroDSH.unregisterMenu();
      ZoteroDSH.unregisterSelectionActions();
      ZoteroDSH.unregisterFocusWatcher();
      try {
        const w = Services.wm.getMostRecentWindow(ZoteroDSH.CHAT_WINDOW_TYPE);
        if (w && !w.closed) w.close();
      } catch (e) {}
    },
  },
};

if (!Zotero.ZoteroDSH) {
  Zotero.ZoteroDSH = ZoteroDSH;
}