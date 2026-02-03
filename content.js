/* transcriber.content.js — MT Transcriber (no-rewrite)
   - Captura legendas (Meet / Teams / Slack)
   - Mostra histórico + sugestões em painel lateral in-page
   - ✅ Auto-IA: depois de 1s sem novas linhas, manda o “tail” do chat pra IA
   - ✅ Respostas: 2 caminhos -> POSITIVO e NEGATIVO
   - ✅ FIX: anti-duplicação de requests (manual + auto + double-click + frames)
   - ✅ FIX: ACK/streaming compatível (não exige res.status === "ok")
   - ✅ NEW: Teams "." final NÃO vira linha nova (cola no final da última)
   - ✅ NEW: Rewrite (IA) consolida/junta “pipocos” do Teams quando finaliza com "."
   - ✅ NEW: Flags nas linhas arrumadas (pra não corrigir toda hora)
*/

console.log("✅ Transcriber content script carregado!");

// =====================================================
// ⚡ Tuning
// =====================================================
const CAPTURE_START_DELAY_MS = 300;
const CAPTURE_INTERVAL_MS = 700;
const FLUSH_INTERVAL_MS = 2000;
const FLUSH_DEBOUNCE_MS = 350;
const MAX_HISTORY_CHARS = 120000;

// =====================================================
// ✅ Panel cache (tail)
// =====================================================
const PANEL_HISTORY_MAX_CHARS = 25000;
const PANEL_SCROLL_LOCK_PX = 48;
const TRANSCRIPT_DISPLAY_MAX_LINES = 80;

// =====================================================
// ✅ Auto-IA (1s de “silêncio” -> manda tail do chat)
// =====================================================
const AUTO_IA_ENABLED_DEFAULT = true;
const AUTO_IA_IDLE_MS = 1000;
const AUTO_IA_MAX_LINES = 10;

// =====================================================
// ✅ Teams behavior
// =====================================================
const CAPTURE_SELF_LINES = true;
const TEAMS_DEBUG = false;
const tdbg = (...a) => {
  if (TEAMS_DEBUG) console.debug("[MT][Teams]", ...a);
};

// =====================================================
// ✅ UI ids
// =====================================================
const UI_IDS = {
  style: "__mt_style",
  overlay: "__mt_dim_overlay",
  bubble: "__mt_launcher_bubble",
  panel: "__mt_side_panel",
  panelHeader: "__mt_side_panel_header",
  panelClose: "__mt_side_panel_close",
  panelOpenTab: "__mt_side_panel_open_tab",
  panelStatus: "__mt_side_panel_status",
  panelTranscript: "__mt_side_panel_transcript",
  // suggestions (2 rotas)
  panelSuggestionsWrap: "__mt_side_panel_suggestions_wrap",
  panelSuggestionPos: "__mt_side_panel_suggestion_pos",
  panelSuggestionNeg: "__mt_side_panel_suggestion_neg",
  panelSugCopyPos: "__mt_side_panel_copy_pos",
  panelSugCopyNeg: "__mt_side_panel_copy_neg",
  // auto toggle
  panelAutoIaBtn: "__mt_side_panel_auto_ia_btn",
};

// =====================================================
// ✅ State (transcrição)
// =====================================================
let transcriptData = "";
let lastSavedHash = "";
let lastLineBySpeaker = new Map();
let seenKeys = new Set();
let latestBySpeaker = new Map();

// ✅ Guarda a última linha “singleLine” por origin+speaker (pra colar "." no final)
let lastSingleLineByKey = new Map();

// =====================================================
// ✅ Flags: linhas já “arrumadas” (pra não ficar corrigindo toda hora)
// - guarda chaves em localStorage
// - mostra ✅ no UI
// =====================================================
const FIXED_FLAGS_STORE_KEY = "__mt_fixed_line_flags_v1";
const FIXED_FLAGS_MAX = 2500;

let fixedLineFlags = new Map(); // key -> ts (insertion order)
let fixedFlagsLoaded = false;
let fixedFlagsSaveTimer = null;

function lineFlagKey(line) {
  // chave curta e estável (hash do conteúdo normalizado)
  const clean = normTextKey(String(line || "").replace(/^🎤\s*/u, "").trim());
  return clean ? fastHash(clean) : "";
}

function loadFixedFlags() {
  if (fixedFlagsLoaded) return;
  fixedFlagsLoaded = true;

  try {
    const raw = localStorage.getItem(FIXED_FLAGS_STORE_KEY);
    if (!raw) return;

    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return;

    fixedLineFlags.clear();
    for (const it of arr) {
      if (!it) continue;
      const k = String(it[0] || "").trim();
      const ts = Number(it[1] || 0) || 0;
      if (!k) continue;
      fixedLineFlags.set(k, ts || Date.now());
      if (fixedLineFlags.size >= FIXED_FLAGS_MAX) break;
    }
  } catch {}
}

function scheduleSaveFixedFlags() {
  try {
    if (fixedFlagsSaveTimer) clearTimeout(fixedFlagsSaveTimer);
    fixedFlagsSaveTimer = setTimeout(() => {
      fixedFlagsSaveTimer = null;
      try {
        // salva como lista de [key, ts]
        const arr = Array.from(fixedLineFlags.entries()).slice(-FIXED_FLAGS_MAX);
        localStorage.setItem(FIXED_FLAGS_STORE_KEY, JSON.stringify(arr));
      } catch {}
    }, 400);
  } catch {}
}

function markLineFixed(line) {
  loadFixedFlags();
  const k = lineFlagKey(line);
  if (!k) return;

  // refresh/insertion-order
  fixedLineFlags.delete(k);
  fixedLineFlags.set(k, Date.now());

  // eviction
  while (fixedLineFlags.size > FIXED_FLAGS_MAX) {
    const first = fixedLineFlags.keys().next().value;
    if (!first) break;
    fixedLineFlags.delete(first);
  }

  scheduleSaveFixedFlags();
}

function isLineFixed(line) {
  loadFixedFlags();
  const k = lineFlagKey(line);
  return !!k && fixedLineFlags.has(k);
}

// =====================================================
// ✅ Dedupe curto por texto (evita "Desconhecido" duplicar "Leonel")
// =====================================================
const TEXT_DEDUP_MS = 1600;
const recentText = new Map(); // key -> { ts, speaker, line }

function normTextKey(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function isUnknownSpeaker(s) {
  const t = String(s || "").trim().toLowerCase();
  return !t || t === "desconhecido" || t === "unknown";
}

// =====================================================
// ✅ Parse: 🎤 Origin: Speaker: Text
// =====================================================
function parseTranscriptLine(line) {
  const clean = String(line || "").replace(/^🎤\s*/u, "").trim();
  const m = clean.match(/^([^:]+?)\s*:\s*([^:]+?)\s*:\s*(.*)$/u);
  if (!m) return { origin: "", speaker: "", text: clean };
  return { origin: (m[1] || "").trim(), speaker: (m[2] || "").trim(), text: (m[3] || "").trim() };
}

function isTeamsFinalLine(line) {
  const p = parseTranscriptLine(line);
  return String(p.origin || "").trim().toLowerCase() === "teams" && String(p.text || "").trim().endsWith(".");
}

function isDotOnlyDelta(s) {
  return String(s || "").trim() === ".";
}

// substitui a última ocorrência de uma linha no transcriptData e no cache do painel
function replaceLastLineInCaches(oldLine, newLine) {
  if (!oldLine || !newLine || oldLine === newLine) return;

  // ✅ preserva flag “arrumada” (se a old tinha flag, a new herda)
  const oldK = lineFlagKey(oldLine);
  const hadFlag = oldK && fixedLineFlags.has(oldK);

  const replaceLast = (big, oldL, newL) => {
    const idx = big.lastIndexOf(oldL);
    if (idx < 0) return big;
    return big.slice(0, idx) + newL + big.slice(idx + oldL.length);
  };

  transcriptData = replaceLast(transcriptData, oldLine, newLine);
  panelTranscriptCache = replaceLast(panelTranscriptCache, oldLine, newLine);

  if (hadFlag) {
    try {
      fixedLineFlags.delete(oldK);
    } catch {}
    markLineFixed(newLine);
  }

  renderTranscriptListFromCache();
}

// =====================================================
// ✅ "EU" (normalizado) — evita variações tipo "(Você)"
// =====================================================
function normName(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/\(.*?\)/g, "")
    .replace(/\s+/g, "")
    .replace(/[^\p{L}\p{N}]/gu, "");
}
const myKnownNameNorms = new Set([normName("Você"), normName("Leonel Dorneles Porto")]);
function addMyName(name) {
  const n = normName(name);
  if (n) myKnownNameNorms.add(n);
}
function isMe(name) {
  return myKnownNameNorms.has(normName(name));
}

// =====================================================
// ✅ State (UI)
// =====================================================
let panelTranscriptCache = "";
let panelSuggestionCache = { positivo: "", negativo: "" };

// =====================================================
// ✅ Guard / timers
// =====================================================
let captureIntervalId = null;
let flushIntervalId = null;
let startTimeoutId = null;
let flushDebounceId = null;
let extensionInvalidated = false;

let IS_TOP_FRAME = false;
try {
  IS_TOP_FRAME = window.top === window;
} catch {
  IS_TOP_FRAME = false;
}

// =====================================================
// ✅ FIX: Anti-duplicação de requests (manual + auto + frames)
// =====================================================

// Só TOP FRAME pode disparar IA (manual e auto)
const AI_ONLY_TOP_FRAME = true;

// Se true, volta o fallback de 2 chamadas (gera 2 requests). Mantém false por design.
const ENABLE_TWO_CALL_FALLBACK = false;

// Janela para dedupe do mesmo payload (manual/auto clicado junto)
const REPLY_DEDUP_MS = 1800;

// Lock mínimo após iniciar request (segura double-click + auto junto)
const REPLY_LOCK_MS = 2500;

// Se estiver em streaming, estende lock quando chegam chunks
const STREAM_LOCK_BUMP_MS = 1200;

let repliesInFlight = false;
let repliesLockUntil = 0;
let lastReplyKey = "";
let lastReplyAt = 0;

function aiAllowedHere() {
  return !AI_ONLY_TOP_FRAME || IS_TOP_FRAME;
}

function releaseReplyLockIfExpired() {
  const now = Date.now();
  if (repliesInFlight && now >= repliesLockUntil) {
    repliesInFlight = false;
    repliesLockUntil = 0;
  }
}

function bumpReplyLock(ms = STREAM_LOCK_BUMP_MS) {
  if (!aiAllowedHere()) return;
  const now = Date.now();
  repliesInFlight = true;
  repliesLockUntil = Math.max(repliesLockUntil || 0, now + Math.max(250, ms | 0));
}

function tryAcquireReplyLock(payloadStr) {
  if (!aiAllowedHere()) return { ok: false, reason: "not_top_frame" };

  releaseReplyLockIfExpired();

  const now = Date.now();
  const payload = String(payloadStr || "").trim();
  if (!payload) return { ok: false, reason: "empty" };

  const key = fastHash(payload);

  // dedupe: mesmo payload dentro da janela => ignora
  if (key === lastReplyKey && now - lastReplyAt < REPLY_DEDUP_MS) {
    return { ok: false, reason: "dedup" };
  }

  // lock: já tem request em andamento => ignora
  if (repliesInFlight && now < repliesLockUntil) {
    return { ok: false, reason: "in_flight" };
  }

  // acquire
  lastReplyKey = key;
  lastReplyAt = now;
  repliesInFlight = true;
  repliesLockUntil = now + REPLY_LOCK_MS;

  return { ok: true, key };
}

function finishReplyLock() {
  // libera lock cedo, mas mantém uma “trava leve” curta pra clique duplo
  const now = Date.now();
  repliesInFlight = false;
  repliesLockUntil = now + 350;
}

// =====================================================
// Utils
// =====================================================
function nowIso() {
  return new Date().toISOString();
}
function tail(str, max) {
  str = String(str || "");
  if (!max || str.length <= max) return str;
  return str.slice(str.length - max);
}
function fastHash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return String(h >>> 0);
}
function trimHistoryIfNeeded() {
  if (transcriptData.length <= MAX_HISTORY_CHARS) return;
  transcriptData = transcriptData.slice(transcriptData.length - MAX_HISTORY_CHARS);
}
function isPanelOpen() {
  return document.documentElement.classList.contains("__mt_panel_open");
}
function setTextPreserveScroll(el, text) {
  if (!el) return;
  const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < PANEL_SCROLL_LOCK_PX;
  el.textContent = text || "";
  if (nearBottom) el.scrollTop = el.scrollHeight;
}
function withPanelTranscriptScrollPreserved(fn) {
  const host = document.getElementById(UI_IDS.panelTranscript);
  if (!host) return fn();
  const nearBottom = host.scrollHeight - host.scrollTop - host.clientHeight < PANEL_SCROLL_LOCK_PX;
  fn();
  if (nearBottom) host.scrollTop = host.scrollHeight;
}
function transcriptCacheHasLine(line) {
  if (!line) return false;
  return panelTranscriptCache.includes(line);
}
function normalizeTranscriptLineForLLM(line) {
  return String(line || "").replace(/^🎤\s*/u, "").trim();
}

// =====================================================
// ✅ Anti-loop: linhas internas NÃO entram em Auto-IA
// =====================================================
function isInternalInjectedLine(line) {
  const s = String(line || "");
  return (
    /^\s*🎤\s*MT\b/i.test(s) ||
    /\bSpeaker\s*\(Origin\)\s*:/i.test(s) ||
    /^\s*(Question|Answer|Pergunta|Resposta)\s*:/i.test(s)
  );
}

// =====================================================
// Heurística: junta “pipocos” (co + mo => como)
// =====================================================
function mergePipocadas(lines) {
  const out = [];
  let last = null; // { origin, speaker, text }

  function parse(line) {
    const clean = normalizeTranscriptLineForLLM(line);
    const parts = clean.split(":").map((p) => p.trim());
    if (parts.length < 3) return { origin: "", speaker: "", text: clean };
    const origin = parts[0];
    const speaker = parts[1];
    const text = parts.slice(2).join(":").trim();
    return { origin, speaker, text };
  }

  function isTinyToken(t) {
    return /^[A-Za-zÀ-ÿ]{1,2}$/u.test(t);
  }

  for (const raw of lines) {
    const { origin, speaker, text } = parse(raw);
    const t = (text || "").trim();
    if (!t) continue;

    if (last && last.origin === origin && last.speaker === speaker) {
      const prevText = last.text || "";
      if (isTinyToken(prevText) && isTinyToken(t)) {
        last.text = prevText + t;
        continue;
      }
      if (t.length <= 3 && prevText.length > 0) {
        last.text = (prevText + " " + t).replace(/\s+/g, " ").trim();
        continue;
      }
    }

    if (last) out.push(last);
    last = { origin, speaker, text: t };
  }

  if (last) out.push(last);
  return out.map((x) => `${x.origin}: ${x.speaker}: ${x.text}`.trim());
}

// =====================================================
// Messaging (safe)
// =====================================================
function stopTranscriber(reason) {
  if (captureIntervalId) clearInterval(captureIntervalId);
  if (flushIntervalId) clearInterval(flushIntervalId);
  if (startTimeoutId) clearTimeout(startTimeoutId);
  if (flushDebounceId) clearTimeout(flushDebounceId);
  cancelAutoIaTimer();

  captureIntervalId = null;
  flushIntervalId = null;
  startTimeoutId = null;
  flushDebounceId = null;

  console.warn("🛑 Transcriber parado:", reason || "unknown");
}

function safeSendMessage(message, cb) {
  if (extensionInvalidated) return;
  try {
    chrome.runtime.sendMessage(message, cb);
  } catch (err) {
    const msg = String(err?.message || err);
    if (msg.includes("Extension context invalidated")) {
      extensionInvalidated = true;
      stopTranscriber("Extension context invalidated (provável reload/update da extensão)");
      setLauncherState("error");
      return;
    }
    throw err;
  }
}

// =====================================================
// Detect page support
// =====================================================
function isSupportedPage() {
  const url = window.location.href;
  return (
    url.includes("meet.google.com") ||
    url.includes("teams.microsoft.com") ||
    url.includes("teams.live.com") ||
    url.includes("slack.com")
  );
}
if (!isSupportedPage()) {
  console.warn("⚠️ Transcriber: página não suportada para UI/launcher.");
}

// =====================================================
// Panel status
// =====================================================
function setPanelStatus(msg) {
  const el = document.getElementById(UI_IDS.panelStatus);
  if (el) el.textContent = msg || "";
}

// =====================================================
// Clipboard
// =====================================================
function copyToClipboard(text) {
  const t = String(text || "").trim();
  if (!t) return;
  try {
    navigator.clipboard?.writeText(t);
    setPanelStatus("Copiado ✅");
  } catch {
    const ta = document.createElement("textarea");
    ta.value = t;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    ta.remove();
    setPanelStatus("Copiado ✅");
  }
}

// =====================================================
// Suggestions UI (2 slots)
// =====================================================
function setAllSuggestionSlots(value) {
  setSuggestionSlot("positivo", value);
  setSuggestionSlot("negativo", value);
}
function setSuggestionSlot(slot, raw) {
  slot = slot === "negativo" ? "negativo" : "positivo";
  panelSuggestionCache[slot] = tail(String(raw || ""), 8000);

  const el = document.getElementById(slot === "positivo" ? UI_IDS.panelSuggestionPos : UI_IDS.panelSuggestionNeg);
  if (!el) return;

  const label = slot === "positivo" ? "Positivo" : "Negativo";
  const txt = panelSuggestionCache[slot] ? `${label}:\n${panelSuggestionCache[slot]}` : `${label}: (vazio)`;

  setTextPreserveScroll(el, txt);
}

// =====================================================
// ✅ Transcript cache (painel)
// =====================================================
function setPanelTranscriptText(raw) {
  panelTranscriptCache = tail(raw, PANEL_HISTORY_MAX_CHARS);
  renderTranscriptListFromCache();
}
function appendPanelTranscriptLine(line) {
  if (!line) return;
  if (transcriptCacheHasLine(line)) return;

  panelTranscriptCache = (panelTranscriptCache ? panelTranscriptCache + "\n" : "") + line;
  panelTranscriptCache = tail(panelTranscriptCache, PANEL_HISTORY_MAX_CHARS);
  renderTranscriptListFromCache();
}

// =====================================================
// ✅ Rewrite (IA): junta mensagens do Teams (e aplica no transcript)
// - Espera response do background como:
//   { text: "..." } OU { lines: ["Teams: Nome: frase", ...], text?: "..." }
// =====================================================
let rewriteInFlight = false;
let lastRewriteRequestKey = "";

function requestRewriteContext(lines, cb) {
  if (!aiAllowedHere()) return cb(null);
  if (rewriteInFlight) return cb(null);

  const merged = Array.isArray(lines) ? lines : [];
  const payloadStr = merged.join("\n").trim();
  if (!payloadStr) return cb(null);

  const reqKey = fastHash(payloadStr);
  if (reqKey === lastRewriteRequestKey) return cb(null);
  lastRewriteRequestKey = reqKey;

  rewriteInFlight = true;

  safeSendMessage(
    {
      action: "rewriteContext",
      payload: {
        lines: merged,
        // dica pro background: retornar linhas no formato "Origin: Speaker: Text"
        wantLines: true,
        fmt: "origin:speaker:text",
      },
    },
    (res) => {
      rewriteInFlight = false;

      if (chrome.runtime?.lastError) return cb(null);
      if (!res || typeof res !== "object") return cb(null);

      const out = {
        text: String(res.text || "").trim(),
        lines: Array.isArray(res.lines) ? res.lines.map((s) => String(s || "").trim()).filter(Boolean) : null,
      };

      // fallback: se veio só text, tenta extrair linhas
      if ((!out.lines || !out.lines.length) && out.text) {
        const parts = out.text
          .split("\n")
          .map((s) => String(s || "").trim())
          .filter(Boolean);
        const good = parts.filter((s) => (s.match(/:/g) || []).length >= 2);
        if (good.length) out.lines = good;
      }

      cb(out);
    }
  );
}

// aplica rewrite no final do transcript (replace do tail)
function applyRewriteToTail(rawTailLines, rewrittenLines) {
  const rawTail = (rawTailLines || []).map((s) => String(s || "").trim()).filter(Boolean);
  const newTail = (rewrittenLines || []).map((s) => String(s || "").trim()).filter(Boolean);
  if (!rawTail.length || !newTail.length) return false;

  // normaliza newTail: garante "🎤 "
  const newTailWithMic = newTail.map((s) => (s.startsWith("🎤") ? s : `🎤 ${s}`));

  // ---------- atualiza PANEL CACHE ----------
  const curPanelLines = String(panelTranscriptCache || "")
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);

  if (curPanelLines.length < rawTail.length) return false;

  const panelTail = curPanelLines.slice(-rawTail.length).join("\n");
  const rawTailJoin = rawTail.join("\n");
  if (panelTail !== rawTailJoin) return false;

  const nextPanelLines = curPanelLines.slice(0, -rawTail.length).concat(newTailWithMic);
  panelTranscriptCache = tail(nextPanelLines.join("\n") + "\n", PANEL_HISTORY_MAX_CHARS);
  renderTranscriptListFromCache();

  // ---------- atualiza TRANSCRIPT DATA ----------
  const curFullLines = String(transcriptData || "")
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);

  if (curFullLines.length >= rawTail.length) {
    const fullTail = curFullLines.slice(-rawTail.length).join("\n");
    if (fullTail === rawTailJoin) {
      const nextFull = curFullLines.slice(0, -rawTail.length).concat(newTailWithMic);
      transcriptData = nextFull.join("\n") + "\n";
      trimHistoryIfNeeded();
    }
  }

  // atualiza “última linha por origin+speaker” (pra colar "." certo depois)
  for (const ln of newTailWithMic) {
    const p = parseTranscriptLine(ln);
    if (!p.origin || !p.speaker) continue;
    lastSingleLineByKey.set(`${p.origin}::${p.speaker}`, ln);
  }

  // flags: marca as novas linhas como “arrumadas”
  for (const ln of newTailWithMic) markLineFixed(ln);

  // força persistência pra background ficar alinhado
  scheduleFlushSoon();
  return true;
}

// =====================================================
// ✅ Transcript list renderer
// =====================================================
function renderTranscriptListFromCache() {
  const list = document.getElementById("__mt_transcript_list");
  if (!list) return;

  withPanelTranscriptScrollPreserved(() => {
    list.innerHTML = "";

    const lines = String(panelTranscriptCache || "")
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);

    if (!lines.length) {
      const empty = document.createElement("div");
      empty.style.opacity = "0.7";
      empty.textContent = "Transcrição: (aguardando...)";
      list.appendChild(empty);
      return;
    }

    const displayLines = lines.slice(-TRANSCRIPT_DISPLAY_MAX_LINES).reverse();
    for (const line of displayLines) {
      const row = document.createElement("div");
      row.className = "mt-line";

      const fixed = isLineFixed(line);
      if (fixed) row.classList.add("fixed");

      const txt = document.createElement("div");
      txt.className = "mt-line-text";

      if (fixed) {
        const badge = document.createElement("span");
        badge.className = "mt-flag";
        badge.textContent = "✅";
        txt.appendChild(badge);

        const span = document.createElement("span");
        span.textContent = line;
        txt.appendChild(span);
      } else {
        txt.textContent = line;
      }

      const btn = document.createElement("button");
      btn.className = "mt-line-btn";
      btn.type = "button";
      btn.textContent = "Responder (2)";
      btn.addEventListener("click", (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        generateRepliesForLine(line);
      });

      row.appendChild(txt);
      row.appendChild(btn);
      list.appendChild(row);
    }
  });
}

// =====================================================
// ✅ State (Auto IA)
// =====================================================
let autoIaEnabled = AUTO_IA_ENABLED_DEFAULT;
let autoIaTimerId = null;
let lastTranscriptActivityAt = 0;
let lastAutoIaSourceHash = "";

// pausa temporária (manual vs auto)
let autoIaPauseUntil = 0;

function cancelAutoIaTimer() {
  if (autoIaTimerId) {
    clearTimeout(autoIaTimerId);
    autoIaTimerId = null;
  }
}
function pauseAutoIa(ms = 3000) {
  autoIaPauseUntil = Date.now() + Math.max(0, ms | 0);
  cancelAutoIaTimer();
}
function suppressAutoIaForPayload(payloadStr) {
  const s = String(payloadStr || "").trim();
  if (!s) return;
  lastAutoIaSourceHash = fastHash(s);
}

// =====================================================
// ✅ Auto-IA: pega tail do chat e manda após 1s
// =====================================================
function getTailLinesForAutoIa(maxLines = AUTO_IA_MAX_LINES) {
  const lines = String(panelTranscriptCache || "")
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean)
    .filter((l) => !isInternalInjectedLine(l));

  if (!lines.length) return [];
  return lines.slice(-Math.max(1, maxLines));
}

// ✅ NEW: Teams só arma Auto-IA quando a linha finaliza com "."
function markTranscriptActivity(lastLine = "") {
  lastTranscriptActivityAt = Date.now();
  if (!autoIaEnabled) return;

  // ✅ FIX: só TOP FRAME dispara IA (auto)
  if (!aiAllowedHere()) return;

  // se estiver em pausa (manual recente), não arma Auto-IA
  if (Date.now() < autoIaPauseUntil) return;

  // Teams: só arma quando tiver "."
  if (lastLine) {
    const p = parseTranscriptLine(lastLine);
    if (String(p.origin || "").trim().toLowerCase() === "teams") {
      if (!String(p.text || "").trim().endsWith(".")) return;
    }
  }

  // se já tem request em andamento, não arma auto agora
  releaseReplyLockIfExpired();
  if (repliesInFlight && Date.now() < repliesLockUntil) return;

  cancelAutoIaTimer();
  autoIaTimerId = setTimeout(() => {
    const idleFor = Date.now() - lastTranscriptActivityAt;
    if (idleFor < AUTO_IA_IDLE_MS) return;
    startAutoIaFromTail({ auto: true });
  }, AUTO_IA_IDLE_MS + 50);
}

function toggleAutoIa() {
  autoIaEnabled = !autoIaEnabled;
  try {
    localStorage.setItem("__mt_auto_ia", autoIaEnabled ? "1" : "0");
  } catch {}
  if (!autoIaEnabled) cancelAutoIaTimer();

  const btn = document.getElementById(UI_IDS.panelAutoIaBtn);
  if (btn) btn.textContent = autoIaEnabled ? "Auto IA: ON" : "Auto IA: OFF";
  setPanelStatus(autoIaEnabled ? "Auto IA ligado ✅" : "Auto IA desligado 📴");
}

function loadAutoIaSetting() {
  try {
    const v = localStorage.getItem("__mt_auto_ia");
    if (v === "0") autoIaEnabled = false;
    if (v === "1") autoIaEnabled = true;
  } catch {}
}

function startAutoIaFromTail(opts = {}) {
  // ✅ FIX: só TOP FRAME dispara IA (manual/auto)
  if (!aiAllowedHere()) return;

  // bloqueia só o disparo AUTOMÁTICO durante pausa
  if (opts.auto && Date.now() < autoIaPauseUntil) return;

  // se já tem request em andamento, não duplica
  releaseReplyLockIfExpired();
  if (repliesInFlight && Date.now() < repliesLockUntil) return;

  const rawLines = getTailLinesForAutoIa(AUTO_IA_MAX_LINES);
  if (!rawLines.length) return;

  const merged = mergePipocadas(rawLines);
  const sourceStr = merged.join("\n").trim();
  if (!sourceStr) return;

  const sourceHash = fastHash(sourceStr);

  // dedupe do próprio auto
  if (sourceHash === lastAutoIaSourceHash) return;
  lastAutoIaSourceHash = sourceHash;

  // se foi manual, já suprime o auto repetir esse mesmo payload depois
  if (!opts.auto) {
    suppressAutoIaForPayload(sourceStr);
  }

  // =====================================================
  // ✅ NEW: Se for Teams e finalizou com ".", roda rewrite (IA) pra juntar pipocos
  // - Só reescreve se existir pelo menos 1 linha do tail ainda NÃO “arrumada”
  // =====================================================
  const lastTeamsLine = [...rawLines].reverse().find((l) => parseTranscriptLine(l).origin.toLowerCase() === "teams");
  const canRewriteTeams = !!lastTeamsLine && isTeamsFinalLine(lastTeamsLine);

  if (canRewriteTeams) {
    // acha primeira linha não-arrumada do Teams dentro do tail
    const firstUnfixedIdx = rawLines.findIndex((l) => {
      const p = parseTranscriptLine(l);
      if (p.origin.toLowerCase() !== "teams") return false;
      return !isLineFixed(l);
    });

    // só vale a pena se tem algo novo pra arrumar
    if (firstUnfixedIdx >= 0) {
      // inclui um pouco de contexto antes (2 linhas)
      const sliceStart = Math.max(0, firstUnfixedIdx - 2);
      const rawSlice = rawLines.slice(sliceStart);
      const mergedSlice = mergePipocadas(rawSlice);

      setPanelStatus(opts.auto ? "Auto IA: consolidando (IA)..." : "Consolidando (IA)...");
      setLauncherState("busy");
      setAllSuggestionSlots("");

      requestRewriteContext(mergedSlice, (rw) => {
        if (!rw) {
          // fallback: segue sem rewrite
          setPanelStatus(opts.auto ? "Auto IA (streaming)..." : "Gerando (streaming)...");
          requestRepliesForText(sourceStr, opts.auto ? "auto_tail" : "manual_tail");
          return;
        }

        // se veio linhas “limpas”, tenta aplicar no transcript
        const linesOut = Array.isArray(rw.lines) && rw.lines.length ? rw.lines : null;

        if (linesOut) {
          const applied = applyRewriteToTail(rawSlice, linesOut);
          if (applied) {
            // flags: marca as linhas originais do slice também, só pra garantir não tentar de novo
            for (const l of rawSlice) markLineFixed(l);

            // input pro LLM (respostas): usa as linhas limpas
            const cleanedInput = linesOut.join("\n").trim() || sourceStr;

            // evita re-disparo automático com o mesmo texto “limpo”
            suppressAutoIaForPayload(cleanedInput);

            setPanelStatus(opts.auto ? "Auto IA (streaming)..." : "Gerando (streaming)...");
            requestRepliesForText(cleanedInput, opts.auto ? "auto_tail_rewrite" : "manual_tail_rewrite");
            return;
          }
        }

        // se não aplicou no transcript, ainda assim marca as do slice como “arrumadas” se veio texto
        if (rw.text) {
          for (const l of rawSlice) markLineFixed(l);

          suppressAutoIaForPayload(rw.text);

          setPanelStatus(opts.auto ? "Auto IA (streaming)..." : "Gerando (streaming)...");
          requestRepliesForText(rw.text, opts.auto ? "auto_tail_rewrite_text" : "manual_tail_rewrite_text");
          return;
        }

        // fallback final: segue com sourceStr
        setPanelStatus(opts.auto ? "Auto IA (streaming)..." : "Gerando (streaming)...");
        requestRepliesForText(sourceStr, opts.auto ? "auto_tail" : "manual_tail");
      });

      return;
    }
  }

  // default
  setPanelStatus(opts.auto ? "Auto IA (streaming)..." : "Gerando (streaming)...");
  setLauncherState("busy");
  setAllSuggestionSlots("");

  requestRepliesForText(sourceStr, opts.auto ? "auto_tail" : "manual_tail");
}

// =====================================================
// ✅ Request replies (2 rotas)
// =====================================================
function sendAskMeSuggestion(cleanText, extraPayload, cb) {
  const t = String(cleanText || "").trim();
  safeSendMessage(
    {
      action: "generateSuggestion",
      payload: { line: t, ...(extraPayload || {}) },
    },
    cb
  );
}

// ✅ helper: aceita ACK do background (não exige status:"ok")
function isGenerateRepliesAck(res) {
  if (!res || typeof res !== "object") return false;
  return (
    res.status === "ok" ||
    res.ok === true ||
    res.success === true ||
    res.accepted === true ||
    res.queued === true ||
    res.streaming === true ||
    res.mode === "stream" ||
    res.status === "stream"
  );
}

function requestRepliesForText(text, originLabel = "context") {
  const clean = String(text || "").trim();
  if (!clean) {
    setPanelStatus("Sem texto pra responder.");
    return;
  }

  // ✅ FIX: só TOP FRAME dispara IA
  if (!aiAllowedHere()) {
    setPanelStatus("IA: ignorado (iframe).");
    return;
  }

  // ✅ FIX: lock + dedupe global (manual + auto + clique duplo)
  const lock = tryAcquireReplyLock(clean);
  if (!lock.ok) {
    if (lock.reason === "dedup") setPanelStatus("Ignorado (duplicado).");
    else if (lock.reason === "in_flight") setPanelStatus("Já gerando...");
    return;
  }

  setLauncherState("busy");

  safeSendMessage(
    {
      action: "generateReplies",
      payload: {
        text: clean,
        routes: ["positivo", "negativo"],
        origin: originLabel,
      },
    },
    (res) => {
      const le = chrome.runtime?.lastError?.message;
      if (le) {
        console.warn("[MT] generateReplies lastError:", le);
        if (ENABLE_TWO_CALL_FALLBACK) {
          finishReplyLock();
          return fallbackTwoSuggestions(clean);
        }
        setPanelStatus("Erro: generateReplies falhou (fallback 2 chamadas OFF).");
        setLauncherState("error");
        finishReplyLock();
        return;
      }

      // debug legível (evita [object Object])
      if (res && typeof res === "object") {
        try {
          console.debug("[MT] generateReplies res:", JSON.stringify(res));
        } catch {
          console.debug("[MT] generateReplies res:", res);
        }
      }

      // ✅ pronto num-shot
      if (res?.suggestions && typeof res.suggestions === "object") {
        setSuggestionSlot("positivo", String(res.suggestions.positivo || ""));
        setSuggestionSlot("negativo", String(res.suggestions.negativo || ""));
        setPanelStatus("Respostas prontas ✅");
        setLauncherState("ok");
        finishReplyLock();
        return;
      }

      // ✅ ACK/streaming (qualquer shape aceito)
      if (!res || isGenerateRepliesAck(res)) {
        setPanelStatus("Respostas (streaming)...");
        setLauncherState("busy");

        // mantém lock um pouco mais (stream)
        bumpReplyLock(REPLY_LOCK_MS);

        // deadman: libera depois de um tempo se não vier "done"
        setTimeout(() => {
          releaseReplyLockIfExpired();
          if (!repliesInFlight) setLauncherState("ok");
        }, REPLY_LOCK_MS + 200);

        return;
      }

      // ❌ resposta realmente inesperada
      console.warn("[MT] generateReplies res inesperada:", res);

      if (ENABLE_TWO_CALL_FALLBACK) {
        finishReplyLock();
        return fallbackTwoSuggestions(clean);
      }

      setPanelStatus("Erro: resposta inesperada do background.");
      setLauncherState("error");
      finishReplyLock();
    }
  );

  // fallback: duas chamadas generateSuggestion (DESLIGADO por padrão)
  function fallbackTwoSuggestions(seed) {
    setPanelStatus("Fallback (2 chamadas)...");
    setLauncherState("busy");
    setAllSuggestionSlots("");

    sendAskMeSuggestion(seed, { route: "positivo", origin: originLabel }, (r1) => {
      if (chrome.runtime?.lastError) {
        setPanelStatus("Erro: " + chrome.runtime.lastError.message);
        setLauncherState("error");
        finishReplyLock();
        return;
      }
      if (r1?.status !== "ok") {
        setPanelStatus("Erro: " + (r1?.error || "unknown"));
        setLauncherState("error");
        finishReplyLock();
        return;
      }

      setSuggestionSlot("positivo", String(r1?.suggestion || "").trim());

      sendAskMeSuggestion(seed, { route: "negativo", origin: originLabel }, (r2) => {
        if (chrome.runtime?.lastError) {
          setPanelStatus("Erro: " + chrome.runtime.lastError.message);
          setLauncherState("error");
          finishReplyLock();
          return;
        }
        if (r2?.status !== "ok") {
          setPanelStatus("Erro: " + (r2?.error || "unknown"));
          setLauncherState("error");
          finishReplyLock();
          return;
        }

        setSuggestionSlot("negativo", String(r2?.suggestion || "").trim());
        setPanelStatus("Respostas prontas ✅");
        setLauncherState("ok");
        finishReplyLock();
      });
    });
  }
}

function generateRepliesForLine(line) {
  const clean = normalizeTranscriptLineForLLM(line);
  if (!clean) return;

  // ✅ FIX: só TOP FRAME dispara IA no clique
  if (!aiAllowedHere()) return;

  // manual -> pausa Auto-IA e evita repetição imediata
  pauseAutoIa(3000);
  suppressAutoIaForPayload(clean);

  setPanelStatus("Gerando (2 rotas)...");
  setLauncherState("busy");
  setAllSuggestionSlots("");

  requestRepliesForText(clean, "line");
}

// =====================================================
// Viewer open (tab / side panel)
// =====================================================
function openViewerTab() {
  safeSendMessage({ action: "openViewerTab" }, () => {
    if (chrome.runtime?.lastError) {
      console.warn("⚠️ Falha ao abrir viewer via background:", chrome.runtime.lastError.message);
      setLauncherState("error");
    }
  });
}

function openViewerSidePanel() {
  safeSendMessage({ action: "openViewerSidePanel" }, (res) => {
    if (chrome.runtime?.lastError) {
      console.warn("⚠️ Falha ao abrir Side Panel:", chrome.runtime.lastError.message);
      openViewerTab();
      return;
    }
    if (res?.via === "tab") return;
  });
}

// =====================================================
// Panel open/close + refresh
// =====================================================
function ensurePanelUI() {
  if (document.getElementById(UI_IDS.panel)) return;

  loadAutoIaSetting();
  loadFixedFlags();

  const panel = document.createElement("div");
  panel.id = UI_IDS.panel;
  panel.innerHTML = `
    <div id="${UI_IDS.panelHeader}">
      <div class="title">MT • Viewer</div>
      <div class="actions">
        <button id="${UI_IDS.panelAutoIaBtn}" title="Auto IA (1s)">${autoIaEnabled ? "Auto IA: ON" : "Auto IA: OFF"}</button>
        <button id="${UI_IDS.panelOpenTab}" title="Abrir viewer.html em nova aba">↗</button>
        <button id="${UI_IDS.panelClose}" title="Fechar">✕</button>
      </div>
    </div>
    <div id="${UI_IDS.panelStatus}">Pronto.</div>

    <div id="${UI_IDS.panelTranscript}">
      <div class="mt-transcript-title">Transcrição (histórico):</div>
      <div class="mt-transcript-list" id="__mt_transcript_list"></div>
    </div>

    <div id="${UI_IDS.panelSuggestionsWrap}">
      <div class="mt-sug-head">
        <div class="mt-sug-title">Respostas (2 caminhos)</div>
        <button id="__mt_btn_manual_tail" class="mt-mini-btn ok" type="button" title="Gerar com base nas últimas linhas do chat">Gerar agora</button>
      </div>

      <div class="mt-sug-grid">
        <div class="mt-sug-card">
          <div class="mt-sug-card-head">
            <div class="mt-sug-card-title">Positivo</div>
            <button id="${UI_IDS.panelSugCopyPos}" class="mt-mini-btn" type="button">Copiar</button>
          </div>
          <div id="${UI_IDS.panelSuggestionPos}" class="mt-sug-box">Positivo: (vazio)</div>
        </div>

        <div class="mt-sug-card">
          <div class="mt-sug-card-head">
            <div class="mt-sug-card-title">Negativo</div>
            <button id="${UI_IDS.panelSugCopyNeg}" class="mt-mini-btn" type="button">Copiar</button>
          </div>
          <div id="${UI_IDS.panelSuggestionNeg}" class="mt-sug-box">Negativo: (vazio)</div>
        </div>
      </div>
    </div>
  `;

  document.documentElement.appendChild(panel);

  // header handlers
  panel.querySelector(`#${UI_IDS.panelClose}`)?.addEventListener("click", closePanel);
  panel.querySelector(`#${UI_IDS.panelOpenTab}`)?.addEventListener("click", openViewerTab);
  panel.querySelector(`#${UI_IDS.panelAutoIaBtn}`)?.addEventListener("click", toggleAutoIa);

  // manual tail
  panel.querySelector("#__mt_btn_manual_tail")?.addEventListener("click", (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    pauseAutoIa(3000);
    startAutoIaFromTail({ auto: false });
  });

  // copy buttons
  panel.querySelector(`#${UI_IDS.panelSugCopyPos}`)?.addEventListener("click", () => {
    copyToClipboard(panelSuggestionCache.positivo);
  });
  panel.querySelector(`#${UI_IDS.panelSugCopyNeg}`)?.addEventListener("click", () => {
    copyToClipboard(panelSuggestionCache.negativo);
  });

  // render inicial
  setPanelTranscriptText(transcriptData ? tail(transcriptData, PANEL_HISTORY_MAX_CHARS) : "");
  setSuggestionSlot("positivo", panelSuggestionCache.positivo);
  setSuggestionSlot("negativo", panelSuggestionCache.negativo);
}

function openPanel() {
  ensurePanelUI();
  document.documentElement.classList.add("__mt_panel_open");

  if (transcriptData) setPanelTranscriptText(tail(transcriptData, PANEL_HISTORY_MAX_CHARS));
  setSuggestionSlot("positivo", panelSuggestionCache.positivo);
  setSuggestionSlot("negativo", panelSuggestionCache.negativo);

  refreshPanel();
}

function closePanel() {
  document.documentElement.classList.remove("__mt_panel_open");
}

function togglePanel() {
  if (document.documentElement.classList.contains("__mt_panel_open")) closePanel();
  else openPanel();
}

function refreshPanel() {
  safeSendMessage({ action: "getTranscriberState" }, (res) => {
    if (chrome.runtime?.lastError) {
      setPanelStatus("Erro ao buscar estado: " + chrome.runtime.lastError.message);
      return;
    }

    const payload = res?.payload || null;
    const bgHistory = String(payload?.fullHistory || "").trim();
    const localHistory = String(transcriptData || "").trim();
    const bestHistory = bgHistory.length >= localHistory.length ? bgHistory : localHistory;

    setPanelTranscriptText(bestHistory ? tail(bestHistory, PANEL_HISTORY_MAX_CHARS) : "");
  });
}

// =====================================================
// Floating launcher + dim (não bloqueia click)
// =====================================================
let dimEnabled = false;

function applyDim(enabled) {
  const overlay = document.getElementById(UI_IDS.overlay);
  if (overlay) overlay.classList.toggle("active", !!enabled);
  dimEnabled = !!enabled;
  try {
    localStorage.setItem("__mt_dim_enabled", dimEnabled ? "1" : "0");
  } catch {}
}

function toggleDim() {
  applyDim(!dimEnabled);
}

function setLauncherState(state) {
  const bubble = document.getElementById(UI_IDS.bubble);
  if (!bubble) return;

  bubble.classList.remove("busy", "error");
  if (state === "busy") bubble.classList.add("busy");
  if (state === "error") bubble.classList.add("error");
}

function injectLauncherUI() {
  if (!isSupportedPage()) return;
  if (!IS_TOP_FRAME) return;
  if (document.getElementById(UI_IDS.bubble)) return;

  const style = document.createElement("style");
  style.id = UI_IDS.style;
  style.textContent = `
#${UI_IDS.overlay}{
  position: fixed; inset: 0;
  background: rgba(0,0,0,0.35);
  z-index: 2147483646;
  display: none;
  pointer-events: none;
}
#${UI_IDS.overlay}.active{ display:block; }

#${UI_IDS.bubble}{
  position: fixed;
  right: 16px;
  bottom: 16px;
  width: 48px;
  height: 48px;
  border-radius: 50%;
  z-index: 2147483647;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(20,20,20,0.92);
  color: #fff;
  font: 700 12px/1 Arial, sans-serif;
  letter-spacing: .5px;
  box-shadow: 0 10px 24px rgba(0,0,0,.25);
  cursor: pointer;
  user-select: none;
}
#${UI_IDS.bubble} .dot{
  position: absolute;
  right: 6px;
  bottom: 6px;
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: #2ecc71;
  box-shadow: 0 0 0 4px rgba(46,204,113,0.15);
}
#${UI_IDS.bubble}.busy .dot{
  background: #f1c40f;
  box-shadow: 0 0 0 4px rgba(241,196,15,0.18);
  animation: __mt_pulse 900ms ease-in-out infinite;
}
#${UI_IDS.bubble}.error .dot{
  background: #e74c3c;
  box-shadow: 0 0 0 4px rgba(231,76,60,0.18);
  animation: none;
}
#${UI_IDS.bubble}:hover{ transform: translateY(-1px); }

@keyframes __mt_pulse{
  0%{ transform: scale(1); }
  50%{ transform: scale(1.25); }
  100%{ transform: scale(1); }
}

:root{ --mt_panel_w: min(25vw, 520px); }

#${UI_IDS.panel}{
  position: fixed;
  top: 0;
  right: 0;
  width: var(--mt_panel_w);
  min-width: 360px;
  height: 100vh;
  z-index: 2147483645;
  background: rgba(16,16,18,0.97);
  color: #fff;
  border-left: 1px solid rgba(255,255,255,0.08);
  box-shadow: -18px 0 40px rgba(0,0,0,0.35);
  transform: translateX(100%);
  transition: transform 160ms ease-out;
  pointer-events: auto;
  display: flex;
  flex-direction: column;
  font: 12px/1.35 Arial, sans-serif;
}
:root.__mt_panel_open #${UI_IDS.panel}{ transform: translateX(0); }
:root.__mt_panel_open body{ margin-right: var(--mt_panel_w); overflow-x: hidden; }

#${UI_IDS.panelHeader}{
  display:flex;
  align-items:center;
  justify-content:space-between;
  gap: 10px;
  padding: 10px 10px;
  border-bottom: 1px solid rgba(255,255,255,0.08);
}
#${UI_IDS.panelHeader} .title{
  font-weight: 900;
  letter-spacing: .4px;
}
#${UI_IDS.panelHeader} .actions{
  display:flex;
  gap: 8px;
  align-items: center;
  flex-wrap: wrap;
}
#${UI_IDS.panelHeader} button{
  background: rgba(255,255,255,0.10);
  color: #fff;
  border: 1px solid rgba(255,255,255,0.14);
  border-radius: 10px;
  padding: 6px 10px;
  cursor: pointer;
  font: 800 11px/1 Arial, sans-serif;
  white-space: nowrap;
}
#${UI_IDS.panelHeader} button:hover{ background: rgba(255,255,255,0.16); }

#${UI_IDS.panelStatus}{
  padding: 8px 10px;
  color: rgba(255,255,255,0.75);
  border-bottom: 1px solid rgba(255,255,255,0.06);
  font-size: 11px;
}

#${UI_IDS.panelTranscript}{
  padding: 10px;
  overflow: auto;
  flex: 1;
  border-bottom: 1px solid rgba(255,255,255,0.06);
}
.mt-transcript-title{
  font-weight: 900;
  margin-bottom: 8px;
  color: rgba(255,255,255,0.85);
}
.mt-transcript-list{
  display:flex;
  flex-direction:column;
  gap: 6px;
}
.mt-line{
  display:flex;
  align-items:flex-start;
  justify-content:space-between;
  gap: 10px;
  padding: 8px 8px;
  border: 1px solid rgba(255,255,255,0.08);
  border-radius: 10px;
  background: rgba(255,255,255,0.04);
}
.mt-line:hover{ background: rgba(255,255,255,0.06); }
.mt-line.fixed{
  border-color: rgba(46,204,113,0.28);
}
.mt-line-text{
  white-space: pre-wrap;
  word-break: break-word;
  flex: 1;
  opacity: .95;
}
.mt-flag{
  display:inline-block;
  margin-right: 6px;
  font-weight: 900;
}
.mt-line-btn{
  flex: none;
  background: rgba(46,204,113,0.18);
  border: 1px solid rgba(46,204,113,0.35);
  border-radius: 10px;
  padding: 6px 10px;
  color: #fff;
  cursor: pointer;
  font-weight: 900;
  font-size: 11px;
  line-height: 1;
  white-space: nowrap;
}
.mt-line-btn:hover{ background: rgba(46,204,113,0.24); }

#${UI_IDS.panelSuggestionsWrap}{
  padding: 10px;
  overflow: auto;
  flex: 1;
}
.mt-mini-btn{
  background: rgba(255,255,255,0.10);
  color: #fff;
  border: 1px solid rgba(255,255,255,0.14);
  border-radius: 10px;
  padding: 6px 10px;
  cursor: pointer;
  font: 900 11px/1 Arial, sans-serif;
  white-space: nowrap;
}
.mt-mini-btn:hover{ background: rgba(255,255,255,0.16); }
.mt-mini-btn.ok{
  background: rgba(46,204,113,0.18);
  border: 1px solid rgba(46,204,113,0.35);
}
.mt-mini-btn.ok:hover{ background: rgba(46,204,113,0.24); }

.mt-sug-head{
  display:flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 8px;
  gap: 10px;
}
.mt-sug-title{
  font-weight: 900;
  color: rgba(255,255,255,0.92);
}
.mt-sug-grid{
  display:grid;
  grid-template-columns: 1fr;
  gap: 10px;
}
.mt-sug-card{
  border: 1px solid rgba(255,255,255,0.08);
  border-radius: 12px;
  background: rgba(255,255,255,0.04);
  padding: 10px;
}
.mt-sug-card-head{
  display:flex;
  align-items:center;
  justify-content: space-between;
  gap: 10px;
  margin-bottom: 8px;
}
.mt-sug-card-title{
  font-weight: 900;
  opacity: .95;
}
.mt-sug-box{
  background: rgba(255,255,255,0.03);
  border: 1px solid rgba(255,255,255,0.08);
  border-radius: 12px;
  padding: 10px;
  max-height: 220px;
  overflow:auto;
  white-space: pre-wrap;
  word-break: break-word;
}
`;
  document.documentElement.appendChild(style);

  const overlay = document.createElement("div");
  overlay.id = UI_IDS.overlay;
  document.documentElement.appendChild(overlay);

  const bubble = document.createElement("div");
  bubble.id = UI_IDS.bubble;
  bubble.title =
    "Clique: abrir/fechar painel | Alt+Clique: viewer em nova aba | Ctrl+Clique: Side Panel | Shift+Clique: Dim on/off | Botão direito: Dim on/off";
  bubble.innerHTML = `MT<div class="dot"></div>`;
  document.documentElement.appendChild(bubble);

  try {
    dimEnabled = localStorage.getItem("__mt_dim_enabled") === "1";
  } catch {}
  applyDim(dimEnabled);

  bubble.addEventListener("click", (ev) => {
    if (ev.shiftKey) return toggleDim();
    if (ev.altKey) return openViewerTab();
    if (ev.ctrlKey) return openViewerSidePanel();
    togglePanel();
  });

  bubble.addEventListener("contextmenu", (ev) => {
    ev.preventDefault();
    toggleDim();
  });

  console.log("✅ Launcher UI injetada (bubble + dim + painel in-page).");
}

// injeta UI o quanto antes (somente top frame)
if (isSupportedPage() && IS_TOP_FRAME) {
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", injectLauncherUI, { once: true });
  } else {
    injectLauncherUI();
  }
}

// =====================================================
// ✅ Ping + streaming do background
// =====================================================
chrome.runtime.onMessage.addListener((req, sender, sendResponse) => {
  if (req?.action === "pingTranscriber") {
    sendResponse({ status: "ok", ts: new Date().toISOString() });
    return;
  }

  // sugestões streaming (slot: positivo|negativo)
  if (req?.action === "suggestionChunk") {
    // ✅ FIX: só top frame processa chunks (evita duplicação/concorrência em iframe)
    if (!aiAllowedHere()) return;

    // bump lock enquanto chega stream
    bumpReplyLock(STREAM_LOCK_BUMP_MS);

    const slot = req?.slot === "negativo" ? "negativo" : "positivo";
    if (req.reset) setSuggestionSlot(slot, "");

    const txt = String(req.text || "");
    if (txt) setSuggestionSlot(slot, txt);

    if (isPanelOpen()) setPanelStatus("Respostas (streaming)...");

    // ✅ NOVO: finaliza quando background sinalizar done/final
    if (req.done === true || req.final === true || req.isFinal === true) {
      finishReplyLock();
      setPanelStatus("Respostas prontas ✅");
      setLauncherState("ok");
    }

    return;
  }

  // transcrição incremental
  if (req?.action === "transcriptTick") {
    const line = String(req?.payload?.line || req?.line || "");
    if (line) {
      appendPanelTranscriptLine(line);
      if (!isInternalInjectedLine(line)) markTranscriptActivity(line);
    }
    return;
  }

  // Sync: payload completo (flush)
  if (req?.action === "transcriptDataUpdated") {
    const payload = req.payload || null;
    const history = String(payload?.fullHistory || "");
    if (history) setPanelTranscriptText(tail(history, PANEL_HISTORY_MAX_CHARS));
    return;
  }
});

// =====================================================
// Persistência: flush (full history)
// =====================================================
function scheduleFlushSoon() {
  if (flushDebounceId) clearTimeout(flushDebounceId);
  flushDebounceId = setTimeout(() => flushNow("debounce"), FLUSH_DEBOUNCE_MS);
}

function buildLatestLine() {
  return Array.from(latestBySpeaker.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([speaker, text]) => `🎤 ${speaker}: ${text}`)
    .join("\n");
}

function flushNow(reason) {
  if (extensionInvalidated) return;
  if (!transcriptData) return;

  const currentHash = fastHash(transcriptData);
  if (currentHash === lastSavedHash) return;

  const latestLine = buildLatestLine();

  try {
    setLauncherState("busy");
    safeSendMessage(
      {
        action: "transcriptData",
        payload: { fullHistory: transcriptData, latestLine, filename: "" },
      },
      () => {
        if (chrome.runtime?.lastError) {
          console.warn("⚠️ lastError:", chrome.runtime.lastError.message);
          setLauncherState("error");
        } else {
          setLauncherState("ok");
        }
      }
    );

    lastSavedHash = currentHash;
    latestBySpeaker.clear();
  } catch (err) {
    console.error("❌ flushNow erro:", err);
    setLauncherState("error");
  }
}

// =====================================================
// ✅ Teams helpers (speaker + text) — RTT + Captions
// =====================================================
function cleanCaptionText(t) {
  const s = String(t || "").replace(/\u00A0/g, " ").trim();
  if (!s) return "";
  if (/^\s*RTT\b/i.test(s)) return "";
  if (/Pol[ií]tica de Privacidade/i.test(s)) return "";
  if (/Digite uma mensagem/i.test(s)) return "";
  if (/Legendas ao Vivo/i.test(s)) return "";
  if (/Configuraç(ões|oes) da Legenda/i.test(s)) return "";
  return s;
}

function isJunkCaptionText(s) {
  s = String(s || "");
  if (!s) return true;
  if (/^\s*RTT\b/i.test(s)) return true;
  if (/Pol[ií]tica de Privacidade/i.test(s)) return true;
  if (/Digite uma mensagem/i.test(s)) return true;
  if (/Legendas ao Vivo/i.test(s)) return true;
  if (/Configuraç(ões|oes) da Legenda/i.test(s)) return true;
  return false;
}

// evita capturar "LP" do avatar como se fosse texto
function looksLikeInitials(t) {
  return /^[A-Z]{1,3}$/u.test(String(t || "").trim());
}

function bestLeafText(root) {
  if (!root) return "";
  let best = "";
  const nodes = root.querySelectorAll("span,div");
  for (const el of nodes) {
    if (el.children && el.children.length) continue;
    const raw = el.innerText;
    const t = cleanCaptionText(raw);
    if (!t) continue;
    if (t.length < 1 || t.length > 260) continue;
    if (looksLikeInitials(t)) continue;
    if (t.length > best.length) best = t;
  }
  return best;
}

function collectLeafTexts(root) {
  const out = [];
  if (!root) return out;

  const tw = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT, {
    acceptNode(node) {
      const el = node;
      if (!el) return NodeFilter.FILTER_SKIP;
      if (!(el instanceof Element)) return NodeFilter.FILTER_SKIP;
      if (!/^(SPAN|DIV)$/i.test(el.tagName)) return NodeFilter.FILTER_SKIP;
      if (el.children && el.children.length) return NodeFilter.FILTER_SKIP;

      const t = cleanCaptionText(el.innerText);
      if (!t) return NodeFilter.FILTER_SKIP;
      if (t.length > 260) return NodeFilter.FILTER_SKIP;
      if (looksLikeInitials(t)) return NodeFilter.FILTER_SKIP;

      return NodeFilter.FILTER_ACCEPT;
    },
  });

  let n = tw.nextNode();
  while (n) {
    const t = cleanCaptionText(n.innerText);
    if (t) out.push(t);
    n = tw.nextNode();
  }

  return out.filter(Boolean);
}

function extractMessageFromRoot(root, speaker) {
  if (!root) return "";

  const speakerClean = cleanCaptionText(speaker);
  const speakerNorm = normName(speakerClean);

  const texts = collectLeafTexts(root)
    .filter((t) => !isJunkCaptionText(t))
    .filter((t) => !looksLikeInitials(t))
    .filter((t) => {
      if (speakerNorm && normName(t) === speakerNorm) return false;
      return true;
    });

  if (!texts.length) return "";

  const last = texts[texts.length - 1];
  if (last && !isJunkCaptionText(last)) return last;

  let best = "";
  for (const t of texts) if (t.length > best.length) best = t;
  return best;
}

// tenta "Nome: texto"
function splitSpeakerInline(text) {
  const s = cleanCaptionText(text);
  if (!s) return null;

  const m = s.match(/^(.{2,40}?)[：:]\s*(.{1,})$/u);
  if (m) {
    const speaker = m[1].trim();
    const msg = m[2].trim();
    if (speaker && msg) return { speaker, text: msg };
  }

  return { speaker: "", text: s };
}

// =====================================================
// Append (linha nova)
// =====================================================
function appendNewTranscript(speaker, fullText, origin) {
  speaker = (speaker || "Desconhecido").trim();

  // CAPTURE_SELF_LINES = true pra testar speaker "você"
  if (!CAPTURE_SELF_LINES && isMe(speaker)) return;

  const cleanText = (fullText || "").trim();
  if (!cleanText) return;

  const key = `${origin}::${speaker}::${cleanText}`;
  if (seenKeys.has(key)) return;
  seenKeys.add(key);
  if (seenKeys.size > 8000) seenKeys.clear();

  const prevLine = lastLineBySpeaker.get(speaker) || "";
  let newContent = cleanText;

  if (prevLine && cleanText.startsWith(prevLine)) {
    newContent = cleanText.slice(prevLine.length).trim();
  }
  if (!newContent) return;

  // =====================================================
  // ✅ NEW: Teams "." final -> cola no final da última linha (não cria nova)
  // =====================================================
  if (String(origin || "").trim().toLowerCase() === "teams" && isDotOnlyDelta(newContent)) {
    const sk = `${origin}::${speaker}`;
    const oldSingle = lastSingleLineByKey.get(sk);
    if (!oldSingle) return;

    // evita duplicar ponto
    if (oldSingle.trim().endsWith(".")) return;

    const updatedSingle = oldSingle + ".";
    replaceLastLineInCaches(oldSingle, updatedSingle);
    lastSingleLineByKey.set(sk, updatedSingle);

    // tick pro background com linha atualizada (sem duplicar no painel)
    safeSendMessage({ action: "transcriptTick", payload: { line: updatedSingle, timestamp: nowIso() } });

    // Teams: agora finalizou -> arma Auto-IA
    markTranscriptActivity(updatedSingle);
    scheduleFlushSoon();
    return;
  }

  // ✅ DEDUPE por (origin + texto), preferindo speaker conhecido
  const textKey = `${origin}||${normTextKey(newContent)}`;
  const now = Date.now();
  const prev = recentText.get(textKey);

  if (prev && now - prev.ts < TEXT_DEDUP_MS) {
    const prevUnknown = isUnknownSpeaker(prev.speaker);
    const curUnknown = isUnknownSpeaker(speaker);

    // mesmo speaker (normalizado) -> drop
    if (normName(prev.speaker) === normName(speaker)) {
      prev.ts = now;
      recentText.set(textKey, prev);
      return;
    }

    // já temos speaker bom e chegou "Desconhecido" -> drop o desconhecido
    if (!prevUnknown && curUnknown) {
      prev.ts = now;
      recentText.set(textKey, prev);
      return;
    }

    // veio "Desconhecido" antes e agora veio speaker bom -> substitui a última linha
    if (prevUnknown && !curUnknown) {
      const singleLineNew = `🎤 ${origin}: ${speaker}: ${newContent}`;

      replaceLastLineInCaches(prev.line, singleLineNew);
      trimHistoryIfNeeded();

      // atualiza lastSingleLineByKey (pra "." colar certo depois)
      lastSingleLineByKey.set(`${origin}::${speaker}`, singleLineNew);

      // melhora flush/latestLine evitando "Desconhecido"
      try {
        latestBySpeaker.delete(prev.speaker);
      } catch {}

      lastLineBySpeaker.set(speaker, cleanText);
      const previous = latestBySpeaker.get(speaker) || "";
      latestBySpeaker.set(speaker, previous ? `${previous} ${newContent}` : newContent);

      recentText.set(textKey, { ts: now, speaker, line: singleLineNew });

      // NÃO manda transcriptTick aqui (senão duplica no background)
      markTranscriptActivity(singleLineNew);
      scheduleFlushSoon();
      return;
    }

    // dois speakers diferentes e ambos conhecidos -> deixa passar (pode ser "oi" de 2 pessoas)
  }

  const singleLine = `🎤 ${origin}: ${speaker}: ${newContent}`;
  transcriptData += singleLine + "\n";
  trimHistoryIfNeeded();

  // guarda última linha (pra colar "." certo)
  lastSingleLineByKey.set(`${origin}::${speaker}`, singleLine);

  // realtime UI
  appendPanelTranscriptLine(singleLine);

  // marca no dedupe por texto
  recentText.set(textKey, { ts: Date.now(), speaker, line: singleLine });
  if (recentText.size > 4000) {
    // limpeza simples (evita crescer infinito)
    const cutoff = Date.now() - TEXT_DEDUP_MS * 3;
    for (const [k, v] of recentText.entries()) {
      if (!v || v.ts < cutoff) recentText.delete(k);
      if (recentText.size <= 2500) break;
    }
    if (recentText.size > 6000) recentText.clear();
  }

  lastLineBySpeaker.set(speaker, cleanText);

  const previous = latestBySpeaker.get(speaker) || "";
  latestBySpeaker.set(speaker, previous ? `${previous} ${newContent}` : newContent);

  // tick pro background
  safeSendMessage({ action: "transcriptTick", payload: { line: singleLine, timestamp: nowIso() } });

  // agenda Auto-IA
  markTranscriptActivity(singleLine);
  scheduleFlushSoon();
}

// =====================================================
// Capture sources
// =====================================================
const captureMeet = () => {
  document.querySelectorAll('div[jsname="tgaKEf"]').forEach((line) => {
    const text = line.innerText?.trim();
    if (!text) return;
    const speaker = line.closest(".nMcdL")?.querySelector("span.NWpY1d")?.innerText?.trim() || "Desconhecido";
    appendNewTranscript(speaker, text, "Meet");
  });
};

// Teams captions old (fallback raro)
const captureTeamsOld = () => {
  document.querySelectorAll('[data-tid="closed-caption-text"]').forEach((caption) => {
    const text = cleanCaptionText(caption.innerText);
    if (!text) return;

    const speaker =
      cleanCaptionText(caption.closest("[data-focuszone-id]")?.querySelector(".ui-chat__message__author")?.innerText) ||
      "Desconhecido";

    appendNewTranscript(speaker, text, "Teams");
  });
};

// ✅ Teams RTT
const captureTeamsRTT = () => {
  const rttHint =
    document.querySelector('[data-tid*="real-time-text"]') ||
    document.querySelector('[data-tid="real-time-text-intro-card"]') ||
    document.querySelector('input[placeholder*="tempo real"], textarea[placeholder*="tempo real"]') ||
    document.querySelector('[role="textbox"][aria-label*="tempo real"], [role="textbox"][aria-label*="real time"]');

  const scope = rttHint?.closest('[data-tid*="real-time-text"]') || rttHint?.parentElement || document;
  const authorEls = scope.querySelectorAll('span[data-tid="author"]');
  if (!authorEls.length) return;

  tdbg("RTT authors:", authorEls.length);

  for (const authorEl of authorEls) {
    const speaker = cleanCaptionText(authorEl.innerText) || "Desconhecido";

    let root =
      authorEl.closest(".fui-ChatMessageCompact") ||
      authorEl.closest('[role="listitem"]') ||
      authorEl.closest("li") ||
      authorEl.closest("div");

    if (!root) continue;

    if (root.querySelector?.('[data-tid="real-time-text-intro-card"]')) continue;

    let msg = "";
    let cur = root;
    for (let i = 0; i < 7 && cur && cur !== scope && !msg; i++) {
      msg = extractMessageFromRoot(cur, speaker);
      cur = cur.parentElement;
    }

    msg = cleanCaptionText(msg);
    if (!msg) continue;

    appendNewTranscript(speaker, msg, "Teams");
  }
};

// ✅ Teams Live Captions v2
const captureTeamsCaptionsV2 = () => {
  const wrapper =
    document.querySelector('[data-tid="closed-caption-renderer-wrapper"]') ||
    document.querySelector('[data-tid="closed-caption-v2-window-wrapper"]');

  if (!wrapper) return;

  const list = wrapper.querySelector('[data-tid="closed-caption-v2-virtual-list-content"]') || wrapper;

  const authorEls = list.querySelectorAll('span[data-tid="author"]');
  if (authorEls && authorEls.length) {
    for (const authorEl of authorEls) {
      const speaker = cleanCaptionText(authorEl.innerText) || "Desconhecido";

      let root =
        authorEl.closest(".fui-ChatMessageCompact") ||
        authorEl.closest('[role="listitem"]') ||
        authorEl.closest("div") ||
        authorEl.parentElement;

      if (!root) continue;
      if (root.querySelector?.('[data-tid="real-time-text-intro-card"]')) continue;

      let msg = "";
      let cur = root;
      for (let i = 0; i < 7 && cur && cur !== list && !msg; i++) {
        msg = extractMessageFromRoot(cur, speaker);
        cur = cur.parentElement;
      }

      if (!msg) {
        const rawBest = bestLeafText(root);
        const inline = splitSpeakerInline(rawBest);
        msg = String(inline?.text || "").trim();
      }

      msg = cleanCaptionText(msg);
      if (!msg) continue;

      appendNewTranscript(speaker, msg, "Teams");
    }
    return;
  }

  // fallback geral
  const items = list.querySelectorAll(
    '[role="listitem"], [data-tid*="closed-caption"], .ui-box, .fui-ChatMessageCompact'
  );
  for (const item of items) {
    if (item.querySelector?.('[data-tid="real-time-text-intro-card"]')) continue;

    const rawBest = bestLeafText(item);
    if (!rawBest) continue;

    const inline = splitSpeakerInline(rawBest);
    if (!inline) continue;

    const msg = cleanCaptionText(inline.text);
    if (!msg) continue;

    const speaker =
      cleanCaptionText(item.querySelector?.('span[data-tid="author"]')?.innerText) ||
      cleanCaptionText(inline.speaker) ||
      "Desconhecido";

    appendNewTranscript(speaker, msg, "Teams");
  }
};

const captureTeams = () => {
  captureTeamsRTT();
  captureTeamsCaptionsV2();
  captureTeamsOld();
};

const captureSlack = () => {
  document.querySelectorAll(".p-huddle_event_log__base_event").forEach((event) => {
    const speaker = event.querySelector(".p-huddle_event_log__member_name")?.innerText?.trim() || "Desconhecido";
    const text = event.querySelector(".p-huddle_event_log__transcription")?.innerText?.trim();
    if (text) appendNewTranscript(speaker, text, "Slack");
  });
};

const captureTranscript = () => {
  const url = window.location.href;
  if (url.includes("meet.google.com")) return captureMeet();
  if (url.includes("teams.microsoft.com") || url.includes("teams.live.com")) return captureTeams();
  if (url.includes("slack.com")) return captureSlack();
};

// =====================================================
// Start loops
// =====================================================
// Start loops (✅ só TOP FRAME)
if (isSupportedPage() && IS_TOP_FRAME) {
  loadFixedFlags();

  startTimeoutId = setTimeout(() => {
    captureIntervalId = setInterval(captureTranscript, CAPTURE_INTERVAL_MS);
  }, CAPTURE_START_DELAY_MS);

  flushIntervalId = setInterval(() => flushNow("interval"), FLUSH_INTERVAL_MS);
}
