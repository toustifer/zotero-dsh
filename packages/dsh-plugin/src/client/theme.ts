/**
 * dsh-zotero — 共享 client 样式（面板 + 浮动文献聊天窗共用）。
 * iOS 深色质感（用户确认）：#0A84FF 主蓝 / #1C1C1E 基底 / #2C2C2E 卡片 /
 * 毛玻璃顶层 / SF 字体栈 / 大圆角 + 柔和阴影 / iMessage 气泡 / inset grouped 列表。
 */
export const CSS = `
/* ── iOS 深色色板 & 基线 ── */
.dshz{
  display:flex;flex-direction:column;height:100%;min-height:0;
  font-size:13px;
  font-family:-apple-system,BlinkMacSystemFont,"SF Pro Text","PingFang SC","Segoe UI",Roboto,"Helvetica Neue",sans-serif;
  -webkit-font-smoothing:antialiased;
  --ios-bg:#000; --ios-panel:#1C1C1E; --ios-card:#2C2C2E; --ios-card2:#3A3A3C;
  --ios-sep:#38383A; --ios-fg:#F2F2F7; --ios-dim:#98989F; --ios-dim2:#6E6E73;
  --ios-blue:#0A84FF; --ios-green:#30D158; --ios-orange:#FF9F0A; --ios-red:#FF453A;
  --ios-blue-dim:#0A84FF33; --ios-fill:#3A3A3C66;
  --dshz-bg:var(--ios-bg); --dshz-panel:var(--ios-panel); --dshz-line:var(--ios-sep);
  --dshz-fg:var(--ios-fg); --dshz-dim:var(--ios-dim); --dshz-accent:var(--ios-blue);
}
.dshz *{box-sizing:border-box;scrollbar-width:thin;scrollbar-color:#4A4A4F transparent}
.dshz *::-webkit-scrollbar{width:8px;height:8px}
.dshz *::-webkit-scrollbar-thumb{background:#444;border-radius:8px}
.dshz *::-webkit-scrollbar-track{background:transparent}

/* ── 面板头部（毛玻璃） ── */
.dshz-h{
  display:flex;align-items:center;gap:8px;padding:9px 12px;
  border-bottom:1px solid var(--ios-sep);
  background:rgba(28,28,30,.86);backdrop-filter:blur(20px) saturate(1.6);-webkit-backdrop-filter:blur(20px) saturate(1.6);
  position:sticky;top:0;z-index:3;
}
.dshz-h .dot{width:9px;height:9px;border-radius:50%;background:var(--dshz-dim);flex:none;box-shadow:0 0 6px rgba(255,255,255,.25)}
.dshz-h b{font-size:14px;font-weight:650;color:var(--ios-fg);letter-spacing:.1px}
.dshz-h .st{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--ios-dim);font-size:12px}

/* ── 按钮（iOS 胶囊） ── */
.dshz-btn{
  background:var(--ios-card);color:var(--ios-fg);border:1px solid transparent;
  border-radius:12px;padding:5px 12px;font-size:12.5px;font-weight:500;
  cursor:pointer;white-space:nowrap;transition:transform .12s ease,background .15s ease,opacity .15s ease;
}
.dshz-btn:hover{background:var(--ios-card2)}
.dshz-btn:active{transform:scale(.96)}
.dshz-btn.primary{background:var(--ios-blue);border-color:transparent;color:#fff;font-weight:600}
.dshz-btn.primary:hover{background:#3D9BFF}
.dshz-btn:disabled{opacity:.4;cursor:default;transform:none}

/* ── 顶部标签（iOS 分段/标签） ── */
.dshz-tabs{display:flex;gap:6px;padding:8px 12px 8px;border-bottom:1px solid var(--ios-sep);background:rgba(28,28,30,.72);backdrop-filter:blur(20px) saturate(1.5);-webkit-backdrop-filter:blur(20px) saturate(1.5)}
.dshz-tab{
  flex:1;text-align:center;padding:6px 10px;border-radius:10px;cursor:pointer;
  color:var(--ios-dim);font-size:12.5px;font-weight:500;
  background:transparent;transition:background .15s ease,color .15s ease;
}
.dshz-tab:hover{color:var(--ios-fg)}
.dshz-tab.on{color:#fff;background:var(--ios-blue);font-weight:600;box-shadow:0 2px 10px var(--ios-blue-dim)}

/* ── 内容区 / 分组列表（iOS inset grouped） ── */
.dshz-b{flex:1;min-height:0;overflow:auto;background:var(--ios-bg);padding:10px 12px 14px}
.dshz-row{
  padding:11px 13px;border-radius:14px;margin-bottom:9px;
  background:var(--ios-card);cursor:pointer;
  transition:background .15s ease,transform .12s ease;
  animation:dshz-rowin .2s ease both;
}
.dshz-row:hover{background:var(--ios-card2)}
.dshz-row:active{transform:scale(.985)}
.dshz-row .t{color:var(--ios-fg);font-size:13.5px;font-weight:500;line-height:1.4}
.dshz-row .m{color:var(--ios-dim);font-size:12px;margin-top:4px;display:flex;gap:8px;flex-wrap:wrap}

/* 徽章 pill */
.dshz-badge{
  font-size:11px;border-radius:8px;padding:2px 8px;
  background:var(--ios-fill);color:var(--ios-dim);font-weight:500;
}
.dshz-badge.pdf{background:rgba(10,132,255,.16);color:#6CB2FF}
.dshz-badge.summary{background:rgba(48,209,88,.15);color:#5ADB7E}

/* 输入/下拉（iOS 填充控件） */
.dshz-input{
  width:100%;background:var(--ios-card);border:1px solid transparent;border-radius:12px;
  color:var(--ios-fg);padding:8px 12px;font-size:13px;
  font-family:inherit;outline:none;transition:border-color .15s ease;
}
.dshz-input:focus{border-color:var(--ios-blue);box-shadow:0 0 0 3px var(--ios-blue-dim)}
.dshz-input::placeholder{color:var(--ios-dim2)}
.dshz-sel{
  background:var(--ios-card);border:1px solid transparent;border-radius:12px;
  color:var(--ios-fg);padding:8px 10px;font-size:13px;width:100%;
  font-family:inherit;outline:none;
}

/* 键值/说明 */
.dshz-kv{color:var(--ios-dim);font-size:12px;line-height:1.6}
.dshz-kv b{color:var(--ios-fg);font-weight:600}
.dshz-note{color:var(--ios-dim);font-size:12px;line-height:1.6}
.dshz-banner{
  border-radius:12px;padding:8px 12px;font-size:12.5px;margin-bottom:10px;
  display:flex;align-items:flex-start;gap:8px;
  animation:dshz-fadein .16s ease both;
}
.dshz-banner.err{background:rgba(255,69,58,.14);color:#FF8B84}
.dshz-banner.ok{background:rgba(48,209,88,.13);color:#6BDD8B}
.dshz-null{padding:26px 12px;text-align:center;color:var(--ios-dim2);font-size:13px}

/* PDF 卡片 */
.dshz-pdf{position:relative;border:1px solid var(--ios-sep);border-radius:14px;background:#111;margin-bottom:10px;overflow:hidden}
.dshz-pdf iframe{display:block;width:100%;height:420px;border:0}
.dshz-pdf .bar{position:absolute;top:5px;right:5px;z-index:2;display:flex;gap:5px}

/* 设置表单 */
.dshz-field{margin-bottom:10px}
.dshz-field label{display:block;color:var(--ios-dim);font-size:12px;margin-bottom:4px;font-weight:500}
.dshz-sec{color:var(--ios-fg);font-size:13px;font-weight:650;margin:14px 0 8px;padding-bottom:4px;border-bottom:1px solid var(--ios-sep)}

/* ── 浮动窗（iOS 面板） ── */
.dshz-win{
  position:fixed;z-index:9999;display:flex;flex-direction:column;
  background:rgba(28,28,30,.92);backdrop-filter:blur(30px) saturate(1.8);-webkit-backdrop-filter:blur(30px) saturate(1.8);
  border:1px solid rgba(255,255,255,.08);border-radius:20px;
  box-shadow:0 24px 70px rgba(0,0,0,.55),0 8px 24px rgba(0,0,0,.35),inset 0 1px 0 rgba(255,255,255,.06);
  overflow:hidden;font-size:13px;color:var(--ios-fg);
  animation:dshz-pop-in .18s ease both;
}
.dshz-win[data-hidden="1"]{display:none}
.dshz-win-head{
  display:flex;align-items:center;gap:8px;padding:9px 12px;
  background:rgba(28,28,30,.75);border-bottom:1px solid var(--ios-sep);
  cursor:move;user-select:none;
}
.dshz-win-head b{font-size:13.5px;font-weight:650;letter-spacing:.1px}
.dshz-win-body{display:flex;flex:1;min-height:0}

/* History 侧栏（inset grouped） */
.dshz-win-side{width:196px;flex:none;border-right:1px solid var(--ios-sep);background:rgba(0,0,0,.25);overflow:auto;padding:8px}
.dshz-win-side .side-item{
  display:flex;align-items:center;gap:5px;padding:8px 10px;font-size:12.5px;
  color:var(--ios-dim);cursor:pointer;border-radius:11px;margin-bottom:2px;line-height:1.4;
  transition:background .12s ease;
}
.dshz-win-side .side-item:hover{background:rgba(255,255,255,.06)}
.dshz-win-side .side-item.on{background:var(--ios-blue);color:#fff;font-weight:600}
.dshz-win-side .side-item .side-txt{flex:1;min-width:0;overflow:hidden}
.dshz-win-side .side-item .side-del{opacity:0;border:0;background:transparent;color:var(--ios-dim);cursor:pointer;font-size:12px;padding:0 2px;flex:none}
.dshz-win-side .side-item:hover .side-del{opacity:1}
.dshz-win-side .side-item .side-del:hover{color:var(--ios-red)}
.dshz-win-side .side-item.on .side-del{color:rgba(255,255,255,.8)}

/* 主区 */
.dshz-win-main{flex:1;min-width:0;display:flex;flex-direction:column}

/* 顶栏：标题 + segmented */
.dshz-wt{display:flex;align-items:center;gap:8px;padding:8px 12px;border-bottom:1px solid var(--ios-sep);background:rgba(28,28,30,.6)}
.dshz-ttl{flex:1;min-width:0;font-size:12.5px;color:var(--ios-fg);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dshz-seg{display:flex;background:rgba(120,120,128,.24);border-radius:9px;padding:2px;flex:none;gap:2px}
.dshz-seg button{
  border:0;background:transparent;color:var(--ios-dim);padding:4px 12px;
  font-size:12px;font-weight:600;cursor:pointer;border-radius:7px;font-family:inherit;
  transition:background .15s ease,color .15s ease,box-shadow .15s ease;
}
.dshz-seg button.on{background:var(--ios-bg);color:#fff;box-shadow:0 1px 6px rgba(0,0,0,.4)}

/* 上下文标签（iOS Tag 胶囊） */
.dshz-chips{display:flex;gap:6px;flex-wrap:wrap;padding:6px 12px 0}
.dshz-chip{
  display:inline-flex;align-items:center;gap:6px;
  border:1px solid rgba(10,132,255,.4);background:rgba(10,132,255,.16);
  color:#8CC3FF;border-radius:999px;padding:3px 11px;font-size:12px;cursor:pointer;user-select:none;
  transition:background .12s ease;
}
.dshz-chip:hover{background:rgba(10,132,255,.28)}
.dshz-chip .mode{font-size:10px;color:#6EA8E8;border-left:1px solid rgba(10,132,255,.4);padding-left:6px;font-weight:600}
.dshz-chip .x{border:0;background:transparent;color:#6EA8E8;cursor:pointer;padding:0 0 0 2px;font-size:12px}
.dshz-chip .x:hover{color:var(--ios-red)}

/* 消息流（iMessage 气泡） */
.dshz-chat-msgs{flex:1;min-height:0;overflow:auto;padding:12px}
.dshz-msg{margin:7px 0;display:flex;flex-direction:column;align-items:flex-start}
.dshz-msg.user{align-items:flex-end}
.dshz-msg .who{font-size:10.5px;color:var(--ios-dim2);margin:0 6px 3px;font-weight:500}
.dshz-msg.user .who{order:-1;text-align:right}
.dshz-msg .bubble{
  max-width:86%;white-space:pre-wrap;word-break:break-word;
  background:var(--ios-card);border:1px solid transparent;
  border-radius:18px;border-bottom-left-radius:6px;
  padding:8px 13px;font-size:13.5px;line-height:1.55;color:var(--ios-fg);
}
.dshz-msg.user .bubble{
  background:var(--ios-blue);color:#fff;
  border-bottom-left-radius:18px;border-bottom-right-radius:6px;
}
.dshz-msg .run::after{content:"▍";animation:dshz-blink 1s steps(2) infinite;color:var(--ios-dim)}
@keyframes dshz-blink{50%{opacity:0}}

/* CoT 折叠（iOS 分组卡） */
.dshz-cot{background:rgba(120,120,128,.14);border:1px solid transparent;border-radius:14px;margin:0 0 6px;font-size:12px;max-width:86%}
.dshz-cot summary{
  cursor:pointer;padding:6px 11px;color:var(--ios-dim);user-select:none;
  list-style:none;display:flex;align-items:center;gap:5px;font-weight:500;
}
.dshz-cot summary::before{content:"▸";font-size:10px;transition:transform .12s ease}
.dshz-cot[open] summary::before{content:"▾"}
.dshz-cot-body{
  padding:5px 11px 8px;white-space:pre-wrap;word-break:break-word;
  color:var(--ios-dim2);line-height:1.6;max-height:220px;overflow:auto;
  border-top:1px solid rgba(255,255,255,.06);
}

/* 快捷操作（pills） */
.dshz-pills{
  display:flex;gap:6px;flex-wrap:wrap;padding:8px 12px;
  border-top:1px solid var(--ios-sep);background:rgba(28,28,30,.6);
}
.dshz-pills .dshz-btn{border-radius:999px;padding:5px 13px;font-size:12px;font-weight:500}

/* 输入行（胶囊） */
.dshz-inputrow{display:flex;gap:8px;padding:8px 12px;border-top:1px solid var(--ios-sep);background:rgba(28,28,30,.75);backdrop-filter:blur(20px);-webkit-backdrop-filter:blur(20px)}
.dshz-inputwrap{position:relative;flex:1;min-width:0}
.dshz-inputwrap .dshz-input{border-radius:999px;padding:9px 15px;font-size:13.5px}
.dshz-inputrow .dshz-btn.primary{border-radius:999px;padding:0 18px;font-weight:600}

/* @弹层（毛玻璃） */
.dshz-pop{
  position:absolute;left:0;right:0;top:calc(100% + 6px);
  background:rgba(44,44,46,.92);backdrop-filter:blur(24px) saturate(1.6);-webkit-backdrop-filter:blur(24px) saturate(1.6);
  border:1px solid rgba(255,255,255,.09);border-radius:14px;
  box-shadow:0 12px 32px rgba(0,0,0,.5);
  max-height:240px;overflow:auto;z-index:20;
}
.dshz-pop .pop-item{
  padding:9px 12px;font-size:12.5px;color:var(--ios-fg);cursor:pointer;
  border-bottom:1px solid rgba(255,255,255,.05);line-height:1.35;
}
.dshz-pop .pop-item:hover{background:rgba(255,255,255,.06)}
.dshz-pop .pop-item .m{color:var(--ios-dim);font-size:11px}

/* 模型行 */
.dshz-model-row{
  display:flex;gap:8px;align-items:center;padding:7px 12px;
  border-top:1px solid var(--ios-sep);background:rgba(28,28,30,.6);
}
.dshz-model-row label{font-size:11.5px;color:var(--ios-dim);font-weight:500;flex:none}
.dshz-model-row select{
  flex:1;background:var(--ios-card);border:1px solid transparent;border-radius:11px;
  color:var(--ios-fg);padding:6px 10px;font-size:12.5px;font-family:inherit;outline:none;
}

/* 欢迎首屏 */
.dshz-welcome{padding:28px 20px;text-align:center}
.dshz-welcome h2{font-size:18px;font-weight:700;color:var(--ios-fg);margin:0 0 8px;letter-spacing:-.2px}
.dshz-welcome p{font-size:12.5px;color:var(--ios-dim);line-height:1.8;margin:5px 0}

/* ── 通用动效（短、轻、iOS 节奏） ── */
@keyframes dshz-fadein{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:none}}
@keyframes dshz-rowin{from{opacity:0;transform:translateY(5px)}to{opacity:1;transform:none}}
@keyframes dshz-pop-in{from{opacity:0;transform:scale(.965) translateY(6px)}to{opacity:1;transform:none}}
@keyframes dshz-spin{to{transform:rotate(360deg)}}
.dshz-fade{
  animation:dshz-fadein .18s ease both;
  /* 撑满内容区：阅读模式（height:100% 链）依赖确定高度；relative 供阅读层 absolute 定位 */
  display:flex;flex-direction:column;height:100%;min-height:0;position:relative;
}
.dshz-spin{
  width:13px;height:13px;border-radius:50%;flex:none;margin-top:1px;
  border:2px solid rgba(255,255,255,.22);border-top-color:currentColor;
  animation:dshz-spin .7s linear infinite;
}

/* banner 关闭按钮 */
.dshz-banner-x{
  margin-left:auto;border:0;background:transparent;color:inherit;opacity:.55;
  cursor:pointer;font-size:15px;line-height:1;padding:0 2px;font-family:inherit;
  transition:opacity .12s ease;
}
.dshz-banner-x:hover{opacity:1}

/* PDF 阅读载入态 */
.dshz-pdf-wrap{position:relative;flex:1;min-height:0;display:flex;border:1px solid var(--ios-sep);border-radius:12px;background:var(--ios-bg);overflow:hidden}
.dshz-pdf-wrap iframe{flex:1;width:100%;border:0;background:#111}
.dshz-pdf-loading{
  position:absolute;inset:0;z-index:5;display:flex;flex-direction:column;gap:10px;
  align-items:center;justify-content:center;background:rgba(0,0,0,.55);
  backdrop-filter:blur(2px);-webkit-backdrop-filter:blur(2px);
  animation:dshz-fadein .15s ease both;
}
.dshz-pdf-loading .t{color:var(--ios-dim);font-size:12px}

/* ── 设置折叠分组（iOS inset card + 平滑开合动画） ── */
.dshz-sec-card{
  border:1px solid var(--ios-sep);border-radius:14px;background:var(--ios-card);
  margin-bottom:10px;overflow:hidden;
}
.dshz-sec-head{
  display:flex;align-items:center;gap:8px;padding:10px 13px;cursor:pointer;user-select:none;
  color:var(--ios-fg);font-size:13px;font-weight:600;
  transition:background .15s ease;
}
.dshz-sec-head:hover{background:rgba(255,255,255,.05)}
.dshz-sec-head:active{background:rgba(255,255,255,.08)}
.dshz-sec-head .chev{
  flex:none;width:12px;text-align:center;font-size:10px;color:var(--ios-dim);
  transition:transform .2s cubic-bezier(.4,0,.2,1);
}
.dshz-sec-card.open .dshz-sec-head .chev{transform:rotate(90deg)}
.dshz-sec-head .lbl{flex:1}
.dshz-sec-head .hint{
  font-size:11px;color:var(--ios-dim2);font-weight:400;
  opacity:0;transition:opacity .15s ease;
}
.dshz-sec-head:hover .hint{opacity:1}
/* 0fr→1fr：无需 JS 测高、无抖动 */
.dshz-sec-body{display:grid;grid-template-rows:0fr;transition:grid-template-rows .24s cubic-bezier(.4,0,.2,1)}
.dshz-sec-card.open .dshz-sec-body{grid-template-rows:1fr}
.dshz-sec-body .inner{
  min-height:0;overflow:hidden;padding:0 13px;
  transition:padding .24s cubic-bezier(.4,0,.2,1);
}
.dshz-sec-card.open .dshz-sec-body .inner{padding:4px 13px 12px}
.dshz-sec-tools{display:flex;gap:12px;justify-content:flex-end;margin:2px 2px 10px}
.dshz-sec-tools button{
  border:0;background:transparent;color:var(--ios-dim);font-size:11.5px;
  cursor:pointer;padding:2px 4px;font-family:inherit;transition:color .12s ease;
}
.dshz-sec-tools button:hover{color:var(--ios-fg)}

/* ── PdfReader（pdf.js 自渲染阅读器） ── */
.dshz-pdf-toolbar{
  display:flex;gap:6px;align-items:center;padding:6px 10px;flex-wrap:wrap;
  border-bottom:1px solid var(--ios-sep);background:rgba(28,28,30,.6);
}
.dshz-pdf-toolbar .pg{color:var(--ios-dim);font-size:12px;min-width:52px;text-align:center;font-variant-numeric:tabular-nums}
.dshz-pdf-scroll{
  flex:1;min-height:0;overflow:auto;position:relative;
  background:var(--ios-bg);padding:14px;scroll-behavior:auto;
}
.dshz-pdf-page{
  position:relative;margin:0 auto;border-radius:8px;overflow:hidden;
  border:1px solid var(--ios-sep);background:#fff;
  transition:width .12s ease,height .12s ease;
}
.dshz-pdf-page{ margin-bottom:14px }
.dshz-pdf-page canvas{position:absolute;inset:0;display:block}
.dshz-pdf-page .tl{
  position:absolute;inset:0;overflow:hidden;opacity:.25;line-height:1;
  text-size-adjust:none;transform-origin:0 0;z-index:2;caret-color:transparent;
}
.dshz-pdf-page .tl span,.dshz-pdf-page .tl br{
  color:transparent;position:absolute;white-space:pre;cursor:text;transform-origin:0% 0%;
}
.dshz-sel{
  position:fixed;z-index:40;transform:translate(-50%,-100%);
  background:var(--ios-blue);color:#fff;border:0;border-radius:999px;
  padding:6px 15px;font-size:13px;font-weight:600;cursor:pointer;font-family:inherit;
  box-shadow:0 6px 18px rgba(0,0,0,.5);
  animation:dshz-pop-in .14s ease both;
}
.dshz-sel:hover{background:#3D9BFF}

/* ── PDF 划词浮动 Action Bar ── */
.dshz-action-bar{
  position:fixed;z-index:90;transform:translate(-50%,-100%);
  background:rgba(28,28,30,.92);backdrop-filter:blur(20px) saturate(1.8);-webkit-backdrop-filter:blur(20px) saturate(1.8);
  border:1px solid rgba(255,255,255,.14);border-radius:24px;
  padding:4px 6px;display:flex;align-items:center;gap:3px;
  box-shadow:0 10px 30px rgba(0,0,0,.5);
  animation:dshz-pop-in .15s ease both;
  user-select:none;
}
.dshz-action-btn{
  background:transparent;border:0;color:var(--ios-fg);
  font-size:12px;font-weight:500;padding:5px 9px;border-radius:18px;
  cursor:pointer;display:inline-flex;align-items:center;gap:4px;
  white-space:nowrap;transition:background .15s ease,transform .1s ease;
  font-family:inherit;
}
.dshz-action-btn:hover{background:rgba(255,255,255,.12)}
.dshz-action-btn:active{transform:scale(.95)}
.dshz-action-btn.active{background:rgba(10,132,255,.25);color:#6CB2FF}

/* 颜色选择器展开条 */
.dshz-color-popover{
  display:flex;align-items:center;gap:6px;padding:2px 6px;
  background:rgba(44,44,46,.95);border-radius:16px;margin-left:2px;
  border:1px solid rgba(255,255,255,.12);
}
.dshz-color-dot{
  width:17px;height:17px;border-radius:50%;cursor:pointer;
  border:2px solid transparent;transition:transform .12s ease,border-color .12s ease;
}
.dshz-color-dot:hover{transform:scale(1.25);border-color:#fff}

/* 便签弹窗 */
.dshz-note-popover{
  position:fixed;z-index:95;width:min(320px,90vw);
  background:rgba(36,36,38,.96);backdrop-filter:blur(24px) saturate(1.6);-webkit-backdrop-filter:blur(24px) saturate(1.6);
  border:1px solid rgba(255,255,255,.14);border-radius:16px;padding:10px 12px;
  box-shadow:0 16px 40px rgba(0,0,0,.6);transform:translateX(-50%);
  animation:dshz-pop-in .15s ease both;
  display:flex;flex-direction:column;gap:8px;
}
.dshz-note-popover textarea{
  width:100%;height:75px;background:rgba(0,0,0,.25);border:1px solid var(--ios-sep);
  border-radius:10px;color:var(--ios-fg);padding:8px 10px;font-size:12.5px;
  font-family:inherit;resize:none;outline:none;
}
.dshz-note-popover textarea:focus{border-color:var(--ios-blue)}
.dshz-note-popover-foot{display:flex;align-items:center;justify-content:space-between;gap:6px}

/* 高亮层与矩形色块 */
.dshz-anno-layer{
  position:absolute;inset:0;pointer-events:none;z-index:3;
}
.dshz-hl-rect{
  position:absolute;pointer-events:auto;border-radius:2px;
  mix-blend-mode:multiply;opacity:.46;
  transition:opacity .15s ease;
}
.dshz-hl-rect:hover{opacity:.72}

/* 便签小标记 */
.dshz-note-pin{
  position:absolute;pointer-events:auto;cursor:pointer;
  font-size:14px;line-height:1;transform:translate(2px,-6px);
  filter:drop-shadow(0 2px 4px rgba(0,0,0,.4));
  transition:transform .15s ease;
  z-index:4;
}
.dshz-note-pin:hover{transform:translate(2px,-8px) scale(1.25)}

/* 便签查看悬浮气泡 */
.dshz-note-tooltip{
  position:absolute;bottom:calc(100% + 6px);left:50%;transform:translateX(-50%);
  background:rgba(28,28,30,.95);border:1px solid rgba(255,255,255,.15);
  border-radius:10px;padding:6px 10px;font-size:12px;line-height:1.5;
  color:var(--ios-fg);max-width:240px;min-width:140px;box-shadow:0 8px 24px rgba(0,0,0,.5);
  pointer-events:none;white-space:pre-wrap;z-index:10;
}
.dshz-bubble{
  position:fixed;z-index:41;width:min(440px,92vw);max-height:60vh;overflow:auto;
  background:rgba(44,44,46,.95);backdrop-filter:blur(20px) saturate(1.5);-webkit-backdrop-filter:blur(20px) saturate(1.5);
  border:1px solid rgba(255,255,255,.09);border-radius:14px;padding:10px 12px;
  box-shadow:0 12px 40px rgba(0,0,0,.55);
  font-size:13px;line-height:1.65;color:var(--ios-fg);white-space:pre-wrap;
  animation:dshz-pop-in .16s ease both;
  transform:translateX(-50%);
}
.dshz-bubble .bar{display:flex;gap:8px;align-items:center;margin-bottom:6px;flex-wrap:wrap}
.dshz-bubble .bar .lang{font-size:11px;color:var(--ios-dim);font-weight:600}
.dshz-bubble .bar .dshz-btn{padding:2px 10px;font-size:11.5px;border-radius:8px}
.dshz-bubble .txt{color:var(--ios-fg)}

/* ── 全文翻译对照视图 ── */
.dshz-ft{flex:1;min-height:0;display:flex;flex-direction:column}
.dshz-ft-head{padding:8px 12px;border-bottom:1px solid var(--ios-sep);background:rgba(28,28,30,.6);display:flex;flex-direction:column;gap:7px}
.dshz-ft-head .row1{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.dshz-ft-head .ttl{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--ios-fg);font-size:12.5px;font-weight:600}
.dshz-ft-head .pg{color:var(--ios-dim);font-size:12px;font-variant-numeric:tabular-nums}
.dshz-ft-progress{height:4px;border-radius:4px;background:rgba(255,255,255,.08);overflow:hidden}
.dshz-ft-progress .fill{height:100%;background:var(--ios-blue);background-image:linear-gradient(45deg,rgba(255,255,255,.18) 25%,transparent 25%,transparent 50%,rgba(255,255,255,.18) 50%,rgba(255,255,255,.18) 75%,transparent 75%);background-size:28px 28px;border-radius:4px;transition:width .4s ease}
.dshz-ft-list{flex:1;min-height:0;overflow:auto;padding:10px 12px;display:flex;flex-direction:column;gap:10px}
.dshz-ft-card{border:1px solid var(--ios-sep);border-radius:12px;background:var(--ios-card);padding:10px 12px;animation:dshz-rowin .18s ease both}
.dshz-ft-card .src{color:var(--ios-dim);font-size:12.5px;line-height:1.6;white-space:pre-wrap}
.dshz-ft-card .dst{margin-top:6px;color:var(--ios-fg);font-size:13px;line-height:1.7;white-space:pre-wrap}
.dshz-ft-card.pending .dst{color:var(--ios-dim2)}
.dshz-ft-body{flex:1;min-height:0;display:flex;flex-direction:column;background:var(--ios-bg)}
a.dshz-btn{display:inline-flex;align-items:center;text-decoration:none;color:var(--ios-fg)}
a.dshz-btn.primary{color:#fff}
@keyframes dshz-stripe{0%{background-position:0 0}100%{background-position:28px 0}}

/* ── DSH GUI 全局控件样式（蓝底/方角/!important）防御：面板内拉回 iOS 质感 ──
   GUI 规则 body:not(.theme-endfield-round) button/select/input（0,1,1 + !important）。
   [data-dshz-root] 锚点把 specificity 提到 (0,2,1) 必胜（面板根自持该属性）。 */
.dshz[data-dshz-root] button{
  background-color:transparent !important;
  border:0 !important;
  border-radius:12px !important;
  color:inherit !important;
}
.dshz[data-dshz-root] button.dshz-btn{
  background-color:var(--ios-card) !important;
  color:var(--ios-fg) !important;
  border:1px solid transparent !important;
  font-weight:500 !important;
}
.dshz[data-dshz-root] button.dshz-btn.primary{background-color:var(--ios-blue) !important;color:#fff !important;font-weight:600 !important}
.dshz[data-dshz-root] button.dshz-btn:hover{background-color:var(--ios-card2) !important}
.dshz[data-dshz-root] button.dshz-btn.primary:hover{background-color:#3D9BFF !important}
.dshz[data-dshz-root] button.dshz-btn:active{transform:scale(.96)}
.dshz[data-dshz-root] button.dshz-btn:disabled{opacity:.4 !important;cursor:default !important}
.dshz[data-dshz-root] button.dshz-action-btn{border-radius:18px !important;padding:5px 9px !important}
.dshz[data-dshz-root] button.dshz-action-btn:hover{background-color:rgba(255,255,255,.14) !important}
.dshz[data-dshz-root] button.dshz-action-btn.active{background-color:rgba(10,132,255,.28) !important;color:#6CB2FF !important}
.dshz[data-dshz-root] .dshz-pills button.dshz-btn{border-radius:999px !important}
.dshz[data-dshz-root] .dshz-inputwrap button.dshz-btn.primary{border-radius:999px !important}
.dshz[data-dshz-root] .dshz-sec-tools button{border-radius:8px !important;background-color:transparent !important;color:var(--ios-dim) !important}
.dshz[data-dshz-root] .dshz-sec-tools button:hover{color:var(--ios-fg) !important}
.dshz[data-dshz-root] .dshz-banner-x{background-color:transparent !important}
.dshz[data-dshz-root] .dshz-seg button{border-radius:7px !important}
.dshz[data-dshz-root] .dshz-seg button.on{background-color:var(--ios-bg) !important;color:#fff !important}
.dshz[data-dshz-root] input.dshz-input,.dshz[data-dshz-root] textarea.dshz-input{border-radius:12px !important}
.dshz[data-dshz-root] .dshz-ft-card,.dshz[data-dshz-root] .dshz-row{border-radius:14px !important}
/* 面板收起：只留头部一行（露出主对话）；CSS 隐藏，不动 JSX 结构 */
.dshz[data-dshz-root].collapsed .dshz-tabs,
.dshz[data-dshz-root].collapsed .dshz-b{display:none !important}
.dshz[data-dshz-root] .dshz-sel,
.dshz[data-dshz-root] .dshz-sel:hover,
.dshz[data-dshz-root] .dshz-sel:focus,
.dshz[data-dshz-root] .dshz-sel:active{
  -webkit-appearance:none;appearance:none;
  background-color:var(--ios-card) !important;
  border:1px solid var(--ios-sep) !important;
  border-radius:12px !important;
  color:var(--ios-fg) !important;
  /* GUI 全局样式把 select 置为 fixed 悬浮浮层：还原为文档流内控件 */
  position:static !important;
  top:auto !important;left:auto !important;right:auto !important;bottom:auto !important;
  z-index:auto !important;
  transform:none !important;
  display:block !important;
  width:100% !important;
  max-width:none !important;
}
.dshz[data-dshz-root] .dshz-sel:focus{border-color:var(--ios-blue) !important;box-shadow:0 0 0 3px var(--ios-blue-dim) !important}
`
