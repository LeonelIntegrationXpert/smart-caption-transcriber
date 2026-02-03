const els = {
  // Tabs (popup)
  tabDialogBtn: document.getElementById("tabPopupDialogBtn"),
  tabSettingsBtn: document.getElementById("tabPopupSettingsBtn"),
  tabDialog: document.getElementById("tabPopupDialog"),
  tabSettings: document.getElementById("tabPopupSettings"),

  // Dialog
  transcript: document.getElementById("transcript"),
  suggestion: document.getElementById("suggestion"),
  lastUpdate: document.getElementById("lastUpdate"),
  suggestStatus: document.getElementById("suggestStatus"),

  // Settings
  llamaMode: document.getElementById("llamaMode"),
  llamaEndpoint: document.getElementById("llamaEndpoint"),
  llamaModel: document.getElementById("llamaModel"),
  llamaApiKey: document.getElementById("llamaApiKey"),
  llamaSystemPrompt: document.getElementById("llamaSystemPrompt"),
  settingsStatus: document.getElementById("settingsStatus"),
};

function setStatus(el, msg) {
  if (!el) return;
  el.textContent = msg || "";
}

function formatWhen(iso) {
  if (!iso) return "";
  try { return new Date(iso).toLocaleString(); } catch { return iso; }
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

  try { localStorage.setItem("popupActiveTab", tabName); } catch {}
}

function initTabs() {
  els.tabDialogBtn?.addEventListener("click", () => setActiveTab("dialog"));
  els.tabSettingsBtn?.addEventListener("click", () => setActiveTab("settings"));

  let saved = "dialog";
  try { saved = localStorage.getItem("popupActiveTab") || "dialog"; } catch {}
  setActiveTab(saved === "settings" ? "settings" : "dialog");
}

/* =========================
   Streaming state
========================= */

let activeRequestId = null;

function makeRequestId() {
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

/* =========================
   UI actions
========================= */
async function refresh() {
  setStatus(els.suggestStatus, "");
  setStatus(els.settingsStatus, "");

  chrome.runtime.sendMessage({ action: "getTranscriberState" }, (res) => {
    if (chrome.runtime.lastError) {
      console.error(chrome.runtime.lastError);
      setStatus(els.lastUpdate, "Error: " + chrome.runtime.lastError.message);
      return;
    }

    const payload = res?.payload || null;
    const suggestion = res?.suggestion || "";
    const suggestionAt = res?.suggestionAt || "";
    const settings = res?.llamaSettings || null;

    if (!payload) {
      els.transcript.value = "No data yet.";
      setStatus(els.lastUpdate, "");
    } else {
      const text = payload.latestLine || payload.fullHistory || "No data yet.";
      els.transcript.value = text;

      setStatus(
        els.lastUpdate,
        payload.timestamp ? ("Last update: " + formatWhen(payload.timestamp)) : ""
      );
    }

    els.suggestion.value = suggestion || "";
    if (suggestionAt) {
      setStatus(els.suggestStatus, "Last suggestion: " + formatWhen(suggestionAt));
    }

    if (settings) {
      els.llamaMode.value = settings.mode || "openai";
      els.llamaEndpoint.value = settings.endpoint || "";
      els.llamaModel.value = settings.model || "";
      els.llamaApiKey.value = settings.apiKey || "";
      els.llamaSystemPrompt.value = settings.systemPrompt || "";
    }
  });
}

async function copyTranscript() {
  try {
    await navigator.clipboard.writeText(els.transcript.value || "");
    setStatus(els.lastUpdate, "Copied.");
  } catch (e) {
    console.error(e);
    setStatus(els.lastUpdate, "Copy failed.");
  }
}

async function clearState() {
  chrome.runtime.sendMessage({ action: "clearTranscriberState" }, () => refresh());
}

async function saveSettings() {
  const settings = {
    mode: els.llamaMode.value,
    endpoint: (els.llamaEndpoint.value || "").trim(),
    model: (els.llamaModel.value || "").trim(),
    apiKey: (els.llamaApiKey.value || "").trim(),
    systemPrompt: (els.llamaSystemPrompt.value || "").trim(),
  };

  chrome.runtime.sendMessage({ action: "saveLlamaSettings", payload: settings }, () => {
    if (chrome.runtime.lastError) {
      console.error(chrome.runtime.lastError);
      setStatus(els.settingsStatus, "Save error: " + chrome.runtime.lastError.message);
      return;
    }
    setStatus(els.settingsStatus, "Settings saved.");
    refresh();
  });
}

async function suggestReply() {
  // SEMPRE vem da transcrição (não existe manual prompt)
  const input = (els.transcript.value || "").trim();
  if (!input || input === "No data yet.") {
    setStatus(els.suggestStatus, "No transcript to process.");
    return;
  }

  els.suggestion.value = "";

  // ✅ tudo via background (inclusive python) para stream chegar no Viewer/painel
  activeRequestId = makeRequestId();
  setStatus(els.suggestStatus, "Generating (stream)…");

  chrome.runtime.sendMessage({ action: "generateSuggestion", payload: { requestId: activeRequestId } }, (res) => {
    if (chrome.runtime.lastError) {
      console.error(chrome.runtime.lastError);
      setStatus(els.suggestStatus, "Error: " + chrome.runtime.lastError.message);
      return;
    }
    if (res?.status !== "ok") {
      setStatus(els.suggestStatus, res?.error || "Failed.");
      return;
    }
    // ✅ texto final também vem por streaming, mas garantimos aqui
    els.suggestion.value = res.suggestion || els.suggestion.value || "";
    setStatus(els.suggestStatus, "Done: " + formatWhen(res.timestamp));
  });
}

/* =========================
   Streaming listener
========================= */

chrome.runtime.onMessage.addListener((msg) => {
  if (!msg || typeof msg !== "object") return;
  if (msg.action === "suggestionChunk") {
    // se tiver requestId, respeita
    if (msg.requestId && activeRequestId && msg.requestId !== activeRequestId) return;
    els.suggestion.value = String(msg.text || "");
    els.suggestion.scrollTop = els.suggestion.scrollHeight;
    setStatus(els.suggestStatus, "Generating (stream)…");
    return;
  }

  if (msg.action === "suggestionDone") {
    if (msg.requestId && activeRequestId && msg.requestId !== activeRequestId) return;
    setStatus(els.suggestStatus, "Done: " + formatWhen(msg.timestamp));
    return;
  }
});

/* =========================
   Bind + init
========================= */
document.getElementById("btnRefresh")?.addEventListener("click", refresh);
document.getElementById("btnCopy")?.addEventListener("click", copyTranscript);
document.getElementById("btnClear")?.addEventListener("click", clearState);
document.getElementById("btnSuggest")?.addEventListener("click", suggestReply);
document.getElementById("btnSaveSettings")?.addEventListener("click", saveSettings);
document.getElementById("btnOpenTab")?.addEventListener("click", () => {
  chrome.runtime.sendMessage({ action: "openViewerTab" });
});

initTabs();
refresh();
