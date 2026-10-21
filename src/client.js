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

  // ── restore state across live reloads ──────────────────────────────────
  try {
    const s = JSON.parse(sessionStorage.getItem(STATE_KEY) || "null");
    if (s && s.page === page) {
      ({ panelOpen, activeId, filter, drafts } = { ...s, drafts: s.drafts || {} });
      sessionStorage.removeItem(STATE_KEY);
      addEventListener("load", () => scrollTo(0, s.scrollY || 0));
      setTimeout(() => scrollTo(0, s.scrollY || 0), 50);
    }
  } catch {}

  // ── DOM ────────────────────────────────────────────────────────────────
  const host = document.createElement("page-review");
  host.style.cssText = "all:initial;position:fixed;inset:0;pointer-events:none;z-index:2147483646";
  const root = host.attachShadow({ mode: "open" });
  root.innerHTML = `<style>${styles()}</style>
    <div class="pins"></div>
    <div class="box" hidden></div>
    <button class="sel-btn" hidden>💬 Comment</button>
    <div class="composer" hidden>
      <div class="quote"></div>
      <textarea placeholder="Ask a question or request a change…  (⌘↵ to send)"></textarea>
      <div class="row"><span class="hint">Esc to cancel</span><button class="ghost cancel">Cancel</button><button class="primary send">Comment</button></div>
    </div>
    <aside class="panel">
      <header><b>Comments</b>
        <div class="tabs"><button data-f="open">Open</button><button data-f="resolved">Resolved</button><button data-f="all">All</button></div>
        <button class="close" title="Close">✕</button></header>
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
      <footer>Select text and press <kbd>Comment</kbd>, or <kbd>Alt</kbd>+click an element.</footer>
    </aside>
    <button class="launcher" title="Comments"><span class="ico">💬</span><span class="count"></span></button>`;
  document.documentElement.appendChild(host);
  const $ = (s) => root.querySelector(s);
  const pinsEl = $(".pins"), boxEl = $(".box"), selBtn = $(".sel-btn"), composer = $(".composer");
  const panel = $(".panel"), list = $(".list"), launcher = $(".launcher");

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
      section: sectionOf(el),
    };
  }

  function elementAnchor(el) {
    return {
      kind: "element",
      selector: cssPath(el),
      tag: el.tagName.toLowerCase(),
      snippet: (el.innerText || el.textContent || el.getAttribute("alt") || "").trim().replace(/\s+/g, " ").slice(0, 160),
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

  function resolve(a) {
    if (!a) return null;
    let el = null;
    try { el = a.selector ? document.querySelector(a.selector) : null; } catch {}
    if (a.kind === "element") {
      if (el) return { el };
      return null;
    }
    if (!a.exact) return null;
    const r = (el && findIn(el, a)) || findIn(document.body, a);
    return r ? { range: r } : null;
  }

  // ── rendering ──────────────────────────────────────────────────────────
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const md = (s) =>
    esc(s)
      .replace(/```([\s\S]*?)```/g, (_, c) => `<pre>${c.trim()}</pre>`)
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>")
      .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank">$1</a>')
      .replace(/\n/g, "<br>");
  const ago = (iso) => {
    const s = (Date.now() - new Date(iso)) / 1000;
    if (s < 60) return "just now";
    if (s < 3600) return `${Math.floor(s / 60)} min ago`;
    if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
    return new Date(iso).toLocaleDateString();
  };

  const visible = () => threads.filter((t) => filter === "all" || t.status === filter);
  const numberOf = (t) => threads.indexOf(t) + 1;

  function render() {
    const open = threads.filter((t) => t.status === "open").length;
    launcher.querySelector(".count").textContent = open || "";
    launcher.classList.toggle("has", open > 0);
    panel.classList.toggle("open", panelOpen);
    launcher.hidden = panelOpen;
    root.querySelectorAll(".tabs button").forEach((b) => b.classList.toggle("on", b.dataset.f === filter));

    const items = visible();
    list.innerHTML = items.length
      ? items.map(card).join("")
      : `<div class="empty">${filter === "open" ? "No open comments." : "Nothing here yet."}</div>`;
    for (const t of items) {
      const ta = list.querySelector(`[data-id="${t.id}"] textarea`);
      if (ta && drafts[t.id]) ta.value = drafts[t.id];
    }
    paintHighlights();
    placePins();
  }

  function card(t) {
    const r = resolve(t.anchor);
    const quote = t.anchor?.exact || t.anchor?.snippet || "";
    const working = t.status === "open" && t.agent !== "idle" && t.messages.at(-1)?.author === "user";
    return `<article class="card ${t.id === activeId ? "active" : ""} ${t.status}" data-id="${t.id}">
      <div class="top"><span class="num">${numberOf(t)}</span>
        <span class="q">${t.anchor?.kind === "element" ? `&lt;${esc(t.anchor.tag)}&gt; ` : ""}${esc(quote.slice(0, 140))}${quote.length > 140 ? "…" : ""}</span>
        ${r ? "" : `<span class="tag">detached</span>`}</div>
      ${t.messages.map((m) => `<div class="msg ${m.author}"><div class="who"><span class="av">${m.author === "agent" ? "✳" : "You".slice(0, 1)}</span>${m.author === "agent" ? esc(m.name || "Claude") : "You"}<span class="at">${ago(m.at)}</span></div><div class="txt">${md(m.text)}</div></div>`).join("")}
      ${working ? `<div class="working"><span class="dot"></span>${t.agent === "working" ? `${t.worker || "Claude"} is working on it…` : `Waiting for ${t.worker || "the agent"}…`}</div>` : ""}
      <div class="reply"><textarea rows="1" placeholder="Reply…"></textarea>
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
    pinsEl.innerHTML = shown
      .map((t) => {
        const r = rectOf(t);
        if (!r || (!r.width && !r.height)) return "";
        return `<button class="pin ${t.id === activeId ? "active" : ""}" data-id="${t.id}" style="top:${r.top - 20}px;left:${Math.min(r.right - 6, innerWidth - (panelOpen ? 420 : 40))}px">${numberOf(t)}</button>`;
      })
      .join("");
    const active = threads.find((t) => t.id === activeId);
    const ar = active?.anchor?.kind === "element" ? rectOf(active) : null;
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

  function focusThread(id, scroll = true) {
    activeId = id;
    panelOpen = true;
    render();
    const t = threads.find((x) => x.id === id);
    const r = t && resolve(t.anchor);
    if (scroll && r) scrollToAnchor(r);
    // Only move the comments list; scrollIntoView can also scroll the document.
    const card = list.querySelector(`[data-id="${id}"]`);
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
      sessionStorage.setItem(STATE_KEY, JSON.stringify({ page, scrollY, panelOpen, activeId, filter, drafts }));
      location.reload();
    }
  };

  // ── interactions ───────────────────────────────────────────────────────
  function openComposer(anchor, rect) {
    pendingAnchor = anchor;
    selBtn.hidden = true;
    composer.hidden = false;
    composer.querySelector(".quote").textContent = anchor.kind === "element" ? `<${anchor.tag}> ${anchor.snippet}` : anchor.exact;
    const top = Math.min(rect.bottom + 8, innerHeight - 190);
    const left = Math.min(Math.max(8, rect.left), innerWidth - 360 - (panelOpen ? 400 : 0));
    Object.assign(composer.style, { top: `${top}px`, left: `${left}px` });
    const ta = composer.querySelector("textarea");
    ta.value = "";
    ta.focus();
  }
  const closeComposer = () => ((composer.hidden = true), (pendingAnchor = null), (boxEl.hidden = true), placePins());

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

  launcher.addEventListener("click", () => ((panelOpen = true), render()));
  $(".close").addEventListener("click", () => ((panelOpen = false), (activeId = null), render()));
  root.querySelectorAll(".tabs button").forEach((b) => b.addEventListener("click", () => ((filter = b.dataset.f), render())));
  pinsEl.addEventListener("click", (e) => {
    const id = e.target.closest(".pin")?.dataset.id;
    if (id) focusThread(id, false);
  });

  list.addEventListener("click", async (e) => {
    const cardEl = e.target.closest(".card");
    if (!cardEl) return;
    const id = cardEl.dataset.id;
    const ta = cardEl.querySelector("textarea");
    if (e.target.closest(".send-reply")) {
      const text = ta.value.trim();
      if (!text) return;
      delete drafts[id];
      upsert(await call("POST", `/threads/${id}/messages`, { author: "user", text }));
    } else if (e.target.closest(".resolve")) upsert(await call("POST", `/threads/${id}/status`, { status: "resolved", author: "user" }));
    else if (e.target.closest(".reopen")) upsert(await call("POST", `/threads/${id}/status`, { status: "open" }));
    else if (e.target.closest(".del")) {
      if (confirm("Delete this thread?")) await call("DELETE", `/threads/${id}`);
    } else if (!e.target.closest("textarea, a")) focusThread(id);
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
  });

  load();
  loadSettings();

  function styles() {
    return `
    :host{--ink:#1f1f23;--sub:#6b6b74;--line:#e6e6ea;--accent:#d97757;--hl:#ffb020;font:13.5px/1.45 -apple-system,BlinkMacSystemFont,Inter,"Segoe UI",sans-serif;color:var(--ink)}
    *{box-sizing:border-box} button{font:inherit;cursor:pointer} [hidden]{display:none!important}
    .launcher,.sel-btn,.composer,.panel,.pin{pointer-events:auto}
    .launcher,.sel-btn,.composer,.panel,.pins{font:13.5px/1.45 -apple-system,BlinkMacSystemFont,Inter,"Segoe UI",sans-serif;color:var(--ink);text-align:left;letter-spacing:normal}
    .launcher{position:fixed;right:20px;bottom:20px;height:44px;min-width:44px;padding:0 14px;border-radius:22px;border:0;background:var(--ink);color:#fff;box-shadow:0 8px 24px rgba(0,0,0,.25);display:flex;gap:6px;align-items:center;justify-content:center;font-size:15px}
    .launcher.has{background:var(--accent)} .launcher .count:empty{display:none} .launcher .count{font-weight:700}
    .sel-btn{position:fixed;padding:7px 12px;border-radius:9px;border:0;background:var(--ink);color:#fff;font-weight:600;box-shadow:0 6px 18px rgba(0,0,0,.25)}
    .composer{position:fixed;width:360px;background:#fff;border-radius:14px;box-shadow:0 18px 48px rgba(0,0,0,.22),0 0 0 1px rgba(0,0,0,.06);padding:12px}
    .quote{font-size:12.5px;color:var(--sub);border-left:3px solid var(--hl);padding:2px 0 2px 9px;margin-bottom:9px;max-height:64px;overflow:hidden;white-space:pre-wrap}
    textarea{width:100%;border:1px solid var(--line);border-radius:10px;padding:9px 10px;font:inherit;resize:vertical;min-height:38px;outline:none;color:var(--ink);background:#fff}
    textarea:focus{border-color:#b9b9c3;box-shadow:0 0 0 3px rgba(0,0,0,.05)} .composer textarea{min-height:80px}
    .row{display:flex;gap:6px;align-items:center;justify-content:flex-end;margin-top:8px} .hint{flex:1;color:var(--sub);font-size:12px}
    .primary{border:0;background:var(--ink);color:#fff;padding:6px 13px;border-radius:8px;font-weight:600} .ghost{border:1px solid var(--line);background:#fff;color:var(--ink);padding:5px 11px;border-radius:8px}
    .ghost.del{color:#b42318;border-color:transparent}
    .panel{position:fixed;top:0;right:0;bottom:0;width:396px;background:#f7f7f9;border-left:1px solid var(--line);box-shadow:-12px 0 32px rgba(0,0,0,.08);transform:translateX(105%);transition:transform .2s ease;display:flex;flex-direction:column}
    .panel.open{transform:none}
    header{display:flex;align-items:center;gap:10px;padding:14px 16px;border-bottom:1px solid var(--line);background:#fff} header b{font-size:15px}
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
    .tag{font-size:11px;background:#fdecea;color:#b42318;border-radius:99px;padding:1px 7px}
    .msg{margin:8px 0 0} .who{display:flex;align-items:center;gap:7px;font-weight:600;font-size:12.5px}
    .av{width:20px;height:20px;border-radius:50%;display:grid;place-items:center;font-size:11px;background:#e3e8f8;color:#2b4bb8} .agent .av{background:#fbe6dd;color:var(--accent)}
    .at{color:var(--sub);font-weight:400;font-size:11.5px} .txt{margin:3px 0 0 27px;word-break:break-word}
    .txt code{font:12px ui-monospace,Menlo,monospace;background:#f0f0f3;border-radius:4px;padding:0 4px} .txt pre{font:12px ui-monospace,Menlo,monospace;background:#f0f0f3;border-radius:6px;padding:6px 8px;white-space:pre-wrap;margin:4px 0}
    .txt a{color:#2b5fd9}
    .working{display:flex;align-items:center;gap:8px;color:var(--accent);font-size:12.5px;margin:10px 0 0 27px}
    .dot{width:8px;height:8px;border-radius:50%;background:var(--accent);animation:p 1s ease-in-out infinite alternate} @keyframes p{to{opacity:.25}}
    .reply{margin-top:10px;display:none} .card.active .reply{display:block}
    .pins{position:fixed;inset:0;pointer-events:none} .pin{position:fixed;box-shadow:0 2px 8px rgba(0,0,0,.25);cursor:pointer} .pin.active{background:var(--accent);color:#fff}
    .box{position:fixed;border:2px solid var(--accent);border-radius:6px;background:rgba(217,119,87,.08);pointer-events:none} .box.hover{border-style:dashed}
    `;
  }
})();
