#!/usr/bin/env python3
# server.py — FastAPI proxy -> Ollama /api/chat (streaming texto puro)

import os
import sys
import subprocess

# =========================
# 📦 AUTO-INSTALL (libs)
# =========================
REQUIRED = [
    "fastapi",
    "uvicorn[standard]",
    "requests",
]

def _pip_install(pkgs):
    cmd = [sys.executable, "-m", "pip", "install", "--upgrade", *pkgs]
    print("📦 Instalando dependências:", " ".join(pkgs))
    subprocess.check_call(cmd)

def ensure_deps():
    missing = []
    try:
        import fastapi  # noqa
    except Exception:
        missing.append("fastapi")
    try:
        import uvicorn  # noqa
    except Exception:
        missing.append("uvicorn[standard]")
    try:
        import requests  # noqa
    except Exception:
        missing.append("requests")
    if missing:
        _pip_install(missing)

ensure_deps()

# =========================
# ✅ Imports (após install)
# =========================
import json
import re
import time
import hashlib
import threading
import logging
import requests
from fastapi import FastAPI, Request, BackgroundTasks
from fastapi.responses import StreamingResponse, JSONResponse

# =========================
# 🧾 LOGGING
# =========================
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s | %(levelname)s | %(message)s",
)
log = logging.getLogger("mt-ollama-proxy")

# =========================
# 🔧 CONFIG (env override)
# =========================
OLLAMA_URL = os.getenv("OLLAMA_URL", "http://localhost:11434/api/chat")
MODEL = os.getenv("OLLAMA_MODEL", "gpt-oss:120b-cloud")

TIMEOUT = int(os.getenv("OLLAMA_TIMEOUT", "300"))                   # read timeout
CONNECT_TIMEOUT = float(os.getenv("OLLAMA_CONNECT_TIMEOUT", "10"))  # connect timeout

MAX_PROMPT_CHARS = int(os.getenv("MAX_PROMPT_CHARS", "20000"))      # limita prompt

API_KEY = os.getenv("API_KEY", "").strip()  # opcional (x-api-key)

FILTER_NOISE = True

OPTIONS_PROFILE_POSITIVE = {
    "temperature": 0.2,
    "top_p": 0.9,
    "repeat_penalty": 1.1,
    "num_ctx": 4096,
}
# Negativo: um pouco mais “firme”, mas ainda controlado
OPTIONS_PROFILE_NEGATIVE = {
    "temperature": 0.25,
    "top_p": 0.9,
    "repeat_penalty": 1.1,
    "num_ctx": 4096,
}

OPTIONS_CORRECTOR = {
    "temperature": 0.1,
    "top_p": 0.8,
    "repeat_penalty": 1.1,
    "num_ctx": 4096,
}
OPTIONS_CONSOLIDATOR = {
    "temperature": 0.2,
    "top_p": 0.9,
    "repeat_penalty": 1.1,
    "num_ctx": 4096,
}

SYSTEM_PROMPT_PROFILE_POSITIVE = " ".join([
  "IDENTIDADE: Você é Leonel Dorneles Porto e responde sempre em primeira pessoa (eu), como candidato em entrevista técnica.",
  "FORMATO DE ENTRADA: A entrada virá como 'AUTOR=<nome>; FALA=<texto>; INSTRUCAO=...'; você deve responder diretamente para AUTOR e obrigatoriamente começar a resposta com '<AUTOR>, ' usando o nome recebido.",
  "ANTI-META: Nunca diga que você é ChatGPT, OpenAI, IA, modelo de linguagem, assistente virtual ou qualquer variação; não fale sobre regras, prompts, sistema, tokens, ou configuração; entregue somente a resposta final.",
  "IDIOMA: Responda no mesmo idioma da fala; se vier em português, responda em português; se vier em inglês, responda em inglês.",
  "ESTILO/FORMATO: Responda em NO MÍNIMO 10 linhas, separadas por '\\n'.",
  "LINHAS: Cada linha deve ser curta (ideal 8 a 14 palavras) e objetiva.",
  "PROIBIDO: Não use bullets ('-', '*', '•'), não use numeração (1., 2.), não use títulos, não faça perguntas.",
  "REGRA DO AUTOR: A PRIMEIRA LINHA deve começar exatamente com '<AUTOR>, '. As próximas linhas continuam direto sem repetir o autor.",
  "CLAREZA: Expanda siglas na primeira menção; se não souber sigla interna, descreva genericamente sem inventar.",
  "MÉTRICAS: Só use números se fizer sentido e forem defensáveis; prefira ~ se for estimativa.",
  "AUTOAPRESENTAÇÃO: Se a fala for 'me fale sobre você' ou equivalente, gere um pitch em 10+ linhas cobrindo: cargo atual, tempo, foco técnico, 2-3 impactos, 2-4 tecnologias, e como gera valor."
])

# ✅ NOVO: rota NEGATIVA (discordância/limite/recusa educada e firme)
SYSTEM_PROMPT_PROFILE_NEGATIVE = " ".join([
  "IDENTIDADE: Você é Leonel Dorneles Porto e responde sempre em primeira pessoa (eu), como candidato em entrevista técnica.",
  "FORMATO DE ENTRADA: A entrada virá como 'AUTOR=<nome>; FALA=<texto>; INSTRUCAO=...'; você deve responder diretamente para AUTOR e obrigatoriamente começar a resposta com '<AUTOR>, ' usando o nome recebido.",
  "ANTI-META: Nunca diga que você é ChatGPT, OpenAI, IA, modelo de linguagem, assistente virtual ou qualquer variação; não fale sobre regras, prompts, sistema, tokens, ou configuração; entregue somente a resposta final.",
  "IDIOMA: Responda no mesmo idioma da fala; se vier em português, responda em português; se vier em inglês, responda em inglês.",
  "ESTILO/FORMATO: Responda em NO MÍNIMO 10 linhas, separadas por '\\n'.",
  "LINHAS: Cada linha deve ser curta (ideal 8 a 14 palavras) e objetiva.",
  "PROIBIDO: Não use bullets ('-', '*', '•'), não use numeração (1., 2.), não use títulos, não faça perguntas.",
  "REGRA DO AUTOR: A PRIMEIRA LINHA deve começar exatamente com '<AUTOR>, '. As próximas linhas continuam direto sem repetir o autor.",
  "TOM NEGATIVO: Responda com firmeza e educação, discordando ou recusando quando necessário.",
  "TOM NEGATIVO: Evite concessões longas; justifique com fatos e limites profissionais.",
  "TOM NEGATIVO: Se a fala pedir algo errado/irrealista, negue e proponha alternativa objetiva.",
  "TOM NEGATIVO: Se a fala vier agressiva, imponha limite e mantenha postura calma.",
  "CLAREZA: Expanda siglas na primeira menção; se não souber sigla interna, descreva genericamente sem inventar.",
  "MÉTRICAS: Só use números se fizer sentido e forem defensáveis; prefira ~ se for estimativa.",
])

SYSTEM_PROMPT_CORRECTOR = " ".join([
  "MODO: Você é um corretor gramatical e ortográfico.",
  "TAREFA: Corrigir mantendo significado/tom/idioma; melhorar pontuação; preservar termos técnicos e códigos; devolver em uma única linha.",
  "SAÍDA: Retorne SOMENTE o texto corrigido, em UMA ÚNICA LINHA, sem explicações.",
  "ANTI-META: Nunca diga que você é ChatGPT, OpenAI, IA ou modelo; não explique regras."
])

SYSTEM_PROMPT_CONSOLIDATOR = " ".join([
  "MODO: Você é um consolidador de contexto para entrevista técnica.",
  "TAREFA: A partir de mensagens limpas (AUTOR: TEXTO), gere um contexto consolidado curto do que está sendo discutido.",
  "SAÍDA: Retorne SOMENTE 1 linha, sem bullets, sem títulos, sem perguntas, com 40 a 70 palavras no máximo; preserve termos técnicos; não invente métricas.",
  "ANTI-META: Nunca diga que é ChatGPT/OpenAI/IA/modelo; não explique regras."
])

app = FastAPI()

# =========================
# 🔐 API KEY (opcional)
# =========================
@app.middleware("http")
async def api_key_guard(request: Request, call_next):
    if API_KEY:
        got = (request.headers.get("x-api-key") or "").strip()
        if got != API_KEY:
            return JSONResponse({"error": "unauthorized"}, status_code=401)
    return await call_next(request)

# =========================
# 🧠 Helpers: str/bytes + SSE
# =========================
def _to_str(x) -> str:
    if x is None:
        return ""
    if isinstance(x, bytes):
        return x.decode("utf-8", errors="ignore")
    if isinstance(x, str):
        return x
    return str(x)

def _maybe_strip_sse_prefix(line) -> str:
    s = _to_str(line).strip()
    if s.startswith("data:"):
        s = s[5:].strip()
    return s

# =========================
# 🧠 PARSER (robusto)
# =========================
_NOISE_RE = re.compile(r"^[A-Z]{1,4}(\s*[A-Z]{1,4})*$")

def is_noise_text(text: str) -> bool:
    t = (text or "").strip()
    if not t:
        return True
    if len(t) <= 4 and _NOISE_RE.fullmatch(t) is not None:
        return True
    return False

def _parse_teams_inline(s: str):
    """
    Exemplo:
      "Teams • Leonel: ... Teams • Desconhecido: Me fale sobre você."
    Pega o ÚLTIMO "Teams • <autor>: <fala>"
    """
    if "Teams •" not in s:
        return None

    chunks = s.split("Teams • ")
    found = []
    for seg in chunks[1:]:
        if ":" not in seg:
            continue
        speaker, msg = seg.split(":", 1)
        speaker = speaker.strip()
        msg = msg.strip()
        if speaker and msg:
            found.append((speaker, msg))

    if not found:
        return None

    speaker, msg = found[-1]
    author = speaker
    if author.lower() in ("desconhecido", "unknown"):
        author = "Entrevistador"
    return {"author": author, "text": msg, "raw": s}

def parse_line_author_and_text(line: str):
    """
    Prioridade:
      1) Teams inline (múltiplos turnos na mesma linha)
      2) pelos 2 últimos ':' => <...>: <SPEAKER>: <MENSAGEM>
      3) fallback: <AUTOR>: <FALA>
    """
    s = (line or "").strip()
    if not s or ":" not in s:
        return None

    p = _parse_teams_inline(s)
    if p:
        return p

    parts = [p.strip() for p in s.rsplit(":", 2)]
    if len(parts) == 3:
        _prefix, speaker, msg = parts
        if speaker and msg:
            author = speaker
            text = msg
            if author.lower() in ("desconhecido", "unknown"):
                author = "Entrevistador"
            return {"author": author, "text": text, "raw": s}

    author, rest = s.split(":", 1)
    author = author.strip()
    text = rest.strip()
    if not author or not text:
        return None
    if author.lower() in ("desconhecido", "unknown"):
        author = "Entrevistador"
    return {"author": author, "text": text, "raw": s}

def extract_last_valid(raw: str):
    raw = raw or ""
    p_inline = _parse_teams_inline(raw.strip())
    if p_inline and (not FILTER_NOISE or not is_noise_text(p_inline["text"])):
        return p_inline

    lines = [ln.strip() for ln in raw.splitlines() if ln.strip()]
    for ln in reversed(lines):
        p = parse_line_author_and_text(ln)
        if not p:
            continue
        if FILTER_NOISE and is_noise_text(p["text"]):
            continue
        return p
    return None

def build_profile_user_text(raw_prompt: str) -> str:
    last = extract_last_valid(raw_prompt)
    if not last:
        return raw_prompt.strip()
    author = last["author"]
    text = last["text"]
    return (
        f"AUTOR={author}; FALA={text}; "
        f"INSTRUCAO=Responda diretamente para AUTOR e comece a resposta com '{author}, '"
    )

# =========================
# 🧠 CONTEXTO CONSOLIDADO (buffer + cache + async)
# =========================
STATE_LOCK = threading.Lock()
CLEAN_BUFFER = []     # [{ts, author, text}]
CONTEXT_TEXT = ""
LAST_CONTEXT_HASH = ""
LAST_CONTEXT_AT = 0.0

def _hash_messages(msgs):
    raw = "|".join([f'{m.get("author","")}:{m.get("text","")}' for m in msgs])
    return hashlib.sha256(raw.encode("utf-8", errors="ignore")).hexdigest()

def push_clean_message(author: str, text: str, max_keep: int = 60):
    with STATE_LOCK:
        CLEAN_BUFFER.append({"ts": time.time(), "author": author, "text": text})
        if len(CLEAN_BUFFER) > max_keep:
            del CLEAN_BUFFER[:-max_keep]

def build_consolidator_input(msgs):
    s = " | ".join([f'{m["author"]}: {m["text"]}' for m in msgs])
    return f"MENSAGENS={s}"

def call_ollama_sync(system_prompt: str, user_text: str, options: dict) -> str:
    payload = {
        "model": MODEL,
        "stream": False,
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_text},
        ],
        "options": options,
    }
    r = requests.post(
        OLLAMA_URL,
        json=payload,
        timeout=(CONNECT_TIMEOUT, TIMEOUT),
    )
    r.raise_for_status()
    data = r.json()
    out = ((data.get("message") or {}).get("content")) or ""
    return out.replace("\r", " ").replace("\n", " ").strip()

def refresh_context_sync():
    global CONTEXT_TEXT, LAST_CONTEXT_HASH, LAST_CONTEXT_AT

    with STATE_LOCK:
        msgs = CLEAN_BUFFER[-20:]
        current_ctx = CONTEXT_TEXT
        current_hash = LAST_CONTEXT_HASH

    if not msgs:
        return ""

    h = _hash_messages(msgs)
    if h == current_hash and current_ctx:
        return current_ctx

    ctx = call_ollama_sync(
        SYSTEM_PROMPT_CONSOLIDATOR,
        build_consolidator_input(msgs),
        OPTIONS_CONSOLIDATOR,
    )

    with STATE_LOCK:
        CONTEXT_TEXT = ctx
        LAST_CONTEXT_HASH = h
        LAST_CONTEXT_AT = time.time()
        return CONTEXT_TEXT

def refresh_context_background():
    try:
        ctx = refresh_context_sync()
        if ctx:
            with STATE_LOCK:
                at = LAST_CONTEXT_AT
            log.info("[context] updated_at=%.0f ctx_preview=%r", at, ctx[:160])
    except Exception as e:
        log.info("[context] erro ao gerar contexto: %s", e)

# =========================
# 🌊 STREAM OLLAMA
# =========================
def stream_ollama_chat(system_prompt: str, user_text: str, options: dict, sanitize_newlines: bool = True):
    payload = {
        "model": MODEL,
        "stream": True,
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_text},
        ],
        "options": options,
    }

    with requests.post(
        OLLAMA_URL,
        json=payload,
        stream=True,
        timeout=(CONNECT_TIMEOUT, TIMEOUT),
    ) as r:
        r.raise_for_status()

        for raw_line in r.iter_lines(decode_unicode=True):
            if not raw_line:
                continue

            raw_line = _maybe_strip_sse_prefix(raw_line)
            if not raw_line:
                continue

            try:
                msg = json.loads(raw_line)
            except Exception:
                continue

            if msg.get("error"):
                yield f"[ollama_error] {msg['error']}\n"
                return

            chunk = (msg.get("message") or {}).get("content") or ""
            if chunk:
                if sanitize_newlines:
                    chunk = chunk.replace("\r", " ").replace("\n", " ")
                yield chunk

            if msg.get("done"):
                return

# =========================
# ✅ ENDPOINTS
# =========================
@app.get("/health")
def health():
    return {"ok": True}

def _read_prompt_json(body: dict) -> str:
    prompt = str((body or {}).get("prompt", "")).strip()
    if not prompt:
        return ""
    if len(prompt) > MAX_PROMPT_CHARS:
        prompt = prompt[:MAX_PROMPT_CHARS]
    return prompt

def _read_route(body: dict) -> str:
    # opcional: dá pra mandar route no JSON e reutilizar /ask_me
    r = str((body or {}).get("route", "")).strip().lower()
    return r

@app.post("/ask")
async def ask(req: Request):
    try:
        body = await req.json()
    except Exception:
        return JSONResponse({"error": "invalid json"}, status_code=400)

    prompt = _read_prompt_json(body)
    if not prompt:
        return JSONResponse({"error": "missing prompt"}, status_code=400)

    log.info("[/ask] prompt_len=%d preview=%r", len(prompt), prompt[:220])

    return StreamingResponse(
        stream_ollama_chat(SYSTEM_PROMPT_CORRECTOR, prompt, OPTIONS_CORRECTOR, sanitize_newlines=True),
        media_type="text/plain; charset=utf-8",
    )

async def _ask_me_core(req: Request, background_tasks: BackgroundTasks, mode: str):
    """
    mode: "positivo" | "negativo"
    """
    try:
        body = await req.json()
    except Exception:
        return JSONResponse({"error": "invalid json"}, status_code=400)

    prompt = _read_prompt_json(body)
    if not prompt:
        return JSONResponse({"error": "missing prompt"}, status_code=400)

    # Se vier route no JSON, ele pode forçar aqui (mantém compat)
    route = _read_route(body)
    if route in ("negativo", "negative", "no", "hard", "reject"):
        mode = "negativo"

    log.info("[/%s] prompt_len=%d preview=%r", "ask_me" if mode=="positivo" else "ask_me_neg", len(prompt), prompt[:240])

    last = extract_last_valid(prompt)
    if last:
        log.info("[/ask_me] last_raw=%r", last["raw"][:280])
        log.info("[/ask_me] parsed_author=%r parsed_text=%r", last["author"], last["text"][:200])
        push_clean_message(last["author"], last["text"])
        background_tasks.add_task(refresh_context_background)
    else:
        log.info("[/ask_me] parser: nenhuma linha válida encontrada (usando prompt inteiro)")

    clean_prompt = build_profile_user_text(prompt)
    log.info("[/ask_me] clean_prompt=%r", clean_prompt[:320])

    if mode == "negativo":
        sys_prompt = SYSTEM_PROMPT_PROFILE_NEGATIVE
        options = OPTIONS_PROFILE_NEGATIVE
    else:
        sys_prompt = SYSTEM_PROMPT_PROFILE_POSITIVE
        options = OPTIONS_PROFILE_POSITIVE

    return StreamingResponse(
        stream_ollama_chat(sys_prompt, clean_prompt, options, sanitize_newlines=False),
        media_type="text/plain; charset=utf-8",
    )

@app.post("/ask_me")
async def ask_me(req: Request, background_tasks: BackgroundTasks):
    # padrão: positivo (mantém compat com o que você já usa)
    return await _ask_me_core(req, background_tasks, mode="positivo")

# ✅ NOVO ENDPOINT: NEGATIVO
@app.post("/ask_me_neg")
async def ask_me_neg(req: Request, background_tasks: BackgroundTasks):
    return await _ask_me_core(req, background_tasks, mode="negativo")

@app.post("/context_ingest")
async def context_ingest(req: Request, background_tasks: BackgroundTasks):
    try:
        body = await req.json()
    except Exception:
        return JSONResponse({"error": "invalid json"}, status_code=400)

    prompt = _read_prompt_json(body)
    if not prompt:
        return JSONResponse({"error": "missing prompt"}, status_code=400)

    last = extract_last_valid(prompt)
    if not last:
        return JSONResponse({"error": "no valid line found"}, status_code=400)

    push_clean_message(last["author"], last["text"])
    background_tasks.add_task(refresh_context_background)

    log.info("[/context_ingest] author=%r text=%r", last["author"], last["text"][:180])

    with STATE_LOCK:
        buf_size = len(CLEAN_BUFFER)
        ctx = CONTEXT_TEXT
        at = LAST_CONTEXT_AT

    return {
        "accepted": True,
        "parsed": {"author": last["author"], "text": last["text"], "raw": last["raw"]},
        "buffer_size": buf_size,
        "context_current": ctx,
        "context_updated_at": at,
    }

@app.get("/context")
def get_context():
    with STATE_LOCK:
        return {
            "context": CONTEXT_TEXT,
            "updated_at": LAST_CONTEXT_AT,
            "buffer_size": len(CLEAN_BUFFER),
            "last_items": CLEAN_BUFFER[-3:],
        }

@app.post("/context_refresh")
def context_refresh():
    try:
        ctx = refresh_context_sync()
        with STATE_LOCK:
            at = LAST_CONTEXT_AT
        return {"ok": True, "context": ctx, "updated_at": at}
    except Exception as e:
        return JSONResponse({"ok": False, "error": str(e)}, status_code=500)

@app.get("/buffer")
def get_buffer():
    with STATE_LOCK:
        return {"buffer_size": len(CLEAN_BUFFER), "items": CLEAN_BUFFER[-30:]}

# =========================
# ▶️ RUN
# =========================
if __name__ == "__main__":
    import uvicorn
    port = int(os.getenv("PORT", "8000"))
    uvicorn.run(app, host="0.0.0.0", port=port)
