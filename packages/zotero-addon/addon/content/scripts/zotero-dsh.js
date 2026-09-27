/**
 * Zotero DSH — host module.
 *
 * 1. resolve the DSH web URL (port + auth token)
 * 2. register the right-hand item-pane section (sidenav button -> DSH panel)
 * 3. register a Tools-menu entry as a secondary entry point
 */

var ZoteroDSH = {
  id: "zotero-dsh@fisfzy.local",
  version: "0.18.0",

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
        const t = nav.querySelector('[data-pane="' + this.SECTION_ID + '"]');
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
    const ok = await actor.sendQuery("loadURI", { uri: url });
    this.diag("embed: sendQuery loadURI ok=" + ok);
    // 导航提交成功不等于页面正确（401 页同样返回 ok），所以落地后回读标题。
    for (const delay of [2000, 3000]) {
      await new Promise((r) => setTimeout(r, delay));
      let title = "";
      let cur = "";
      try { title = br.contentTitle || ""; } catch (e) {}
      try { cur = br.currentURI ? br.currentURI.spec : ""; } catch (e) {}
      this.diag("embed probe title=" + JSON.stringify(title)
        + " uri=" + String(cur).replace(/token=[^&]*/, "token=***"));
      if (title) break;
    }
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

          const style = "font:11px system-ui;padding:2px 8px;margin-inline-start:4px;border-radius:4px;cursor:pointer;";
          const mk = (label, ask) => {
            const btn = doc.createElement("button");
            btn.textContent = label;
            btn.setAttribute("style", style);
            btn.addEventListener("click", (ev) => {
              ev.preventDefault();
              ev.stopPropagation();
              this.sendQuote({ itemKey, page, text, ask });
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
      if (data && data.ok === false && data.error) this.notify("送入失败：" + data.error);
    } catch (e) {
      this.diag("quote failed: " + e);
      this.notify("送入失败：" + String(e).slice(0, 80));
    }
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