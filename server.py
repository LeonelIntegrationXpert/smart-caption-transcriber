#!/usr/bin/env python3
# server.py — FastAPI chain:
# 1) runs ask-llama.ps1 (streaming)  [8B]
# 2) captures its full output (draft)
# 3) feeds draft + clean prompt into Ollama 120b (streaming)
#
# Endpoints:
#  - POST /ask_llama     -> streams ONLY stage-1 (PowerShell)
#  - POST /ask           -> streams ONLY 120b corrector (as before)
#  - POST /ask_me        -> CHAIN positive (ps1 -> 120b)  ✅ stage1 stream DEFAULT ON
#  - POST /ask_me_neg    -> CHAIN negative (ps1 -> 120b)  ✅ stage1 stream DEFAULT ON
#  - /health, /context*, /buffer (as before)

import os
import sys
import json
import re
import time
import hashlib
import threading
import logging
import subprocess
from pathlib import Path
from typing import Iterator, Optional, Tuple

# =========================
# 📦 AUTO-INSTALL (libs)
# =========================
REQUIRED = ["fastapi", "uvicorn[standard]", "requests", "pydantic"]


def _pip_install(pkgs):
    cmd = [sys.executable, "-m", "pip", "install", "--upgrade", *pkgs]
    print("📦 Instalando dependências:", " ".join(pkgs), flush=True)
    subprocess.check_call(cmd)


def ensure_deps():
    missing = []
    for pkg in REQUIRED:
        mod = pkg.split("[", 1)[0]
        try:
            __import__(mod)
        except Exception:
            missing.append(pkg)
    if missing:
        _pip_install(missing)


ensure_deps()

# =========================
# ✅ Imports (após install)
# =========================
import requests
from fastapi import FastAPI, Request, BackgroundTasks, HTTPException
from fastapi.responses import StreamingResponse, JSONResponse, FileResponse
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field, ValidationError

# =========================
# 🧾 LOGGING
# =========================
logging.basicConfig(level=logging.INFO, format="%(asctime)s | %(levelname)s | %(message)s")
log = logging.getLogger("mt-chain-proxy")

# =========================
# ✅ Streaming headers (anti-buffer)
# =========================
STREAM_HEADERS = {
    "Cache-Control": "no-cache",
    "X-Accel-Buffering": "no",
}

# =========================
# 🔧 CONFIG (env override)
# =========================
BASE_DIR = Path(__file__).parent
INDEX_PATH = BASE_DIR / "index.html"

# ---- Stage 1 (PowerShell / ask-llama.ps1)
POWERSHELL = os.getenv("POWERSHELL_EXE", "powershell.exe")
SCRIPT_DEFAULT = Path(os.getenv("LLAMA_PS1", str(BASE_DIR / "ask-llama.ps1")))

LLAMA_DEFAULT_URL = os.getenv("LLAMA_URL", "http://localhost:8080/completion")
LLAMA_DEFAULT_NPREDICT = int(os.getenv("LLAMA_NPREDICT", "220"))  # ✅ default menor
LLAMA_DEFAULT_TEMPERATURE = float(os.getenv("LLAMA_TEMPERATURE", "0.30"))
LLAMA_DEFAULT_TOPP = float(os.getenv("LLAMA_TOPP", "0.90"))

# ✅ clamps/caps específicos do stage1 (pra evitar textão)
STAGE1_MAX_NPREDICT = int(os.getenv("STAGE1_MAX_NPREDICT", "220"))
STAGE1_STREAM_MAX_BYTES = int(os.getenv("STAGE1_STREAM_MAX_BYTES", "8192"))  # corta o stream do 8B se passar disso
STAGE1_DRAFT_MAX_CHARS = int(os.getenv("STAGE1_DRAFT_MAX_CHARS", "600"))  # draft pro 120B

# ---- Stage 2 (Ollama / 120b)
OLLAMA_URL = os.getenv("OLLAMA_URL", "http://localhost:11434/api/chat")
MODEL = os.getenv("OLLAMA_MODEL", "gpt-oss:120b-cloud")
TIMEOUT = int(os.getenv("OLLAMA_TIMEOUT", "300"))
CONNECT_TIMEOUT = float(os.getenv("OLLAMA_CONNECT_TIMEOUT", "10"))

MAX_PROMPT_CHARS = int(os.getenv("MAX_PROMPT_CHARS", "20000"))
MAX_DRAFT_CHARS = int(os.getenv("MAX_DRAFT_CHARS", "6000"))

API_KEY = os.getenv("API_KEY", "").strip()  # opcional (x-api-key)
FILTER_NOISE = True


def _env_bool(name: str, default: bool) -> bool:
    v = (os.getenv(name, "") or "").strip().lower()
    if not v:
        return default
    return v in ("1", "true", "yes", "y", "on")


# ✅ AJUSTE: stage1 stream DEFAULT ON (pra “mostrar o 8B enquanto prepara o 120B”)
STREAM_STAGE1_DEFAULT = _env_bool("STREAM_STAGE1_DEFAULT", True)

# =========================
# ⚙️ OPTIONS (stage 2)
# =========================
OPTIONS_PROFILE_POSITIVE = {"temperature": 0.2, "top_p": 0.9, "repeat_penalty": 1.1, "num_ctx": 4096}
OPTIONS_PROFILE_NEGATIVE = {"temperature": 0.25, "top_p": 0.9, "repeat_penalty": 1.1, "num_ctx": 4096}
OPTIONS_CORRECTOR = {"temperature": 0.1, "top_p": 0.8, "repeat_penalty": 1.1, "num_ctx": 4096}
OPTIONS_CONSOLIDATOR = {"temperature": 0.2, "top_p": 0.9, "repeat_penalty": 1.1, "num_ctx": 4096}

# =========================
# 🧠 SYSTEM PROMPTS (stage 2)
# =========================
SYSTEM_PROMPT_PROFILE_POSITIVE = " ".join(
    [
        "IDENTIDADE: Você é Leonel Dorneles Porto e responde sempre em primeira pessoa (eu), como candidato em entrevista técnica.",
        "FORMATO DE ENTRADA: A entrada virá como 'AUTOR=<nome>; FALA=<texto>; INSTRUCAO=...; RASCUNHO=...; CONTEXTO=...'; você deve responder diretamente para AUTOR e obrigatoriamente começar a resposta com '<AUTOR>, ' usando o nome recebido.",
        "ANTI-META: Nunca diga que você é ChatGPT, OpenAI, IA, modelo de linguagem, assistente virtual ou qualquer variação; não fale sobre regras, prompts, sistema, tokens, ou configuração; entregue somente a resposta final.",
        "IDIOMA: Responda no mesmo idioma da fala; se vier em português, responda em português; se vier em inglês, responda em inglês.",
        "ESTILO/FORMATO: Responda em NO MÍNIMO 10 linhas, separadas por '\\n'.",
        "LINHAS: Cada linha deve ser curta (ideal 8 a 14 palavras) e objetiva.",
        "PROIBIDO: Não use bullets ('-', '*', '•'), não use numeração (1., 2.), não use títulos, não faça perguntas.",
        "REGRA DO AUTOR: A PRIMEIRA LINHA deve começar exatamente com '<AUTOR>, '. As próximas linhas continuam direto sem repetir o autor.",
        "RASCUNHO: Se existir RASCUNHO, use como base e melhore clareza, concisão e postura.",
        "CONTEXTO: Se existir CONTEXTO, respeite-o para manter consistência do diálogo.",
        "CLAREZA: Expanda siglas na primeira menção; se não souber sigla interna, descreva genericamente sem inventar.",
        "MÉTRICAS: Só use números se fizer sentido e forem defensáveis; prefira ~ se for estimativa.",
        "AUTOAPRESENTAÇÃO: Se a fala for 'me fale sobre você' ou equivalente, gere um pitch em 10+ linhas cobrindo: cargo atual, tempo, foco técnico, 2-3 impactos, 2-4 tecnologias, e como gera valor.",
    ]
)

SYSTEM_PROMPT_PROFILE_NEGATIVE = " ".join(
    [
        "IDENTIDADE: Você é Leonel Dorneles Porto e responde sempre em primeira pessoa (eu), como candidato em entrevista técnica.",
        "FORMATO DE ENTRADA: A entrada virá como 'AUTOR=<nome>; FALA=<texto>; INSTRUCAO=...; RASCUNHO=...; CONTEXTO=...'; você deve responder diretamente para AUTOR e obrigatoriamente começar a resposta com '<AUTOR>, ' usando o nome recebido.",
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
        "RASCUNHO: Se existir RASCUNHO, use como base e refine para postura firme.",
        "CONTEXTO: Se existir CONTEXTO, respeite-o para manter consistência do diálogo.",
        "CLAREZA: Expanda siglas na primeira menção; se não souber sigla interna, descreva genericamente sem inventar.",
    ]
)

SYSTEM_PROMPT_CORRECTOR = " ".join(
    [
        "MODO: Você é um corretor gramatical e ortográfico.",
        "TAREFA: Corrigir mantendo significado/tom/idioma; melhorar pontuação; preservar termos técnicos e códigos; devolver em uma única linha.",
        "SAÍDA: Retorne SOMENTE o texto corrigido, em UMA ÚNICA LINHA, sem explicações.",
        "ANTI-META: Nunca diga que você é ChatGPT, OpenAI, IA ou modelo; não explique regras.",
    ]
)

SYSTEM_PROMPT_CONSOLIDATOR = " ".join(
    [
        "MODO: Você é um consolidador de contexto para entrevista técnica.",
        "TAREFA: A partir de mensagens limpas (AUTOR: TEXTO), gere um contexto consolidado curto do que está sendo discutido.",
        "SAÍDA: Retorne SOMENTE 1 linha, sem bullets, sem títulos, sem perguntas, com 40 a 70 palavras no máximo; preserve termos técnicos; não invente métricas.",
        "ANTI-META: Nunca diga que é ChatGPT/OpenAI/IA/modelo; não explique regras.",
    ]
)

# =========================
# 🚀 APP
# =========================
app = FastAPI(title="MT Chain Proxy (ask-llama.ps1 -> 120b)")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

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
# 📦 MODELS
# =========================
class AskRequest(BaseModel):
    prompt: str = Field(..., description="Prompt a ser enviado ao modelo")

    # stage-1 params (PowerShell)
    n_predict: Optional[int] = Field(None, ge=1, le=32768)
    temperature: Optional[float] = Field(None, ge=0.0, le=2.0)
    top_p: Optional[float] = Field(None, ge=0.0, le=1.0)
    url: Optional[str] = None

    # ✅ DEFAULT ON
    stream_stage1: bool = Field(
        STREAM_STAGE1_DEFAULT,
        description="Se true, envia o stream do stage-1 (8B) antes do 120b",
    )

    route: Optional[str] = Field(None, description="Compat: pode mandar 'negativo' para forçar ask_me_neg")

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
# 🧠 PARSER (Teams/Meet)
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
    author = "Entrevistador" if speaker.lower() in ("desconhecido", "unknown") else speaker
    return {"author": author, "text": msg, "raw": s}

def parse_line_author_and_text(line: str):
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
            author = "Entrevistador" if speaker.lower() in ("desconhecido", "unknown") else speaker
            return {"author": author, "text": msg, "raw": s}

    author, rest = s.split(":", 1)
    author = author.strip()
    text = rest.strip()
    if not author or not text:
        return None
    author = "Entrevistador" if author.lower() in ("desconhecido", "unknown") else author
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

def build_profile_user_text(raw_prompt: str, draft: str = "", context: str = "") -> str:
    last = extract_last_valid(raw_prompt)
    if not last:
        author = "Entrevistador"
        text = (raw_prompt or "").strip()
    else:
        author = last["author"]
        text = last["text"]

    author_safe = (author or "Entrevistador").strip()
    text_safe = (text or "").strip()
    draft_safe = (draft or "").replace("\r", " ").strip()
    context_safe = (context or "").replace("\r", " ").strip()

    out = (
        f"AUTOR={author_safe}; FALA={text_safe}; "
        f"INSTRUCAO=Responda diretamente para AUTOR e comece a resposta com '{author_safe}, '; "
    )
    if draft_safe:
        out += f"RASCUNHO={draft_safe}; "
    if context_safe:
        out += f"CONTEXTO={context_safe}; "
    return out.strip()

# ✅ NOVO: prompt stage1 (8B) também entende AUTOR/FALA
STAGE1_RULES = os.getenv(
    "STAGE1_RULES",
    "REGRAS: 1 único parágrafo, sem quebras de linha; exatamente 1 frase curta; "
    "no máximo 260 caracteres; não faça perguntas; não diga 'começou a entrevista' "
    "nem 'estou pronto'; responda em primeira pessoa; idioma igual ao da FALA; "
    "comece exatamente com '<AUTOR>, '.",
).strip()

def build_stage1_user_text(raw_prompt: str) -> str:
    last = extract_last_valid(raw_prompt)
    if not last:
        author = "Entrevistador"
        text = (raw_prompt or "").strip()
    else:
        author = last["author"]
        text = last["text"]

    author_safe = (author or "Entrevistador").strip()
    text_safe = (text or "").strip()

    # mesmo contrato do ask_me: AUTOR/FALA/INSTRUCAO
    return (
        f"AUTOR={author_safe}; FALA={text_safe}; "
        f"INSTRUCAO=Responda diretamente para AUTOR e comece exatamente com '{author_safe}, '; "
        f"{STAGE1_RULES}"
    ).strip()

# =========================
# 🧠 CONTEXTO CONSOLIDADO
# =========================
STATE_LOCK = threading.Lock()
CLEAN_BUFFER = []  # [{ts, author, text}]
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
    r = requests.post(OLLAMA_URL, json=payload, timeout=(CONNECT_TIMEOUT, TIMEOUT))
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
# 🌊 STAGE 2: STREAM OLLAMA
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
# 🧠 STAGE 1: PowerShell (REALTIME + capture)
# =========================
def _ps_quote(s: str) -> str:
    return "'" + (s or "").replace("'", "''") + "'"

def _effective_stage1_n_predict(req: AskRequest) -> str:
    base = req.n_predict if req.n_predict is not None else LLAMA_DEFAULT_NPREDICT
    try:
        base_i = int(base)
    except Exception:
        base_i = LLAMA_DEFAULT_NPREDICT
    return str(min(max(base_i, 1), STAGE1_MAX_NPREDICT))

def _build_ps_cmd(req: AskRequest) -> list[str]:
    url = (req.url or LLAMA_DEFAULT_URL).strip()
    n_predict = _effective_stage1_n_predict(req)
    temperature = str(req.temperature if req.temperature is not None else LLAMA_DEFAULT_TEMPERATURE)
    top_p = str(req.top_p if req.top_p is not None else LLAMA_DEFAULT_TOPP)

    # ✅ aqui é o pulo do gato: stage1 recebe AUTOR/FALA/INSTRUCAO
    stage1_prompt = build_stage1_user_text(req.prompt)

    # ✅ força UTF-8 no PowerShell (reduz “Ãª/Ã§”)
    ps_prefix = " ".join(
        [
            "$ProgressPreference='SilentlyContinue';",
            "$InformationPreference='Continue';",
            "$OutputEncoding = New-Object System.Text.UTF8Encoding $false;",
            "[Console]::OutputEncoding = $OutputEncoding;",
        ]
    )

    # ✅ 6>&1 captura Write-Host (Information stream) + outros streams pro stdout
    cmd = " ".join(
        [
            ps_prefix,
            "&",
            _ps_quote(str(SCRIPT_DEFAULT)),
            "-Prompt",
            _ps_quote(stage1_prompt),
            "-NPredict",
            n_predict,
            "-Temperature",
            temperature,
            "-TopP",
            top_p,
            "-Url",
            _ps_quote(url),
            "-Stream",
            "6>&1",
        ]
    )
    return [
        POWERSHELL,
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        cmd,
    ]

_ANSI_RE = re.compile(r"\x1b\[[0-9;]*[A-Za-z]")
_PS_PROMPT_RE = re.compile(r"^\s*PS\s+[A-Z]:\\.*?>\s*", re.IGNORECASE)

def _clean_stage1_text(raw: str) -> str:
    s = raw or ""
    s = _ANSI_RE.sub("", s)

    lines = []
    for ln in s.replace("\r\n", "\n").replace("\r", "\n").split("\n"):
        if _PS_PROMPT_RE.match(ln):
            continue
        if ln.strip().startswith("[setup]"):
            continue
        lines.append(ln)

    s = "\n".join(lines).strip()

    if "```" in s:
        s = s.split("```", 1)[0].strip()

    s = re.sub(r"[ \t]+", " ", s).strip()

    # ✅ draft bem curto pro stage2
    if len(s) > STAGE1_DRAFT_MAX_CHARS:
        s = s[:STAGE1_DRAFT_MAX_CHARS].rstrip() + "…"

    if len(s) > MAX_DRAFT_CHARS:
        s = s[:MAX_DRAFT_CHARS].rstrip() + "…"
    return s

def stream_and_collect_llama_ps(req: AskRequest) -> Tuple[Iterator[bytes], bytearray]:
    if not SCRIPT_DEFAULT.exists():
        raise FileNotFoundError(f"Script não encontrado: {SCRIPT_DEFAULT}")

    cmd = _build_ps_cmd(req)
    log.info("[stage1] script=%s exists=%s", str(SCRIPT_DEFAULT), SCRIPT_DEFAULT.exists())
    log.info("[stage1] cmd=%r", cmd)

    proc = subprocess.Popen(
        cmd,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=False,
        bufsize=0,
    )
    buf = bytearray()

    def _gen() -> Iterator[bytes]:
        try:
            if not proc.stdout:
                return

            if os.name == "nt":
                import ctypes
                import msvcrt

                k32 = ctypes.windll.kernel32
                handle = msvcrt.get_osfhandle(proc.stdout.fileno())
                avail = ctypes.c_ulong(0)

                while True:
                    ok = k32.PeekNamedPipe(handle, None, 0, None, ctypes.byref(avail), None)
                    if not ok:
                        if proc.poll() is not None:
                            break
                        time.sleep(0.01)
                        continue

                    n = int(avail.value)
                    if n > 0:
                        chunk = os.read(proc.stdout.fileno(), min(n, 8192))
                        if not chunk:
                            if proc.poll() is not None:
                                break
                            time.sleep(0.005)
                            continue

                        buf.extend(chunk)
                        yield chunk

                        # ✅ corta o stream do stage1 se passar do limite
                        if STAGE1_STREAM_MAX_BYTES > 0 and len(buf) >= STAGE1_STREAM_MAX_BYTES:
                            try:
                                proc.terminate()
                            except Exception:
                                pass
                            break

                        continue

                    if proc.poll() is not None:
                        break
                    time.sleep(0.01)
            else:
                while True:
                    chunk = proc.stdout.read(256)
                    if not chunk:
                        if proc.poll() is not None:
                            break
                        time.sleep(0.01)
                        continue
                    buf.extend(chunk)
                    yield chunk
                    if STAGE1_STREAM_MAX_BYTES > 0 and len(buf) >= STAGE1_STREAM_MAX_BYTES:
                        try:
                            proc.terminate()
                        except Exception:
                            pass
                        break

        except GeneratorExit:
            pass
        finally:
            try:
                if proc.poll() is None:
                    proc.terminate()
            except Exception:
                pass
            try:
                proc.wait(timeout=2)
            except Exception:
                try:
                    proc.kill()
                except Exception:
                    pass

    return _gen(), buf

# =========================
# 🔎 Request JSON read + validate
# =========================
async def _read_payload(request: Request) -> AskRequest:
    raw = await request.body()
    raw_text = raw.decode("utf-8", errors="replace")

    try:
        data = json.loads(raw_text) if raw_text.strip() else {}
    except Exception:
        raise HTTPException(status_code=400, detail="Body não é JSON válido")

    if not isinstance(data, dict):
        raise HTTPException(status_code=400, detail="JSON precisa ser objeto (dict)")

    try:
        payload = AskRequest.model_validate(data)
    except ValidationError:
        raise HTTPException(status_code=400, detail="Payload inválido (esperado: {prompt: string, ...})")

    prompt = (payload.prompt or "").strip()
    if not prompt:
        raise HTTPException(status_code=400, detail="Campo 'prompt' ausente/vazio")

    if len(prompt) > MAX_PROMPT_CHARS:
        payload.prompt = prompt[:MAX_PROMPT_CHARS]
    return payload

# =========================
# 🌐 HTML
# =========================
@app.get("/")
def serve_root():
    if not INDEX_PATH.exists():
        return JSONResponse({"error": "index.html não encontrado"}, status_code=404)
    return FileResponse(str(INDEX_PATH), media_type="text/html")

@app.get("/index.html")
def serve_index():
    if not INDEX_PATH.exists():
        return JSONResponse({"error": "index.html não encontrado"}, status_code=404)
    return FileResponse(str(INDEX_PATH), media_type="text/html")

# =========================
# ✅ HEALTH
# =========================
@app.get("/health")
def health():
    return {
        "ok": True,
        "stage1": {
            "script": str(SCRIPT_DEFAULT),
            "script_exists": SCRIPT_DEFAULT.exists(),
            "default_url": LLAMA_DEFAULT_URL,
            "stream_stage1_default": STREAM_STAGE1_DEFAULT,
            "stage1_max_n_predict": STAGE1_MAX_NPREDICT,
            "stage1_stream_max_bytes": STAGE1_STREAM_MAX_BYTES,
            "stage1_draft_max_chars": STAGE1_DRAFT_MAX_CHARS,
        },
        "stage2": {
            "ollama_url": OLLAMA_URL,
            "model": MODEL,
        },
    }

# =========================
# ✅ STAGE 1 ONLY
# =========================
@app.post("/ask_llama")
async def ask_llama(req: Request):
    payload = await _read_payload(req)
    try:
        gen, _buf = stream_and_collect_llama_ps(payload)
        return StreamingResponse(gen, media_type="text/plain; charset=utf-8", headers=STREAM_HEADERS)
    except FileNotFoundError as e:
        return JSONResponse({"error": str(e)}, status_code=500)
    except Exception as e:
        return JSONResponse({"error": f"Erro ao chamar PowerShell: {e}"}, status_code=500)

# =========================
# ✅ STAGE 2 ONLY (corrector)
# =========================
def _read_prompt_json(body: dict) -> str:
    prompt = str((body or {}).get("prompt", "")).strip()
    if not prompt:
        return ""
    if len(prompt) > MAX_PROMPT_CHARS:
        prompt = prompt[:MAX_PROMPT_CHARS]
    return prompt

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
        headers=STREAM_HEADERS,
    )

# =========================
# ✅ CHAIN CORE
# =========================
def _read_route(body: dict) -> str:
    return str((body or {}).get("route", "")).strip().lower()

def chain_stream(payload: AskRequest, background_tasks: BackgroundTasks, mode: str) -> Iterator[bytes]:
    last = extract_last_valid(payload.prompt)
    if last:
        push_clean_message(last["author"], last["text"])
        background_tasks.add_task(refresh_context_background)

    with STATE_LOCK:
        ctx_now = CONTEXT_TEXT

    # ---- Stage 1 (ask-llama.ps1): realtime stream + capture
    try:
        gen1, buf = stream_and_collect_llama_ps(payload)

        if payload.stream_stage1:
            yield b"[stage1]\n"
            for ch in gen1:
                yield ch
            yield b"\n[stage1_done]\n"
        else:
            for _ in gen1:
                pass

        draft_raw = _to_str(bytes(buf))
        draft = _clean_stage1_text(draft_raw)

    except Exception as e:
        draft = ""
        log.info("[chain] stage1_error=%s", e)
        if payload.stream_stage1:
            yield b"[stage1_error] "
            yield _to_str(e).encode("utf-8", errors="ignore")
            yield b"\n"

    # ---- Stage 2: stream 120b (só começa depois do stage1 terminar)
    if mode == "negativo":
        sys_prompt = SYSTEM_PROMPT_PROFILE_NEGATIVE
        options = OPTIONS_PROFILE_NEGATIVE
    else:
        sys_prompt = SYSTEM_PROMPT_PROFILE_POSITIVE
        options = OPTIONS_PROFILE_POSITIVE

    user_text = build_profile_user_text(payload.prompt, draft=draft, context=ctx_now)

    log.info(
        "[chain] mode=%s prompt_len=%d draft_len=%d ctx_len=%d stream_stage1=%s",
        mode,
        len(payload.prompt or ""),
        len(draft or ""),
        len(ctx_now or ""),
        payload.stream_stage1,
    )

    if payload.stream_stage1:
        yield b"\n[stage2]\n"

    for chunk in stream_ollama_chat(sys_prompt, user_text, options, sanitize_newlines=False):
        yield _to_str(chunk).encode("utf-8", errors="ignore")

# =========================
# ✅ CHAIN ENDPOINTS
# =========================
async def _ask_me_core(req: Request, background_tasks: BackgroundTasks, mode: str):
    payload = await _read_payload(req)

    try:
        body = await req.json()
    except Exception:
        body = {}

    route = _read_route(body)
    if route in ("negativo", "negative", "no", "hard", "reject"):
        mode = "negativo"

    return StreamingResponse(
        chain_stream(payload, background_tasks, mode=mode),
        media_type="text/plain; charset=utf-8",
        headers=STREAM_HEADERS,
    )

@app.post("/ask_me")
async def ask_me(req: Request, background_tasks: BackgroundTasks):
    return await _ask_me_core(req, background_tasks, mode="positivo")

@app.post("/ask_me_neg")
async def ask_me_neg(req: Request, background_tasks: BackgroundTasks):
    return await _ask_me_core(req, background_tasks, mode="negativo")

# =========================
# 🧾 Context endpoints (as before)
# =========================
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
    uvicorn.run(app, host="0.0.0.0", port=port, reload=False)
