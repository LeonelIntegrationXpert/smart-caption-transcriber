/* background.js (MV3 service worker) — SW-safe
 * - NUNCA usa window/document/localStorage
 * - Usa globalThis
 * - Mantém: transcriptTick anti-spam, rewriteContext, generateSuggestion, generateReplies (2 rotas)
 */

"use strict";

// ✅ MV3: não existe window/document. Use globalThis/self.
const G = globalThis;

const DEFAULT_PYTHON_BASE_URL = "http://localhost:8000";
const PYTHON_PATH_REWRITE = "/ask";
const PYTHON_PATH_SUGGEST = "/ask_me";

const state = {
  payload: null, // { fullHistory, latestLine, timestamp }
  suggestion: "",
  suggestionAt: "",

  rewriteText: "",
  rewriteAt: "",

  llamaSettings: {
    mode: "python", // python | openai | ollama
    endpoint: "", // base http://localhost:8000 ou full http://localhost:8000/ask
    model: "",
    apiKey: "",
    systemPrompt: "", // usado APENAS para openai/ollama
    autoSuggestEnabled: false,
    autoSuggestDebounceMs: 1200,
  },

  conversation: [], // [{timestamp, origin, speaker, text}]
  activeMeetingTabId: null,

  stream: {
    abort: null,
    requestId: null,
    text: "",
  },
};

// (Opcional) pra debugar no DevTools do service worker:
// abre chrome://extensions -> Inspect views -> service worker
G.__MT_STATE__ = state;

// =========================
// Utils
// =========================
function nowIso() {
  return new Date().toISOString();
}

function normalizeSpace(s) {
  return String(s || "").replace(/\s+/g, " ").trim();
}

function safeRuntimeSend(msg) {
  try {
    chrome.runtime.sendMessage(msg, () => void chrome.runtime.lastError);
  } catch {}
}

function safeTabsSend(tabId, msg) {
  if (typeof tabId !== "number") return;
  try {
    chrome.tabs.sendMessage(tabId, msg, () => void chrome.runtime.lastError);
  } catch {}
}

// viewer.html (extension) via runtime, meeting tab via tabs.sendMessage
function broadcastToUI(msg, targetTabId) {
  safeRuntimeSend(msg);
  safeTabsSend(targetTabId, msg);
}

function parseTickLine(line) {
  const s = String(line || "").trim();
  const m = s.match(/^🎤\s*(.+?)\s*:\s*(.+?)\s*:\s*(.*)$/);
  if (!m) return null;
  return {
    origin: (m[1] || "").trim(),
    speaker: (m[2] || "").trim(),
    text: (m[3] || "").trim(),
  };
}

function parseAnyTranscriptLine(line) {
  const s = String(line || "").replace(/^🎤\s*/u, "").trim();
  const parts = s.split(":").map((p) => p.trim());
  if (parts.length >= 3) {
    return {
      origin: parts[0] || "",
      speaker: parts[1] || "",
      text: parts.slice(2).join(":").trim(),
    };
  }
  return { origin: "", speaker: "", text: s };
}

function keepConversationTail(max = 500) {
  if (state.conversation.length <= max) return;
  state.conversation = state.conversation.slice(state.conversation.length - max);
}

function buildContextFromConversation(maxTurns = 10) {
  const tail = state.conversation.slice(-Math.max(1, maxTurns));
  return tail
    .map((t) => {
      const who = t.speaker || "Unknown";
      const origin = t.origin ? ` (${t.origin})` : "";
      const text = t.text || "";
      return `${who}${origin}: ${text}`.trim();
    })
    .filter(Boolean)
    .join("\n");
}

function tailChars(s, maxChars) {
  s = String(s || "");
  if (!maxChars || s.length <= maxChars) return s;
  return s.slice(s.length - maxChars);
}

/**
 * Normaliza endpoint PYTHON para um path específico.
 */
function normalizePythonEndpoint(baseOrFull, path, defaultBase = DEFAULT_PYTHON_BASE_URL) {
  const desiredPath = String(path || "").startsWith("/") ? String(path) : `/${path || ""}`;
  const raw = String(baseOrFull || "").trim();

  const baseDefault = String(defaultBase || "").replace(/\/+$/, "");
  if (!raw) return baseDefault + desiredPath;

  if (!/^https?:\/\//i.test(raw)) {
    return baseDefault + desiredPath;
  }

  const cleaned = raw.replace(/\/+$/, "");

  if (/\b\/ask_me\b/i.test(cleaned) || /\b\/ask\b/i.test(cleaned)) {
    const swapped = cleaned
      .replace(/\/ask_me\b/gi, desiredPath)
      .replace(/\/ask\b/gi, desiredPath);
    return swapped;
  }

  return cleaned + desiredPath;
}

function makeRequestId() {
  return `${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

function abortActiveStream() {
  try {
    state.stream.abort?.abort();
  } catch {}
  state.stream.abort = null;
  state.stream.requestId = null;
  state.stream.text = "";
}

function resolveTargetTabId(sender) {
  if (sender?.tab?.url && !String(sender.tab.url).startsWith("chrome-extension://")) {
    return sender.tab.id;
  }
  return state.activeMeetingTabId;
}

// =========================
// Anti-spam reducer (Teams incremental transcript)
// =========================
const tickAgg = {
  recent: new Map(),      // key(origin||speaker||text) -> ts
  recentText: new Map(),  // text -> ts
  lastByKey: new Map(),   // key(origin||speaker) -> { idx, ts, text }
};

const TICK_DEDUPE_TTL_MS = 4500;
const TICK_MERGE_WINDOW_MS = 2600;
const UNKNOWN_SPEAKERS = new Set(["desconhecido", "unknown", "participante", ""]);

function normLabel(s) {
  return normalizeSpace(s);
}

function normSpeakerName(s) {
  let out = normLabel(s);
  out = out.replace(/\s*\(convidado\)\s*/gi, "").trim();
  return out;
}

function normOriginName(s) {
  return normLabel(s);
}

function cleanTickText(s) {
  let t = String(s || "");
  t = t.replace(/\s+/g, " ").trim();
  t = t.replace(/^[—\-–•]+/g, "").trim();
  t = t.replace(/\s*[—\-–•]+$/g, "").trim();
  return t;
}

function isNoiseLine(text) {
  const t = normLabel(text).toLowerCase();
  if (!t) return true;
  if (/^[.·…]+$/.test(t)) return true;
  if (/^(responder|reply)\s*\(\d+\)$/i.test(t)) return true;
  if (/^\(?\d+\)?$/.test(t)) return true;
  if (/^(uh|um|hmm+)\.?$/.test(t)) return true;
  if (t.length <= 2) return true;
  return false;
}

function purgeOld(map, ttlMs) {
  const now = Date.now();
  for (const [k, ts] of map.entries()) {
    if (now - Number(ts || 0) > ttlMs) map.delete(k);
  }
}

function isUnknownSpeaker(s) {
  const key = normLabel(s).toLowerCase();
  return UNKNOWN_SPEAKERS.has(key);
}

function findRecentUnknownIdxSameText(text, windowMs = 3200) {
  const now = Date.now();
  for (let i = state.conversation.length - 1; i >= 0 && i >= state.conversation.length - 25; i--) {
    const t = state.conversation[i];
    if (!t) continue;
    const ts = Date.parse(t.timestamp || "") || 0;
    if (now - ts > windowMs) break;
    if (isUnknownSpeaker(t.speaker) && normLabel(t.text) === normLabel(text)) return i;
  }
  return -1;
}

// =========================
// Pós-filtro (remove meta)
// =========================
function isMetaParagraph(p) {
  const t = normalizeSpace(p).toLowerCase();
  if (t.startsWith("this response")) return true;
  if (t.startsWith("overall,")) return true;
  if (t.includes("maintains the informal tone")) return true;
  if (t.includes("does not explain rules")) return true;
  if (t.includes("the question mark indicates")) return true;
  if (t.includes("by using")) return true;
  if (t.includes("you would avoid")) return true;
  if (t.includes("this keeps the answer")) return true;
  if (t.includes("overall, you would")) return true;
  return false;
}

function stripMetaAnalysisText(s) {
  const raw = String(s || "").trim();
  if (!raw) return "";
  const paras = raw.split(/\n\s*\n+/g).map((p) => p.trim()).filter(Boolean);
  const kept = paras.filter((p) => !isMetaParagraph(p));
  return (kept.length ? kept : paras).join("\n\n").trim();
}

// =========================
// Rewrite helpers
// =========================
function isTinyToken(t) {
  return /^[A-Za-zÀ-ÿ]{1,2}$/u.test(String(t || "").trim());
}

function joinTokensSmart(tokens) {
  let out = "";
  for (const raw of tokens) {
    const t = normalizeSpace(raw);
    if (!t) continue;

    if (!out) {
      out = t;
      continue;
    }

    const prevWord = out.split(" ").slice(-1)[0] || "";
    if (isTinyToken(prevWord) && isTinyToken(t)) {
      out = out + t;
      continue;
    }

    out = (out + " " + t).replace(/\s+/g, " ").trim();
  }
  return out;
}

function looksLikeQuestion(s) {
  const t = normalizeSpace(s).toLowerCase();
  if (!t) return false;
  if (t.endsWith("?")) return true;

  return (
    t.startsWith("como ") ||
    t.startsWith("qual ") ||
    t.startsWith("quais ") ||
    t.startsWith("quando ") ||
    t.startsWith("onde ") ||
    t.startsWith("quem ") ||
    t.startsWith("por que") ||
    t.startsWith("porque") ||
    t.startsWith("o que") ||
    t.startsWith("oq ") ||
    t.startsWith("me fale") ||
    t.startsWith("fala ") ||
    t.startsWith("pode ") ||
    t.startsWith("consegue ") ||
    t.startsWith("vc ") ||
    t.startsWith("você ")
  );
}

function compactTranscriptLinesForLLM(lines, maxLines = 80) {
  const src = Array.isArray(lines) ? lines.slice(-maxLines) : [];
  const groups = new Map();

  for (const line of src) {
    const { origin, speaker, text } = parseAnyTranscriptLine(line);
    const org = normalizeSpace(origin) || "Canal";
    const spk = normalizeSpace(speaker) || "Participante";
    const msg = normalizeSpace(text);
    if (!msg || isNoiseLine(msg)) continue;

    const key = `${org}||${spk}`;
    if (!groups.has(key)) groups.set(key, { origin: org, speaker: spk, tokens: [] });
    groups.get(key).tokens.push(msg);
  }

  if (!groups.size) return "";

  const blocks = [];
  const questions = [];

  for (const g of groups.values()) {
    const merged = joinTokensSmart(g.tokens);

    let final = merged;
    if (looksLikeQuestion(final) && !final.endsWith("?")) final += "?";
    if (!/[.!?]$/.test(final)) final += ".";

    blocks.push(`${g.origin} • ${g.speaker}: ${final}`);

    const parts = merged
      .split(/[.!?]\s*/g)
      .map((s) => normalizeSpace(s))
      .filter(Boolean);

    for (const p of parts) {
      if (looksLikeQuestion(p)) {
        const q = p.endsWith("?") ? p : p + "?";
        if (!questions.includes(q)) questions.push(q);
      }
    }
  }

  let out = blocks.join("\n");
  if (questions.length) {
    out += `\n\nPerguntas:\n` + questions.map((q) => `- ${q}`).join("\n");
  }

  return out.trim();
}

// =========================
// Persistence (chrome.storage)
// =========================
async function loadStateFromStorage() {
  const keys = [
    "payload",
    "suggestion",
    "suggestionAt",
    "rewriteText",
    "rewriteAt",
    "llamaSettings",
    "conversation",
    "activeMeetingTabId",
  ];
  const res = await chrome.storage.local.get(keys);
  if (res?.payload) state.payload = res.payload;
  if (typeof res?.suggestion === "string") state.suggestion = res.suggestion;
  if (typeof res?.suggestionAt === "string") state.suggestionAt = res.suggestionAt;

  if (typeof res?.rewriteText === "string") state.rewriteText = res.rewriteText;
  if (typeof res?.rewriteAt === "string") state.rewriteAt = res.rewriteAt;

  if (res?.llamaSettings) state.llamaSettings = { ...state.llamaSettings, ...res.llamaSettings };
  if (Array.isArray(res?.conversation)) state.conversation = res.conversation;
  if (typeof res?.activeMeetingTabId === "number") state.activeMeetingTabId = res.activeMeetingTabId;
}

async function saveStateToStorage() {
  await chrome.storage.local.set({
    payload: state.payload,
    suggestion: state.suggestion,
    suggestionAt: state.suggestionAt,
    rewriteText: state.rewriteText,
    rewriteAt: state.rewriteAt,
    llamaSettings: state.llamaSettings,
    conversation: state.conversation,
    activeMeetingTabId: state.activeMeetingTabId,
  });
}

chrome.runtime.onInstalled.addListener(() => {
  console.log("🧠 Background (SW) iniciado");
});

loadStateFromStorage().catch(() => {});

// =========================
// LLM calls
// =========================
function buildChatMessagesForOpenAI(userText) {
  const sys = (state.llamaSettings.systemPrompt || "").trim();
  const msgs = [];
  if (sys) msgs.push({ role: "system", content: sys });
  msgs.push({ role: "user", content: userText });
  return msgs;
}

// rota como "dado", sem regra fixa no JS
function routeTaggedText(route, text) {
  const r = String(route || "").trim();
  const t = String(text || "").trim();
  return JSON.stringify({ route: r || "default", text: t });
}

async function callOpenAICompletion({
  messages,
  stream = false,
  requestId,
  targetTabId,
  uiAction = "suggestionChunk",
  slot = undefined,
}) {
  const endpoint = (state.llamaSettings.endpoint || "https://api.openai.com/v1/chat/completions").trim();
  const model = state.llamaSettings.model || "gpt-4o-mini";
  const apiKey = (state.llamaSettings.apiKey || "").trim();

  const headers = { "Content-Type": "application/json" };
  if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;

  const body = { model, messages, stream: !!stream };

  const res = await fetch(endpoint, { method: "POST", headers, body: JSON.stringify(body) });
  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`OpenAI error ${res.status}: ${errText || res.statusText}`);
  }

  const send = (text, done, extra = {}) => {
    const msg = { action: uiAction, text, requestId, done: !!done, ...extra };
    if (slot) msg.slot = slot;
    broadcastToUI(msg, targetTabId);
  };

  if (!stream) {
    const json = await res.json();
    const textRaw = json?.choices?.[0]?.message?.content ?? "";
    const text = stripMetaAnalysisText(textRaw);
    state.stream.text = text;
    send(text, true);
    return text;
  }

  if (!res.body) throw new Error("OpenAI stream: missing body");
  const reader = res.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buf = "";
  let out = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });

    const parts = buf.split(/\r?\n/);
    buf = parts.pop() || "";
    for (const line of parts) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const data = trimmed.slice(5).trim();
      if (!data || data === "[DONE]") continue;

      try {
        const evt = JSON.parse(data);
        const delta = evt?.choices?.[0]?.delta?.content;
        if (typeof delta === "string" && delta) {
          out += delta;
          const filtered = stripMetaAnalysisText(out);
          state.stream.text = filtered;
          send(filtered, false);
        }
      } catch {}
    }
  }

  const final = stripMetaAnalysisText(out);
  state.stream.text = final;
  send(final, true);
  return final;
}

async function callOllama({ prompt, stream = false, requestId, targetTabId, uiAction = "suggestionChunk", slot }) {
  const base = (state.llamaSettings.endpoint || "http://localhost:11434").trim().replace(/\/+$/, "");
  const url = base.endsWith("/api/generate") ? base : base + "/api/generate";
  const model = state.llamaSettings.model || "llama3";

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, prompt, stream: !!stream }),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`Ollama error ${res.status}: ${errText || res.statusText}`);
  }

  const send = (text, done, extra = {}) => {
    const msg = { action: uiAction, text, requestId, done: !!done, ...extra };
    if (slot) msg.slot = slot;
    broadcastToUI(msg, targetTabId);
  };

  if (!stream) {
    const json = await res.json();
    const text = stripMetaAnalysisText(json?.response ?? "");
    state.stream.text = text;
    send(text, true);
    return text;
  }

  if (!res.body) throw new Error("Ollama stream: missing body");
  const reader = res.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buf = "";
  let out = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });

    const lines = buf.split(/\r?\n/);
    buf = lines.pop() || "";
    for (const ln of lines) {
      const t = ln.trim();
      if (!t) continue;
      try {
        const j = JSON.parse(t);
        if (typeof j?.response === "string") {
          out += j.response;
          const filtered = stripMetaAnalysisText(out);
          state.stream.text = filtered;
          send(filtered, false);
        }
      } catch {}
    }
  }

  const final = stripMetaAnalysisText(out);
  state.stream.text = final;
  send(final, true);
  return final;
}

/**
 * callPythonStream
 * - rewriteContext -> /ask
 * - suggestion -> /ask_me
 *
 * ✅ suporta extraBody (ex: {route:"positivo"})
 */
async function callPythonStream({
  prompt,
  requestId,
  targetTabId,
  signal,
  uiAction = "suggestionChunk",
  path = PYTHON_PATH_REWRITE,
  slot = undefined,
  extraBody = undefined,
}) {
  const url = normalizePythonEndpoint(state.llamaSettings.endpoint, path, DEFAULT_PYTHON_BASE_URL);

  const bodyObj = { prompt: String(prompt || "") };
  if (extraBody && typeof extraBody === "object") Object.assign(bodyObj, extraBody);

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(bodyObj),
    signal,
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`Python error ${res.status}: ${errText || res.statusText}`);
  }

  const send = (text, done, extra = {}) => {
    const msg = { action: uiAction, text, requestId, done: !!done, ...extra };
    if (slot) msg.slot = slot;
    broadcastToUI(msg, targetTabId);
  };

  if (!res.body) {
    const textRaw = await res.text().catch(() => "");
    const text = stripMetaAnalysisText(textRaw);
    state.stream.text = text;
    send(text, true);
    return text;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let out = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    const chunk = decoder.decode(value, { stream: true });
    if (!chunk) continue;

    out += chunk;
    const filtered = stripMetaAnalysisText(out);
    state.stream.text = filtered;
    send(filtered, false);
  }

  const final = stripMetaAnalysisText(out);
  state.stream.text = final;
  send(final, true);
  return final;
}

// =========================
// Conteúdo "puro" (sem prompts fixos)
// =========================
function buildSuggestionContentOnly({ forcedLine = "" } = {}) {
  const forced = String(forcedLine || "").trim();
  const consolidated = normalizeSpace(state.rewriteText || "");

  const last = state.payload?.latestLine ? String(state.payload.latestLine) : "";
  const historyTail = tailChars(state.payload?.fullHistory, 2000);
  const convTail = buildContextFromConversation(10);

  const contextBlock = forced || consolidated || convTail || last || historyTail || "";
  return String(contextBlock).trim();
}

// =========================
// Helpers de replies 2-rotas
// =========================
async function generateOneRoute({ route, prompt, requestId, targetTabId, signal }) {
  const mode = (state.llamaSettings.mode || "python").toLowerCase();
  const stream = true;

  broadcastToUI(
    { action: "suggestionChunk", slot: route, text: "", requestId, done: false, reset: true },
    targetTabId
  );

  if (mode === "python") {
    return await callPythonStream({
      prompt,
      requestId,
      targetTabId,
      signal,
      uiAction: "suggestionChunk",
      path: PYTHON_PATH_SUGGEST,
      slot: route,
      extraBody: { route },
    });
  }

  if (mode === "ollama") {
    const p = routeTaggedText(route, prompt);
    return await callOllama({
      prompt: p,
      stream,
      requestId,
      targetTabId,
      uiAction: "suggestionChunk",
      slot: route,
    });
  }

  const tagged = routeTaggedText(route, prompt);
  const messages = buildChatMessagesForOpenAI(tagged);
  return await callOpenAICompletion({
    messages,
    stream,
    requestId,
    targetTabId,
    uiAction: "suggestionChunk",
    slot: route,
  });
}

// =========================
// Messaging
// =========================
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  (async () => {
    try {
      const action = request?.action;

      if (action === "openViewerTab") {
        const url = chrome.runtime.getURL("viewer.html");
        chrome.tabs.create({ url }, () => sendResponse({ status: "ok" }));
        return;
      }

      if (action === "openViewerSidePanel") {
        const tabId = sender?.tab?.id;

        // ✅ Guard: sidePanel pode não existir em versões antigas
        if (!chrome.sidePanel || !chrome.sidePanel.setOptions || !chrome.sidePanel.open) {
          sendResponse({ status: "ok", via: "tab", reason: "sidePanel_unavailable" });
          return;
        }

        if (!tabId) {
          sendResponse({ status: "ok", via: "tab" });
          return;
        }
        try {
          await chrome.sidePanel.setOptions({ tabId, path: "viewer.html", enabled: true });
          await chrome.sidePanel.open({ tabId });
          sendResponse({ status: "ok", via: "sidePanel" });
        } catch {
          sendResponse({ status: "ok", via: "tab" });
        }
        return;
      }

      if (action === "getTranscriberState") {
        sendResponse({
          status: "ok",
          payload: state.payload,
          suggestion: state.suggestion,
          suggestionAt: state.suggestionAt,
          rewriteText: state.rewriteText,
          rewriteAt: state.rewriteAt,
          llamaSettings: state.llamaSettings,
          conversation: state.conversation,
        });
        return;
      }

      if (action === "clearTranscriberState") {
        abortActiveStream();
        state.payload = null;
        state.suggestion = "";
        state.suggestionAt = "";
        state.rewriteText = "";
        state.rewriteAt = "";
        state.conversation = [];

        tickAgg.recent.clear();
        tickAgg.recentText.clear();
        tickAgg.lastByKey.clear();

        await saveStateToStorage();

        broadcastToUI(
          { action: "transcriptDataUpdated", payload: { fullHistory: "", latestLine: "", timestamp: nowIso() } },
          state.activeMeetingTabId
        );
        broadcastToUI({ action: "suggestionChunk", text: "", done: true, reset: true, slot: "positivo" }, state.activeMeetingTabId);
        broadcastToUI({ action: "suggestionChunk", text: "", done: true, reset: true, slot: "negativo" }, state.activeMeetingTabId);
        broadcastToUI({ action: "rewriteChunk", text: "", done: true, reset: true }, state.activeMeetingTabId);

        safeRuntimeSend({ action: "conversationUpdated" });
        sendResponse({ status: "ok" });
        return;
      }

      if (action === "saveLlamaSettings") {
        state.llamaSettings = { ...state.llamaSettings, ...(request?.payload || {}) };
        await saveStateToStorage();
        sendResponse({ status: "ok" });
        return;
      }

      // ✅ transcriptTick COM ANTI-SPAM
      if (action === "transcriptTick") {
        if (typeof sender?.tab?.id === "number") state.activeMeetingTabId = sender.tab.id;

        const rawLine = request?.payload?.line;
        const parsed = parseTickLine(rawLine);
        if (!parsed) {
          sendResponse({ status: "ok", skipped: "unparsed" });
          return;
        }

        const origin = normOriginName(parsed.origin);
        const speaker = normSpeakerName(parsed.speaker);
        const text = cleanTickText(parsed.text);

        if (!text || isNoiseLine(text)) {
          sendResponse({ status: "ok", skipped: "noise" });
          return;
        }

        const ts = Date.parse(request?.payload?.timestamp || "") || Date.now();

        purgeOld(tickAgg.recent, TICK_DEDUPE_TTL_MS);
        purgeOld(tickAgg.recentText, TICK_DEDUPE_TTL_MS);

        // 1) dedupe exato
        const dedupeKey = `${origin}||${speaker}||${text}`;
        const prevExact = tickAgg.recent.get(dedupeKey);
        if (prevExact && ts - prevExact < TICK_DEDUPE_TTL_MS) {
          sendResponse({ status: "ok", skipped: "dedupe_exact" });
          return;
        }
        tickAgg.recent.set(dedupeKey, ts);

        // 2) se for "Desconhecido" e o texto já apareceu há pouco, ignora
        if (isUnknownSpeaker(speaker)) {
          const prevAny = tickAgg.recentText.get(text);
          if (prevAny && ts - prevAny < 2000) {
            sendResponse({ status: "ok", skipped: "unknown_dup" });
            return;
          }
        }

        // 3) se speaker conhecido e existe "Desconhecido" recente com mesmo texto, substitui
        if (!isUnknownSpeaker(speaker)) {
          const idx = findRecentUnknownIdxSameText(text, 3200);
          if (idx >= 0) {
            state.conversation[idx] = {
              ...state.conversation[idx],
              timestamp: request?.payload?.timestamp || nowIso(),
              origin,
              speaker,
              text,
            };
            keepConversationTail(500);

            tickAgg.lastByKey.set(`${origin}||${speaker}`, { idx, ts, text });
            tickAgg.recentText.set(text, ts);

            await chrome.storage.local.set({
              conversation: state.conversation,
              activeMeetingTabId: state.activeMeetingTabId,
            });

            safeRuntimeSend({ action: "conversationUpdated" });
            sendResponse({ status: "ok", merged: "replace_unknown" });
            return;
          }
        }

        // 4) merge incremental (mesmo origin+speaker)
        const key = `${origin}||${speaker}`;
        const last = tickAgg.lastByKey.get(key);

        if (last && ts - last.ts < TICK_MERGE_WINDOW_MS) {
          const prevText = String(state.conversation[last.idx]?.text || last.text || "");

          if (text === prevText) {
            tickAgg.recentText.set(text, ts);
            sendResponse({ status: "ok", skipped: "same_as_last" });
            return;
          }

          if (text.startsWith(prevText) && text.length > prevText.length) {
            state.conversation[last.idx].text = text;
            state.conversation[last.idx].timestamp = request?.payload?.timestamp || nowIso();

            tickAgg.lastByKey.set(key, { idx: last.idx, ts, text });
            tickAgg.recentText.set(text, ts);

            await chrome.storage.local.set({
              conversation: state.conversation,
              activeMeetingTabId: state.activeMeetingTabId,
            });

            safeRuntimeSend({ action: "conversationUpdated" });
            sendResponse({ status: "ok", merged: "extended" });
            return;
          }

          if (prevText.includes(text) && text.length <= 18) {
            tickAgg.recentText.set(prevText, ts);
            sendResponse({ status: "ok", skipped: "subset" });
            return;
          }

          if (prevText.startsWith(text)) {
            tickAgg.recentText.set(prevText, ts);
            sendResponse({ status: "ok", skipped: "shorter" });
            return;
          }
        }

        // 5) push normal
        state.conversation.push({
          timestamp: request?.payload?.timestamp || nowIso(),
          origin,
          speaker,
          text,
        });
        keepConversationTail(500);

        tickAgg.lastByKey.set(key, { idx: state.conversation.length - 1, ts, text });
        tickAgg.recentText.set(text, ts);

        await chrome.storage.local.set({
          conversation: state.conversation,
          activeMeetingTabId: state.activeMeetingTabId,
        });

        safeRuntimeSend({ action: "conversationUpdated" });
        sendResponse({ status: "ok" });
        return;
      }

      if (action === "transcriptData") {
        if (typeof sender?.tab?.id === "number") state.activeMeetingTabId = sender.tab.id;

        state.payload = { ...request.payload, timestamp: nowIso() };

        await chrome.storage.local.set({
          payload: state.payload,
          activeMeetingTabId: state.activeMeetingTabId,
        });

        broadcastToUI({ action: "transcriptDataUpdated", payload: state.payload }, state.activeMeetingTabId);
        sendResponse({ status: "ok" });
        return;
      }

      // --------
      // ✅ Rewrite / Consolidação -> /ask
      // --------
      if (action === "rewriteContext") {
        const reqId = request?.payload?.requestId || makeRequestId();
        const targetTabId = resolveTargetTabId(sender);

        let lines = Array.isArray(request?.payload?.lines) ? request.payload.lines : [];

        if (!lines.length && typeof request?.payload?.fullHistory === "string") {
          lines = request.payload.fullHistory.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
        }
        if (!lines.length && typeof state.payload?.fullHistory === "string") {
          lines = state.payload.fullHistory.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
        }
        if (!lines.length && Array.isArray(state.conversation) && state.conversation.length) {
          lines = state.conversation
            .slice(-120)
            .map((t) => `${t.origin || "Canal"}: ${t.speaker || "Participante"}: ${t.text || ""}`.trim())
            .filter(Boolean);
        }

        abortActiveStream();
        const abort = new AbortController();
        state.stream.abort = abort;
        state.stream.requestId = reqId;
        state.stream.text = "";

        broadcastToUI({ action: "rewriteChunk", text: "", requestId: reqId, done: false, reset: true }, targetTabId);

        const compact = compactTranscriptLinesForLLM(lines, 80);
        const fallback = compact || lines.join("\n");

        const mode = (state.llamaSettings.mode || "python").toLowerCase();
        const stream = true;

        let finalText = "";
        try {
          const prompt = String(compact || fallback || "").trim();

          if (mode === "python") {
            finalText = await callPythonStream({
              prompt,
              requestId: reqId,
              targetTabId,
              signal: abort.signal,
              uiAction: "rewriteChunk",
              path: PYTHON_PATH_REWRITE,
            });
          } else if (mode === "ollama") {
            finalText = await callOllama({ prompt, stream, requestId: reqId, targetTabId, uiAction: "rewriteChunk" });
          } else {
            const messages = buildChatMessagesForOpenAI(prompt);
            finalText = await callOpenAICompletion({
              messages,
              stream,
              requestId: reqId,
              targetTabId,
              uiAction: "rewriteChunk",
            });
          }
        } catch (e) {
          console.warn("rewriteContext fallback:", e);
          finalText = stripMetaAnalysisText(fallback);
          broadcastToUI({ action: "rewriteChunk", text: finalText, requestId: reqId, done: true }, targetTabId);
        }

        state.rewriteText = String(finalText || "");
        state.rewriteAt = nowIso();
        await chrome.storage.local.set({ rewriteText: state.rewriteText, rewriteAt: state.rewriteAt });

        sendResponse({ status: "ok", text: state.rewriteText, timestamp: state.rewriteAt, requestId: reqId });
        return;
      }

      // --------
      // ✅ Suggestion (1 rota) -> /ask_me (slot positivo)
      // --------
      if (action === "generateSuggestion") {
        const reqId = request?.payload?.requestId || makeRequestId();
        const targetTabId = resolveTargetTabId(sender);

        abortActiveStream();
        const abort = new AbortController();
        state.stream.abort = abort;
        state.stream.requestId = reqId;
        state.stream.text = "";

        broadcastToUI(
          { action: "suggestionChunk", text: "", requestId: reqId, done: false, reset: true, slot: "positivo" },
          targetTabId
        );

        const mode = (state.llamaSettings.mode || "python").toLowerCase();
        const stream = true;

        const forcedLine = request?.payload?.line ? String(request.payload.line) : "";
        const prompt = buildSuggestionContentOnly({ forcedLine });

        let finalText = "";
        if (mode === "python") {
          finalText = await callPythonStream({
            prompt,
            requestId: reqId,
            targetTabId,
            signal: abort.signal,
            uiAction: "suggestionChunk",
            path: PYTHON_PATH_SUGGEST,
            slot: "positivo",
          });
        } else if (mode === "ollama") {
          finalText = await callOllama({
            prompt,
            stream,
            requestId: reqId,
            targetTabId,
            uiAction: "suggestionChunk",
            slot: "positivo",
          });
        } else {
          const messages = buildChatMessagesForOpenAI(prompt);
          finalText = await callOpenAICompletion({
            messages,
            stream,
            requestId: reqId,
            targetTabId,
            uiAction: "suggestionChunk",
            slot: "positivo",
          });
        }

        state.suggestion = String(finalText || "");
        state.suggestionAt = nowIso();
        await chrome.storage.local.set({ suggestion: state.suggestion, suggestionAt: state.suggestionAt });

        sendResponse({ status: "ok", suggestion: state.suggestion, timestamp: state.suggestionAt, requestId: reqId });
        return;
      }

      // --------
      // ✅ Replies (2 caminhos) -> POSITIVO + NEGATIVO
      // --------
      if (action === "generateReplies") {
        const reqId = request?.payload?.requestId || makeRequestId();
        const targetTabId = resolveTargetTabId(sender);

        const text = String(request?.payload?.text || "").trim();
        const routes =
          Array.isArray(request?.payload?.routes) && request.payload.routes.length
            ? request.payload.routes
            : ["positivo", "negativo"];

        const prompt = buildSuggestionContentOnly({ forcedLine: text });

        abortActiveStream();
        const abort = new AbortController();
        state.stream.abort = abort;
        state.stream.requestId = reqId;
        state.stream.text = "";

        broadcastToUI({ action: "suggestionChunk", slot: "positivo", text: "", requestId: reqId, done: false, reset: true }, targetTabId);
        broadcastToUI({ action: "suggestionChunk", slot: "negativo", text: "", requestId: reqId, done: false, reset: true }, targetTabId);

        const wantPos = routes.includes("positivo");
        const wantNeg = routes.includes("negativo");

        let positivo = "";
        let negativo = "";

        const jobs = [];

        if (wantPos) {
          jobs.push(
            generateOneRoute({
              route: "positivo",
              prompt,
              requestId: reqId,
              targetTabId,
              signal: abort.signal,
            }).then((t) => {
              positivo = String(t || "").trim();
            })
          );
        }

        if (wantNeg) {
          jobs.push(
            generateOneRoute({
              route: "negativo",
              prompt,
              requestId: reqId,
              targetTabId,
              signal: abort.signal,
            }).then((t) => {
              negativo = String(t || "").trim();
            })
          );
        }

        await Promise.all(jobs);

        sendResponse({
          status: "ok",
          suggestions: { positivo, negativo },
          timestamp: nowIso(),
          requestId: reqId,
        });
        return;
      }

      sendResponse({ status: "error", error: "Unknown action" });
    } catch (err) {
      const msg = String(err?.message || err);
      console.error("❌ background error:", err);

      const reqId = state.stream.requestId || null;

      broadcastToUI(
        { action: "suggestionChunk", slot: "positivo", text: state.stream.text || "", requestId: reqId, done: true, error: msg },
        state.activeMeetingTabId
      );
      broadcastToUI(
        { action: "suggestionChunk", slot: "negativo", text: state.stream.text || "", requestId: reqId, done: true, error: msg },
        state.activeMeetingTabId
      );
      broadcastToUI(
        { action: "rewriteChunk", text: state.rewriteText || "", requestId: reqId, done: true, error: msg },
        state.activeMeetingTabId
      );

      sendResponse({ status: "error", error: msg });
    }
  })();

  return true; // mantém canal async
});
