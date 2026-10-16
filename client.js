/**
 * dsh-session-cleaner — 客户端 UI 半边：
 *  1. 工作区会话行 "..." 菜单 → 「删除会话」；
 *  2. 鼠标在对话里选中一段消息 → 浮动工具条「引用 / 提问」：
 *     - 引用：把选中内容（带来源元数据）插入当前输入框；
 *     - 提问：把选中内容 + 问题派生子 agent 并发回答，流式显示在右侧栏。
 * 只 require('react')，不依赖任何 Harness Client 包；样式仅用主题 token。
 * 参考 @michengai/dsh-sidebar-qa 的选取与输入框接入机制。
 */
window.__ModuleLoader__.load({
  id: "@local/dsh-session-cleaner-host",
  factory(require) {
    const React = require("react");
    const h = React.createElement;
    const { useState, useEffect, useRef, useSyncExternalStore } = React;

    const NS = "session-cleaner";
    const ASK_KIND = "dsh-session-cleaner-ask";
    const ASK_ID = "dsh-session-cleaner-ask";

    const zh = {
      "menu.deleteSession": "删除会话",
      "action.quote": "引用",
      "action.ask": "提问",
      "ask.hint": "输入你的问题（并发回答，显示在右侧栏）",
      "ask.send": "发送",
      "ask.tabTitle": "追问",
      "ask.tabDesc": "基于选中内容并发提问",
      "ask.answering": "回答中…",
      "quote.fromUser": "用户消息",
      "quote.fromAssistant": "助手消息",
      "quote.turn": "第{turn}回合",
      "dialog.cancel": "取消",
      "dialog.confirm": "确认删除",
      "dialog.deleteSession.title": "删除会话",
      "dialog.deleteSession.desc": "确定要删除会话「{title}」吗？它的全部消息与存储文件都会被移除，不可恢复。",
      "dialog.deleteSession.current": "「{title}」是当前打开的会话：删除会停止它并把页面切换到新会话。",
      "dialog.failed": "删除失败：{reason}",
    };
    const en = {
      "menu.deleteSession": "Delete session",
      "action.quote": "Quote",
      "action.ask": "Ask",
      "ask.hint": "Type your question (answered concurrently in the right sidebar)",
      "ask.send": "Send",
      "ask.tabTitle": "Follow-up",
      "ask.tabDesc": "Ask about the selection concurrently",
      "ask.answering": "Answering…",
      "quote.fromUser": "user message",
      "quote.fromAssistant": "assistant message",
      "quote.turn": "turn {turn}",
      "dialog.cancel": "Cancel",
      "dialog.confirm": "Delete",
      "dialog.deleteSession.title": "Delete session",
      "dialog.deleteSession.desc": "Delete the session \"{title}\"? All its messages and storage files will be removed. This cannot be undone.",
      "dialog.deleteSession.current": "\"{title}\" is the currently open session: deleting it stops the conversation and switches the page to a new session.",
      "dialog.failed": "Delete failed: {reason}",
    };

    /* ---------------- 图标 ---------------- */

    function IconTrash() {
      return h(
        "svg",
        { viewBox: "0 0 16 16", width: 15, height: 15, "aria-hidden": true },
        h("path", {
          d: "M6.5 2h3M3.5 4h9M5.5 4v9.5a1 1 0 0 0 1 1h3a1 1 0 0 0 1-1V4M6.7 6.7v4.2M9.3 6.7v4.2",
          stroke: "currentColor", strokeWidth: 1.3, fill: "none", strokeLinecap: "round",
        }),
      );
    }
    function IconQuote() {
      return h(
        "svg",
        { viewBox: "0 0 16 16", width: 15, height: 15, "aria-hidden": true },
        h("path", {
          d: "M6.2 4C4.3 4.6 3 6.2 3 8.4c0 1.4.9 2.4 2.1 2.4 1 0 1.8-.8 1.8-1.8 0-1-.8-1.7-1.7-1.7.1-.9.6-1.7 1.5-2.2L6.2 4Zm6.3 0c-1.9.6-3.2 2.2-3.2 4.4 0 1.4.9 2.4 2.1 2.4 1 0 1.8-.8 1.8-1.8 0-1-.8-1.7-1.7-1.7.1-.9.6-1.7 1.5-2.2L12.5 4Z",
          fill: "currentColor",
        }),
      );
    }

    /* ---------------- 小型可观察 store ---------------- */

    function createStore() {
      let value = null;
      let rev = 0;
      const listeners = new Set();
      return {
        subscribe(listener) {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        getSnapshot: () => value,
        getRev: () => rev,
        set(next) {
          value = next;
          rev += 1;
          listeners.forEach((l) => l());
        },
      };
    }

    const confirmStore = createStore();
    let confirmSeq = 0;
    function openConfirm(request) {
      confirmSeq += 1;
      confirmStore.set({ ...request, id: confirmSeq });
    }

    /* ---------------- 样式 ---------------- */

    const CSS = `
.dsc-action{width:28px;height:28px;border-radius:var(--dsw-radius-sm);color:var(--dsw-alias-label-tertiary);cursor:pointer;background:0 0;border:none;display:inline-flex;justify-content:center;align-items:center;padding:0;flex:none}
.dsc-action:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dsc-menuItem{display:flex;align-items:center;gap:8px;width:100%;box-sizing:border-box;background:0 0;border:none;cursor:pointer;color:var(--dsw-alias-label-primary);font-size:13px;line-height:20px;padding:6px 10px;border-radius:var(--dsw-radius-sm);text-align:left}
.dsc-menuItem:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dsc-menuItem svg{flex:none}
.dsc-dialog{pointer-events:auto;border:1px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-bg-overlay,var(--dsw-alias-bg-layer-1));color:var(--dsw-alias-label-primary);padding:20px;min-width:320px;max-width:480px;box-shadow:0 12px 32px rgba(0,0,0,.25)}
.dsc-dialog::backdrop{background:rgba(0,0,0,.4)}
.dsc-dialog h3{margin:0 0 8px;font-size:16px;line-height:22px;font-weight:600}
.dsc-dialog p{margin:0 0 12px;font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary);word-break:break-word}
.dsc-dialog .dsc-error{color:var(--dsw-alias-state-error-primary)}
.dsc-dialog .dsc-footer{display:flex;justify-content:flex-end;gap:8px;margin-top:4px}
.dsc-dialog button{font-size:13px;line-height:22px;padding:4px 14px;border-radius:var(--dsw-radius-md);border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);cursor:pointer}
.dsc-dialog button:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dsc-dialog button:disabled{opacity:.5;cursor:default}
.dsc-dialog button.dsc-danger{background:var(--dsw-alias-state-error-primary);color:#fff;border-color:transparent}
.dsc-dialog button.dsc-danger:hover{filter:brightness(1.08)}
.dsc-dialog button.dsc-primary{background:var(--dsw-alias-brand-primary);color:#fff;border-color:transparent}
.dsc-dialog button.dsc-primary:hover{filter:brightness(1.08)}
.dsc-popover{pointer-events:auto;position:fixed;z-index:1200;display:flex;flex-direction:column;gap:6px;box-sizing:border-box;min-width:180px;max-width:320px;padding:8px;border:1px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-overlay,var(--dsw-alias-bg-layer-2));box-shadow:var(--dsw-elevation-prominent,0 12px 32px rgba(0,0,0,.25));color:var(--dsw-alias-label-primary)}
.dsc-popover .dsc-popRow{display:flex;gap:6px}
.dsc-popover button{font-size:13px;line-height:22px;padding:4px 12px;border-radius:var(--dsw-radius-sm);border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);cursor:pointer;display:inline-flex;align-items:center;gap:6px}
.dsc-popover button:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dsc-popover button.dsc-primary{background:var(--dsw-alias-brand-primary);color:#fff;border-color:transparent}
.dsc-popover .dsc-askBox{display:flex;flex-direction:column;gap:6px}
.dsc-popover textarea{box-sizing:border-box;width:100%;min-height:64px;resize:vertical;font:inherit;font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-sm);padding:8px}
.dsc-popover textarea:focus{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-brand-primary));outline-offset:-2px}
.dsc-askPanel{display:flex;flex-direction:column;gap:10px;padding:4px 2px;box-sizing:border-box;height:100%;overflow-y:auto;overscroll-behavior:contain}
.dsc-askQuote{font-family:inherit;font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-interactive-bg-hover);border-left:2px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm);padding:8px 10px;margin:0;white-space:pre-wrap;word-break:break-word}
.dsc-askQuestion{font-size:14px;line-height:22px;font-weight:600;color:var(--dsw-alias-label-primary);white-space:pre-wrap;word-break:break-word}
.dsc-askReasoning{font-size:13px;line-height:20px;color:var(--dsw-alias-label-tertiary);white-space:pre-wrap;word-break:break-word;border-left:2px solid var(--dsw-alias-border-l2);padding-inline-start:10px;margin:2px 0}
.dsc-askAnswer{font-size:14px;line-height:22px;color:var(--dsw-alias-label-primary);white-space:pre-wrap;word-break:break-word}
.dsc-askWaiting{font-size:13px;line-height:20px;color:var(--dsw-alias-label-tertiary)}
`;

    /* ---------------- 选取捕获（参考 dsh-sidebar-qa/selection.ts） ---------------- */

    const MAX_SELECTION_CHARS = 2000;

    function chatAnchorOf(node) {
      const element = node && node.nodeType === 3 ? node.parentElement : node;
      if (element === null || element === undefined || typeof element.closest !== "function") return null;
      return element.closest("[data-chat-anchor-key]");
    }
    function isStreaming(anchor) {
      return anchor.hasAttribute("data-streaming") || anchor.querySelector("[data-streaming]") !== null;
    }
    function roleOfKind(kind) {
      return String(kind).toLowerCase().includes("user") ? "user" : "assistant";
    }

    /** 捕获并校验当前窗口选取，返回 {text, kind, turn, rect} 或 null。 */
    function captureSelection() {
      const sel = window.getSelection();
      if (sel === null || sel.isCollapsed || sel.rangeCount === 0) return null;
      const text = sel.toString();
      if (text.trim() === "" || text.length > MAX_SELECTION_CHARS) return null;
      const range = sel.getRangeAt(0);
      const startAnchor = chatAnchorOf(range.startContainer);
      const endAnchor = chatAnchorOf(range.endContainer);
      if (startAnchor === null || startAnchor !== endAnchor) return null;
      if (isStreaming(startAnchor)) return null;
      const kind = startAnchor.dataset.chatFlowKind ?? "";
      const turn = startAnchor.dataset.chatTurn ?? "";
      const rect = range.getBoundingClientRect();
      return {
        text,
        kind,
        turn,
        rect: { left: rect.left, top: rect.top, width: rect.width, bottom: rect.bottom },
      };
    }

    /** 选取控制器（每个激活周期一个）。 */
    function createSelectionController() {
      let selection = null;
      let pinned = false;
      const listeners = new Set();
      let state = { selection: null };
      let debounceTimer;

      const notify = () => {
        state = { selection };
        listeners.forEach((fn) => fn());
      };
      const recompute = () => {
        if (pinned) return;
        const next = captureSelection();
        const changed =
          (selection === null) !== (next === null) ||
          (selection !== null && next !== null &&
            (selection.text !== next.text || selection.kind !== next.kind || selection.turn !== next.turn));
        if (!changed) return;
        selection = next;
        notify();
      };
      const onSelectionChange = () => {
        if (debounceTimer !== undefined) window.clearTimeout(debounceTimer);
        debounceTimer = window.setTimeout(recompute, 200);
      };
      document.addEventListener("selectionchange", onSelectionChange);
      document.addEventListener("mouseup", recompute);
      document.addEventListener("keyup", onSelectionChange);

      return {
        getSnapshot: () => state,
        subscribe(fn) {
          listeners.add(fn);
          return () => listeners.delete(fn);
        },
        pin() {
          pinned = true;
        },
        clear() {
          pinned = false;
          selection = null;
          notify();
        },
        dispose() {
          document.removeEventListener("selectionchange", onSelectionChange);
          document.removeEventListener("mouseup", recompute);
          document.removeEventListener("keyup", onSelectionChange);
          if (debounceTimer !== undefined) window.clearTimeout(debounceTimer);
        },
      };
    }

    /* ---------------- 输入框 / 会话接入 ---------------- */

    /** 主面板当前保留的会话 id（同 DSH 工作区树定义）。 */
    function resolveCurrentSessionId(list) {
      if (list === undefined) return undefined;
      const rows = list.byId ?? {};
      const order = list.ids ?? Object.keys(rows);
      const rank = new Map(order.map((id, index) => [id, index]));
      let best;
      for (const [key, row] of Object.entries(rows)) {
        if ((row.retainedBy?.mainView ?? 0) <= 0) continue;
        const id = row.id === undefined || row.id === "" ? key : row.id;
        const candidate = {
          id,
          updatedAt: row.updatedAt ?? Number.NEGATIVE_INFINITY,
          rank: rank.get(id) ?? Number.POSITIVE_INFINITY,
        };
        if (best === undefined || candidate.updatedAt > best.updatedAt ||
          (candidate.updatedAt === best.updatedAt && candidate.rank < best.rank)) {
          best = candidate;
        }
      }
      return best?.id;
    }

    /** UUID v4（crypto.getRandomValues，兼容 http 非安全上下文）。 */
    function mintRequestId() {
      const value = new Uint8Array(globalThis.crypto.getRandomValues(new Uint8Array(16)));
      value[6] = ((value[6] & 0x0f) | 0x40);
      value[8] = ((value[8] & 0x3f) | 0x80);
      const hex = Array.from(value, (b) => b.toString(16).padStart(2, "0")).join("");
      return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
    }

    /** 生成带来源元数据的 Markdown 引用块（角色 + 回合 + 内容）。 */
    function buildQuote(selection, t) {
      const role = roleOfKind(selection.kind);
      const sourceLabel = t(role === "assistant" ? "quote.fromAssistant" : "quote.fromUser");
      const turnLabel = selection.turn !== "" ? t("quote.turn", { turn: selection.turn }) : "";
      const head = `【引用·${sourceLabel}${turnLabel ? "·" + turnLabel : ""}】`;
      const body = String(selection.text ?? "").trim();
      const lines = body.split("\n").map((l) => (l === "" ? ">" : `> ${l}`)).join("\n");
      return `> ${head}\n${lines}`;
    }

    /** 「引用」：把引用块追加到当前会话输入框（同 dsh-sidebar-qa 的 draft-insert）。 */
    function insertQuoteIntoComposer(ctx, sessionId, selection, t) {
      try {
        const actx = ctx.sessions.scope(sessionId);
        if (actx === undefined) return false;
        const conversation = ctx.get("conversation");
        if (conversation === undefined) return false;
        const input = conversation.input.for(actx);
        const quote = buildQuote(selection, t);
        const draft = input.state.getSnapshot().draft ?? "";
        const head = draft.replace(/\s+$/, "");
        const next = head === "" ? `${quote}\n\n` : `${head}\n\n${quote}\n\n`;
        if (next !== draft) input.setDraft(next);
        if (typeof input.focus === "function") input.focus();
        return true;
      } catch (error) {
        console.warn("[dsh-session-cleaner] composer insert failed:", error);
        return false;
      }
    }

    /** 解包 Remote 结果信封，失败抛错。 */
    function unwrapRemote(result, what) {
      if (result === undefined || result === null || result.ok !== true) {
        const err = result?.error;
        throw new Error(`${what} failed: ${err ? `${err.code}: ${err.message}` : "unknown"}`);
      }
      return result.value;
    }

    /** 会话所属 workspace id（无则 undefined）。 */
    function resolveWorkspaceId(ctx, sessionId) {
      try {
        const items = ctx.get("workspaces")?.list?.getSnapshot?.()?.items ?? [];
        for (const ws of items) {
          const ids = ws.sessionIds ?? ws.sessions ?? [];
          if (Array.isArray(ids) && ids.includes(sessionId)) return ws.workspaceId ?? ws.id;
        }
      } catch {
        /* 忽略 */
      }
      return undefined;
    }

    /**
     * 「提问」（并发）：调用宿主 /ask 端点，用 subagents 派生子 agent
     * （继承父 agent 的 provider/model），并发回答，回答流在右侧栏显示。
     * 返回子会话 id。
     */
    async function askConcurrent(ctx, sessionId, selection, question, t) {
      const quote = buildQuote(selection, t);
      const q = String(question ?? "").trim();
      const text =
        `请基于以下引用内容回答：\n\n${quote}\n\n` +
        (q === "" ? "请基于以上引用内容回应。" : `问题：${q}`);

      let result;
      try {
        const r = await fetch("/api/dsh-session-cleaner/ask", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ sessionId, text }),
        });
        result = await r.json();
      } catch (error) {
        throw new Error(`ask 请求失败：${String(error?.message ?? error)}`);
      }
      if (result?.ok !== true || typeof result.childId !== "string") {
        throw new Error(result?.summary ?? "ask failed");
      }
      return result.childId;
    }

    /* ---------------- 侧会话回答流折叠（只折助手回答，含 reasoning + text 逐字流式） ---------------- */

    /** 从 assistant/message 或 assistant/chunk 提取 { reasoning, answer }。 */
    function assistantContent(event) {
      if (event.type === "assistant/message") {
        const content = event.data?.message?.content;
        if (!Array.isArray(content)) return { reasoning: "", answer: "" };
        let reasoning = "", answer = "";
        for (const b of content) {
          if (typeof b?.text !== "string") continue;
          if (b.type === "reasoning") reasoning += b.text;
          else if (b.type === "text") answer += b.text;
        }
        return { reasoning, answer };
      }
      if (event.type === "assistant/chunk") {
        const chunk = event.data?.chunk;
        if (typeof chunk?.text !== "string") return { reasoning: "", answer: "" };
        if (chunk.type === "reasoning-delta") return { reasoning: chunk.text, answer: "" };
        if (chunk.type === "text-delta") return { reasoning: "", answer: chunk.text };
        return { reasoning: "", answer: "" };
      }
      return { reasoning: "", answer: "" };
    }

    /** 折叠快照：只保留助手回答（含 reasoning + text），用户提示词不显示。 */
    function foldRecords(records) {
      const msgs = []; // [{ reasoning, answer, streaming }]
      for (const rec of records ?? []) {
        const event = rec.event ?? rec;
        const c = assistantContent(event);
        if (c.reasoning === "" && c.answer === "") continue;
        if (event.type === "assistant/message") {
          const idx = msgs.findIndex((m) => m.streaming);
          if (idx >= 0) msgs.splice(idx, 1);
          msgs.push({ reasoning: c.reasoning, answer: c.answer, streaming: false });
        } else if (event.type === "assistant/chunk") {
          const last = msgs[msgs.length - 1];
          if (last && last.streaming) {
            last.reasoning += c.reasoning;
            last.answer += c.answer;
          } else {
            msgs.push({ reasoning: c.reasoning, answer: c.answer, streaming: true });
          }
        }
      }
      return msgs;
    }
    function appendEvent(prev, event) {
      const c = assistantContent(event);
      if (c.reasoning === "" && c.answer === "") return prev;
      if (event.type === "assistant/message") {
        const copy = prev.filter((m) => !m.streaming);
        copy.push({ reasoning: c.reasoning, answer: c.answer, streaming: false });
        return copy;
      }
      if (event.type === "assistant/chunk") {
        const copy = [...prev];
        const last = copy[copy.length - 1];
        if (last && last.streaming) {
          copy[copy.length - 1] = { reasoning: last.reasoning + c.reasoning, answer: last.answer + c.answer, streaming: true };
        } else {
          copy.push({ reasoning: c.reasoning, answer: c.answer, streaming: true });
        }
        return copy;
      }
      return prev;
    }

    /* ---------------- 组件 ---------------- */

    /** 会话行菜单条目：删除会话。 */
    function DeleteSessionMenuItem({ sessionId, displayTitle, useMenuOpenState, useSessions, t, requestDelete }) {
      const [, setMenuOpen] = useMenuOpenState();
      const currentId = useSessions((state) => {
        return Object.values(state.byId).find((s) => (s.retainedBy?.mainView ?? 0) > 0)?.id ?? null;
      });
      return h(
        "button",
        {
          type: "button",
          role: "menuitem",
          className: "dsc-menuItem",
          onClick: () => {
            setMenuOpen(false);
            requestDelete({ sessionId, displayTitle, currentId });
          },
        },
        h(IconTrash),
        h("span", null, t("menu.deleteSession")),
      );
    }

    /** 确认对话框宿主（shell.overlay）。 */
    function ConfirmDialogHost({ t }) {
      const request = useSyncExternalStore(confirmStore.subscribe, confirmStore.getSnapshot, confirmStore.getSnapshot);
      const ref = useRef(null);
      const [busy, setBusy] = useState(false);
      const [error, setError] = useState(null);
      useEffect(() => {
        const el = ref.current;
        if (el === null) return;
        if (request !== null) {
          setBusy(false);
          setError(null);
          if (!el.open) el.showModal();
        } else if (el.open) {
          el.close();
        }
      }, [request]);
      const close = () => {
        if (busy) return;
        confirmStore.set(null);
      };
      const confirm = async () => {
        if (request === null || busy) return;
        setBusy(true);
        setError(null);
        try {
          const result = await request.run();
          if (result?.ok) confirmStore.set(null);
          else {
            setError(t("dialog.failed", { reason: result?.text ?? "" }));
            setBusy(false);
          }
        } catch (err) {
          setError(t("dialog.failed", { reason: String(err?.message ?? err) }));
          setBusy(false);
        }
      };
      return h(
        "dialog",
        {
          ref,
          className: "dsc-dialog",
          onCancel: (e) => { e.preventDefault(); close(); },
          onClose: () => { if (request !== null) confirmStore.set(null); },
        },
        request === null
          ? null
          : [
              h("h3", { key: "title" }, request.title),
              h("p", { key: "desc" }, request.description),
              error !== null ? h("p", { key: "error", className: "dsc-error" }, error) : null,
              h(
                "div",
                { key: "footer", className: "dsc-footer" },
                h("button", { type: "button", onClick: close, disabled: busy }, t("dialog.cancel")),
                h("button", { type: "button", className: request.danger === false ? "dsc-primary" : "dsc-danger", onClick: confirm, disabled: busy }, request.confirmLabel ?? t("dialog.confirm")),
              ),
            ],
      );
    }

    /* ---------------- apply ---------------- */

    return {
      inject: ["slots", "locale", "uiWorkspace", "sessions", "remote", "remote.session"],
      apply(ctx) {
        // 样式注入
        ctx.effect(() => {
          if (typeof document === "undefined" || document.querySelector('style[data-plugin-css="dsh-session-cleaner-ui"]') !== null) {
            return () => {};
          }
          const tag = document.createElement("style");
          tag.dataset.pluginCss = "dsh-session-cleaner-ui";
          tag.textContent = CSS;
          document.head.appendChild(tag);
          return () => tag.remove();
        }, "dsh-session-cleaner-ui: css");

        ctx.effect(() => ctx.locale.register(NS, { zh, en }), "dsh-session-cleaner-ui: locale");
        const t = ctx.locale.bind(NS);

        // 选取控制器（每个激活周期一个，应用内共享）。
        const selectionController = createSelectionController();
        const currentSessionId = () => resolveCurrentSessionId(ctx.sessions.list.getSnapshot()) ?? "";

        // 引用：把选中内容插入当前会话输入框。
        const onQuote = (selection) => {
          const sid = currentSessionId();
          if (sid === "") return false;
          return insertQuoteIntoComposer(ctx, sid, selection, t);
        };

        // 提问（并发）：新建侧会话并行回答，结果显示在右侧栏，主会话不受影响。
        const onAsk = (selection, question) => {
          const sid = currentSessionId();
          if (sid === "") return false;
          const right = ctx.get("sidebarRight");
          askConcurrent(ctx, sid, selection, question, t)
            .then((sideSessionId) => {
              if (right && typeof right.openTab === "function") {
                right.openTab(ASK_KIND, {
                  params: { sideSessionId, parentSessionId: sid, question: String(question ?? "").trim(), quote: buildQuote(selection, t) },
                });
              }
            })
            .catch((err) => {
              console.warn("[dsh-session-cleaner] ask failed:", err);
            });
          return true;
        };

        // 浮动工具条组件（读 selection controller，渲染到 shell.overlay）。
        function SelectionPopover() {
          const state = useSyncExternalStore(selectionController.subscribe, selectionController.getSnapshot);
          const [asking, setAsking] = useState(false);
          const [question, setQuestion] = useState("");
          const selection = state.selection;
          const isNull = selection === null;
          useEffect(() => {
            if (isNull) {
              setAsking(false);
              setQuestion("");
            }
          }, [isNull]);
          if (selection === null) return null;
          const { rect } = selection;
          const left = rect.left + rect.width / 2;
          const top = rect.top - 12;

          const keep = (e) => { e.preventDefault(); };
          const fireQuote = (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (onQuote(selection)) selectionController.clear();
          };
          const fireAskToggle = (e) => {
            e.preventDefault();
            e.stopPropagation();
            // 钉住选区：进入提问态后停止 recompute，否则 textarea 获得焦点
            // 会让文档选区坍缩，从而清空选区并让整个工具条消失。
            selectionController.pin();
            setAsking(true);
          };
          const dismiss = (e) => {
            e.preventDefault();
            e.stopPropagation();
            selectionController.clear();
          };
          const fireSend = (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (onAsk(selection, question)) selectionController.clear();
          };

          return h(
            "div",
            { className: "dsc-popover", style: { left, top } },
            h(
              "div",
              { className: "dsc-popRow" },
              h("button", { type: "button", onMouseDown: keep, onMouseUp: keep, onClick: fireQuote }, h(IconQuote), t("action.quote")),
              h("button", { type: "button", className: "dsc-primary", onMouseDown: keep, onMouseUp: keep, onClick: fireAskToggle }, t("action.ask")),
            ),
            asking
              ? h(
                  "div",
                  { className: "dsc-askBox" },
                  h(
                    "textarea",
                    {
                      autoFocus: true,
                      placeholder: t("ask.hint"),
                      value: question,
                      onChange: (e) => setQuestion(e.target.value),
                      onKeyDown: (e) => {
                        if (e.key === "Enter" && !e.shiftKey) {
                          e.preventDefault();
                          fireSend(e);
                        }
                      },
                    },
                  ),
                  h(
                    "div",
                    { className: "dsc-popRow" },
                    h("button", { type: "button", onClick: dismiss }, t("dialog.cancel")),
                    h("button", { type: "button", className: "dsc-primary", onClick: fireSend }, t("ask.send")),
                  ),
                )
              : null,
          );
        }

        /** 右侧栏追问 tab body：流式显示侧会话的问答。
         * ask 子会话的上下文压缩由宿主在它下一次提问的 pre-step 自动完成（作用域内），
         * 这里不再提供手动按钮——因为子智能体答完后就不再驻留，手动压缩没有可用窗口。 */
        function AskBody({ useTabInfo, t }) {
          const { tab } = useTabInfo();
          const params = tab?.navigation?.params ?? {};
          const sideSessionId = typeof params.sideSessionId === "string" ? params.sideSessionId : "";
          const parentSessionId = typeof params.parentSessionId === "string" ? params.parentSessionId : "";
          const [messages, setMessages] = useState([]);

          useEffect(() => {
            if (sideSessionId === "") return;
            let disposed = false;
            const controller = new AbortController();
            void (async () => {
              try {
                // 可继续子 agent 会话，用 subagent 地址（含 mode + 父会话 id）follow。
                const address = parentSessionId !== ""
                  ? { kind: "subagent", childSessionId: sideSessionId, parentSessionId, mode: "continuable" }
                  : { kind: "session", sessionId: sideSessionId };
                const frames = ctx.remote.session.follow(
                  { address, maxMessages: 60 },
                  controller.signal,
                );
                for await (const frame of frames) {
                  if (disposed) return;
                  if (frame.type === "snapshot") {
                    setMessages(foldRecords(frame.records ?? []));
                  } else if (frame.type === "event") {
                    setMessages((prev) => appendEvent(prev, frame.event));
                  }
                }
              } catch (error) {
                console.warn("[dsh-session-cleaner] ask follow failed:", error);
              }
            })();
            return () => {
              disposed = true;
              controller.abort();
            };
          }, [sideSessionId, parentSessionId]);

          const q = typeof params.question === "string" && params.question !== "" ? params.question : null;
          const quote = typeof params.quote === "string" ? params.quote : "";
          const reasoningText = messages.map((m) => m.reasoning).join("\n\n");
          const answerText = messages.map((m) => m.answer).join("\n\n");
          const hasContent = (reasoningText + answerText).trim() !== "";

          return h(
            "div",
            { className: "dsc-askPanel" },
            quote !== "" ? h("pre", { className: "dsc-askQuote" }, quote) : null,
            q !== null ? h("div", { className: "dsc-askQuestion" }, q) : null,
            reasoningText.trim() !== "" ? h("div", { className: "dsc-askReasoning" }, reasoningText) : null,
            answerText.trim() !== "" ? h("div", { className: "dsc-askAnswer" }, answerText) : null,
            !hasContent ? h("div", { className: "dsc-askWaiting" }, t("ask.answering")) : null,
          );
        }

        /** 追问 tab 类型注册（sidebarRightTabs，可选服务，缺失则降级）。 */
        const sidebarTabs = ctx.get("sidebarRightTabs");
        if (sidebarTabs && typeof sidebarTabs.register === "function") {
          ctx.effect(() => sidebarTabs.register({
            id: ASK_ID,
            kind: ASK_KIND,
            title: () => t("ask.tabTitle"),
            description: () => t("ask.tabDesc"),
          }), "dsh-session-cleaner: ask tab type");
        }

        /** 追问 tab body（右侧栏）。 */
        ctx.slots.inject("sidebar.right.pane.tab", () =>
          ctx.slots.register(
            { name: "sidebar.right.pane.tab", key: ASK_ID, locale: NS },
            AskBody,
          ),
        );

        /** 会话菜单 → 删除会话 */
        ctx.slots.inject("sidebar.workspaces.session.menu.item", () =>
          ctx.slots.register(
            {
              name: "sidebar.workspaces.session.menu.item",
              id: "dsh-session-cleaner.delete-session",
              order: 500,
              locale: NS,
              inject: () => ({
                requestDelete: ({ sessionId, displayTitle, currentId }) => {
                  const isCurrent = currentId === sessionId;
                  openConfirm({
                    title: t("dialog.deleteSession.title"),
                    description: `${t("dialog.deleteSession.desc", { title: displayTitle || sessionId })}${
                      isCurrent ? `\n\n${t("dialog.deleteSession.current", { title: displayTitle || sessionId })}` : ""
                    }`,
                    confirmLabel: t("dialog.confirm"),
                    danger: true,
                    run: async () => {
                      const result = await (async () => {
                        try {
                          const r = await fetch("/api/dsh-session-cleaner/delete-session", {
                            method: "POST",
                            headers: { "content-type": "application/json" },
                            body: JSON.stringify({ sessionId }),
                          });
                          return await r.json();
                        } catch (error) {
                          return { ok: false, summary: `网络请求失败：${String(error?.message ?? error)}` };
                        }
                      })();
                      if (result?.ok === true && isCurrent && typeof ctx.uiWorkspace?.startSession === "function") {
                        try { ctx.uiWorkspace.startSession(); } catch { /* 导航失败不掩盖删除成功 */ }
                      }
                      return { ok: result?.ok === true, text: result?.summary ?? "" };
                    },
                  });
                },
              }),
            },
            DeleteSessionMenuItem,
          ),
        );

        /** 确认对话框 */
        ctx.slots.inject("shell.overlay", () =>
          ctx.slots.register(
            { name: "shell.overlay", id: "dsh-session-cleaner.confirm", locale: NS },
            ConfirmDialogHost,
          ),
        );

        /** 选取浮动工具条 */
        ctx.slots.inject("shell.overlay", () =>
          ctx.slots.register(
            { name: "shell.overlay", id: "dsh-session-cleaner.selection-popover", locale: NS },
            SelectionPopover,
          ),
        );

        // 卸载时释放选取监听。
        ctx.effect(() => () => selectionController.dispose(), "dsh-session-cleaner: selection listeners");
      },
    };
  },
});
