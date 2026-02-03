// viewer.js — versão completa (stream true) ✅
// - suporta streaming via msg.delta (append) OU msg.text (full)
// - evita refresh() sobrescrever sugestão durante streaming
// - mantém fallback: se o callback final vier com suggestion, aplica
// ✅ add: rewriteChunk + rewriteText render + reset/requestId

const els = {
  // Tabs
  tabDialogBtn: document.getElementById("tabDialogBtn"),
  tabSettingsBtn: document.getElementById("tabSettingsBtn"),
  tabDialog: document.getElementById("tabDialog"),
  tabSettings: document.getElementById("tabSettings"),

  // Overlay UI
  screenDim: document.getElementById("screenDim"),
  floatingDot: document.getElementById("floatingDot"),

  // ✅ Dia/Noite
  btnDayNight: document.getElementById("btnDayNight"),
  dayNightIcon: document.getElementById("dayNightIcon"),
  dayNightLabel: document.getElementById("dayNightLabel"),

  // Dialog tab
  transcript: document.getElementById("transcript"),
  lastTurn: document.getElementById("lastTurn"),
  conversation: document.getElementById("conversation"),

  suggestion: document.getElementById("suggestion"),
  manualPrompt: document.getElementById("manualPrompt"),

  // ✅ Rewrite UI (adiciona no HTML se quiser ver)
  rewriteText: document.getElementById("rewriteText"),
  rewriteStatus: document.getElementById("rewriteStatus"),

  lastUpdate: document.getElementById("lastUpdate"),
  turnStatus: document.getElementById("turnStatus"),
  historyStatus: document.getElementById("historyStatus"),
  suggestStatus: document.getElementById("suggestStatus"),

  // Settings tab
  llamaMode: document.getElementById("llamaMode"),
  llamaEndpoint: document.getElementById("llamaEndpoint"),
  llamaModel: document.getElementById("llamaModel"),
  llamaApiKey: document.getElementById("llamaApiKey"),
  llamaSystemPrompt: document.getElementById("llamaSystemPrompt"),
  autoSuggestEnabled: document.getElementById("autoSuggestEnabled"),
  autoSuggestDebounceMs: document.getElementById("autoSuggestDebounceMs"),
  settingsStatus: document.getElementById("settingsStatus"),
};

function setStatus(el, msg) {
  if (!el) return;
  el.textContent = msg || "";
}

function formatWhen(iso) {
  if (!iso) return "";
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

function formatTimeOnly(iso) {
  if (!iso) return "";
  try {
    return new Date(iso).toLocaleTimeString();
  } catch {
    return "";
  }
}

/* =========================
   🔥 Overlay + dot control
========================= */

let dimEnabled = false;

function setDotState(state) {
  // state: "ok" | "busy" | "error"
  if (!els.floatingDot) return;
  els.floatingDot.classList.remove("busy", "error");
  if (state === "busy") els.floatingDot.classList.add("busy");
  else if (state === "error") els.floatingDot.classList.add("error");
}

function setDayNightUI(enabled) {
  dimEnabled = !!enabled;

  if (els.screenDim) els.screenDim.classList.toggle("active", dimEnabled);
  if (els.floatingDot) els.floatingDot.classList.toggle("active", true);

  if (els.dayNightIcon) els.dayNightIcon.textContent = dimEnabled ? "☀️" : "🌙";
  if (els.dayNightLabel) els.dayNightLabel.textContent = dimEnabled ? "Dia" : "Noite";

  try {
    localStorage.setItem("viewerDimEnabled", dimEnabled ? "1" : "0");
  } catch {}
}

function toggleDayNight() {
  setDayNightUI(!dimEnabled);
}

function initOverlayAndDayNight() {
  if (els.floatingDot) els.floatingDot.classList.add("active");

  let enabled = false;
  try {
    enabled = (localStorage.getItem("viewerDimEnabled") || "0") === "1";
  } catch {}
  setDayNightUI(enabled);

  els.floatingDot?.addEventListener("click", toggleDayNight);
  els.btnDayNight?.addEventListener("click", toggleDayNight);
}

/* =========================
   Tabs
========================= */

function setActiveTab(tabName) {
  const isDialog = tabName === "dialog";

  els.tabDialogBtn?.classList.toggle("active", isDialog);
  els.tabSettingsBtn?.classList.toggle("active", !isDialog);

  els.tabDialog?.classList.toggle("active", isDialog);
  els.tabSettings?.classList.toggle("active", !isDialog);

  try {
    localStorage.setItem("viewerActiveTab", tabName);
  } catch {}
}

function initTabs() {
  els.tabDialogBtn?.addEventListener("click", () => setActiveTab("dialog"));
  els.tabSettingsBtn?.addEventListener("click", () => setActiveTab("settings"));

  let saved = "dialog";
  try {
    saved = localStorage.getItem("viewerActiveTab") || "dialog";
  } catch {}
  setActiveTab(saved === "settings" ? "settings" : "dialog");
}

/* =========================
   ✅ Streaming state (viewer)
========================= */

let suggestionStreamingActive = false;
let suggestionBuf = "";
let suggestionReqId = null;

let rewriteStreamingActive = false;
let rewriteBuf = "";
let rewriteReqId = null;

let refreshDebounceId = null;
function debounceRefresh(skipSuggestion, skipRewrite) {
  if (refreshDebounceId) clearTimeout(refreshDebounceId);
  refreshDebounceId = setTimeout(() => refresh({ skipSuggestion, skipRewrite }), 200);
}

function setSuggestionText(text) {
  if (!els.suggestion) return;
  els.suggestion.value = text || "";
  els.suggestion.scrollTop = els.suggestion.scrollHeight;
}

function setRewriteText(text) {
  if (!els.rewriteText) return;
  els.rewriteText.value = text || "";
  els.rewriteText.scrollTop = els.rewriteText.scrollHeight;
}

// ===== suggestion stream (msg.delta append OR msg.text overwrite)
function applySuggestionChunk(msg) {
  const rid = msg?.requestId || null;

  // reset por requestId novo ou reset explícito
  if (msg?.reset || (rid && rid !== suggestionReqId)) {
    suggestionReqId = rid;
    suggestionBuf = "";
  }

  suggestionStreamingActive = true;

  if (typeof msg?.delta === "string") {
    suggestionBuf += msg.delta;
  } else if (typeof msg?.text === "string") {
    suggestionBuf = msg.text;
  } else {
    return;
  }

  setSuggestionText(suggestionBuf);
  setStatus(els.suggestStatus, msg?.error ? `Error: ${msg.error}` : "Generating (stream)…");
  setDotState(msg?.error ? "error" : "busy");

  if (msg?.done) {
    suggestionStreamingActive = false;
    setDotState(msg?.error ? "error" : "ok");
    setStatus(els.suggestStatus, msg?.error ? `Error: ${msg.error}` : "Done (stream).");
  }
}

// ===== rewrite stream (mesmo esquema)
function applyRewriteChunk(msg) {
  const rid = msg?.requestId || null;

  if (msg?.reset || (rid && rid !== rewriteReqId)) {
    rewriteReqId = rid;
    rewriteBuf = "";
  }

  rewriteStreamingActive = true;

  if (typeof msg?.delta === "string") {
    rewriteBuf += msg.delta;
  } else if (typeof msg?.text === "string") {
    rewriteBuf = msg.text;
  } else {
    return;
  }

  setRewriteText(rewriteBuf);
  setStatus(els.rewriteStatus, msg?.error ? `Error: ${msg.error}` : "Rewriting (stream)…");
  setDotState(msg?.error ? "error" : "busy");

  if (msg?.done) {
    rewriteStreamingActive = false;
    setDotState(msg?.error ? "error" : "ok");
    setStatus(els.rewriteStatus, msg?.error ? `Error: ${msg.error}` : "Done (rewrite).");
  }
}

/* =========================
   Conversation render
========================= */

function renderLastTurn(turns) {
  const items = Array.isArray(turns) ? turns : [];
  if (!els.lastTurn) return;

  if (!items.length) {
    els.lastTurn.value = "";
    setStatus(els.turnStatus, "No turns yet.");
    return;
  }

  const t = items[items.length - 1];
  const ts = formatTimeOnly(t.timestamp);
  const who = t.speaker || "Unknown";
  const origin = t.origin ? ` (${t.origin})` : "";
  const text = t.text || "";

  let out = `${ts ? `[${ts}] ` : ""}${who}${origin}:\n${text}`;

  if (t.suggestion) {
    out += `\n\nSugestão:\n${t.suggestion}`;
  }

  els.lastTurn.value = out;
  els.lastTurn.scrollTop = els.lastTurn.scrollHeight;

  setStatus(els.turnStatus, `Last turn: ${formatWhen(t.timestamp)}`);
}

function renderConversation(turns) {
  const items = Array.isArray(turns) ? turns : [];
  if (!els.conversation) return;

  const text = items
    .slice(-200)
    .map((t) => {
      const ts = t.timestamp ? new Date(t.timestamp).toLocaleTimeString() : "";
      const who = t.speaker || "Unknown";
      const origin = t.origin ? ` (${t.origin})` : "";
      const line = `${ts ? `[${ts}] ` : ""}${who}${origin}: ${t.text || ""}`;
      const sug = t.suggestion ? `\n  ↳ Sugestão: ${t.suggestion}` : "";
      return line + sug;
    })
    .join("\n\n");

  els.conversation.value = text;
  els.conversation.scrollTop = els.conversation.scrollHeight;

  setStatus(els.historyStatus, items.length ? `Turns: ${items.length}` : "No turns yet.");
}

/* =========================
   Data refresh
========================= */

async function refresh(opts = {}) {
  const skipSuggestion = !!opts.skipSuggestion;
  const skipRewrite = !!opts.skipRewrite;

  setStatus(els.settingsStatus, "");

  chrome.runtime.sendMessage({ action: "getTranscriberState" }, (res) => {
    if (chrome.runtime.lastError) {
      console.error(chrome.runtime.lastError);
      setStatus(els.lastUpdate, "Error: " + chrome.runtime.lastError.message);
      setDotState("error");
      return;
    }

    const payload = res?.payload || null;
    const suggestion = res?.suggestion || "";
    const suggestionAt = res?.suggestionAt || "";
    const rewriteText = res?.rewriteText || "";
    const rewriteAt = res?.rewriteAt || "";
    const settings = res?.llamaSettings || null;
    const conversation = res?.conversation || [];

    // Transcript (latest)
    if (!payload) {
      if (els.transcript) els.transcript.value = "No data yet.";
      setStatus(els.lastUpdate, "");
    } else {
      const text = payload.latestLine || payload.fullHistory || "No data yet.";
      if (els.transcript) els.transcript.value = text;

      const label = payload.timestamp ? "Last update: " + formatWhen(payload.timestamp) : "";
      setStatus(els.lastUpdate, label);
    }

    // ✅ Suggestion (global) - NÃO pisa durante streaming
    if (!skipSuggestion && !suggestionStreamingActive) {
      if (els.suggestion) els.suggestion.value = suggestion || "";
      if (suggestionAt && !suggestionStreamingActive) {
        setStatus(els.suggestStatus, "");
      }
    }

    // ✅ Rewrite (global) - NÃO pisa durante streaming
    if (!skipRewrite && !rewriteStreamingActive) {
      if (els.rewriteText) els.rewriteText.value = rewriteText || "";
      if (rewriteAt && !rewriteStreamingActive && els.rewriteStatus) {
        setStatus(els.rewriteStatus, "");
      }
    }

    renderConversation(conversation);
    renderLastTurn(conversation);

    // Settings fill
    if (settings) {
      if (els.llamaMode) els.llamaMode.value = settings.mode || "openai";
      if (els.llamaEndpoint) els.llamaEndpoint.value = settings.endpoint || "";
      if (els.llamaModel) els.llamaModel.value = settings.model || "";
      if (els.llamaApiKey) els.llamaApiKey.value = settings.apiKey || "";
      if (els.llamaSystemPrompt) els.llamaSystemPrompt.value = settings.systemPrompt || "";

      if (els.autoSuggestEnabled) els.autoSuggestEnabled.checked = !!settings.autoSuggestEnabled;
      if (els.autoSuggestDebounceMs) els.autoSuggestDebounceMs.value = String(settings.autoSuggestDebounceMs ?? "");
    }

    if (!suggestionStreamingActive && !rewriteStreamingActive) {
      setDotState("ok");
    }
  });
}

/* =========================
   Actions
========================= */

async function copyTranscript() {
  try {
    await navigator.clipboard.writeText(els.transcript?.value || "");
    setStatus(els.lastUpdate, "Copied transcript.");
  } catch (e) {
    console.error(e);
    setStatus(els.lastUpdate, "Copy failed.");
  }
}

async function copyHistory() {
  try {
    await navigator.clipboard.writeText(els.conversation?.value || "");
    setStatus(els.historyStatus, "Copied history.");
  } catch (e) {
    console.error(e);
    setStatus(els.historyStatus, "Copy failed.");
  }
}

async function clearState() {
  chrome.runtime.sendMessage({ action: "clearTranscriberState" }, () => refresh());
}

async function saveSettings() {
  const settings = {
    mode: els.llamaMode?.value || "openai",
    endpoint: (els.llamaEndpoint?.value || "").trim(),
    model: (els.llamaModel?.value || "").trim(),
    apiKey: (els.llamaApiKey?.value || "").trim(),
    systemPrompt: (els.llamaSystemPrompt?.value || "").trim(),
    autoSuggestEnabled: !!els.autoSuggestEnabled?.checked,
    autoSuggestDebounceMs: Number(els.autoSuggestDebounceMs?.value || 1200),
  };

  chrome.runtime.sendMessage({ action: "saveLlamaSettings", payload: settings }, () => {
    if (chrome.runtime.lastError) {
      console.error(chrome.runtime.lastError);
      setStatus(els.settingsStatus, "Save error: " + chrome.runtime.lastError.message);
      setDotState("error");
      return;
    }
    setStatus(els.settingsStatus, "Settings saved.");
    refresh({ skipSuggestion: suggestionStreamingActive, skipRewrite: rewriteStreamingActive });
  });
}

async function suggestReply() {
  // inicia buffer local de streaming
  suggestionStreamingActive = true;
  suggestionBuf = "";
  suggestionReqId = null;
  setSuggestionText("");

  setStatus(els.suggestStatus, "Generating (stream)…");
  setDotState("busy");

  const manualPrompt = (els.manualPrompt?.value || "").trim();

  chrome.runtime.sendMessage({ action: "generateSuggestion", payload: { manualPrompt } }, (res) => {
    if (chrome.runtime.lastError) {
      console.error(chrome.runtime.lastError);
      setStatus(els.suggestStatus, "Error: " + chrome.runtime.lastError.message);
      setDotState("error");
      suggestionStreamingActive = false;
      return;
    }

    if (res?.status !== "ok") {
      setStatus(els.suggestStatus, res?.error || "Failed.");
      setDotState("error");
      suggestionStreamingActive = false;
      return;
    }

    // fallback: garante final correto
    if (typeof res?.suggestion === "string" && res.suggestion.trim()) {
      suggestionBuf = res.suggestion;
      setSuggestionText(suggestionBuf);
    }

    suggestionStreamingActive = false;
    setDotState(rewriteStreamingActive ? "busy" : "ok");
    setStatus(els.suggestStatus, "Done: " + formatWhen(res.timestamp));
  });
}

/* =========================
   Streaming listeners
========================= */

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.action === "suggestionChunk") {
    applySuggestionChunk(msg);
    return;
  }

  if (msg?.action === "rewriteChunk") {
    applyRewriteChunk(msg);
    return;
  }

  if (msg?.action === "conversationUpdated") {
    // não deixa refresh pisar em streaming
    setDotState(suggestionStreamingActive || rewriteStreamingActive ? "busy" : "ok");
    debounceRefresh(true, true); // skipSuggestion=true, skipRewrite=true
    return;
  }
});

/* =========================
   Bind buttons + init
========================= */

document.getElementById("btnRefresh")?.addEventListener("click", () =>
  refresh({ skipSuggestion: suggestionStreamingActive, skipRewrite: rewriteStreamingActive })
);
document.getElementById("btnCopy")?.addEventListener("click", copyTranscript);
document.getElementById("btnCopyHistory")?.addEventListener("click", copyHistory);
document.getElementById("btnClear")?.addEventListener("click", clearState);
document.getElementById("btnSuggest")?.addEventListener("click", suggestReply);
document.getElementById("btnSaveSettings")?.addEventListener("click", saveSettings);

initTabs();
initOverlayAndDayNight();
refresh();
