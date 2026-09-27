/** 试验：triggeringPrincipal + 可见的 browser。 */
function el(tag, css, txt) {
  const n = document.createElementNS("http://www.w3.org/1999/xhtml", tag);
  if (css) n.setAttribute("style", css);
  if (txt != null) n.textContent = txt;
  return n;
}
function readUrlPref() {
  try { const v = Services.prefs.getStringPref("extensions.zotero-dsh.url", ""); if (v) return v; } catch (e) {}
  try { const v = Zotero.Prefs.get("extensions.zotero-dsh.url", true); if (v) return String(v); } catch (e) {}
  return null;
}

async function main() {
  const root = document.getElementById("zotero-dsh-root");
  if (!root) return;
  root.textContent = "";
  const log = [];
  const box = el("div", "display:flex;flex-direction:column;gap:6px;padding:10px;font:11px/1.5 ui-monospace,monospace;height:100%;box-sizing:border-box;");
  const out = el("div", "white-space:pre-wrap;word-break:break-all;flex:0 0 auto;");
  box.appendChild(out);
  root.appendChild(box);
  const show = () => { out.textContent = log.join("\n"); };

  // 走宿主的解析：base 来自 pref，token 现取，避免读到过期地址。
  var url = null;
  try { url = await Zotero.ZoteroDSH.resolveDSHUrl(); } catch (e) {}
  if (!url) url = readUrlPref();
  if (!url) { log.push("未取到 DSH 地址"); show(); return; }
  log.push("目标: " + String(url).replace(/token=[^&]*/, "token=***")); show();

  var uri = Services.io.newURI(url);
  var conP = null;
  try { conP = Services.scriptSecurityManager.createContentPrincipal(uri, {}); } catch (e) {}
  log.push("contentPrincipal = " + (conP ? "ok" : "null")); show();

  var br = null;
  try {
    br = document.createXULElement("browser");
    br.setAttribute("type", "content");
    br.setAttribute("flex", "1");
    // 关键：必须可见，否则 Gecko 不会真正加载
    br.setAttribute("style", "display:block;flex:1 1 auto;width:100%;min-height:300px;border:0;background:#fff;");
    box.appendChild(br);
    show();
    br.fixupAndLoadURIString(url, { triggeringPrincipal: conP });
    log.push("导航已提交，等待加载..."); show();
  } catch (e) {
    log.push("提交失败: " + String(e).replace(/\s+/g, " ").slice(0, 140)); show(); return;
  }

  for (var t = 0; t < 5; t++) {
    await new Promise(function (r) { setTimeout(r, 1500); });
    var cur = br.currentURI ? br.currentURI.spec : "none";
    var title = "";
    try { title = br.contentTitle || ""; } catch (e) {}
    log.push("t+" + ((t + 1) * 1.5) + "s currentURI=" + String(cur).replace(/token=[^&]*/, "token=***")
      + (title ? "  title=" + JSON.stringify(title) : ""));
    show();
    if (cur && String(cur) !== "about:blank" && String(cur).indexOf("127.0.0.1") !== -1) { log.push(""); log.push(">>> 成功！内容已加载"); show(); return; }
  }
  log.push(""); log.push("导航提交成功但 URL 未改变"); show();
}

window.addEventListener("load", main);
