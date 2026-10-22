// page-review client: comment threads on any page. Injected by the page-review server.
// Select text and press "Comment", or Alt+click an element. Threads live in the side panel;
// agent replies and page edits arrive live.
(() => {
  if (window.__pageReview) return;
  window.__pageReview = true;

  const script = document.currentScript || document.querySelector('script[src*="/__review/client.js"]');
  const SITE = script?.dataset.site;
  const KIND = script?.dataset.kind || "dir";
  const API = "/__review/api";
  const STATE_KEY = "__page_review_state";
  const LAYOUT_KEY = "__page_review_layout";
  const SEEN_KEY = `__page_review_seen:${SITE}`;
  const page = (() => {
    let p = location.pathname;
    if (KIND === "dir" && p.endsWith("/")) p += "index.html";
    return p;
  })();

  let threads = [];
  let filter = "open";
  let panelOpen = false;
  let activeId = null;
  let drafts = {};
  let pendingAnchor = null;
  let restoredComposer = null;
  let reloadPending = false;
  // What the user last saw of each thread (agent replies + status), kept across visits, so
  // the launcher only lights up for news. `fresh` marks the cards that were news this time.
  let seen = {};
  try { seen = JSON.parse(localStorage.getItem(SEEN_KEY) || "{}"); } catch {}
  const fresh = new Set();
  // Where the panel is docked and how big it is, shared by every site on this server.
  let layout = { dock: "right", width: 396, height: 320 };
  try { layout = { ...layout, ...JSON.parse(localStorage.getItem(LAYOUT_KEY) || "{}") }; } catch {}
  if (!["left", "right", "bottom"].includes(layout.dock)) layout.dock = "right";

  // ── restore state across live reloads ──────────────────────────────────
  try {
    const s = JSON.parse(sessionStorage.getItem(STATE_KEY) || "null");
    if (s && s.page === page) {
      ({ panelOpen, activeId, filter, drafts } = { ...s, drafts: s.drafts || {} });
      restoredComposer = s.composer || null;
      sessionStorage.removeItem(STATE_KEY);
      addEventListener("load", () => scrollTo(0, s.scrollY || 0));
      setTimeout(() => scrollTo(0, s.scrollY || 0), 50);
    }
  } catch {}

  // ── DOM ────────────────────────────────────────────────────────────────
  const host = document.createElement("page-review");
  host.style.cssText = "all:initial;position:fixed;inset:0;pointer-events:none;z-index:2147483646";
  const root = host.attachShadow({ mode: "open" });
  const SHORTCUT = /Mac|iP(hone|ad)/.test(navigator.platform) ? "⌥C" : "Alt+C";
  root.innerHTML = `<style>${styles()}</style>
    <div class="pins"></div>
    <div class="box" hidden></div>
    <button class="sel-btn" hidden>💬 Comment</button>
    <div class="composer" hidden>
      <div class="quote"></div>
      <textarea placeholder="Ask a question or request a change. Type @ to point at a folder for context.  (⌘↵ to send)"></textarea>
      <div class="row"><span class="hint">Esc to cancel</span><button class="ghost cancel">Cancel</button><button class="primary send">Comment</button></div>
    </div>
    <aside class="panel" tabindex="-1">
      <header><b>Comments</b>
        <div class="tabs"><button data-f="open">Open</button><button data-f="resolved">Resolved</button><button data-f="all">All</button></div>
        <button class="dock-btn" title="Move panel" aria-haspopup="menu" aria-expanded="false"></button>
        <div class="dock-menu" role="menu" hidden>${["left", "bottom", "right"].map((d) => `<button role="menuitemradio" data-dock="${d}">${dockIcon(d)}Dock ${d}</button>`).join("")}</div>
        <button class="close" title="Close">✕</button></header>
      <div class="resizer" title="Drag to resize, double-click to reset"></div>
      <details class="settings">
        <summary>Agent settings</summary>
        <form class="settings-form">
          <fieldset disabled>
            <label>Provider<select name="provider" aria-label="Provider"></select></label>
            <label class="model-field">Model<select name="model" aria-label="Model"></select></label>
            <label class="custom-model-field" hidden>Custom model<input name="customModel" aria-label="Custom model" placeholder="Model ID or alias"></label>
            <label class="effort-field">Effort<select name="effort" aria-label="Effort"></select></label>
            <p class="settings-hint">Applies to the next run on this site. Running agents keep their settings.</p>
            <div class="row"><button type="button" class="ghost settings-defaults">Use defaults</button><button class="primary" type="submit">Save</button></div>
          </fieldset>
          <p class="settings-status" role="status">Loading settings…</p>
        </form>
      </details>
      <div class="list"></div>
      <footer>Select text and press <kbd>Comment</kbd>, or <kbd>Alt</kbd>+click an element. <kbd>${SHORTCUT}</kbd> toggles this panel.</footer>
      <footer class="reload-note" hidden>Page updated. It refreshes when you finish writing.</footer>
    </aside>
    <button class="launcher" title="Comments (${SHORTCUT})"><span class="ico">💬</span><span class="count"></span></button>
    <div class="mention-menu" role="listbox" hidden></div>`;
  document.documentElement.appendChild(host);
  const $ = (s) => root.querySelector(s);
  const pinsEl = $(".pins"), boxEl = $(".box"), selBtn = $(".sel-btn"), composer = $(".composer");
  const panel = $(".panel"), list = $(".list"), launcher = $(".launcher");
  const dockBtn = $(".dock-btn"), dockMenu = $(".dock-menu"), resizer = $(".resizer"), mentionMenu = $(".mention-menu");

  const hlStyle = document.createElement("style");
  hlStyle.textContent = `::highlight(page-review){background-color:rgba(255,200,0,.32)}::highlight(page-review-active){background-color:rgba(255,145,0,.55)}`;
  document.head.appendChild(hlStyle);

  const inUi = (e) => e.composedPath().includes(host);

  // ── anchors ────────────────────────────────────────────────────────────
  function cssPath(el) {
    if (!(el instanceof Element)) return "";
    const parts = [];
    while (el && el.nodeType === 1 && el !== document.documentElement) {
      if (el.id && document.querySelectorAll(`#${CSS.escape(el.id)}`).length === 1) {
        parts.unshift(`#${CSS.escape(el.id)}`);
        break;
      }
      let i = 1, sib = el;
      while ((sib = sib.previousElementSibling)) if (sib.tagName === el.tagName) i++;
      parts.unshift(`${el.tagName.toLowerCase()}:nth-of-type(${i})`);
      el = el.parentElement;
    }
    return parts.join(" > ");
  }

  function sectionOf(node) {
    const heads = [...document.querySelectorAll("h1,h2,h3,h4")];
    let found = "";
    for (const h of heads) if (h.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING || h.contains(node)) found = h.textContent.trim();
    return found.slice(0, 120);
  }

  // Visible page text with whitespace collapsed, mapped back to DOM positions. Anchors keep
  // the text just before and after them in this form so they can find their spot again
  // after the anchored text itself was rewritten.
  let pageTextCache = null;
  new MutationObserver(() => (pageTextCache = null)).observe(document.documentElement, { subtree: true, childList: true, characterData: true });
  function pageText() {
    if (pageTextCache) return pageTextCache;
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) => (n.parentElement?.closest("script,style,noscript,template") ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
    });
    const chars = [], map = [];
    let node, space = true;
    while ((node = walker.nextNode())) {
      const v = node.nodeValue;
      for (let i = 0; i < v.length; i++) {
        const ws = /\s/.test(v[i]);
        if (ws && space) continue;
        space = ws;
        chars.push(ws ? " " : v[i]);
        map.push([node, i]);
      }
    }
    return (pageTextCache = { text: chars.join(""), map });
  }

  // Index of the first page-text character at or after a DOM point.
  function textIndexAt(map, node, offset) {
    const point = document.createRange();
    point.setStart(node, offset);
    let lo = 0, hi = map.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (point.comparePoint(map[mid][0], map[mid][1]) < 0) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  function contextOf(range) {
    const { text, map } = pageText();
    const start = textIndexAt(map, range.startContainer, range.startOffset);
    const end = textIndexAt(map, range.endContainer, range.endOffset);
    return { before: text.slice(Math.max(0, start - 64), start), after: text.slice(end, end + 64) };
  }

  const snippetOf = (el) => (el.innerText || el.textContent || el.getAttribute("alt") || "").trim().replace(/\s+/g, " ").slice(0, 160);

  function textAnchor(range) {
    let el = range.commonAncestorContainer;
    if (el.nodeType !== 1) el = el.parentElement;
    const pre = document.createRange();
    pre.selectNodeContents(el);
    pre.setEnd(range.startContainer, range.startOffset);
    const full = el.textContent;
    const start = pre.toString().length;
    const exact = range.toString();
    return {
      kind: "text",
      selector: cssPath(el),
      exact: exact.slice(0, 600),
      prefix: full.slice(Math.max(0, start - 48), start),
      suffix: full.slice(start + exact.length, start + exact.length + 48),
      ...contextOf(range),
      section: sectionOf(el),
    };
  }

  function elementAnchor(el) {
    const range = document.createRange();
    range.selectNode(el);
    return {
      kind: "element",
      selector: cssPath(el),
      tag: el.tagName.toLowerCase(),
      snippet: snippetOf(el),
      ...contextOf(range),
      section: sectionOf(el),
    };
  }

  function rangeFromOffsets(el, start, end) {
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let pos = 0, node, r = document.createRange(), started = false;
    while ((node = walker.nextNode())) {
      const len = node.nodeValue.length;
      if (!started && start < pos + len) {
        r.setStart(node, start - pos);
        started = true;
      }
      if (started && end <= pos + len) {
        r.setEnd(node, end - pos);
        return r;
      }
      pos += len;
    }
    return null;
  }

  function findIn(el, a) {
    const text = el.textContent;
    let best = -1, bestScore = -1, i = text.indexOf(a.exact);
    while (i !== -1) {
      let score = 0;
      if (a.prefix && text.slice(Math.max(0, i - a.prefix.length), i) === a.prefix) score += 2;
      if (a.suffix && text.slice(i + a.exact.length, i + a.exact.length + a.suffix.length) === a.suffix) score += 2;
      if (score > bestScore) (best = i), (bestScore = score);
      i = text.indexOf(a.exact, i + 1);
    }
    return best === -1 ? null : rangeFromOffsets(el, best, best + a.exact.length);
  }

  // The text now sitting between the anchor's old neighbours: where it went after a rewrite.
  function relocate(a) {
    const before = (a.before || "").slice(-32), after = (a.after || "").slice(0, 32);
    if (!before.trim() || !after.trim()) return null;
    const { text, map } = pageText();
    const limit = Math.max(600, 4 * (a.exact || a.snippet || "").length);
    let best = null;
    for (let i = text.indexOf(before); i !== -1; i = text.indexOf(before, i + 1)) {
      const start = i + before.length, end = text.indexOf(after, start);
      if (end !== -1 && end - start <= limit && (!best || end - start < best[1] - best[0])) best = [start, end];
    }
    return best && spanRange(best[0], best[1]);
  }

  // A DOM range for page-text characters [start, end), without surrounding spaces.
  function spanRange(start, end) {
    const { text, map } = pageText();
    while (start < end && text[start] === " ") start++;
    while (end > start && text[end - 1] === " ") end--;
    if (start === end) return null;
    const r = document.createRange();
    r.setStart(map[start][0], map[start][1]);
    r.setEnd(map[end - 1][0], map[end - 1][1] + 1);
    return r;
  }

  // Resolution order: the anchor as saved, then its old neighbours, then its CSS path.
  // `moved` marks a match found after the page changed; render() saves it as the new anchor.
  function resolve(a) {
    if (!a) return null;
    let el = null;
    try { el = a.selector ? document.querySelector(a.selector) : null; } catch {}
    if (a.kind === "element") {
      if (el && snippetOf(el) === (a.snippet || "")) return { el };
      const r = relocate(a);
      let found = r && (r.commonAncestorContainer.nodeType === 1 ? r.commonAncestorContainer : r.commonAncestorContainer.parentElement);
      found = found && (found.closest(a.tag) || found);
      if (found) return { el: found, moved: true };
      return el ? { el, moved: true } : null;
    }
    if (!a.exact) return null;
    const r = (el && findIn(el, a)) || findIn(document.body, a);
    if (r) return { range: r };
    const moved = relocate(a);
    if (moved) return { range: moved, moved: true };
    if (!el || el === document.body) return null;
    if (el.textContent.trim().length > Math.max(400, 3 * a.exact.length)) return { el };
    const { map } = pageText();
    const all = spanRange(textIndexAt(map, el, 0), textIndexAt(map, el, el.childNodes.length));
    return all ? { range: all, moved: true } : { el };
  }

  // Save where a rewritten anchor went, once per thread per page load. The server keeps the
  // first quoted text as `original` so the thread still shows what the comment was about.
  const healed = new Set();
  function heal(t, r) {
    if (healed.has(t.id)) return;
    healed.add(t.id);
    const anchor = r.el ? elementAnchor(r.el) : textAnchor(r.range);
    if (!(anchor.exact || anchor.snippet || "").trim()) return;
    call("POST", `/threads/${t.id}/anchor`, { anchor }).then(upsert, () => {});
  }

  // ── rendering ──────────────────────────────────────────────────────────
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const md = (s) =>
    esc(s)
      .replace(/```([\s\S]*?)```/g, (_, c) => `<pre>${c.trim()}</pre>`)
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>")
      .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank">$1</a>')
      .replace(/(^|[\s(])@(?:&quot;(.+?)&quot;|((?:~|\.{1,2})?\/[^\s&<()]*[^\s&<().,;:!?]))/g, (_, pre, quoted, bare) => {
        const p = quoted || bare;
        return `${pre}<span class="mention" title="${p}">@${p.replace(/\/+$/, "").split("/").pop() || p}</span>`;
      })
      .replace(/\n/g, "<br>");
  // The raw markdown goes out as plain text, so editors and chat boxes get the reply exactly as
  // written; rich editors (Docs, Notion, mail) pick up the rendered HTML instead.
  async function copy(text) {
    try {
      const item = { "text/plain": new Blob([text], { type: "text/plain" }), "text/html": new Blob([md(text)], { type: "text/html" }) };
      await navigator.clipboard.write([new ClipboardItem(item)]);
      return true;
    } catch {}
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {}
    // Plain-http pages on a LAN address have no async clipboard.
    const ta = Object.assign(document.createElement("textarea"), { value: text });
    ta.style.cssText = "position:fixed;opacity:0";
    root.append(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  }
  const ago = (iso) => {
    const s = (Date.now() - new Date(iso)) / 1000;
    if (s < 60) return "just now";
    if (s < 3600) return `${Math.floor(s / 60)} min ago`;
    if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
    return new Date(iso).toLocaleDateString();
  };

  const visible = () => threads.filter((t) => filter === "all" || t.status === filter);
  const numberOf = (t) => threads.indexOf(t) + 1;

  // A thread is news when the agent replied or its status changed since the user last saw it.
  const seenKey = (t) => `${t.messages.filter((m) => m.author === "agent").length}:${t.status}`;
  const isNew = (t) => (t.id in seen ? seen[t.id] !== seenKey(t) : t.messages.some((m) => m.author === "agent"));

  // Everything in an open panel counts as seen.
  function markSeen() {
    let changed = false;
    for (const t of threads) {
      if (isNew(t)) fresh.add(t.id);
      if (seen[t.id] !== seenKey(t)) (seen[t.id] = seenKey(t)), (changed = true);
    }
    if (!changed) return;
    const ids = new Set(threads.map((t) => t.id));
    for (const id of Object.keys(seen)) if (!ids.has(id)) delete seen[id];
    try { localStorage.setItem(SEEN_KEY, JSON.stringify(seen)); } catch {}
  }

  function render() {
    if (panelOpen) markSeen();
    const open = threads.filter((t) => t.status === "open").length;
    launcher.querySelector(".count").textContent = open || "";
    launcher.classList.toggle("has", threads.some(isNew));
    panel.classList.toggle("open", panelOpen);
    launcher.hidden = panelOpen;
    root.querySelectorAll(".tabs button").forEach((b) => b.classList.toggle("on", b.dataset.f === filter));

    const items = visible();
    // A focused thread that leaves the list (resolved under the Open tab) loses its highlight and pin too.
    const active = threads.find((t) => t.id === activeId);
    if (active && !items.includes(active)) activeId = null;
    // Rebuilding the list would drop focus from a reply box mid-typing; put it back.
    const focused = root.activeElement?.tagName === "TEXTAREA" && list.contains(root.activeElement)
      ? { id: root.activeElement.closest(".card").dataset.id, start: root.activeElement.selectionStart, end: root.activeElement.selectionEnd }
      : null;
    list.innerHTML = items.length
      ? items.map(card).join("")
      : `<div class="empty">${filter === "open" ? "No open comments." : "Nothing here yet."}</div>`;
    for (const t of items) {
      const ta = list.querySelector(`[data-id="${t.id}"] textarea`);
      if (ta && drafts[t.id]) ta.value = drafts[t.id];
    }
    const refocus = focused && list.querySelector(`[data-id="${focused.id}"] textarea`);
    if (refocus) refocus.focus(), refocus.setSelectionRange(focused.start, focused.end);
    if (mention && !mention.ta.isConnected) refocus ? (mention.ta = refocus) : closeMention();
    paintHighlights();
    placePins();
  }

  function card(t) {
    const r = resolve(t.anchor);
    if (r?.moved) heal(t, r);
    const quote = t.anchor?.exact || t.anchor?.snippet || "";
    const was = t.anchor?.original?.trim() !== quote.trim() ? t.anchor?.original?.trim() || "" : "";
    const working = t.status === "open" && t.agent !== "idle" && t.messages.at(-1)?.author === "user";
    return `<article class="card ${t.id === activeId ? "active" : ""} ${t.status}" data-id="${t.id}">
      <div class="top"><span class="num">${numberOf(t)}</span>
        <span class="q">${t.anchor?.kind === "element" ? `&lt;${esc(t.anchor.tag)}&gt; ` : ""}${esc(quote.slice(0, 140))}${quote.length > 140 ? "…" : ""}${was ? `<span class="was" title="The page was edited since this comment">was <s>${esc(was.slice(0, 140))}${was.length > 140 ? "…" : ""}</s></span>` : ""}</span>
        ${fresh.has(t.id) ? `<span class="tag new">new</span>` : ""}${r ? "" : `<span class="tag">detached</span>`}</div>
      ${t.messages.map((m, i) => `<div class="msg ${m.author}"><div class="who"><span class="av">${m.author === "agent" ? "✳" : "You".slice(0, 1)}</span>${m.author === "agent" ? esc(m.name || "Claude") : "You"}<span class="at">${ago(m.at)}</span>${m.author === "agent" ? `<button class="copy" data-i="${i}" title="Copy reply">Copy</button>` : ""}</div><div class="txt">${md(m.text)}</div></div>`).join("")}
      ${working ? `<div class="working"><span class="dot"></span>${t.agent === "working" ? `${t.worker || "Claude"} is working on it…` : `Waiting for ${t.worker || "the agent"}…`}</div>` : ""}
      <div class="reply"><textarea rows="1" placeholder="Reply…  (@ for a folder)"></textarea>
        <div class="row">${t.status === "open" ? `<button class="ghost resolve">Resolve</button>` : `<button class="ghost reopen">Reopen</button>`}<button class="ghost del" title="Delete thread">Delete</button><button class="primary send-reply">Reply</button></div></div>
    </article>`;
  }

  function paintHighlights() {
    if (!window.CSS?.highlights) return;
    const all = new Highlight(), act = new Highlight();
    for (const t of threads) {
      if (t.status !== "open" && t.id !== activeId) continue;
      const r = resolve(t.anchor);
      if (r?.range) (t.id === activeId ? act : all).add(r.range);
    }
    CSS.highlights.set("page-review", all);
    CSS.highlights.set("page-review-active", act);
  }

  function rectOf(t) {
    const r = resolve(t.anchor);
    if (!r) return null;
    if (r.el) return r.el.getBoundingClientRect();
    const rects = r.range.getClientRects();
    return rects.length ? rects[rects.length - 1] : r.range.getBoundingClientRect();
  }

  function placePins() {
    const shown = threads.filter((t) => t.status === "open" || t.id === activeId);
    const area = pageArea();
    pinsEl.innerHTML = shown
      .map((t) => {
        const r = rectOf(t);
        if (!r || (!r.width && !r.height)) return "";
        const maxLeft = panelOpen && layout.dock === "right" ? area.right - 24 : innerWidth - 40;
        return `<button class="pin ${t.id === activeId ? "active" : ""}" data-id="${t.id}" style="top:${r.top - 20}px;left:${Math.max(area.left + 4, Math.min(r.right - 6, maxLeft))}px">${numberOf(t)}</button>`;
      })
      .join("");
    const active = threads.find((t) => t.id === activeId);
    const ar = active && resolve(active.anchor)?.el ? rectOf(active) : null;
    boxEl.hidden = !ar;
    if (ar) Object.assign(boxEl.style, { top: `${ar.top - 3}px`, left: `${ar.left - 3}px`, width: `${ar.width + 6}px`, height: `${ar.height + 6}px` });
  }

  let raf = 0;
  const reflow = () => {
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(placePins);
  };
  addEventListener("scroll", reflow, true);
  addEventListener("resize", reflow);

  // ── layout ─────────────────────────────────────────────────────────────
  const clamp = (v, lo, hi) => Math.round(Math.max(lo, Math.min(hi, Number(v) || lo)));
  const DEFAULT_SIZE = { width: 396, height: 320 };
  const fitWidth = (w) => clamp(w, 360, innerWidth - 120);
  const fitHeight = (h) => clamp(h, 160, innerHeight - 80);
  const panelSize = () => (layout.dock === "bottom" ? fitHeight(layout.height) : fitWidth(layout.width));

  // The part of the viewport the open panel leaves uncovered.
  function pageArea() {
    const s = panelOpen ? panelSize() : 0;
    return {
      left: layout.dock === "left" ? s : 0,
      right: innerWidth - (layout.dock === "right" ? s : 0),
      bottom: innerHeight - (layout.dock === "bottom" ? s : 0),
    };
  }

  function applyLayout() {
    const bottom = layout.dock === "bottom";
    for (const d of ["left", "right", "bottom"]) panel.classList.toggle(`dock-${d}`, d === layout.dock);
    panel.style.width = bottom ? "" : `${panelSize()}px`;
    panel.style.height = bottom ? `${panelSize()}px` : "";
    launcher.classList.toggle("left", layout.dock === "left");
    dockBtn.innerHTML = dockIcon(layout.dock);
    dockMenu.querySelectorAll("button").forEach((b) => b.setAttribute("aria-checked", b.dataset.dock === layout.dock));
    reflow();
  }
  const saveLayout = () => { try { localStorage.setItem(LAYOUT_KEY, JSON.stringify(layout)); } catch {} };
  addEventListener("resize", applyLayout);

  const toggleDockMenu = (show = dockMenu.hidden) => ((dockMenu.hidden = !show), dockBtn.setAttribute("aria-expanded", show));
  dockBtn.addEventListener("click", () => toggleDockMenu());
  dockMenu.addEventListener("click", (e) => {
    const d = e.target.closest("[data-dock]")?.dataset.dock;
    if (!d) return;
    layout.dock = d;
    toggleDockMenu(false);
    applyLayout();
    saveLayout();
  });
  panel.addEventListener("click", (e) => {
    if (!dockMenu.hidden && !e.target.closest(".dock-btn, .dock-menu")) toggleDockMenu(false);
  });

  // Drag the panel's inner edge to resize it; double-click resets the default size.
  resizer.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    resizer.setPointerCapture(e.pointerId);
    panel.classList.add("resizing");
  });
  resizer.addEventListener("pointermove", (e) => {
    if (!resizer.hasPointerCapture(e.pointerId)) return;
    if (layout.dock === "bottom") layout.height = fitHeight(innerHeight - e.clientY);
    else layout.width = fitWidth(layout.dock === "left" ? e.clientX : innerWidth - e.clientX);
    applyLayout();
  });
  resizer.addEventListener("lostpointercapture", () => (panel.classList.remove("resizing"), saveLayout()));
  resizer.addEventListener("dblclick", () => {
    layout[layout.dock === "bottom" ? "height" : "width"] = DEFAULT_SIZE[layout.dock === "bottom" ? "height" : "width"];
    applyLayout();
    saveLayout();
  });
  applyLayout();

  // `reveal` scrolls the list to the card; skip it when the click came from the card itself.
  function focusThread(id, scroll = true, reveal = true) {
    activeId = id;
    panelOpen = true;
    render();
    const t = threads.find((x) => x.id === id);
    const r = t && resolve(t.anchor);
    if (scroll && r) scrollToAnchor(r);
    // Only move the comments list; scrollIntoView can also scroll the document.
    const card = reveal && list.querySelector(`[data-id="${id}"]`);
    if (card) {
      const bounds = list.getBoundingClientRect(), rect = card.getBoundingClientRect();
      if (rect.top < bounds.top) list.scrollTop += rect.top - bounds.top;
      else if (rect.bottom > bounds.bottom) list.scrollTop += Math.min(rect.bottom - bounds.bottom, rect.top - bounds.top);
    }
  }

  function scrollToAnchor(anchor) {
    const rect = anchor.el?.getBoundingClientRect() || [...anchor.range.getClientRects()].find((r) => r.width > 0 && r.height > 0);
    if (!rect) return;
    // A range can start in a whitespace node whose parent spans the entire page.
    // Use the first visible text rectangle, never that parent's center.
    let targetY = rect.top + Math.min(rect.height, innerHeight) / 2;
    let el = anchor.el?.parentElement || anchor.range.startContainer.parentElement;
    for (; el && el !== document.body && el !== document.documentElement; el = el.parentElement) {
      if (el.scrollHeight <= el.clientHeight || !/(auto|scroll|hidden)/.test(getComputedStyle(el).overflowY)) continue;
      const bounds = el.getBoundingClientRect();
      const delta = targetY - (bounds.top + el.clientTop + el.clientHeight / 2);
      const next = Math.max(0, Math.min(el.scrollHeight - el.clientHeight, el.scrollTop + delta));
      targetY -= next - el.scrollTop;
      el.scrollTo({ top: next, behavior: "smooth" });
    }
    window.scrollBy({ top: targetY - innerHeight / 2, behavior: "smooth" });
  }

  // ── API ────────────────────────────────────────────────────────────────
  const call = async (method, p, body) => {
    const r = await fetch(API + p, { method, headers: { "content-type": "application/json" }, body: body && JSON.stringify(body) });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || `Request failed (${r.status})`);
    return data;
  };

  let choices = [];
  const settingsForm = $(".settings-form");
  const providerInput = settingsForm.elements.provider;
  const modelInput = settingsForm.elements.model;
  const customModelInput = settingsForm.elements.customModel;
  const effortInput = settingsForm.elements.effort;
  const selectedModel = () => modelInput.value === "__custom__" ? customModelInput.value.trim() : modelInput.value;
  const option = (value, label = value) => `<option value="${esc(value)}">${esc(label)}</option>`;

  function updateEfforts(effort = effortInput.value) {
    const provider = choices.find((c) => c.id === providerInput.value);
    const efforts = provider?.models.find((m) => m.id === selectedModel())?.efforts || provider?.efforts || [];
    effortInput.innerHTML = option("", "Default") + efforts.map((e) => option(e)).join("");
    effortInput.value = efforts.includes(effort) ? effort : "";
    $(".custom-model-field").hidden = modelInput.value !== "__custom__";
  }

  function updateModels(model = "", effort = "") {
    const provider = choices.find((c) => c.id === providerInput.value);
    const local = Boolean(provider?.efforts.length);
    $(".model-field").hidden = $(".effort-field").hidden = !local;
    modelInput.innerHTML = option("", "Default") + (provider?.models || []).map((m) => option(m.id)).join("") + option("__custom__", "Custom model…");
    const custom = model && !provider?.models.some((m) => m.id === model);
    modelInput.value = local ? (custom ? "__custom__" : model || "") : "";
    customModelInput.value = custom ? model : "";
    updateEfforts(local ? effort : "");
    $(".settings-hint").textContent = provider?.id === "webhook"
      ? "Uses this site's configured webhook. Model and effort are configured by its receiver."
      : provider?.id === "none" ? "Automatic replies are off for the next comment on this site."
      : "Applies to the next run on this site. Running agents keep their settings.";
  }

  function showSettings(site) {
    providerInput.value = site.runner_settings.kind;
    updateModels(site.runner_settings.model, site.runner_settings.effort);
    $(".settings-status").textContent = site.runner_override ? "Saved for this site." : "Using global defaults.";
  }

  async function loadSettings() {
    try {
      const [config, sites] = await Promise.all([call("GET", "/config"), call("GET", "/sites")]);
      choices = config.runner_choices;
      providerInput.innerHTML = choices.map((c) => option(c.id, c.name)).join("");
      showSettings(sites.find((s) => s.id === SITE));
      settingsForm.querySelector("fieldset").disabled = false;
    } catch (e) { $(".settings-status").textContent = `Could not load settings: ${e.message}`; }
  }

  async function saveSettings(settings) {
    settingsForm.querySelector("fieldset").disabled = true;
    try {
      showSettings(await call("PATCH", `/sites/${SITE}`, { runner_settings: settings }));
    } catch (e) { $(".settings-status").textContent = `Could not save: ${e.message}`; }
    finally { settingsForm.querySelector("fieldset").disabled = false; }
  }
  providerInput.addEventListener("change", () => updateModels());
  modelInput.addEventListener("change", () => updateEfforts());
  customModelInput.addEventListener("input", () => updateEfforts());
  settingsForm.addEventListener("input", () => { $(".settings-status").textContent = "Unsaved changes."; });
  settingsForm.addEventListener("change", () => { $(".settings-status").textContent = "Unsaved changes."; });
  settingsForm.addEventListener("submit", (e) => {
    e.preventDefault();
    if (modelInput.value === "__custom__" && !selectedModel()) {
      $(".settings-status").textContent = "Enter a model ID or choose Default.";
      return;
    }
    saveSettings({ kind: providerInput.value, model: selectedModel() || null, effort: effortInput.value || null });
  });
  $(".settings-defaults").addEventListener("click", () => saveSettings(null));

  function upsert(t) {
    if (t.siteId !== SITE || t.page !== page) return;
    const i = threads.findIndex((x) => x.id === t.id);
    if (i === -1) threads.push(t);
    else threads[i] = t;
    render();
  }

  async function load() {
    threads = await call("GET", `/threads?site=${SITE}&page=${encodeURIComponent(page)}&full=1`);
    render();
    if (activeId) focusThread(activeId, false);
  }

  const es = new EventSource(`${API}/events?site=${SITE}`);
  es.onmessage = (e) => {
    const ev = JSON.parse(e.data);
    if (ev.type === "thread") upsert(ev.thread);
    if (ev.type === "deleted") (threads = threads.filter((t) => t.id !== ev.id)), render();
    if (ev.type === "reload" && ("/" + ev.file === decodeURIComponent(page) || /\.(css|m?js|svg)$/i.test(ev.file))) {
      reloadPending = true;
      flushReload();
    }
  };

  // ── never lose work in progress ────────────────────────────────────────
  // Live reloads wait while a comment or reply is being written, and drafts
  // (including an open composer) are saved whenever the page unloads.
  function saveState() {
    const text = composer.querySelector("textarea").value;
    const composerState = pendingAnchor && !composer.hidden ? { anchor: pendingAnchor, text } : null;
    sessionStorage.setItem(STATE_KEY, JSON.stringify({ page, scrollY, panelOpen, activeId, filter, drafts, composer: composerState }));
  }
  addEventListener("pagehide", saveState);

  const writing = () => !composer.hidden || (root.activeElement?.tagName === "TEXTAREA" && list.contains(root.activeElement));
  function flushReload() {
    const wait = reloadPending && writing();
    root.querySelector(".reload-note").hidden = !wait;
    composer.querySelector(".hint").textContent = wait ? "Page updated. Refreshes after you send or cancel." : "Esc to cancel";
    if (reloadPending && !wait) saveState(), location.reload();
  }
  // Check after the current interaction settles (submit re-renders, blur moves focus).
  const settleReload = () => setTimeout(flushReload, 0);
  list.addEventListener("focusout", settleReload);

  // ── @path mentions ─────────────────────────────────────────────────────
  // Typing @ in a comment or reply suggests folders (recent ones and the projects next to this
  // one, or the contents of a typed path); the agent gets read access to what is mentioned.
  let mention = null; // { ta, start, items, index }
  let mentionSeq = 0;
  function closeMention() {
    mentionSeq++;
    mention = null;
    mentionMenu.hidden = true;
  }
  async function updateMention(ta) {
    const before = ta.value.slice(0, ta.selectionStart);
    const m = ta.selectionStart === ta.selectionEnd && before.match(/(?:^|[\s(])@("[^"\n]*|[^\s"()]*)$/);
    if (!m) return closeMention();
    const seq = ++mentionSeq;
    let items = [], error = null;
    try { items = await call("GET", `/paths?site=${SITE}&q=${encodeURIComponent(m[1].replace(/^"/, ""))}`); }
    catch (e) { error = /not found/.test(e.message) ? "Folder suggestions need a newer server. Run page-review restart." : e.message; }
    if (seq !== mentionSeq) return; // a later keystroke asked again
    if (!items.length && !error) return closeMention();
    mention = { ta, start: before.length - m[1].length - 1, items, index: 0, error };
    renderMention();
  }
  function renderMention() {
    mentionMenu.innerHTML = mention.items
      .map((it, i) => `<button type="button" role="option" data-i="${i}" class="${i === mention.index ? "on" : ""}"><span>${it.dir ? "📁" : "📄"}</span><b>${esc(it.label)}</b><span class="where">${esc(it.detail)}</span></button>`)
      .join("") + `<div class="mention-hint">${mention.error ? esc(mention.error) : "↵ or Tab to pick · Esc to close"}</div>`;
    mentionMenu.hidden = false;
    const r = mention.ta.getBoundingClientRect();
    const width = Math.max(r.width, 300);
    const below = innerHeight - r.bottom > 240;
    Object.assign(mentionMenu.style, {
      left: `${Math.max(8, Math.min(r.left, innerWidth - width - 8))}px`,
      width: `${width}px`,
      top: below ? `${r.bottom + 4}px` : "",
      bottom: below ? "" : `${innerHeight - r.top + 4}px`,
    });
    mentionMenu.querySelector(".on")?.scrollIntoView({ block: "nearest" });
  }
  // A folder is completed with a trailing slash and keeps the menu open on its contents; a space ends it.
  function pickMention(i) {
    const { ta, start, items } = mention;
    const it = items[i];
    const text = /\s/.test(it.insert) ? `@"${it.insert}" ` : `@${it.insert}${it.dir ? "" : " "}`;
    ta.value = ta.value.slice(0, start) + text + ta.value.slice(ta.selectionStart);
    ta.setSelectionRange(start + text.length, start + text.length);
    ta.focus();
    ta.dispatchEvent(new Event("input", { bubbles: true, composed: true })); // saves the draft and refreshes the menu
  }
  root.addEventListener("input", (e) => {
    if (e.target.tagName === "TEXTAREA") updateMention(e.target);
  });
  root.addEventListener("click", (e) => {
    if (e.target.tagName === "TEXTAREA") updateMention(e.target);
  });
  root.addEventListener("focusout", (e) => {
    if (e.target === mention?.ta) setTimeout(() => mention && root.activeElement !== mention.ta && closeMention(), 0);
  });
  list.addEventListener("scroll", () => mention && closeMention());
  // Captured before the composer's and panel's own keys: Enter picks instead of adding a line, Esc only closes the menu.
  root.addEventListener(
    "keydown",
    (e) => {
      if (!mention || e.target !== mention.ta) return;
      const n = mention.items.length;
      if (!n && e.key !== "Escape") return;
      if (e.key === "ArrowDown" || e.key === "ArrowUp") (mention.index = (mention.index + (e.key === "ArrowDown" ? 1 : n - 1)) % n), renderMention();
      else if ((e.key === "Enter" && !e.metaKey && !e.ctrlKey && !e.shiftKey) || e.key === "Tab") pickMention(mention.index);
      else if (e.key === "Escape") closeMention();
      else return;
      e.preventDefault();
      e.stopPropagation();
    },
    true,
  );
  mentionMenu.addEventListener("mousedown", (e) => e.preventDefault()); // keep focus in the text box
  mentionMenu.addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (b && mention) pickMention(Number(b.dataset.i));
  });

  // ── interactions ───────────────────────────────────────────────────────
  function openComposer(anchor, rect) {
    pendingAnchor = anchor;
    selBtn.hidden = true;
    composer.hidden = false;
    composer.querySelector(".quote").textContent = anchor.kind === "element" ? `<${anchor.tag}> ${anchor.snippet}` : anchor.exact;
    const area = pageArea();
    const top = Math.max(8, Math.min(rect.bottom + 8, area.bottom - 190));
    const left = Math.max(area.left + 8, Math.min(rect.left, area.right - 368));
    Object.assign(composer.style, { top: `${top}px`, left: `${left}px` });
    const ta = composer.querySelector("textarea");
    ta.value = "";
    ta.focus();
    flushReload();
  }
  const closeComposer = () => ((composer.hidden = true), (pendingAnchor = null), (boxEl.hidden = true), closeMention(), placePins(), settleReload());

  async function submitComment() {
    const ta = composer.querySelector("textarea");
    const text = ta.value.trim();
    if (!text || !pendingAnchor) return;
    const t = await call("POST", "/threads", { siteId: SITE, page, anchor: pendingAnchor, text });
    closeComposer();
    getSelection()?.removeAllRanges();
    upsert(t);
    focusThread(t.id, false);
  }

  document.addEventListener("mouseup", (e) => {
    if (inUi(e)) return;
    setTimeout(() => {
      const sel = getSelection();
      if (!sel || sel.isCollapsed || !sel.toString().trim()) return (selBtn.hidden = true);
      const r = sel.getRangeAt(0).getBoundingClientRect();
      Object.assign(selBtn.style, { top: `${Math.max(4, r.top - 40)}px`, left: `${Math.min(r.right - 60, innerWidth - 130)}px` });
      selBtn.hidden = false;
    }, 0);
  });
  selBtn.addEventListener("mousedown", (e) => e.preventDefault());
  selBtn.addEventListener("click", () => {
    const sel = getSelection();
    if (!sel || sel.isCollapsed) return;
    const range = sel.getRangeAt(0);
    openComposer(textAnchor(range), range.getBoundingClientRect());
  });

  // Alt+hover outlines an element; Alt+click comments on it.
  document.addEventListener("mousemove", (e) => {
    if (!e.altKey || inUi(e) || !composer.hidden) return;
    const el = e.target;
    if (!(el instanceof Element)) return;
    const r = el.getBoundingClientRect();
    boxEl.hidden = false;
    boxEl.classList.add("hover");
    Object.assign(boxEl.style, { top: `${r.top - 3}px`, left: `${r.left - 3}px`, width: `${r.width + 6}px`, height: `${r.height + 6}px` });
  });
  document.addEventListener("keyup", (e) => {
    if (e.key === "Alt" && composer.hidden) (boxEl.hidden = true), boxEl.classList.remove("hover"), placePins();
  });
  document.addEventListener(
    "click",
    (e) => {
      if (!e.altKey || inUi(e)) return;
      e.preventDefault();
      e.stopPropagation();
      boxEl.classList.remove("hover");
      openComposer(elementAnchor(e.target), e.target.getBoundingClientRect());
    },
    true,
  );

  composer.querySelector(".send").addEventListener("click", submitComment);
  composer.querySelector(".cancel").addEventListener("click", closeComposer);
  composer.querySelector("textarea").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submitComment();
    if (e.key === "Escape") closeComposer();
  });

  // The panel takes focus (tabindex=-1) so Esc can close it after a click anywhere inside.
  const openPanel = () => ((panelOpen = true), render(), panel.focus({ preventScroll: true }));
  const closePanel = () => ((panelOpen = false), (activeId = null), fresh.clear(), root.activeElement?.blur(), render());
  launcher.addEventListener("click", openPanel);
  $(".close").addEventListener("click", closePanel);
  panel.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    e.stopPropagation();
    if (!dockMenu.hidden) return toggleDockMenu(false), dockBtn.focus();
    // First Esc leaves a reply box or settings field, the next one closes the panel.
    if (e.target.matches("input, textarea, select, [contenteditable]")) panel.focus({ preventScroll: true });
    else closePanel();
  });
  root.querySelectorAll(".tabs button").forEach((b) => b.addEventListener("click", () => ((filter = b.dataset.f), render())));
  pinsEl.addEventListener("click", (e) => {
    const id = e.target.closest(".pin")?.dataset.id;
    if (id) focusThread(id, false), panel.focus({ preventScroll: true });
  });

  list.addEventListener("click", async (e) => {
    const cardEl = e.target.closest(".card");
    if (!cardEl) return;
    const id = cardEl.dataset.id;
    const ta = cardEl.querySelector("textarea");
    const copyBtn = e.target.closest(".copy");
    if (copyBtn) {
      const text = threads.find((t) => t.id === id)?.messages[copyBtn.dataset.i]?.text;
      if (text == null) return;
      copyBtn.textContent = (await copy(text)) ? "Copied" : "Copy failed";
      setTimeout(() => (copyBtn.textContent = "Copy"), 1500);
    } else if (e.target.closest(".send-reply")) {
      const text = ta.value.trim();
      if (!text) return;
      delete drafts[id];
      closeMention();
      upsert(await call("POST", `/threads/${id}/messages`, { author: "user", text }));
    } else if (e.target.closest(".resolve")) upsert(await call("POST", `/threads/${id}/status`, { status: "resolved", author: "user" }));
    else if (e.target.closest(".reopen")) upsert(await call("POST", `/threads/${id}/status`, { status: "open" }));
    else if (e.target.closest(".del")) {
      if (confirm("Delete this thread?")) await call("DELETE", `/threads/${id}`);
    } else if (!e.target.closest("textarea, a")) {
      // A drag-select ends in a click; re-rendering the list here would wipe the selection.
      const sel = root.getSelection?.() || getSelection();
      if (sel && !sel.isCollapsed && sel.toString().trim()) return;
      focusThread(id, true, false);
    }
  });
  list.addEventListener("input", (e) => {
    const id = e.target.closest(".card")?.dataset.id;
    if (id && e.target.tagName === "TEXTAREA") drafts[id] = e.target.value;
  });
  list.addEventListener("keydown", (e) => {
    if (e.target.tagName === "TEXTAREA" && e.key === "Enter" && (e.metaKey || e.ctrlKey)) e.target.closest(".card").querySelector(".send-reply").click();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !composer.hidden) closeComposer();
    // Alt+C toggles the panel. e.code, because on a Mac Option+C types "ç". Fields on the page
    // keep the keystroke; the panel's own reply boxes don't need it.
    if (e.code === "KeyC" && e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
      if (!inUi(e) && e.target instanceof Element && e.target.matches("input, textarea, select, [contenteditable], [contenteditable] *")) return;
      e.preventDefault();
      if (panelOpen) closePanel();
      else openPanel();
    }
  });

  load();
  loadSettings();
  // Reopen a comment that was being written when the page reloaded, after scroll is restored.
  if (restoredComposer) setTimeout(() => {
    const { anchor, text } = restoredComposer;
    const r = resolve(anchor);
    const rect = r?.el?.getBoundingClientRect() || r?.range.getBoundingClientRect() || { top: 80, bottom: 80, left: 24 };
    openComposer(anchor, rect);
    composer.querySelector("textarea").value = text;
  }, 60);

  // A window outline with the docked side filled in.
  function dockIcon(d) {
    const fill = { left: "M3 4h4v8H3z", right: "M9 4h4v8H9z", bottom: "M3 9h10v3H3z" }[d];
    return `<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><rect x="1.5" y="2.5" width="13" height="11" rx="2" fill="none" stroke="currentColor"/><path d="${fill}" fill="currentColor"/></svg>`;
  }

  function styles() {
    return `
    :host{--ink:#1f1f23;--sub:#6b6b74;--line:#e6e6ea;--accent:#d97757;--hl:#ffb020;font:13.5px/1.45 -apple-system,BlinkMacSystemFont,Inter,"Segoe UI",sans-serif;color:var(--ink)}
    *{box-sizing:border-box} button{font:inherit;cursor:pointer} [hidden]{display:none!important}
    .launcher,.sel-btn,.composer,.panel,.pin,.mention-menu{pointer-events:auto}
    .launcher,.sel-btn,.composer,.panel,.pins,.mention-menu{font:13.5px/1.45 -apple-system,BlinkMacSystemFont,Inter,"Segoe UI",sans-serif;color:var(--ink);text-align:left;letter-spacing:normal}
    .launcher{position:fixed;right:20px;bottom:20px;height:44px;min-width:44px;padding:0 14px;border-radius:22px;border:0;background:var(--ink);color:#fff;box-shadow:0 8px 24px rgba(0,0,0,.25);display:flex;gap:6px;align-items:center;justify-content:center;font-size:15px}
    .launcher.left{right:auto;left:20px} .launcher.has{background:var(--accent)} .launcher .count:empty{display:none} .launcher .count{font-weight:700}
    .sel-btn{position:fixed;padding:7px 12px;border-radius:9px;border:0;background:var(--ink);color:#fff;font-weight:600;box-shadow:0 6px 18px rgba(0,0,0,.25)}
    .composer{position:fixed;width:360px;background:#fff;border-radius:14px;box-shadow:0 18px 48px rgba(0,0,0,.22),0 0 0 1px rgba(0,0,0,.06);padding:12px}
    .quote{font-size:12.5px;color:var(--sub);border-left:3px solid var(--hl);padding:2px 0 2px 9px;margin-bottom:9px;max-height:64px;overflow:hidden;white-space:pre-wrap}
    textarea{width:100%;border:1px solid var(--line);border-radius:10px;padding:9px 10px;font:inherit;resize:vertical;min-height:38px;outline:none;color:var(--ink);background:#fff}
    textarea:focus{border-color:#b9b9c3;box-shadow:0 0 0 3px rgba(0,0,0,.05)} .composer textarea{min-height:80px}
    .row{display:flex;gap:6px;align-items:center;justify-content:flex-end;margin-top:8px} .hint{flex:1;color:var(--sub);font-size:12px}
    .primary{border:0;background:var(--ink);color:#fff;padding:6px 13px;border-radius:8px;font-weight:600} .ghost{border:1px solid var(--line);background:#fff;color:var(--ink);padding:5px 11px;border-radius:8px}
    .ghost.del{color:#b42318;border-color:transparent}
    .panel:focus{outline:none} .panel{position:fixed;background:#f7f7f9;transition:transform .2s ease;display:flex;flex-direction:column}
    .panel.dock-right{top:0;right:0;bottom:0;border-left:1px solid var(--line);box-shadow:-12px 0 32px rgba(0,0,0,.08);transform:translateX(105%)}
    .panel.dock-left{top:0;left:0;bottom:0;border-right:1px solid var(--line);box-shadow:12px 0 32px rgba(0,0,0,.08);transform:translateX(-105%)}
    .panel.dock-bottom{left:0;right:0;bottom:0;border-top:1px solid var(--line);box-shadow:0 -12px 32px rgba(0,0,0,.08);transform:translateY(105%)}
    .panel.open{transform:none} .panel.resizing{user-select:none;transition:none}
    .resizer{position:absolute;z-index:3;touch-action:none} .resizer::after{content:"";position:absolute;background:var(--accent);opacity:0;transition:opacity .15s}
    .resizer:hover::after,.resizing .resizer::after{opacity:1}
    .dock-right .resizer{top:0;bottom:0;left:-4px;width:8px;cursor:ew-resize} .dock-left .resizer{top:0;bottom:0;right:-4px;width:8px;cursor:ew-resize}
    .dock-right .resizer::after,.dock-left .resizer::after{top:0;bottom:0;left:3px;width:2px}
    .dock-bottom .resizer{left:0;right:0;top:-4px;height:8px;cursor:ns-resize} .dock-bottom .resizer::after{left:0;right:0;top:3px;height:2px}
    .dock-bottom .list{display:grid;grid-template-columns:repeat(auto-fill,minmax(340px,1fr));gap:10px;align-items:start;align-content:start}
    .dock-bottom .card{margin:0} .dock-bottom .empty{grid-column:1/-1}
    header{position:relative;z-index:2;display:flex;align-items:center;gap:10px;padding:14px 16px;border-bottom:1px solid var(--line);background:#fff} header b{font-size:15px}
    .dock-btn{border:0;background:none;color:var(--sub);padding:4px;display:grid;place-items:center;border-radius:6px} .dock-btn:hover,.dock-btn[aria-expanded=true]{background:#efeff2;color:var(--ink)}
    .dock-menu{position:absolute;top:calc(100% - 8px);right:12px;background:#fff;border-radius:10px;box-shadow:0 12px 32px rgba(0,0,0,.16),0 0 0 1px rgba(0,0,0,.06);padding:4px;display:flex;flex-direction:column;min-width:150px}
    .dock-menu button{border:0;background:none;display:flex;align-items:center;gap:9px;padding:6px 9px;border-radius:7px;color:var(--ink);text-transform:none}
    .dock-menu button:hover{background:#f3f3f5} .dock-menu button[aria-checked=true]{color:var(--accent);font-weight:600}
    .tabs{display:flex;gap:2px;background:#efeff2;border-radius:8px;padding:2px;margin-left:auto} .tabs button{border:0;background:none;padding:4px 9px;border-radius:6px;color:var(--sub);font-size:12.5px} .tabs button.on{background:#fff;color:var(--ink);box-shadow:0 1px 2px rgba(0,0,0,.08)}
    .close{border:0;background:none;color:var(--sub);font-size:15px;padding:4px}
    .list{flex:1;min-height:0;overflow:auto;padding:12px;overscroll-behavior:contain}
    .settings{padding:10px 16px;border-bottom:1px solid var(--line);background:#fff;max-height:55%;overflow:auto}
    .settings summary{cursor:pointer;font-weight:600} .settings form{margin-top:10px}
    .settings fieldset{border:0;margin:0;padding:0;min-width:0}
    .settings label{display:block;margin:8px 0;font-size:12px;color:var(--sub)}
    .settings select,.settings input{display:block;width:100%;margin-top:3px;padding:7px 8px;border:1px solid var(--line);border-radius:7px;font:inherit;color:var(--ink);background:#fff}
    .settings-hint,.settings-status{font-size:12px;color:var(--sub);margin:8px 0 0}
    .empty{color:var(--sub);text-align:center;margin-top:40px}
    footer{padding:10px 16px;color:var(--sub);font-size:12px;border-top:1px solid var(--line);background:#fff} kbd{font:11px ui-monospace,Menlo,monospace;background:#efeff2;border-radius:4px;padding:1px 5px}
    .card{background:#fff;border:1px solid var(--line);border-radius:12px;padding:12px;margin-bottom:10px;cursor:pointer;transition:box-shadow .15s}
    .card.active{box-shadow:0 0 0 2px var(--accent),0 8px 24px rgba(0,0,0,.08);cursor:default} .card.resolved{opacity:.72}
    .top{display:flex;gap:8px;align-items:flex-start;margin-bottom:8px}
    .num,.pin{width:20px;height:20px;flex:none;border-radius:50%;background:var(--hl);color:#3b2600;font-size:11.5px;font-weight:700;display:grid;place-items:center;border:0}
    .resolved .num{background:#d5d5db;color:#555}
    .q{color:var(--sub);font-size:12.5px;border-left:2px solid #ffd27a;padding-left:8px;flex:1;white-space:pre-wrap;word-break:break-word}
    .was{display:block;margin-top:3px;font-size:11.5px;color:#9a9aa3} .was s{color:#9a9aa3}
    .tag{font-size:11px;background:#fdecea;color:#b42318;border-radius:99px;padding:1px 7px} .tag.new{background:#fbe6dd;color:var(--accent);font-weight:600}
    .msg{margin:8px 0 0} .who{display:flex;align-items:center;gap:7px;font-weight:600;font-size:12.5px}
    .av{width:20px;height:20px;border-radius:50%;display:grid;place-items:center;font-size:11px;background:#e3e8f8;color:#2b4bb8} .agent .av{background:#fbe6dd;color:var(--accent)}
    .at{color:var(--sub);font-weight:400;font-size:11.5px}
    .copy{margin-left:auto;border:0;background:none;color:var(--sub);font-size:11.5px;font-weight:400;padding:1px 6px;border-radius:5px;opacity:0;transition:opacity .15s}
    .msg:hover .copy,.copy:focus-visible{opacity:1} .copy:hover{background:#efeff2;color:var(--ink)} .txt{margin:3px 0 0 27px;word-break:break-word}
    .txt code{font:12px ui-monospace,Menlo,monospace;background:#f0f0f3;border-radius:4px;padding:0 4px} .txt pre{font:12px ui-monospace,Menlo,monospace;background:#f0f0f3;border-radius:6px;padding:6px 8px;white-space:pre-wrap;margin:4px 0}
    .txt a{color:#2b5fd9}
    .mention{font:12px ui-monospace,Menlo,monospace;background:#eaf0fd;color:#2b4bb8;border-radius:5px;padding:0 5px;cursor:help;white-space:nowrap}
    .mention-menu{position:fixed;max-height:240px;overflow:auto;background:#fff;border-radius:10px;box-shadow:0 12px 32px rgba(0,0,0,.18),0 0 0 1px rgba(0,0,0,.06);padding:4px}
    .mention-menu button{display:flex;align-items:baseline;gap:7px;width:100%;border:0;background:none;padding:5px 8px;border-radius:7px;color:var(--ink);text-align:left;min-width:0}
    .mention-menu button.on,.mention-menu button:hover{background:#f0f0f3} .mention-menu b{font-weight:600;white-space:nowrap}
    .mention-menu .where{color:var(--sub);font-size:11.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;min-width:0}
    .mention-hint{color:var(--sub);font-size:11px;padding:4px 8px 2px;border-top:1px solid var(--line);margin-top:4px} .mention-hint:first-child{border:0;margin:0;padding:6px 8px}
    .working{display:flex;align-items:center;gap:8px;color:var(--accent);font-size:12.5px;margin:10px 0 0 27px}
    .dot{width:8px;height:8px;border-radius:50%;background:var(--accent);animation:p 1s ease-in-out infinite alternate} @keyframes p{to{opacity:.25}}
    .reply{margin-top:10px;display:none} .card.active .reply{display:block}
    .pins{position:fixed;inset:0;pointer-events:none} .pin{position:fixed;box-shadow:0 2px 8px rgba(0,0,0,.25);cursor:pointer} .pin.active{background:var(--accent);color:#fff}
    .box{position:fixed;border:2px solid var(--accent);border-radius:6px;background:rgba(217,119,87,.08);pointer-events:none} .box.hover{border-style:dashed}
    `;
  }
})();
