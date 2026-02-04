/* transcriber.content.js — MT Transcriber (with rewrite + fixed block)
   - Captura legendas (Meet / Teams / Slack)
   - Mostra histórico + sugestões em painel lateral in-page
   - ✅ Auto-IA: depois de 1s sem novas linhas, manda o “tail” do chat pra IA
   - ✅ Respostas: 2 caminhos -> POSITIVO e NEGATIVO
   - ✅ FIX: anti-duplicação de requests (manual + auto + double-click + frames)
   - ✅ FIX: ACK/streaming compatível (não exige res.status === "ok")
   - ✅ NEW: Teams RTT não gera “pipocos” (buffer + commit por idle/pontuação)
   - ✅ NEW: “Responder (2)” em Teams roda rewrite antes (gera bloco corrigido)
   - ✅ NEW: Bloco corrigido (IA) visível no painel + botão copiar (só Autor: mensagem)
   - ✅ NEW: Teams "." final NÃO vira linha nova (cola no final da última)
   - ✅ NEW: Flags ✅ nas linhas arrumadas (pra não corrigir toda hora)
   - ✅ FIX: rewrite NÃO reenvia linhas já corrigidas (chunk unfixed)
   - ✅ FIX: painel SEMPRE mostra só "Autor: mensagem" (não mostra origin)
   - ✅ FIX: merge do “pipoco” aplica no histórico ANTES do rewrite (segment match)
   - ✅ FIX: dedupe do painel por match exato (não por substring)
   - ✅ FIX: “OK verdinho” não fica preso (watchdog de lock)
   - ✅ NEW: RETRY/LOOP — enquanto existir bloco Teams NÃO corrigido no tail, continua tentando corrigir
   - ✅ FIX NOVO: Teams eco/acúmulo de mensagem (delta-guard + collapse repeats)
*/

"use strict";
console.log("✅ Transcriber content script carregado!");

// =====================================================
// ✅ Rewrite retries (quando o background “some”)
// =====================================================
const REWRITE_RETRY_MAX = 2;
const REWRITE_RETRY_BASE_DELAY_MS = 240;
const REWRITE_RETRY_BACKOFF = 1.8;
const REWRITE_RETRY_JITTER_MS = 120;

function parseRewriteResponse(res) {
  if (!res || typeof res !== "object") return null;
  const text = String(res.text || "").trim();
  const lines = Array.isArray(res.lines)
    ? res.lines.map((s) => String(s || "").trim()).filter(Boolean)
    : null;

  let outLines = lines;
  if ((!outLines || !outLines.length) && text) {
    const parts = text.split("\n").map((s) => s.trim()).filter(Boolean);
    const good = parts.filter((s) => (s.match(/:/g) || []).length >= 2);
    if (good.length) outLines = good;
  }
  if ((outLines && outLines.length) || text) return { text, lines: outLines };
  return null;
}

function requestRewriteContextWithRetries(lines, cb) {
  if (!aiAllowedHere()) return cb(null);
  if (rewriteInFlight) return cb(null);

  const merged = Array.isArray(lines) ? lines : [];
  const payloadStr = merged.join("\n").trim();
  if (!payloadStr) return cb(null);

  const baseKey = fastHash(payloadStr);
  if (baseKey === lastRewriteRequestKey) return cb(null);
  lastRewriteRequestKey = baseKey;

  rewriteInFlight = true;

  const maxAttempts = 1 + Math.max(0, REWRITE_RETRY_MAX | 0);
  const sendAttempt = (attempt) => {
    safeSendMessage(
      {
        action: "rewriteContext",
        payload: {
          lines: merged,
          wantLines: true,
          fmt: "origin:speaker:text",
        },
      },
      (res) => {
        const le = chrome.runtime?.lastError?.message;
        const parsed = le ? null : parseRewriteResponse(res);

        if (parsed) {
          rewriteInFlight = false;
          return cb(parsed);
        }

        if (attempt + 1 < maxAttempts) {
          const delay = Math.round(
            REWRITE_RETRY_BASE_DELAY_MS * Math.pow(REWRITE_RETRY_BACKOFF, attempt) +
              Math.random() * REWRITE_RETRY_JITTER_MS
          );
          return setTimeout(() => sendAttempt(attempt + 1), delay);
        }

        rewriteInFlight = false;
        cb(null);
      }
    );
  };

  sendAttempt(0);
}

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

// RTT buffer (anti-pipoco)
const TEAMS_RTT_COMMIT_CHECK_MS = 240;
const TEAMS_RTT_IDLE_COMMIT_MS = 240;
const TEAMS_RTT_MIN_CHARS = 1;
const TEAMS_RTT_MAX_CHARS = 900;

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

  // ✅ bloco corrigido
  panelFixedBlock: "__mt_fixed_block",
  panelFixedCopy: "__mt_fixed_copy",
};

// =====================================================
// ✅ State (transcrição)
// =====================================================
let transcriptData = "";
let lastSavedHash = "";

// ✅ FIX: agora o “prevLine” é por origin+speaker (não só speaker)
let lastLineByKey = new Map(); // key(origin::speaker) -> last full text

let seenKeys = new Set();
let latestBySpeaker = new Map();

// ✅ Guarda a última linha “singleLine” por origin+speaker (pra colar "." no final)
let lastSingleLineByKey = new Map();

// =====================================================
// Utils
// =====================================================
function extractTaggedLines(rewritten, expectedCount) {
  const raw = Array.isArray(rewritten) ? rewritten.join("\n") : String(rewritten || "");
  if (!/⟦L\d{2}⟧/u.test(raw)) return null;

  const map = new Array(expectedCount).fill(null);
  const re = /⟦L(\d{2})⟧\s*([\s\S]*?)(?=⟦L\d{2}⟧|$)/gu;
  let m;
  while ((m = re.exec(raw)) !== null) {
    const idx = parseInt(m[1], 10) - 1;
    if (idx < 0 || idx >= expectedCount) continue;
    map[idx] = String(m[2] || "").trim();
  }
  if (map.some((x) => !x)) return null;
  return map;
}

function buildSafeRewriteLinesPreserveSpeakers(rawSegmentLines, rewrittenLinesOrText) {
  const rawSeg = (rawSegmentLines || [])
    .map((s) => String(s || "").trim())
    .filter(Boolean);
  if (!rawSeg.length) return null;

  // parse do raw (fonte da verdade p/ origin + speaker)
  const rawP = rawSeg.map((ln) => {
    const probe = ln.startsWith("🎤") ? ln : `🎤 ${ln}`;
    const p = parseTranscriptLine(probe);
    return {
      origin: String(p.origin || "").trim() || "Teams",
      speaker: String(p.speaker || "").trim() || "Desconhecido",
      text: String(p.text || "").trim(),
    };
  });

  const expected = rawP.length;
  const tagged = extractTaggedLines(rewrittenLinesOrText, expected);
  if (tagged) rewrittenLinesOrText = tagged;

  let outLines = Array.isArray(rewrittenLinesOrText)
    ? rewrittenLinesOrText
    : String(rewrittenLinesOrText || "").split("\n");

  outLines = outLines.map((s) => String(s || "").trim()).filter(Boolean);
  if (!outLines.length) return null;

  const expanded = [];
  for (const ln of outLines) {
    const turns = splitTeamsInlineTurns(ln);
    if (turns && turns.length) {
      for (const t of turns) expanded.push(`Teams: ${t.speaker}: ${t.text}`);
    } else {
      expanded.push(ln);
    }
  }
  outLines = expanded;

  if (outLines.length !== rawP.length) return null;

  const safe = [];
  for (let i = 0; i < rawP.length; i++) {
    const src = rawP[i];
    const ln = outLines[i];

    const probe = ln.startsWith("🎤") ? ln : `🎤 ${ln}`;
    const p = parseTranscriptLine(probe);

    let newText = "";
    if (p && p.text) newText = p.text;
    else {
      const m = String(ln).match(/^([^:]{1,80})\s*:\s*(.+)$/u);
      newText = m ? m[2] : ln;
    }

    newText = normalizeSpacesOneLine(newText);

    // Se ainda veio “Teams • ...” dentro do texto, é sinal de colagem -> aborta
    if (/Teams\s*[•·-]/i.test(newText)) return null;

    if (!newText) newText = src.text || "";
    safe.push(`${src.origin}: ${src.speaker}: ${newText}`);
  }

  return safe.length ? safe : null;
}

function nowIso() {
  return new Date().toISOString();
}

function tail(str, max) {
  str = String(str || "");
  if (!max || str.length <= max) return str;
  return str.slice(str.length - max);
}

function trimHistoryIfNeeded() {
  if (transcriptData.length <= MAX_HISTORY_CHARS) return;
  transcriptData = transcriptData.slice(transcriptData.length - MAX_HISTORY_CHARS);
}

// =====================================================
// ✅ Capture dedupe por DOM node (evita reler o mesmo caption)
// =====================================================
const _nodeLastCaptured = new WeakMap();

function appendOncePerNode(node, speaker, text, origin) {
  const sp = normalizeSpacesOneLine(speaker || "");
  const tx = normalizeSpacesOneLine(text || "");
  if (!tx) return;

  const sig = `${sp}||${tx}`;
  if (node) {
    const prev = _nodeLastCaptured.get(node);
    if (prev === sig) return;
    _nodeLastCaptured.set(node, sig);
  }
  appendNewTranscript(sp, tx, origin);
}

// ✅ sempre 1 linha, espaços normalizados
function normalizeSpacesOneLine(s) {
  return String(s || "")
    .replace(/\u00A0/g, " ")
    .replace(/\s*\n+\s*/g, " ")
    .replace(/\s+/g, " ")
    .trim();
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
// ✅ Parse: 🎤 Origin: Speaker: Text
// =====================================================
function parseTranscriptLine(line) {
  const clean = String(line || "").replace(/^🎤\s*/u, "").trim();
  const m = clean.match(/^([^:]+?)\s*:\s*([^:]+?)\s*:\s*(.*)$/u);
  if (!m) return { origin: "", speaker: "", text: clean };
  return {
    origin: (m[1] || "").trim(),
    speaker: (m[2] || "").trim(),
    text: (m[3] || "").trim(),
  };
}

function isTeamsLine(line) {
  const p = parseTranscriptLine(line);
  return String(p.origin || "").trim().toLowerCase() === "teams";
}

function hasFinalPunct(s) {
  const t = String(s || "").trim();
  return /[.!?…]$/.test(t);
}

function isOnlyPunctDelta(s) {
  const t = String(s || "").trim();
  return /^[.!?…]+$/.test(t);
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
// ✅ Flags: linhas já “arrumadas” (pra não ficar corrigindo toda hora)
// =====================================================
const FIXED_FLAGS_STORE_KEY = "__mt_fixed_line_flags_v1";
const FIXED_FLAGS_MAX = 2500;

let fixedLineFlags = new Map(); // key -> ts
let fixedFlagsLoaded = false;
let fixedFlagsSaveTimer = null;

function normTextKey(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

// =====================================================
// ✅ Teams: colapsa repetição absurda (evita eco/acúmulo)
// =====================================================
function collapseTeamsRepeats(text) {
  let s = normalizeSpacesOneLine(text);
  if (s.length < 64) return s;

  // 1) colapsa repetição TOTAL por palavras (mesma frase repetida k vezes)
  const words = s.split(" ").filter(Boolean);
  if (words.length >= 12) {
    for (let rep = 6; rep >= 2; rep--) {
      if (words.length % rep !== 0) continue;
      const patLen = words.length / rep;
      if (patLen < 6) continue;

      const pat = words.slice(0, patLen).join(" ");
      let ok = true;
      for (let r = 1; r < rep; r++) {
        const seg = words.slice(r * patLen, (r + 1) * patLen).join(" ");
        if (seg !== pat) {
          ok = false;
          break;
        }
      }
      if (ok) return pat;
    }
  }

  // 2) por sentenças (remove duplicadas consecutivas e grupos repetidos)
  const segsRaw = s.match(/[^.!?…]+[.!?…]*/g) || [];
  const segs = segsRaw.map((x) => normalizeSpacesOneLine(x)).filter(Boolean);

  if (segs.length >= 2) {
    const canon = (x) =>
      normTextKey(String(x || "").replace(/[.!?…,"'“”‘’]/g, " "));

    // remove duplicadas consecutivas
    const compact = [];
    for (const seg of segs) {
      const c = canon(seg);
      const last = compact.length ? canon(compact[compact.length - 1]) : "";
      if (c && last && c === last) continue;
      compact.push(seg);
    }

    const cArr = compact.map(canon);

    // detecta grupo repetido
    for (let gl = 1; gl <= Math.floor(compact.length / 2); gl++) {
      if (compact.length % gl !== 0) continue;
      let ok = true;
      for (let i = 0; i < cArr.length; i++) {
        if (cArr[i] !== cArr[i % gl]) {
          ok = false;
          break;
        }
      }
      if (ok) {
        return normalizeSpacesOneLine(compact.slice(0, gl).join(" "));
      }
    }

    return normalizeSpacesOneLine(compact.join(" "));
  }

  // 3) fallback: remove repetição de palavra
  const out = [];
  let last = "";
  let run = 0;
  for (const w of words) {
    const c = w.toLowerCase();
    if (c === last) {
      run++;
      if (run >= 2) continue; // deixa no máx 2
    } else {
      run = 0;
      last = c;
    }
    out.push(w);
  }
  return out.join(" ");
}

// =====================================================
// ✅ Suppress: não reapendar frases recém-corrigidas
// =====================================================
const RECENT_FIXED_SUPPRESS_MS = 120000; // 2 min
const recentFixedTextBySpeaker = new Map(); // "Origin::Speaker" -> [{t, ts}]

function rememberFixedText(line) {
  const probe = String(line || "").trim().startsWith("🎤")
    ? String(line).trim()
    : `🎤 ${String(line || "").trim()}`;

  const p = parseTranscriptLine(probe);
  if (!p || !p.origin || !p.speaker) return;

  const k = `${String(p.origin).trim()}::${String(p.speaker).trim()}`;
  const t = normTextKey(p.text);
  if (!t) return;

  const now = Date.now();
  const cutoff = now - RECENT_FIXED_SUPPRESS_MS;

  const arr = recentFixedTextBySpeaker.get(k) || [];
  const keep = arr.filter((it) => it && it.ts >= cutoff && it.t);

  if (!keep.some((it) => it.t === t)) keep.push({ t, ts: now });

  recentFixedTextBySpeaker.set(k, keep.slice(-120));
}

function isRecentlyFixedText(origin, speaker, text) {
  const k = `${String(origin || "").trim()}::${String(speaker || "").trim()}`;
  const t = normTextKey(text);
  if (!t) return false;

  const arr = recentFixedTextBySpeaker.get(k);
  if (!arr || !arr.length) return false;

  const now = Date.now();
  const cutoff = now - RECENT_FIXED_SUPPRESS_MS;

  // prune lazy
  let changed = false;
  const keep = [];
  for (const it of arr) {
    if (it && it.ts >= cutoff && it.t) keep.push(it);
    else changed = true;
  }
  if (changed) recentFixedTextBySpeaker.set(k, keep);

  for (const it of keep) {
    if (it.t === t) return true;
    if (t.length >= 12 && (it.t.includes(t) || t.includes(it.t))) return true;
  }
  return false;
}

function fastHash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return String(h >>> 0);
}

function lineFlagKey(line) {
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
  fixedLineFlags.delete(k);
  fixedLineFlags.set(k, Date.now());
  while (fixedLineFlags.size > FIXED_FLAGS_MAX) {
    const first = fixedLineFlags.keys().next().value;
    if (!first) break;
    fixedLineFlags.delete(first);
  }
  scheduleSaveFixedFlags();

  // ✅ registra texto corrigido pra suppress
  rememberFixedText(line);
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

function isUnknownSpeaker(s) {
  const t = String(s || "").trim().toLowerCase();
  return !t || t === "desconhecido" || t === "unknown";
}

// =====================================================
// ✅ Speaker fallback (não inventa “Entrevistador”)
// =====================================================
const UNKNOWN_SPEAKER_LABEL = "Desconhecido";
const SINGLE_SPEAKER_GUESS_UNKNOWN = true;
const SINGLE_SPEAKER_GUESS_WINDOW_MS = 120000;

let recentNonUnknownSpeakers = new Map(); // norm -> { name, ts }

function noteNonUnknownSpeaker(name) {
  const n = normName(name);
  if (!n) return;
  const now = Date.now();
  recentNonUnknownSpeakers.set(n, { name: String(name || "").trim(), ts: now });

  const cutoff = now - SINGLE_SPEAKER_GUESS_WINDOW_MS;
  for (const [k, v] of recentNonUnknownSpeakers.entries()) {
    if (!v || v.ts < cutoff) recentNonUnknownSpeakers.delete(k);
  }
}

function guessSpeakerIfUnknown(speaker) {
  if (!SINGLE_SPEAKER_GUESS_UNKNOWN) return speaker;
  if (!isUnknownSpeaker(speaker)) return speaker;

  const now = Date.now();
  const cutoff = now - SINGLE_SPEAKER_GUESS_WINDOW_MS;

  const uniq = [];
  for (const v of recentNonUnknownSpeakers.values()) {
    if (!v || v.ts < cutoff) continue;
    const nn = normName(v.name);
    if (!nn) continue;
    if (!uniq.some((x) => normName(x.name) === nn)) uniq.push(v);
  }
  if (uniq.length === 1) return uniq[0].name;
  return speaker;
}

// =====================================================
// ✅ Panel transcript dedupe por match EXATO (não substring)
// =====================================================
let panelTranscriptCache = "";
let panelSuggestionCache = { positivo: "", negativo: "" };
let panelFixedBlockCache = "";
let panelLineSet = new Set();

function rebuildPanelLineSetFromCache() {
  panelLineSet.clear();
  const lines = String(panelTranscriptCache || "")
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
  for (const ln of lines) panelLineSet.add(ln);
}

function transcriptCacheHasLine(line) {
  const ln = String(line || "").trim();
  return !!ln && panelLineSet.has(ln);
}

function normalizeTranscriptLineForLLM(line) {
  return String(line || "").replace(/^🎤\s*/u, "").trim();
}

function replaceLastLineInCaches(oldLine, newLine) {
  if (!oldLine || !newLine || oldLine === newLine) return;

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

  rebuildPanelLineSetFromCache();
  renderTranscriptListFromCache();
}

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
const AI_ONLY_TOP_FRAME = true;
const ENABLE_TWO_CALL_FALLBACK = false;

const REPLY_DEDUP_MS = 1800;
const REPLY_LOCK_MS = 2500;
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
  if (key === lastReplyKey && now - lastReplyAt < REPLY_DEDUP_MS) {
    return { ok: false, reason: "dedup" };
  }

  if (repliesInFlight && now < repliesLockUntil) {
    return { ok: false, reason: "in_flight" };
  }

  lastReplyKey = key;
  lastReplyAt = now;
  repliesInFlight = true;
  repliesLockUntil = now + REPLY_LOCK_MS;
  return { ok: true, key };
}

function finishReplyLock() {
  const now = Date.now();
  repliesInFlight = false;
  repliesLockUntil = now + 350;
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
  if (teamsRttTimerId) {
    clearInterval(teamsRttTimerId);
    teamsRttTimerId = null;
  }
  teamsRttBuf.clear();

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
  const el = document.getElementById(
    slot === "positivo" ? UI_IDS.panelSuggestionPos : UI_IDS.panelSuggestionNeg
  );
  if (!el) return;

  const label = slot === "positivo" ? "Positivo" : "Negativo";
  const txt = panelSuggestionCache[slot]
    ? `${label}:\n${panelSuggestionCache[slot]}`
    : `${label}: (vazio)`;
  setTextPreserveScroll(el, txt);
}

// =====================================================
// ✅ Painel SEMPRE mostra "Autor: mensagem"
// =====================================================
function displayLineAuthorAndText(line) {
  const raw = String(line || "").trim();
  if (!raw) return "";

  const p = parseTranscriptLine(raw);
  if (p && p.speaker && p.text) {
    let sp = String(p.speaker || "").trim();
    if (isUnknownSpeaker(sp)) sp = UNKNOWN_SPEAKER_LABEL;
    return `${sp}: ${String(p.text || "").trim()}`;
  }

  const s = normalizeTranscriptLineForLLM(raw);
  const m = s.match(/^[^•·-]+?\s*[•·-]\s*([^:]+?)\s*:\s*(.+)$/u);
  if (m) {
    let sp = String(m[1] || "").trim();
    if (isUnknownSpeaker(sp)) sp = UNKNOWN_SPEAKER_LABEL;
    return `${sp}: ${String(m[2] || "").trim()}`;
  }

  return normalizeSpacesOneLine(raw.replace(/^🎤\s*/u, ""));
}

function formatBlockForPanel(raw) {
  const lines = String(raw || "")
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
  if (!lines.length) return "";

  const out = [];
  for (const ln of lines) {
    const turns = splitTeamsInlineTurns(ln);
    if (turns && turns.length) {
      for (const t of turns) {
        const sp = isUnknownSpeaker(t.speaker) ? UNKNOWN_SPEAKER_LABEL : t.speaker;
        out.push(`${sp}: ${t.text}`);
      }
      continue;
    }
    out.push(displayLineAuthorAndText(ln));
  }
  return out.join("\n");
}

// =====================================================
// ✅ Bloco corrigido (IA) — só Autor: mensagem
// =====================================================
function setFixedBlock(raw) {
  panelFixedBlockCache = tail(formatBlockForPanel(String(raw || "").trim()), 12000);
  const el = document.getElementById(UI_IDS.panelFixedBlock);
  if (!el) return;
  setTextPreserveScroll(el, panelFixedBlockCache ? panelFixedBlockCache : "(vazio)");
}

// =====================================================
// ✅ Transcript cache (painel)
// =====================================================
function setPanelTranscriptText(raw) {
  panelTranscriptCache = tail(raw, PANEL_HISTORY_MAX_CHARS);
  rebuildPanelLineSetFromCache();
  renderTranscriptListFromCache();
}

function appendPanelTranscriptLine(line) {
  const ln = String(line || "").trim();
  if (!ln) return;
  if (transcriptCacheHasLine(ln)) return;

  panelTranscriptCache = (panelTranscriptCache ? panelTranscriptCache + "\n" : "") + ln;
  panelTranscriptCache = tail(panelTranscriptCache, PANEL_HISTORY_MAX_CHARS);

  rebuildPanelLineSetFromCache();
  renderTranscriptListFromCache();
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

// =====================================================
// ✅ Teams RTT buffer (anti “pipoco”)
// =====================================================
let teamsRttBuf = new Map(); // key(origin::speaker) -> { text, lastUpdateAt }
let teamsRttLastCommitted = new Map(); // key(origin::speaker) -> last committed text
let teamsRttTimerId = null;

function teamsRttKey(origin, speaker) {
  return `${String(origin || "").trim()}::${String(speaker || "").trim()}`;
}

function noteTeamsRtt(speaker, text) {
  const origin = "Teams";
  speaker = normalizeSpacesOneLine(speaker || "Desconhecido");
  speaker = guessSpeakerIfUnknown(speaker);

  if (!CAPTURE_SELF_LINES && isMe(speaker)) return;

  let msg = normalizeSpacesOneLine(cleanCaptionText(text));
  if (!msg) return;

  // ✅ FIX: colapsa eco antes de bufferizar
  msg = collapseTeamsRepeats(msg);

  if (isJunkCaptionText(msg)) return;

  const trimmed = msg.trim();
  if (!trimmed) return;
  if (trimmed.length > TEAMS_RTT_MAX_CHARS) return;

  const k = teamsRttKey(origin, speaker);
  const now = Date.now();
  const cur = teamsRttBuf.get(k);

  if (cur && cur.text === trimmed) {
    cur.lastUpdateAt = now;
    teamsRttBuf.set(k, cur);
  } else {
    teamsRttBuf.set(k, { text: trimmed, lastUpdateAt: now });
  }
  startTeamsRttTimerIfNeeded();
}

function startTeamsRttTimerIfNeeded() {
  if (teamsRttTimerId) return;
  teamsRttTimerId = setInterval(commitTeamsRttIfReady, TEAMS_RTT_COMMIT_CHECK_MS);
}

function stopTeamsRttTimerIfIdle() {
  if (teamsRttTimerId && teamsRttBuf.size === 0) {
    clearInterval(teamsRttTimerId);
    teamsRttTimerId = null;
  }
}

function commitTeamsRttIfReady() {
  const now = Date.now();
  if (!teamsRttBuf.size) return stopTeamsRttTimerIfIdle();

  for (const [k, st] of teamsRttBuf.entries()) {
    const origin = "Teams";
    const speaker = k.split("::").slice(1).join("::") || "Desconhecido";
    const text = String(st?.text || "").trim();
    const lastAt = Number(st?.lastUpdateAt || 0);

    if (!text) {
      teamsRttBuf.delete(k);
      continue;
    }

    const idleFor = now - lastAt;
    const finalNow = hasFinalPunct(text);

    if (!finalNow && idleFor < TEAMS_RTT_IDLE_COMMIT_MS) continue;

    if (!finalNow && text.length < TEAMS_RTT_MIN_CHARS) {
      teamsRttBuf.delete(k);
      continue;
    }

    const lastCommitted = String(teamsRttLastCommitted.get(k) || "");
    if (text === lastCommitted) {
      teamsRttBuf.delete(k);
      continue;
    }

    appendNewTranscript(speaker, text, origin);
    teamsRttLastCommitted.set(k, text);
    teamsRttBuf.delete(k);
  }

  stopTeamsRttTimerIfIdle();
}

// =====================================================
// ✅ State (Auto IA)
// =====================================================
let autoIaEnabled = AUTO_IA_ENABLED_DEFAULT;
let autoIaTimerId = null;
let lastTranscriptActivityAt = 0;
let lastAutoIaSourceHash = "";
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

function getTailLinesForAutoIa(maxLines = AUTO_IA_MAX_LINES) {
  const lines = String(panelTranscriptCache || "")
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean)
    .filter((l) => !isInternalInjectedLine(l));

  if (!lines.length) return [];
  return lines.slice(-Math.max(1, maxLines));
}

// =====================================================
// ✅ Rewrite chunk selector (NÃO manda linhas já corrigidas)
// =====================================================
const AUTO_FIX_SCAN_LINES = 60;
const AUTO_FIX_CHUNK_MAX_LINES = AUTO_IA_MAX_LINES;
const AUTO_FIX_SEGMENTS_BUDGET = 24;
const AUTO_FIX_SEGMENT_LOGIC_RETRIES = 2;
const AUTO_FIX_GLOBAL_TIMEOUT_MS = 9000;

function getRecentLinesForRewriteScan(maxLines = AUTO_FIX_SCAN_LINES) {
  const lines = String(panelTranscriptCache || "")
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean)
    .filter((l) => !isInternalInjectedLine(l));
  if (!lines.length) return [];
  return lines.slice(-Math.max(1, maxLines));
}

function pickTeamsUnfixedChunk(scanLines, chunkMax = AUTO_FIX_CHUNK_MAX_LINES) {
  const L = Array.isArray(scanLines) ? scanLines : [];
  if (!L.length) return [];

  for (let i = L.length - 1; i >= 0; i--) {
    const li = L[i];
    if (!isTeamsLine(li)) continue;
    if (isLineFixed(li)) continue;

    const chunk = [];
    for (let j = i; j >= 0; j--) {
      const lj = L[j];
      if (!isTeamsLine(lj)) break;
      if (isLineFixed(lj)) break;
      chunk.push(lj);
      if (chunk.length >= chunkMax) break;
    }
    return chunk.reverse();
  }
  return [];
}

function hasUnfixedTeamsInScan() {
  const scan = getRecentLinesForRewriteScan(AUTO_FIX_SCAN_LINES);
  return scan.some((l) => isTeamsLine(l) && !isLineFixed(l));
}

// =====================================================
// Heurística: junta “pipocos” (co + mo => como)
// =====================================================
function mergePipocadas(lines) {
  const out = [];
  let last = null;

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
// ✅ Merge de linhas contíguas por origin+speaker
// =====================================================
function mergeRunsBySpeaker(lines) {
  const joinWithSpace = (a, b) => {
    a = String(a || "").trim();
    b = String(b || "").trim();
    if (!a) return b;
    if (!b) return a;
    if (/[.!?…]$/.test(a)) return a + " " + b;
    if (/^[.!?…]+$/.test(b)) return a + b;
    return (a + " " + b).replace(/\s+/g, " ").trim();
  };

  const out = [];
  let cur = null;

  for (const raw of lines || []) {
    const probe = String(raw || "").trim().startsWith("🎤")
      ? String(raw).trim()
      : `🎤 ${String(raw || "").trim()}`;
    const p = parseTranscriptLine(probe);
    const origin = String(p.origin || "").trim() || "Teams";
    const speaker = String(p.speaker || "").trim() || "Desconhecido";
    const text = normalizeSpacesOneLine(p.text || "");
    if (!text) continue;

    if (cur && cur.origin === origin && cur.speaker === speaker) {
      cur.text = joinWithSpace(cur.text, text);
      continue;
    }
    if (cur) out.push(cur);
    cur = { origin, speaker, text };
  }

  if (cur) out.push(cur);
  return out.map((x) => `${x.origin}: ${x.speaker}: ${x.text}`.trim());
}

function mergeForRewrite(lines) {
  const pip = mergePipocadas(lines || []);
  return mergeRunsBySpeaker(pip);
}

function buildReplySeedFromTail(maxLines = AUTO_IA_MAX_LINES) {
  const raw = getTailLinesForAutoIa(maxLines);
  const merged = mergeForRewrite(raw);
  return merged.join("\n").trim();
}

// =====================================================
// ✅ Segment replace helper (merge/rewrite)
// =====================================================
function findSegmentIndex(lines, segmentLines) {
  if (!lines?.length || !segmentLines?.length) return -1;
  const n = segmentLines.length;
  outer: for (let i = lines.length - n; i >= 0; i--) {
    for (let j = 0; j < n; j++) {
      if (lines[i + j] !== segmentLines[j]) continue outer;
    }
    return i;
  }
  return -1;
}

function replaceSegmentInCaches(rawSeg, newWithMic, opts = {}) {
  const markFixedNow = opts.markFixed === true;
  const fixedBlockText =
    typeof opts.fixedBlockText === "string" ? opts.fixedBlockText : null;

  // -------- PANEL CACHE --------
  const panelLines = String(panelTranscriptCache || "")
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);

  const idxP = findSegmentIndex(panelLines, rawSeg);
  if (idxP < 0) return false;

  const nextPanel = panelLines
    .slice(0, idxP)
    .concat(newWithMic)
    .concat(panelLines.slice(idxP + rawSeg.length));

  panelTranscriptCache = tail(nextPanel.join("\n") + "\n", PANEL_HISTORY_MAX_CHARS);
  rebuildPanelLineSetFromCache();
  renderTranscriptListFromCache();

  // -------- TRANSCRIPT DATA --------
  const fullLines = String(transcriptData || "")
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);

  const idxF = findSegmentIndex(fullLines, rawSeg);
  if (idxF >= 0) {
    const nextFull = fullLines
      .slice(0, idxF)
      .concat(newWithMic)
      .concat(fullLines.slice(idxF + rawSeg.length));
    transcriptData = nextFull.join("\n") + "\n";
    trimHistoryIfNeeded();
  }

  // atualiza lastSingleLineByKey
  for (const ln of newWithMic) {
    const p = parseTranscriptLine(ln);
    if (!p.origin || !p.speaker) continue;
    lastSingleLineByKey.set(`${p.origin}::${p.speaker}`, ln);
  }

  if (markFixedNow) {
    for (const ln of newWithMic) markLineFixed(ln);
  }

  if (fixedBlockText != null) setFixedBlock(fixedBlockText);

  scheduleFlushSoon();
  return true;
}

// =====================================================
// ✅ Merge-before-rewrite: aplica merge no histórico e retorna segment pronto
// =====================================================
function prepareSegmentForRewrite(rawSegmentLines) {
  const rawSeg = (rawSegmentLines || [])
    .map((s) => String(s || "").trim())
    .filter(Boolean);
  if (!rawSeg.length) return null;

  const mergedNoMic = mergeForRewrite(rawSeg);
  const mergedWithMic = mergedNoMic.map((s) => (s.startsWith("🎤") ? s : `🎤 ${s}`));

  const same =
    mergedWithMic.length === rawSeg.length &&
    mergedWithMic.every((ln, i) => String(ln) === String(rawSeg[i]));

  if (!same) {
    const ok = replaceSegmentInCaches(rawSeg, mergedWithMic, {
      markFixed: false,
      fixedBlockText: mergedNoMic.join("\n"),
    });
    if (!ok) {
      return { segCacheLines: rawSeg, segLlmLines: rawSeg.map(normalizeTranscriptLineForLLM) };
    }
  }

  const taggedForLlm = mergedNoMic.map((ln, i) => {
    const id = String(i + 1).padStart(2, "0");
    return `⟦L${id}⟧ ${ln}`;
  });

  return {
    segCacheLines: same ? rawSeg : mergedWithMic,
    segLlmLines: taggedForLlm,
  };
}

function applyRewriteToSegment(rawSegmentLines, rewrittenLines) {
  const rawSeg = (rawSegmentLines || [])
    .map((s) => String(s || "").trim())
    .filter(Boolean);
  const newSeg = (rewrittenLines || [])
    .map((s) => String(s || "").trim())
    .filter(Boolean);
  if (!rawSeg.length || !newSeg.length) return false;

  const newWithMic = newSeg.map((s) => (s.startsWith("🎤") ? s : `🎤 ${s}`));
  return !!replaceSegmentInCaches(rawSeg, newWithMic, {
    markFixed: true,
    fixedBlockText: newSeg.join("\n"),
  });
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
      row.title = line;
      row.className = "mt-line";

      const fixed = isLineFixed(line);
      if (fixed) row.classList.add("fixed");

      const txt = document.createElement("div");
      txt.className = "mt-line-text";

      const display = displayLineAuthorAndText(line);

      if (fixed) {
        const badge = document.createElement("span");
        badge.className = "mt-flag";
        badge.textContent = "✅";
        txt.appendChild(badge);

        const span = document.createElement("span");
        span.textContent = display;
        txt.appendChild(span);
      } else {
        txt.textContent = display;
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
// ✅ Auto IA: runner + "corrigir até acabar"
// =====================================================
function markTranscriptActivity() {
  lastTranscriptActivityAt = Date.now();
  if (!autoIaEnabled) return;
  if (!aiAllowedHere()) return;
  if (Date.now() < autoIaPauseUntil) return;

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

// =====================================================
// ✅ Rewrite (IA)
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
      payload: { lines: merged, wantLines: true, fmt: "origin:speaker:text" },
    },
    (res) => {
      rewriteInFlight = false;
      if (chrome.runtime?.lastError) return cb(null);
      const parsed = parseRewriteResponse(res);
      cb(parsed);
    }
  );
}

// =====================================================
// ✅ NOVO: corrigir TODOS os blocos Teams não fixados no scan
// =====================================================
function autoFixUntilClean(opts, done) {
  if (!aiAllowedHere()) return done({ didAny: false, remaining: false });

  const t0 = Date.now();
  let didAny = false;
  let blocksTried = 0;

  const logicRetryByKey = new Map();

  const step = () => {
    if (!aiAllowedHere()) return done({ didAny, remaining: hasUnfixedTeamsInScan() });
    if (Date.now() - t0 > AUTO_FIX_GLOBAL_TIMEOUT_MS)
      return done({ didAny, remaining: hasUnfixedTeamsInScan() });
    if (blocksTried >= AUTO_FIX_SEGMENTS_BUDGET)
      return done({ didAny, remaining: hasUnfixedTeamsInScan() });

    const scanLines = getRecentLinesForRewriteScan(AUTO_FIX_SCAN_LINES);
    const rewriteChunkLines = pickTeamsUnfixedChunk(scanLines, AUTO_FIX_CHUNK_MAX_LINES);
    if (!rewriteChunkLines.length) return done({ didAny, remaining: false });

    const prep = prepareSegmentForRewrite(rewriteChunkLines);
    if (!prep) {
      blocksTried++;
      return setTimeout(step, 60);
    }

    const segKey = fastHash(prep.segCacheLines.join("\n"));
    const used = logicRetryByKey.get(segKey) || 0;

    setPanelStatus(
      `${opts?.auto ? "Auto IA: corrigindo frases (IA)..." : "Corrigindo frases (IA)..."} (${blocksTried + 1}/${AUTO_FIX_SEGMENTS_BUDGET})`
    );
    setLauncherState("busy");
    setAllSuggestionSlots("");

    requestRewriteContextWithRetries(prep.segLlmLines, (rw) => {
      if (!rw) {
        if (used < AUTO_FIX_SEGMENT_LOGIC_RETRIES) {
          logicRetryByKey.set(segKey, used + 1);
          return setTimeout(step, 140);
        }
        blocksTried++;
        return setTimeout(step, 60);
      }

      const linesOut = Array.isArray(rw.lines) && rw.lines.length ? rw.lines : null;
      const safeLines = buildSafeRewriteLinesPreserveSpeakers(prep.segCacheLines, linesOut || rw.text);

      if (!safeLines) {
        setFixedBlock((linesOut ? linesOut.join("\n") : rw.text) || "");
        if (used < AUTO_FIX_SEGMENT_LOGIC_RETRIES) {
          logicRetryByKey.set(segKey, used + 1);
          return setTimeout(step, 170);
        }
        blocksTried++;
        return setTimeout(step, 60);
      }

      const applied = applyRewriteToSegment(prep.segCacheLines, safeLines);
      if (applied) didAny = true;

      blocksTried++;
      setTimeout(step, 40);
    });
  };

  step();
}

// =====================================================
// ✅ Request replies (2 rotas)
// =====================================================
function sendAskMeSuggestion(cleanText, extraPayload, cb) {
  const t = String(cleanText || "").trim();
  safeSendMessage({ action: "generateSuggestion", payload: { line: t, ...(extraPayload || {}) } }, cb);
}

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
  if (!aiAllowedHere()) {
    setPanelStatus("IA: ignorado (iframe).");
    return;
  }

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
      payload: { text: clean, routes: ["positivo", "negativo"], origin: originLabel },
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

      if (res?.suggestions && typeof res.suggestions === "object") {
        setSuggestionSlot("positivo", String(res.suggestions.positivo || ""));
        setSuggestionSlot("negativo", String(res.suggestions.negativo || ""));
        setPanelStatus("Respostas prontas ✅");
        setLauncherState("ok");
        finishReplyLock();
        return;
      }

      if (!res || isGenerateRepliesAck(res)) {
        setPanelStatus("Respostas (streaming)...");
        setLauncherState("busy");
        bumpReplyLock(REPLY_LOCK_MS);
        setTimeout(() => {
          releaseReplyLockIfExpired();
          if (!repliesInFlight) setLauncherState("ok");
        }, REPLY_LOCK_MS + 200);
        return;
      }

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

// =====================================================
// ✅ Auto IA: start (corrige até limpar, depois replies 1x)
// =====================================================
function startAutoIaFromTail(opts = {}) {
  if (!aiAllowedHere()) return;
  if (opts.auto && Date.now() < autoIaPauseUntil) return;

  releaseReplyLockIfExpired();
  if (repliesInFlight && Date.now() < repliesLockUntil) return;

  const rawLines = getTailLinesForAutoIa(AUTO_IA_MAX_LINES);
  if (!rawLines.length) return;

  const merged = mergeForRewrite(rawLines);
  const sourceStr = merged.join("\n").trim();
  if (!sourceStr) return;

  const sourceHash = fastHash(sourceStr);
  const stillHasUnfixed = hasUnfixedTeamsInScan();

  if (sourceHash === lastAutoIaSourceHash && !stillHasUnfixed) return;
  lastAutoIaSourceHash = sourceHash;

  if (!opts.auto) suppressAutoIaForPayload(sourceStr);

  setPanelStatus(opts.auto ? "Auto IA: corrigindo frases (IA)..." : "Corrigindo frases (IA)...");
  setLauncherState("busy");
  setAllSuggestionSlots("");

  autoFixUntilClean(opts, (r) => {
    const didAny = !!r?.didAny;
    const remaining = !!r?.remaining;

    const seed = buildReplySeedFromTail(AUTO_IA_MAX_LINES) || sourceStr;
    suppressAutoIaForPayload(seed);

    setPanelStatus(opts.auto ? "Auto IA (streaming)..." : "Gerando (streaming)...");
    setLauncherState("busy");
    setAllSuggestionSlots("");

    const label = opts.auto
      ? didAny
        ? remaining
          ? "auto_tail_rewrite_partial"
          : "auto_tail_rewrite"
        : "auto_tail"
      : didAny
      ? remaining
        ? "manual_tail_rewrite_partial"
        : "manual_tail_rewrite"
      : "manual_tail";

    requestRepliesForText(seed, label);
  });
}

// =====================================================
// ✅ clique no “Responder (2)”
// =====================================================
function rewriteSegmentUntilApplied(rawSegLines, triesLeft, cb) {
  const rawSeg = (rawSegLines || []).map((s) => String(s || "").trim()).filter(Boolean);
  if (!rawSeg.length) return cb(false);

  const prep = prepareSegmentForRewrite(rawSeg);
  const segCache = prep ? prep.segCacheLines : rawSeg;
  const sendLines = prep ? prep.segLlmLines : segCache.map(normalizeTranscriptLineForLLM);

  requestRewriteContextWithRetries(sendLines, (rw) => {
    if (!rw) {
      if (triesLeft > 0) return setTimeout(() => rewriteSegmentUntilApplied(segCache, triesLeft - 1, cb), 180);
      return cb(false);
    }

    const linesOut = Array.isArray(rw.lines) && rw.lines.length ? rw.lines : null;
    const safeLines = buildSafeRewriteLinesPreserveSpeakers(segCache, linesOut || rw.text);

    if (safeLines && applyRewriteToSegment(segCache, safeLines)) return cb(true);

    setFixedBlock((linesOut ? linesOut.join("\n") : rw.text) || "");
    if (triesLeft > 0) return setTimeout(() => rewriteSegmentUntilApplied(segCache, triesLeft - 1, cb), 220);
    cb(false);
  });
}

function generateRepliesForLine(line) {
  const clean = normalizeTranscriptLineForLLM(line);
  if (!clean) return;
  if (!aiAllowedHere()) return;

  pauseAutoIa(3000);
  suppressAutoIaForPayload(clean);

  const p = parseTranscriptLine(line);
  const isTeams = String(p.origin || "").trim().toLowerCase() === "teams";
  const needRewrite = isTeams && !isLineFixed(line);

  setAllSuggestionSlots("");
  setLauncherState("busy");

  if (!needRewrite) {
    setPanelStatus("Gerando (2 rotas)...");
    requestRepliesForText(clean, "line");
    return;
  }

  const tline = String(line || "").trim();
  const all = String(panelTranscriptCache || "")
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean)
    .filter((l) => !isInternalInjectedLine(l));

  let idx = all.lastIndexOf(tline);
  if (idx < 0) idx = all.length - 1;

  const start = Math.max(0, idx - 9);
  const windowLines = all.slice(start, idx + 1);

  const rewriteChunk = (() => {
    const out = [];
    for (let i = windowLines.length - 1; i >= 0; i--) {
      const l = windowLines[i];
      if (!isTeamsLine(l)) break;
      if (isLineFixed(l)) break;
      out.push(l);
      if (out.length >= AUTO_FIX_CHUNK_MAX_LINES) break;
    }
    return out.reverse();
  })();

  const rawSeg = rewriteChunk.length ? rewriteChunk : windowLines;

  setPanelStatus("Consolidando (IA)...");
  rewriteSegmentUntilApplied(rawSeg, 2, () => {
    const seed = buildReplySeedFromTail(AUTO_IA_MAX_LINES) || clean;
    suppressAutoIaForPayload(seed);
    setPanelStatus("Gerando (2 rotas)...");
    requestRepliesForText(seed, "line_rewrite");
  });
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
      <div class="mt-fixed-head">
        <div class="mt-fixed-title">Bloco corrigido (IA)</div>
        <button id="${UI_IDS.panelFixedCopy}" class="mt-mini-btn" type="button">Copiar</button>
      </div>
      <div id="${UI_IDS.panelFixedBlock}" class="mt-fixed-box">(vazio)</div>

      <div class="mt-sug-head" style="margin-top:10px;">
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

  panel.querySelector(`#${UI_IDS.panelClose}`)?.addEventListener("click", closePanel);
  panel.querySelector(`#${UI_IDS.panelOpenTab}`)?.addEventListener("click", openViewerTab);
  panel.querySelector(`#${UI_IDS.panelAutoIaBtn}`)?.addEventListener("click", toggleAutoIa);

  panel.querySelector("#__mt_btn_manual_tail")?.addEventListener("click", (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    pauseAutoIa(3000);
    startAutoIaFromTail({ auto: false });
  });

  panel.querySelector(`#${UI_IDS.panelSugCopyPos}`)?.addEventListener("click", () => {
    copyToClipboard(panelSuggestionCache.positivo);
  });

  panel.querySelector(`#${UI_IDS.panelSugCopyNeg}`)?.addEventListener("click", () => {
    copyToClipboard(panelSuggestionCache.negativo);
  });

  panel.querySelector(`#${UI_IDS.panelFixedCopy}`)?.addEventListener("click", () => {
    copyToClipboard(panelFixedBlockCache);
  });

  setPanelTranscriptText(transcriptData ? tail(transcriptData, PANEL_HISTORY_MAX_CHARS) : "");
  setSuggestionSlot("positivo", panelSuggestionCache.positivo);
  setSuggestionSlot("negativo", panelSuggestionCache.negativo);
  setFixedBlock(panelFixedBlockCache);
}

function openPanel() {
  ensurePanelUI();
  document.documentElement.classList.add("__mt_panel_open");
  if (transcriptData) setPanelTranscriptText(tail(transcriptData, PANEL_HISTORY_MAX_CHARS));
  setSuggestionSlot("positivo", panelSuggestionCache.positivo);
  setSuggestionSlot("negativo", panelSuggestionCache.negativo);
  setFixedBlock(panelFixedBlockCache);
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
// Floating launcher + dim
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

// ✅ watchdog: não deixa “busy” preso se lock expira
let __mt_lock_watchdog = null;
function startLockWatchdog() {
  if (__mt_lock_watchdog) return;
  __mt_lock_watchdog = setInterval(() => {
    if (!aiAllowedHere()) return;
    releaseReplyLockIfExpired();
    if (!repliesInFlight && !rewriteInFlight) setLauncherState("ok");
  }, 500);
}

function injectLauncherUI() {
  if (!isSupportedPage()) return;
  if (!IS_TOP_FRAME) return;
  if (document.getElementById(UI_IDS.bubble)) return;

  const style = document.createElement("style");
  style.id = UI_IDS.style;

  style.textContent = `
    #${UI_IDS.overlay}{
      position: fixed; inset: 0; background: rgba(0,0,0,0.35);
      z-index: 2147483646; display: none; pointer-events: none;
    }
    #${UI_IDS.overlay}.active{ display:block; }

    #${UI_IDS.bubble}{
      position: fixed; right: 16px; bottom: 16px;
      width: 48px; height: 48px; border-radius: 50%;
      z-index: 2147483647; display:flex; align-items:center; justify-content:center;
      background: rgba(20,20,20,0.92); color:#fff;
      font: 700 12px/1 Arial, sans-serif; letter-spacing:.5px;
      box-shadow: 0 10px 24px rgba(0,0,0,.25);
      cursor:pointer; user-select:none;
    }
    #${UI_IDS.bubble} .dot{
      position:absolute; right:6px; bottom:6px;
      width:10px; height:10px; border-radius:50%;
      background:#2ecc71; box-shadow:0 0 0 4px rgba(46,204,113,0.15);
    }
    #${UI_IDS.bubble}.busy .dot{
      background:#f1c40f; box-shadow:0 0 0 4px rgba(241,196,15,0.18);
      animation: __mt_pulse 900ms ease-in-out infinite;
    }
    #${UI_IDS.bubble}.error .dot{
      background:#e74c3c; box-shadow:0 0 0 4px rgba(231,76,60,0.18);
      animation:none;
    }
    #${UI_IDS.bubble}:hover{ transform: translateY(-1px); }
    @keyframes __mt_pulse{ 0%{transform:scale(1)} 50%{transform:scale(1.25)} 100%{transform:scale(1)} }

    :root{ --mt_panel_w: min(25vw, 520px); }
    #${UI_IDS.panel}{
      position: fixed; top:0; right:0; width: var(--mt_panel_w); min-width: 360px; height: 100vh;
      z-index: 2147483645; background: rgba(16,16,18,0.97); color:#fff;
      border-left: 1px solid rgba(255,255,255,0.08);
      box-shadow: -18px 0 40px rgba(0,0,0,0.35);
      transform: translateX(100%); transition: transform 160ms ease-out;
      pointer-events:auto; display:flex; flex-direction:column; font: 12px/1.35 Arial, sans-serif;
    }
    :root.__mt_panel_open #${UI_IDS.panel}{ transform: translateX(0); }
    :root.__mt_panel_open body{ margin-right: var(--mt_panel_w); overflow-x:hidden; }

    #${UI_IDS.panelHeader}{
      display:flex; align-items:center; justify-content:space-between;
      gap:10px; padding:10px; border-bottom:1px solid rgba(255,255,255,0.08);
    }
    #${UI_IDS.panelHeader} .title{ font-weight:900; letter-spacing:.4px; }
    #${UI_IDS.panelHeader} .actions{ display:flex; gap:8px; align-items:center; flex-wrap:wrap; }
    #${UI_IDS.panelHeader} button{
      background: rgba(255,255,255,0.10); color:#fff;
      border:1px solid rgba(255,255,255,0.14);
      border-radius:10px; padding:6px 10px; cursor:pointer;
      font: 800 11px/1 Arial, sans-serif; white-space:nowrap;
    }
    #${UI_IDS.panelHeader} button:hover{ background: rgba(255,255,255,0.16); }

    #${UI_IDS.panelStatus}{
      padding:8px 10px; color: rgba(255,255,255,0.75);
      border-bottom:1px solid rgba(255,255,255,0.06); font-size:11px;
    }

    #${UI_IDS.panelTranscript}{ padding:10px; overflow:auto; flex:1; border-bottom:1px solid rgba(255,255,255,0.06); }
    .mt-transcript-title{ font-weight:900; margin-bottom:8px; color: rgba(255,255,255,0.85); }
    .mt-transcript-list{ display:flex; flex-direction:column; gap:6px; }

    .mt-line{
      display:flex; align-items:flex-start; justify-content:space-between; gap:10px;
      padding:8px; border:1px solid rgba(255,255,255,0.08);
      border-radius:10px; background: rgba(255,255,255,0.04);
    }
    .mt-line:hover{ background: rgba(255,255,255,0.06); }
    .mt-line.fixed{ border-color: rgba(46,204,113,0.55); background: rgba(46,204,113,0.10); }
    .mt-line-text{ white-space:pre-wrap; word-break:break-word; flex:1; opacity:.95; }
    .mt-flag{ display:inline-block; margin-right:6px; font-weight:900; }
    .mt-line-btn{
      flex:none; background: rgba(46,204,113,0.18);
      border: 1px solid rgba(46,204,113,0.35);
      border-radius:10px; padding:6px 10px; color:#fff; cursor:pointer;
      font-weight:900; font-size:11px; line-height:1; white-space:nowrap;
    }
    .mt-line-btn:hover{ background: rgba(46,204,113,0.24); }

    #${UI_IDS.panelSuggestionsWrap}{ padding:10px; overflow:auto; flex:1; }
    .mt-fixed-head{ display:flex; justify-content:space-between; align-items:center; gap:10px; margin-bottom:8px; }
    .mt-fixed-title{ font-weight:900; color: rgba(255,255,255,0.92); }
    .mt-fixed-box{
      background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.08);
      border-radius:12px; padding:10px; max-height:160px; overflow:auto;
      white-space:pre-wrap; word-break:break-word; margin-bottom:8px;
    }
    .mt-mini-btn{
      background: rgba(255,255,255,0.10); color:#fff;
      border:1px solid rgba(255,255,255,0.14);
      border-radius:10px; padding:6px 10px; cursor:pointer;
      font: 900 11px/1 Arial, sans-serif; white-space:nowrap;
    }
    .mt-mini-btn:hover{ background: rgba(255,255,255,0.16); }
    .mt-mini-btn.ok{ background: rgba(46,204,113,0.18); border: 1px solid rgba(46,204,113,0.35); }
    .mt-mini-btn.ok:hover{ background: rgba(46,204,113,0.24); }

    .mt-sug-head{ display:flex; justify-content:space-between; align-items:center; margin-bottom:8px; gap:10px; }
    .mt-sug-title{ font-weight:900; color: rgba(255,255,255,0.92); }
    .mt-sug-grid{ display:grid; grid-template-columns: 1fr; gap:10px; }
    .mt-sug-card{
      border: 1px solid rgba(255,255,255,0.08);
      border-radius:12px; background: rgba(255,255,255,0.04); padding:10px;
    }
    .mt-sug-card-head{ display:flex; align-items:center; justify-content:space-between; gap:10px; margin-bottom:8px; }
    .mt-sug-card-title{ font-weight:900; opacity:.95; }
    .mt-sug-box{
      background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.08);
      border-radius:12px; padding:10px; max-height:220px; overflow:auto;
      white-space:pre-wrap; word-break:break-word;
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

  startLockWatchdog();
  console.log("✅ Launcher UI injetada (bubble + dim + painel in-page).");
}

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

  if (req?.action === "suggestionChunk") {
    if (!aiAllowedHere()) return;
    bumpReplyLock(STREAM_LOCK_BUMP_MS);

    const slot = req?.slot === "negativo" ? "negativo" : "positivo";
    if (req.reset) setSuggestionSlot(slot, "");
    const txt = String(req.text || "");
    if (txt) setSuggestionSlot(slot, txt);

    if (isPanelOpen()) setPanelStatus("Respostas (streaming)...");

    if (req.done === true || req.final === true || req.isFinal === true) {
      finishReplyLock();
      setPanelStatus("Respostas prontas ✅");
      setLauncherState("ok");
    }
    return;
  }

  if (req?.action === "transcriptTick") {
    const line = String(req?.payload?.line || req?.line || "");
    if (line) {
      appendPanelTranscriptLine(line);
      if (!isInternalInjectedLine(line)) markTranscriptActivity();
    }
    return;
  }

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
// ✅ Teams helpers (speaker + text)
// =====================================================
function cleanCaptionText(t) {
  const s = String(t || "").replace(/\u00A0/g, " ").trim();
  if (!s) return "";

  if (/^\s*RTT\b/i.test(s)) return "";
  if (/Pol[ií]tica de Privacidade/i.test(s)) return "";
  if (/Digite uma mensagem/i.test(s)) return "";
  if (/Legendas ao Vivo/i.test(s)) return "";
  if (/Configuraç(ões|oes) da Legenda/i.test(s)) return "";
  if (/Digita(ç|c)ão\s*RTT/i.test(s)) return "";
  if (/texto\s+em\s+tempo\s+real/i.test(s)) return "";
  if (/real[-\s]*time\s+text/i.test(s)) return "";

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
  if (/Digita(ç|c)ão\s*RTT/i.test(s)) return true;
  if (/texto\s+em\s+tempo\s+real/i.test(s)) return true;
  if (/real[-\s]*time\s+text/i.test(s)) return true;
  return false;
}

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

  let texts = collectLeafTexts(root)
    .map((t) => cleanCaptionText(t))
    .filter((t) => t && !isJunkCaptionText(t) && !looksLikeInitials(t))
    .filter((t) => !(speakerNorm && normName(t) === speakerNorm));

  if (!texts.length) return "";

  // ✅ FIX: dedupe por texto + remove fragments contidos em maiores
  const seen = new Set();
  const uniq = [];
  for (const t of texts) {
    const k = normTextKey(t);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    uniq.push(t);
  }
  texts = uniq.sort((a, b) => b.length - a.length);

  const filtered = [];
  for (const t of texts) {
    const tk = normTextKey(t);
    if (filtered.some((x) => normTextKey(x).includes(tk) && normTextKey(x).length >= tk.length + 6)) continue;
    filtered.push(t);
  }
  texts = filtered;

  let best = texts[0] || "";

  // só junta se realmente agrega (não “duplicar”)
  if (texts.length > 1) {
    const joined = normalizeSpacesOneLine(texts.join(" "));
    if (joined.length > best.length && joined.length < best.length * 1.6) best = joined;
  }

  // ✅ FIX: colapsa eco dentro do próprio texto
  best = collapseTeamsRepeats(best);

  return best;
}

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

// ✅ quebra "Teams • Fulano: ... Teams • Ciclano: ..."
function splitTeamsInlineTurns(raw) {
  const s = normalizeSpacesOneLine(raw);
  if (!/Teams\s*[•·-]/i.test(s) || s.indexOf(":") < 0) return null;
  const re =
    /Teams\s*[•·-]\s*([^:]{1,80}?)\s*:\s*([\s\S]*?)(?=\s*Teams\s*[•·-]\s*[^:]{1,80}?\s*:|$)/gi;
  const out = [];
  let m;
  while ((m = re.exec(s)) !== null) {
    const sp = normalizeSpacesOneLine(m[1]);
    const msg = normalizeSpacesOneLine(m[2]);
    if (!sp || !msg) continue;
    out.push({ speaker: sp, text: msg });
  }
  return out.length ? out : null;
}

// =====================================================
// Append (linha nova)
// =====================================================
function appendNewTranscript(speaker, fullText, origin, _alreadySplit = false) {
  speaker = normalizeSpacesOneLine(speaker || "Desconhecido");
  origin = normalizeSpacesOneLine(origin || "Unknown");
  const originLower = origin.toLowerCase();

  // ✅ sempre 1 linha
  let cleanTextRaw = normalizeSpacesOneLine(fullText);
  if (!cleanTextRaw) return;

  // ✅ Teams: colapsa eco antes de qualquer coisa (resolve “acúmulo” do print)
  if (originLower === "teams") cleanTextRaw = collapseTeamsRepeats(cleanTextRaw);

  // ✅ Teams: multi-turno no mesmo bloco -> quebra
  if (!_alreadySplit && originLower === "teams") {
    const turns = splitTeamsInlineTurns(cleanTextRaw);
    if (turns && turns.length) {
      for (const t of turns) appendNewTranscript(t.speaker, t.text, origin, true);
      return;
    }
  }

  // ✅ fallback de speaker desconhecido
  speaker = guessSpeakerIfUnknown(speaker);

  if (!isUnknownSpeaker(speaker)) {
    noteNonUnknownSpeaker(speaker);
    if (isMe(speaker)) addMyName(speaker);
  }

  if (!CAPTURE_SELF_LINES && isMe(speaker)) return;

  const cleanText = cleanTextRaw;
  if (isJunkCaptionText(cleanText)) return;

  const key = `${origin}::${speaker}::${cleanText}`;
  if (seenKeys.has(key)) return;
  seenKeys.add(key);
  if (seenKeys.size > 8000) seenKeys.clear();

  const kOS = `${origin}::${speaker}`;
  const prevLine = lastLineByKey.get(kOS) || "";

  let newContent = cleanText;

  // ✅ delta: só adiciona o que “cresceu”
  if (prevLine && cleanText.startsWith(prevLine)) {
    const remainder = normalizeSpacesOneLine(cleanText.slice(prevLine.length));

    // ✅ FIX CRÍTICO: Teams eco = remainder começa com prevLine -> NÃO reapenda
    if (originLower === "teams") {
      const remK = normTextKey(remainder);
      const prevK = normTextKey(prevLine);
      if (remK && prevK && (remK.startsWith(prevK) || prevK.startsWith(remK))) {
        // atualiza o last full e sai
        lastLineByKey.set(kOS, cleanText);
        return;
      }
    }

    newContent = remainder;
  }

  // sempre atualiza last full
  lastLineByKey.set(kOS, cleanText);

  if (!newContent) return;

  // ✅ se já foi corrigido há pouco, não reapenda
  if (isRecentlyFixedText(origin, speaker, newContent)) return;

  // ✅ Teams: pontuação isolada -> cola no final da última linha
  if (originLower === "teams" && isOnlyPunctDelta(newContent)) {
    const oldSingle = lastSingleLineByKey.get(kOS);
    if (!oldSingle) return;
    if (oldSingle.trim().endsWith(newContent)) return;

    const updatedSingle = oldSingle + newContent;
    replaceLastLineInCaches(oldSingle, updatedSingle);
    lastSingleLineByKey.set(kOS, updatedSingle);

    safeSendMessage({ action: "transcriptTick", payload: { line: updatedSingle, timestamp: nowIso() } });
    markTranscriptActivity();
    scheduleFlushSoon();
    return;
  }

  // ✅ Teams: mata tokens curtos sem pontuação
  if (originLower === "teams") {
    const t = String(newContent || "").trim();
    if (t.length < TEAMS_RTT_MIN_CHARS && !hasFinalPunct(t)) return;
  }

  // ✅ DEDUPE por (origin + texto), preferindo speaker conhecido
  const textKey = `${origin}||${normTextKey(newContent)}`;
  const now = Date.now();
  const prev = recentText.get(textKey);
  if (prev && now - prev.ts < TEXT_DEDUP_MS) {
    const prevUnknown = isUnknownSpeaker(prev.speaker);
    const curUnknown = isUnknownSpeaker(speaker);
    if (normName(prev.speaker) === normName(speaker)) {
      prev.ts = now;
      recentText.set(textKey, prev);
      return;
    }
    if (!prevUnknown && curUnknown) {
      prev.ts = now;
      recentText.set(textKey, prev);
      return;
    }
    if (prevUnknown && !curUnknown) {
      const singleLineNew = `🎤 ${origin}: ${speaker}: ${newContent}`;
      replaceLastLineInCaches(prev.line, singleLineNew);
      trimHistoryIfNeeded();
      lastSingleLineByKey.set(kOS, singleLineNew);
      try {
        latestBySpeaker.delete(prev.speaker);
      } catch {}
      recentText.set(textKey, { ts: now, speaker, line: singleLineNew });

      markTranscriptActivity();
      scheduleFlushSoon();
      return;
    }
  }

  const singleLine = `🎤 ${origin}: ${speaker}: ${newContent}`;

  transcriptData += singleLine + "\n";
  trimHistoryIfNeeded();

  lastSingleLineByKey.set(kOS, singleLine);
  appendPanelTranscriptLine(singleLine);

  recentText.set(textKey, { ts: Date.now(), speaker, line: singleLine });

  if (recentText.size > 4000) {
    const cutoff = Date.now() - TEXT_DEDUP_MS * 3;
    for (const [k, v] of recentText.entries()) {
      if (!v || v.ts < cutoff) recentText.delete(k);
      if (recentText.size <= 2500) break;
    }
    if (recentText.size > 6000) recentText.clear();
  }

  const previous = latestBySpeaker.get(speaker) || "";
  latestBySpeaker.set(speaker, previous ? `${previous} ${newContent}` : newContent);

  safeSendMessage({ action: "transcriptTick", payload: { line: singleLine, timestamp: nowIso() } });
  markTranscriptActivity();
  scheduleFlushSoon();
}

// =====================================================
// Capture sources
// =====================================================
const captureMeet = () => {
  document.querySelectorAll('div[jsname="tgaKEf"]').forEach((line) => {
    const text = line.innerText?.trim();
    if (!text) return;
    const speaker =
      line.closest(".nMcdL")?.querySelector("span.NWpY1d")?.innerText?.trim() || "Desconhecido";
    appendOncePerNode(line, speaker, text, "Meet");
  });
};

// Teams captions old (fallback raro)
const captureTeamsOld = () => {
  document.querySelectorAll('[data-tid="closed-caption-text"]').forEach((caption) => {
    const text = cleanCaptionText(caption.innerText);
    if (!text) return;
    const speaker =
      cleanCaptionText(
        caption.closest("[data-focuszone-id]")?.querySelector(".ui-chat__message__author")?.innerText
      ) || "Desconhecido";
    appendOncePerNode(caption, speaker, text, "Teams");
  });
};

// ✅ Teams RTT (bufferiza)
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

    noteTeamsRtt(speaker, msg);
  }
};

// ✅ Teams Live Captions v2
const captureTeamsCaptionsV2 = () => {
  const wrapper =
    document.querySelector('[data-tid="closed-caption-renderer-wrapper"]') ||
    document.querySelector('[data-tid="closed-caption-v2-window-wrapper"]');
  if (!wrapper) return;

  const list =
    wrapper.querySelector('[data-tid="closed-caption-v2-virtual-list-content"]') || wrapper;

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

      // ✅ FIX: sempre dedupe por node
      appendOncePerNode(root || authorEl, speaker, msg, "Teams");
    }
    return;
  }

  // fallback: itens
  const items = list.querySelectorAll('[role="listitem"], [data-tid*="closed-caption"], .ui-box, .fui-ChatMessageCompact');
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

    // ✅ FIX CRÍTICO: era appendNewTranscript direto -> causava acúmulo
    appendOncePerNode(item, speaker, msg, "Teams");
  }
};

const captureTeams = () => {
  captureTeamsRTT();
  captureTeamsCaptionsV2();
  captureTeamsOld();
};

const captureSlack = () => {
  document.querySelectorAll(".p-huddle_event_log__base_event").forEach((event) => {
    const speaker =
      event.querySelector(".p-huddle_event_log__member_name")?.innerText?.trim() || "Desconhecido";
    const text = event.querySelector(".p-huddle_event_log__transcription")?.innerText?.trim();
    if (text) appendOncePerNode(event, speaker, text, "Slack");
  });
};

const captureTranscript = () => {
  const url = window.location.href;
  if (url.includes("meet.google.com")) return captureMeet();
  if (url.includes("teams.microsoft.com") || url.includes("teams.live.com")) return captureTeams();
  if (url.includes("slack.com")) return captureSlack();
};

// =====================================================
// Start loops (✅ só TOP FRAME)
// =====================================================
if (isSupportedPage() && IS_TOP_FRAME) {
  loadFixedFlags();

  startTimeoutId = setTimeout(() => {
    captureIntervalId = setInterval(captureTranscript, CAPTURE_INTERVAL_MS);
  }, CAPTURE_START_DELAY_MS);

  flushIntervalId = setInterval(() => flushNow("interval"), FLUSH_INTERVAL_MS);
}
