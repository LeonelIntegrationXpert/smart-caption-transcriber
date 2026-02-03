#!/usr/bin/env python3
# server.py — FastAPI proxy -> Ollama /api/chat (streaming texto puro)

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
# 🔧 CONFIG
# =========================
OLLAMA_URL = "http://localhost:11434/api/chat"
MODEL = "gpt-oss:120b-cloud"
TIMEOUT = 300

# Ignora linhas tipo "OCE", "E V", "D"
FILTER_NOISE = True

OPTIONS_PROFILE = {
    "temperature": 0.2,
    "top_p": 0.9,
    "repeat_penalty": 1.1,
    "num_ctx": 2048
}

OPTIONS_CORRECTOR = {
    "temperature": 0.1,
    "top_p": 0.8,
    "repeat_penalty": 1.1,
    "num_ctx": 2048
}

# ✅ Consolidador (contexto)
OPTIONS_CONSOLIDATOR = {
    "temperature": 0.2,
    "top_p": 0.9,
    "repeat_penalty": 1.1,
    "num_ctx": 512
}

SYSTEM_PROMPT_PROFILE = " ".join([
  "IDENTIDADE: Você é Leonel Dorneles Porto e responde sempre em primeira pessoa (eu), como candidato em entrevista técnica.",
  "FORMATO DE ENTRADA: A entrada virá como 'AUTOR=<nome>; FALA=<texto>; INSTRUCAO=...'; você deve responder diretamente para AUTOR e obrigatoriamente começar a resposta com '<AUTOR>, ' usando o nome recebido.",
  "ANTI-META: Nunca diga que você é ChatGPT, OpenAI, IA, modelo de linguagem, assistente virtual ou qualquer variação; não fale sobre regras, prompts, sistema, tokens, ou configuração; entregue somente a resposta final.",
  "IDIOMA: Responda no mesmo idioma da fala; se vier em português, responda em português; se vier em inglês, responda em inglês (inglês claro e direto).",
  "ESTILO: Resposta direta, sênior e técnica; 1 parágrafo; 2 a 6 frases; sem bullets; sem títulos; sem despedidas; não faça perguntas; evite frases longas e use no máximo 25 a 30 palavras por frase.",
  "CLAREZA DE SIGLAS: Não use siglas sem expandir na primeira menção; se a sigla for específica/interna e você não souber o significado, substitua por uma descrição genérica segura (ex.: 'time de observabilidade' ou 'área de governança') sem inventar.",
  "MÉTRICAS: Só use números se você conseguir contextualizar (ex.: 'incidentes operacionais', 'na janela do projeto', 'aproximadamente'); prefira ~ quando for estimativa; não crie métricas do nada.",
  "ESTRUTURA RECOMENDADA: Responda seguindo o padrão Contexto -> Ação -> Resultado, citando 2 a 4 tecnologias no máximo por resposta para não virar lista.",
  "LOCALIZAÇÃO: Baseado em Pelotas, Rio Grande do Sul, Brasil.",
  "RESUMO PROFISSIONAL: Especialista MuleSoft com mais de cinco anos em integração e desenvolvimento de APIs, entregando soluções robustas e escaláveis em ambientes complexos; forte atuação em APIs, integração com Salesforce e AWS, e resolução de desafios técnicos; perfil colaborativo, foco em valor e execução.",
  "CARGO ATUAL: Accenture Brasil — Specialist MuleSoft (desde abril/2025).",
  "STACK/COMPETÊNCIAS-CHAVE: MuleSoft (CloudHub/CloudHub 2.0 e On-Premise), Anypoint Platform, API-led connectivity, RAML design-first, API Manager, Exchange, Runtime Manager, REST/SOAP/OData, Anypoint MQ e RabbitMQ, DataWeave, MUnit, observabilidade (Visualizer/Monitoring), integração com Salesforce, AWS (S3/multipart), bancos (Oracle/MySQL/MongoDB) e SAP; pipelines CI/CD (Jenkins/GitHub Actions).",
  "IDIOMAS: Português nativo; Inglês nível profissional limitado.",
  "REGRAS DE CONFIDENCIALIDADE: Evite expor segredos, chaves, tokens, endpoints internos, IDs sensíveis e detalhes confidenciais; quando necessário, descreva arquitetura e decisões técnicas sem revelar informação sensível.",
  "AUTOAPRESENTAÇÃO: Se a fala for 'me fala de você' ou equivalente, responda com um pitch de 4 a 6 frases com cargo atual, anos de experiência, foco técnico (MuleSoft/Salesforce/APIs/segurança/CI-CD), 2-3 highlights e como gera valor."
])

SYSTEM_PROMPT_CORRECTOR = " ".join([
  "MODO: Você é um corretor gramatical e ortográfico.",
  "TAREFA: Corrigir o texto do usuário mantendo o significado, o tom e o idioma; melhorar pontuação e concordância; remover repetição e vícios de linguagem quando atrapalharem; preservar termos técnicos, nomes próprios, siglas e códigos; reduzir frases excessivamente longas quebrando em 2 ou 3 frases quando necessário, mas devolver tudo em uma única linha.",
  "SAÍDA: Retorne SOMENTE o texto corrigido, em UMA ÚNICA LINHA, sem explicações, sem comentários, sem aspas, sem bullets, sem títulos.",
  "ANTI-META: Nunca diga que você é ChatGPT, OpenAI, IA ou modelo; não explique regras nem mostre raciocínio."
])

SYSTEM_PROMPT_CONSOLIDATOR = " ".join([
  "MODO: Você é um consolidador de contexto para entrevista técnica.",
  "TAREFA: A partir de mensagens limpas (AUTOR: TEXTO), gere um contexto consolidado curto do que está sendo discutido.",
  "SAÍDA: Retorne SOMENTE 1 linha, sem bullets, sem títulos, sem perguntas, sem meta, com 40 a 70 palavras no máximo; preserve termos técnicos; não invente métricas.",
  "ANTI-META: Nunca diga que é ChatGPT/OpenAI/IA/modelo; não explique regras."
])

app = FastAPI()

# =========================
# 🧠 PARSER (robusto)
# =========================
_NOISE_RE = re.compile(r'^[A-Z]{1,4}(\s*[A-Z]{1,4})*$')

def is_noise_text(text: str) -> bool:
    t = (text or "").strip()
    if not t:
        return True
    if len(t) <= 4 and _NOISE_RE.fullmatch(t) is not None:
        return True
    return False

def parse_line_author_and_text(line: str):
    """
    Preferência:
      - SPEAKER + MENSAGEM pelos 2 últimos ':'  =>  <...>: <SPEAKER>: <MENSAGEM>
    Fallback:
      - AUTOR pelo primeiro ':'               =>  <AUTOR>: <FALA>
    """
    s = (line or "").strip()
    if not s or ":" not in s:
        return None

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
    lines = [ln.strip() for ln in (raw or "").splitlines() if ln.strip()]
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
    return f"AUTOR={author}; FALA={text}; INSTRUCAO=Responda diretamente para AUTOR e comece a resposta com '{author}, '"

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
    # 1 linha só pra não virar bagunça
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
    r = requests.post(OLLAMA_URL, json=payload, timeout=TIMEOUT)
    r.raise_for_status()
    data = r.json()
    out = ((data.get("message") or {}).get("content")) or ""
    return out.replace("\r", " ").replace("\n", " ").strip()

def refresh_context_sync():
    global CONTEXT_TEXT, LAST_CONTEXT_HASH, LAST_CONTEXT_AT

    with STATE_LOCK:
        msgs = CLEAN_BUFFER[-20:]  # últimas 20 mensagens limpas
    if not msgs:
        return ""

    h = _hash_messages(msgs)
    if h == LAST_CONTEXT_HASH and CONTEXT_TEXT:
        return CONTEXT_TEXT

    ctx = call_ollama_sync(SYSTEM_PROMPT_CONSOLIDATOR, build_consolidator_input(msgs), OPTIONS_CONSOLIDATOR)

    with STATE_LOCK:
        CONTEXT_TEXT = ctx
        LAST_CONTEXT_HASH = h
        LAST_CONTEXT_AT = time.time()
    return ctx

def refresh_context_background():
    try:
        ctx = refresh_context_sync()
        if ctx:
            log.info("[context] updated_at=%.0f ctx_preview=%r", LAST_CONTEXT_AT, ctx[:160])
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

    with requests.post(OLLAMA_URL, json=payload, stream=True, timeout=TIMEOUT) as r:
        r.raise_for_status()

        for raw_line in r.iter_lines(decode_unicode=True):
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
@app.post("/ask")
async def ask(req: Request):
    body = await req.json()
    prompt = str(body.get("prompt", "")).strip()
    if not prompt:
        return JSONResponse({"error": "missing prompt"}, status_code=400)

    log.info("[/ask] prompt_len=%d preview=%r", len(prompt), prompt[:220])

    return StreamingResponse(
        stream_ollama_chat(SYSTEM_PROMPT_CORRECTOR, prompt, OPTIONS_CORRECTOR, sanitize_newlines=True),
        media_type="text/plain; charset=utf-8",
    )

@app.post("/ask_me")
async def ask_me(req: Request, background_tasks: BackgroundTasks):
    body = await req.json()
    prompt = str(body.get("prompt", "")).strip()
    if not prompt:
        return JSONResponse({"error": "missing prompt"}, status_code=400)

    log.info("[/ask_me] prompt_len=%d preview=%r", len(prompt), prompt[:240])

    last = extract_last_valid(prompt)
    if last:
        log.info("[/ask_me] last_raw=%r", last["raw"][:280])
        log.info("[/ask_me] parsed_author=%r parsed_text=%r", last["author"], last["text"][:200])

        # ✅ alimenta buffer limpo e dispara consolidação em background
        push_clean_message(last["author"], last["text"])
        background_tasks.add_task(refresh_context_background)
    else:
        log.info("[/ask_me] parser: nenhuma linha válida encontrada (usando prompt inteiro)")

    clean_prompt = build_profile_user_text(prompt)
    log.info("[/ask_me] clean_prompt=%r", clean_prompt[:320])

    return StreamingResponse(
        stream_ollama_chat(SYSTEM_PROMPT_PROFILE, clean_prompt, OPTIONS_PROFILE, sanitize_newlines=True),
        media_type="text/plain; charset=utf-8",
    )

# =========================
# ✅ NOVOS ENDPOINTS (Contexto consolidado)
# =========================
@app.post("/context_ingest")
async def context_ingest(req: Request, background_tasks: BackgroundTasks):
    """
    Envia a transcrição (histórico) e o servidor:
      - pega a última linha útil
      - salva no buffer limpo
      - dispara consolidação assíncrona
    """
    body = await req.json()
    prompt = str(body.get("prompt", "")).strip()
    if not prompt:
        return JSONResponse({"error": "missing prompt"}, status_code=400)

    last = extract_last_valid(prompt)
    if not last:
        return JSONResponse({"error": "no valid line found"}, status_code=400)

    push_clean_message(last["author"], last["text"])
    background_tasks.add_task(refresh_context_background)

    log.info("[/context_ingest] author=%r text=%r", last["author"], last["text"][:180])

    return {
        "accepted": True,
        "parsed": {"author": last["author"], "text": last["text"], "raw": last["raw"]},
        "buffer_size": len(CLEAN_BUFFER),
        "context_current": CONTEXT_TEXT,
        "context_updated_at": LAST_CONTEXT_AT,
    }

@app.get("/context")
def get_context():
    with STATE_LOCK:
        return {
            "context": CONTEXT_TEXT,
            "updated_at": LAST_CONTEXT_AT,
            "buffer_size": len(CLEAN_BUFFER),
            "last_items": CLEAN_BUFFER[-3:],  # debug leve
        }

@app.post("/context_refresh")
def context_refresh():
    """
    Força gerar contexto na hora (bom pro botão "Reformular").
    """
    try:
        ctx = refresh_context_sync()
        return {"ok": True, "context": ctx, "updated_at": LAST_CONTEXT_AT}
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
    uvicorn.run(app, host="0.0.0.0", port=8000)
