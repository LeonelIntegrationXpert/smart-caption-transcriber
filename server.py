#!/usr/bin/env python3
# server.py — FastAPI chain:
# 1) calls llama.cpp /completion directly (streaming)  [8B stage-1]
# 2) captures its full output (draft)
# 3) feeds draft + clean prompt into Ollama 120b (streaming)
#
# Endpoints:
#  - POST /ask_llama     -> streams ONLY stage-1 (llama.cpp /completion)
#  - POST /ask           -> streams ONLY 120b corrector
#  - POST /ask_me        -> CHAIN positive (stage1 -> 120b) ✅ stage1 stream DEFAULT ON
#  - POST /ask_me_neg    -> CHAIN negative (stage1 -> 120b) ✅ stage1 stream DEFAULT ON
#  - /health noting prompt files
#
# ✅ Prompts fora do código (TXT):
#  - prompts/stage1_system.txt
#  - prompts/stage1_rules_positive.txt
#  - prompts/stage1_rules_negative.txt
#  - prompts/stage2_profile_positive.txt
#  - prompts/stage2_profile_negative.txt
#  - prompts/stage2_corrector.txt
#  - prompts/stage2_consolidator.txt

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
from datetime import datetime

try:
    from zoneinfo import ZoneInfo  # py 3.9+
except Exception:
    ZoneInfo = None

# =========================
# 📦 AUTO-INSTALL (libs)
# =========================
REQUIRED = ["fastapi", "uvicorn[standard]", "requests", "pydantic"]


def _pip_install(pkgs):
    cmd = [sys.executable, "-m", "pip", "install", "--upgrade", *pkgs]
    print("📦 Installing dependencies:", " ".join(pkgs), flush=True)
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
# ✅ Imports (after install)
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

# =========================
# 📄 PROMPTS (TXT external)
# =========================
PROMPTS_DIR = Path(os.getenv("PROMPTS_DIR", str(BASE_DIR / "prompts")))
PROMPTS_STRICT = (os.getenv("PROMPTS_STRICT", "true").strip().lower() in ("1", "true", "yes", "y", "on"))
PROMPTS_AUTO_RELOAD = (os.getenv("PROMPTS_AUTO_RELOAD", "true").strip().lower() in ("1", "true", "yes", "y", "on"))

PROMPT_FILES = {
    "stage1_system": "stage1_system.txt",
    "stage1_rules_positive": "stage1_rules_positive.txt",
    "stage1_rules_negative": "stage1_rules_negative.txt",
    "stage2_profile_positive": "stage2_profile_positive.txt",
    "stage2_profile_negative": "stage2_profile_negative.txt",
    "stage2_corrector": "stage2_corrector.txt",
    "stage2_consolidator": "stage2_consolidator.txt",
}

_PROMPT_CACHE = {}  # key -> {"text": str, "mtime": float}


def _read_text_file(path: Path) -> str:
    # strip BOM + trailing whitespace
    txt = path.read_text(encoding="utf-8", errors="replace")
    txt = txt.lstrip("\ufeff").strip()
    return txt


def load_prompt(key: str) -> str:
    if key not in PROMPT_FILES:
        raise RuntimeError(f"Unknown prompt key: {key}")
    path = PROMPTS_DIR / PROMPT_FILES[key]
    if not path.exists():
        if PROMPTS_STRICT:
            raise RuntimeError(f"Missing prompt file: {path}")
        log.warning("[prompts] missing file: %s (returning empty)", path)
        return ""

    try:
        mtime = path.stat().st_mtime
    except Exception:
        mtime = 0.0

    cached = _PROMPT_CACHE.get(key)
    if cached and (not PROMPTS_AUTO_RELOAD or cached.get("mtime") == mtime):
        return cached.get("text", "")

    txt = _read_text_file(path)
    _PROMPT_CACHE[key] = {"text": txt, "mtime": mtime}
    return txt


def _load_all_prompts_on_startup():
    # fail-fast se PROMPTS_STRICT=true
    for k in PROMPT_FILES.keys():
        _ = load_prompt(k)
    log.info("[prompts] loaded dir=%s strict=%s auto_reload=%s", PROMPTS_DIR, PROMPTS_STRICT, PROMPTS_AUTO_RELOAD)


_load_all_prompts_on_startup()

# =========================
# 🕒 TIME CONTEXT (runtime)
# =========================
def _env_bool(name: str, default: bool) -> bool:
    v = (os.getenv(name, "") or "").strip().lower()
    if not v:
        return default
    return v in ("1", "true", "yes", "y", "on")


TIME_CONTEXT_ENABLED = _env_bool("TIME_CONTEXT_ENABLED", True)
TIME_CONTEXT_TZ = os.getenv("TIME_CONTEXT_TZ", "America/Sao_Paulo").strip() or "America/Sao_Paulo"
TIME_CONTEXT_LOCATION = os.getenv("TIME_CONTEXT_LOCATION", "Pelotas, Rio Grande do Sul, Brazil").strip() or "Pelotas, Rio Grande do Sul, Brazil"
TIME_CONTEXT_INCLUDE_ISO = _env_bool("TIME_CONTEXT_INCLUDE_ISO", True)

_WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]
_MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"]
_ORDINAL_1_31 = {
    1: "first", 2: "second", 3: "third", 4: "fourth", 5: "fifth", 6: "sixth", 7: "seventh", 8: "eighth", 9: "ninth", 10: "tenth",
    11: "eleventh", 12: "twelfth", 13: "thirteenth", 14: "fourteenth", 15: "fifteenth", 16: "sixteenth", 17: "seventeenth",
    18: "eighteenth", 19: "nineteenth", 20: "twentieth", 21: "twenty-first", 22: "twenty-second", 23: "twenty-third",
    24: "twenty-fourth", 25: "twenty-fifth", 26: "twenty-sixth", 27: "twenty-seventh", 28: "twenty-eighth",
    29: "twenty-ninth", 30: "thirtieth", 31: "thirty-first",
}

_UNITS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen"]
_TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"]


def _num_to_words(n: int) -> str:
    n = int(n)
    if n < 0:
        return "minus " + _num_to_words(-n)
    if n < 20:
        return _UNITS[n]
    if n < 100:
        tens = n // 10
        rem = n % 10
        return _TENS[tens] if rem == 0 else f"{_TENS[tens]}-{_UNITS[rem]}"
    if n < 1000:
        h = n // 100
        rem = n % 100
        return f"{_UNITS[h]} hundred" if rem == 0 else f"{_UNITS[h]} hundred {_num_to_words(rem)}"
    if n < 10000:
        th = n // 1000
        rem = n % 1000
        head = f"{_UNITS[th]} thousand"
        return head if rem == 0 else f"{head} {_num_to_words(rem)}"
    return str(n)


def _year_to_words(y: int) -> str:
    # 2000–2099 friendly: "two thousand twenty-six"
    y = int(y)
    if 2000 <= y <= 2099:
        rem = y - 2000
        if rem == 0:
            return "two thousand"
        if rem < 100:
            return "two thousand " + _num_to_words(rem)
    return _num_to_words(y)


def _minute_to_words(m: int) -> str:
    m = int(m)
    if m == 0:
        return "o'clock"
    if m < 10:
        return "oh " + _num_to_words(m)
    return _num_to_words(m)


def _time_to_words(dt: datetime) -> str:
    # twelve-hour with am/pm
    hour = int(dt.hour)
    minute = int(dt.minute)
    ampm = "a.m." if hour < 12 else "p.m."
    h12 = hour % 12
    if h12 == 0:
        h12 = 12
    if minute == 0:
        return f"{_num_to_words(h12)} o'clock {ampm}"
    return f"{_num_to_words(h12)} {_minute_to_words(minute)} {ampm}"


def _utc_offset_words(dt: datetime) -> str:
    try:
        off = dt.utcoffset()
        if off is None:
            return "UTC"
        total_min = int(off.total_seconds() // 60)
        if total_min == 0:
            return "UTC plus zero"
        sign = "plus" if total_min > 0 else "minus"
        total_min = abs(total_min)
        hh = total_min // 60
        mm = total_min % 60
        if mm == 0:
            return f"UTC {sign} {_num_to_words(hh)}"
        return f"UTC {sign} {_num_to_words(hh)} hours {_num_to_words(mm)} minutes"
    except Exception:
        return "UTC"


def _now_local() -> datetime:
    if ZoneInfo:
        try:
            return datetime.now(ZoneInfo(TIME_CONTEXT_TZ))
        except Exception:
            return datetime.now()
    return datetime.now()


def time_context_line() -> str:
    if not TIME_CONTEXT_ENABLED:
        return ""
    dt = _now_local()
    weekday = _WEEKDAYS[dt.weekday()]
    month = _MONTHS[dt.month - 1]
    day_ord = _ORDINAL_1_31.get(dt.day, _num_to_words(dt.day))
    year_words = _year_to_words(dt.year)
    time_words = _time_to_words(dt)
    offset_words = _utc_offset_words(dt)

    base = (
        f"Location is {TIME_CONTEXT_LOCATION}. "
        f"Time zone is {TIME_CONTEXT_TZ}, {offset_words}. "
        f"Now is {weekday}, {month} {day_ord}, {year_words}, {time_words}."
    )
    if TIME_CONTEXT_INCLUDE_ISO:
        base += f" ISO_8601={dt.isoformat()}."
    return base.strip()


def _with_time(prompt_text: str) -> str:
    tc = time_context_line()
    if not tc:
        return (prompt_text or "").strip()
    p = (prompt_text or "").strip()
    return (p + "\n\n" + "TIME CONTEXT: " + tc).strip()


# =========================
# 👤 PROFILE CONTEXT (runtime injection)
# =========================
PROFILE_CONTEXT_ENABLED = _env_bool("PROFILE_CONTEXT_ENABLED", True)

PROFILE_CONTEXT_BLOCK = (
    "PROFILE CONTEXT: I am Brazilian and I am based in Pelotas, Rio Grande do Sul, Brazil. "
    "I am an integration professional focused on MuleSoft Anypoint Platform, Design Center, RAML, and DataWeave, "
    "with over five years of hands-on experience delivering API-led integrations and enterprise-grade solutions. "
    "My background includes consulting and delivery roles across organizations such as Accenture Brasil, Capgemini, IBM, "
    "Tata Consultancy Services, Compass UOL, SYS4B, Mouts TI, and Gestor SA. "
    "I am currently not employed and I am available for new opportunities. "
    "I hold Salesforce certifications including Salesforce Certified Agentforce Specialist, Salesforce Certified Administrator, "
    "Salesforce Certified Advanced Administrator, Salesforce Certified Platform App Builder, Salesforce Certified Associate, "
    "Salesforce Certified Marketing Associate, Salesforce Certified JavaScript Developer I, Salesforce Certified MuleSoft Associate, "
    "Salesforce Certified MuleSoft Developer I, and Salesforce Certified MuleSoft Platform Architect I. "
    "If asked about compensation, I state around five thousand US dollars per month, unless the user prompt provides a different amount or cadence. "
    "When responding in English, I write numbers in words in normal prose while preserving standard technical tokens such as OAuth 2.0, HTTP 500, Mule 4, and TLS 1.2."
).strip()


def _with_profile(prompt_text: str) -> str:
    p = (prompt_text or "").strip()
    if not PROFILE_CONTEXT_ENABLED:
        return p
    if not p:
        return PROFILE_CONTEXT_BLOCK
    return (p + "\n\n" + PROFILE_CONTEXT_BLOCK).strip()


def _with_profile_and_time(prompt_text: str) -> str:
    return _with_time(_with_profile(prompt_text))


# ---- Stage 1 (llama.cpp /completion)
LLAMA_DEFAULT_URL = os.getenv("LLAMA_URL", "http://localhost:8080/completion")
LLAMA_DEFAULT_NPREDICT = int(os.getenv("LLAMA_NPREDICT", "220"))
LLAMA_DEFAULT_TEMPERATURE = float(os.getenv("LLAMA_TEMPERATURE", "0.30"))
LLAMA_DEFAULT_TOPK = int(os.getenv("LLAMA_TOPK", "40"))
LLAMA_DEFAULT_TOPP = float(os.getenv("LLAMA_TOPP", "0.90"))
LLAMA_DEFAULT_TYPICALP = float(os.getenv("LLAMA_TYPICALP", "1.0"))
LLAMA_DEFAULT_MINP = float(os.getenv("LLAMA_MINP", "0.05"))
LLAMA_DEFAULT_REPEAT_LAST_N = int(os.getenv("LLAMA_REPEAT_LAST_N", "64"))
LLAMA_DEFAULT_REPEAT_PENALTY = float(os.getenv("LLAMA_REPEAT_PENALTY", "1.0"))
LLAMA_DEFAULT_PRESENCE_PENALTY = float(os.getenv("LLAMA_PRESENCE_PENALTY", "0.0"))
LLAMA_DEFAULT_FREQUENCY_PENALTY = float(os.getenv("LLAMA_FREQUENCY_PENALTY", "0.0"))
STAGE1_CONNECT_TIMEOUT = float(os.getenv("STAGE1_CONNECT_TIMEOUT", "5"))
STAGE1_TIMEOUT = float(os.getenv("STAGE1_TIMEOUT", "120"))

# ---- Stage 1 clamps/caps (avoid long output)
STAGE1_MAX_NPREDICT = int(os.getenv("STAGE1_MAX_NPREDICT", "220"))
STAGE1_STREAM_MAX_BYTES = int(os.getenv("STAGE1_STREAM_MAX_BYTES", "2048"))  # preview cap
STAGE1_DRAFT_MAX_CHARS = int(os.getenv("STAGE1_DRAFT_MAX_CHARS", "480"))

# ---- Stage 2 (Ollama / 120b)
OLLAMA_URL = os.getenv("OLLAMA_URL", "http://localhost:11434/api/chat")
MODEL = os.getenv("OLLAMA_MODEL", "gpt-oss:120b-cloud")
TIMEOUT = int(os.getenv("OLLAMA_TIMEOUT", "300"))
CONNECT_TIMEOUT = float(os.getenv("OLLAMA_CONNECT_TIMEOUT", "10"))
MAX_PROMPT_CHARS = int(os.getenv("MAX_PROMPT_CHARS", "20000"))
MAX_DRAFT_CHARS = int(os.getenv("MAX_DRAFT_CHARS", "6000"))

API_KEY = os.getenv("API_KEY", "").strip()  # optional x-api-key
FILTER_NOISE = True

# stage1 stream default ON (preview the 8B while 120B prepares)
STREAM_STAGE1_DEFAULT = _env_bool("STREAM_STAGE1_DEFAULT", True)

# =========================
# ✅ MODE RESOLVER (route -> positivo/negativo)
# =========================
def resolve_mode(route: str, default_mode: str = "positivo") -> str:
    r = (route or "").strip().lower()
    if r in ("negativo", "negative", "no", "hard", "reject", "sad", "triste"):
        return "negativo"
    if r in ("positivo", "positive", "yes", "soft", "happy", "feliz"):
        return "positivo"
    return default_mode


# =========================
# ⚙️ OPTIONS (stage 2)
# =========================
OPTIONS_PROFILE_POSITIVE = {"temperature": 0.2, "top_p": 0.9, "repeat_penalty": 1.1, "num_ctx": 4096}
OPTIONS_PROFILE_NEGATIVE = {"temperature": 0.25, "top_p": 0.9, "repeat_penalty": 1.1, "num_ctx": 4096}
OPTIONS_CORRECTOR = {"temperature": 0.1, "top_p": 0.8, "repeat_penalty": 1.1, "num_ctx": 4096}
OPTIONS_CONSOLIDATOR = {"temperature": 0.2, "top_p": 0.9, "repeat_penalty": 1.1, "num_ctx": 4096}

# =========================
# 🧠 PROMPTS (loaded from txt)
# =========================
def get_stage2_profile_prompt(mode: str) -> str:
    if (mode or "").strip().lower() == "negativo":
        return _with_profile_and_time(load_prompt("stage2_profile_negative"))
    return _with_profile_and_time(load_prompt("stage2_profile_positive"))


SYSTEM_PROMPT_CORRECTOR = lambda: _with_time(load_prompt("stage2_corrector"))
SYSTEM_PROMPT_CONSOLIDATOR = lambda: _with_time(load_prompt("stage2_consolidator"))

# =========================
# ✅ Stage 1 (llama.cpp) chat template + system
# =========================
STAGE1_SYSTEM = lambda: load_prompt("stage1_system")
STAGE1_RULES_POSITIVE = lambda: load_prompt("stage1_rules_positive")
STAGE1_RULES_NEGATIVE = lambda: load_prompt("stage1_rules_negative")
STAGE1_STOP = ["<|eot_id|>"]


def build_llama3_chat_prompt(system: str, user: str) -> str:
    sys_txt = (system or "").replace("\r", "").strip()
    usr_txt = (user or "").replace("\r", "").strip()
    return (
        "<|begin_of_text|><|start_header_id|>system<|end_header_id|>\n"
        f"{sys_txt}\n"
        "<|eot_id|><|start_header_id|>user<|end_header_id|>\n"
        f"{usr_txt}\n"
        "<|eot_id|><|start_header_id|>assistant<|end_header_id|>\n\n"
    )


def strip_prompt_echo(text: str) -> str:
    if not text:
        return text
    marker = "<|start_header_id|>assistant<|end_header_id|>"
    i = text.lower().find(marker.lower())
    if i >= 0:
        return text[i + len(marker):].strip()
    return text.strip()


def find_stop_index(text: str, markers: list[str]) -> int:
    if not text or not markers:
        return -1
    best = -1
    for m in markers:
        if not m:
            continue
        j = text.lower().find(m.lower())
        if j >= 0 and (best < 0 or j < best):
            best = j
    return best


# =========================
# 🚀 APP
# =========================
app = FastAPI(title="MT Chain Proxy (llama.cpp -> 120b)")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# =========================
# 🔐 API KEY (optional)
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
    prompt: str = Field(..., description="Prompt text")
    # stage-1 params (llama.cpp)
    n_predict: Optional[int] = Field(None, ge=1, le=32768)
    temperature: Optional[float] = Field(None, ge=0.0, le=2.0)
    top_p: Optional[float] = Field(None, ge=0.0, le=1.0)
    url: Optional[str] = None
    # default ON
    stream_stage1: bool = Field(
        STREAM_STAGE1_DEFAULT,
        description="If true, streams stage-1 (8B) before stage-2 (120B)",
    )
    route: Optional[str] = Field(None, description="Compat: send 'negative'/'positive' to force mood")


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
# 🧠 Greeting/thanks/bye detection (Stage1 deterministic)
# =========================
_IDIOMA_RE = re.compile(r"\bIDIOMA\s*:\s*([A-Za-z_-]+)\b", re.IGNORECASE)

_GREET_ONLY_RE = re.compile(
    r"^\s*(hi|hello|hey|yo|good\s+morning|good\s+afternoon|good\s+evening|"
    r"oi|ol[aá]|eae|ea[ií]|bom\s+dia|boa\s+tarde|boa\s+noite)\s*[!.\s🙏😊😄🙂]*$",
    re.IGNORECASE,
)
_THANKS_ONLY_RE = re.compile(
    r"^\s*(thanks|thank\s+you|thx|tks|valeu|obrigado|obrigada|brigad[ao])\s*[!.\s🙏😊😄🙂]*$",
    re.IGNORECASE,
)
_BYE_ONLY_RE = re.compile(
    r"^\s*(bye|goodbye|see\s+you|cya|see\s+ya|tchau|flw|até\s+mais|ate\s+mais|até)\s*[!.\s🙏😊😄🙂]*$",
    re.IGNORECASE,
)
_HOW_ARE_YOU_ONLY_RE = re.compile(
    r"^\s*("
    r"how\s+are\s+you|how\s+are\s+u|how\s+r\s+u|how\s+ya\s+doing|how\s+is\s+it\s+going|"
    r"como\s+voce\s+ta|como\s+vc\s+ta|como\s+você\s+tá|como\s+você\s+está|como\s+vc\s+est[aá]|"
    r"tudo\s+bem|td\s+bem"
    r")\s*[!.\s🙏😊😄🙂]*$",
    re.IGNORECASE,
)


def _hint_lang_from_text(text: str) -> str:
    t = (text or "").lower()
    m = _IDIOMA_RE.search(text or "")
    if m:
        val = (m.group(1) or "").lower()
        if "pt" in val or "port" in val:
            return "pt"
        if "en" in val or "eng" in val:
            return "en"
    pt_markers = [" oi", "olá", "ola", "bom dia", "boa tarde", "boa noite", "obrig", "valeu", "tchau", "até", "ate"]
    if any(p.strip() in t for p in pt_markers) or any(ch in t for ch in "ãõáàâéêíóôúç"):
        return "pt"
    return "en"


def _is_greetish_only(text: str) -> bool:
    s = text or ""
    return bool(_GREET_ONLY_RE.match(s) or _HOW_ARE_YOU_ONLY_RE.match(s))


def _is_thanks_only(text: str) -> bool:
    return bool(_THANKS_ONLY_RE.match(text or ""))


def _is_bye_only(text: str) -> bool:
    return bool(_BYE_ONLY_RE.match(text or ""))


def _stage1_canned(author: str, speech: str, mode: str) -> str:
    lang = _hint_lang_from_text(speech)
    a = (author or "Interviewer").strip() or "Interviewer"
    m = (mode or "positivo").strip().lower()

    if _is_greetish_only(speech):
        if lang == "pt":
            return f"{a}, oi! Estou bem, obrigado." if m == "positivo" else f"{a}, oi. Estou bem."
        return f"{a}, hi! I'm doing well, thanks." if m == "positivo" else f"{a}, hi. I'm doing well."

    if _is_thanks_only(speech):
        if lang == "pt":
            return f"{a}, de nada. Estou à disposição." if m == "positivo" else f"{a}, de nada."
        return f"{a}, you're welcome. Happy to help." if m == "positivo" else f"{a}, you're welcome."

    if _is_bye_only(speech):
        if lang == "pt":
            return f"{a}, fechado. Até mais." if m == "positivo" else f"{a}, certo. Até."
        return f"{a}, sounds good. Talk soon." if m == "positivo" else f"{a}, okay. Take care."

    return ""


# =========================
# 🧠 Parser + Noise/Code filters
# =========================
_NOISE_RE = re.compile(r"^[A-Z]{1,4}(\s*[A-Z]{1,4})*$")
_CODE_PREFIX_RE = re.compile(
    r"^\s*(import|from|def|class|async\s+def|const|let|var|function|public|private|package|using|#include)\b",
    re.IGNORECASE,
)
_INTERVIEWER_PREFIX_RE = re.compile(r"^\s*(interviewer|entrevistador)\s*:\s*", re.IGNORECASE)
_IGNORE_LINE_RE = re.compile(
    r"^\s*(\[(stage1|stage2).*?\]|traceback\b|file\s+\".*?\"|during\s+handling\b|"
    r"\[ollama_error\]|\[stage1_http_error\]|\[stage1_error\])",
    re.IGNORECASE,
)
_PS_PROMPT_RE = re.compile(r"^\s*PS\s+[A-Z]:\\.*?>\s*", re.IGNORECASE)


def is_noise_text(text: str) -> bool:
    t = (text or "").strip()
    if not t:
        return True
    if len(t) <= 4 and _NOISE_RE.fullmatch(t) is not None:
        return True
    return False


def is_code_like(text: str) -> bool:
    t = (text or "").strip()
    if not t:
        return False
    low = t.lower()

    # natural language “question-like” should not be considered code
    if "?" in t or low.startswith(("what ", "how ", "why ", "when ", "where ", "can ", "should ", "describe ", "explain ", "tell me ")):
        if "```" in t or "<|begin_of_text|>" in t or "%dw" in low or "<mule" in low:
            return True
        return False

    if t.startswith("```") or t.endswith("```"):
        return True
    if t.startswith("#!/"):
        return True
    if "<|begin_of_text|>" in t or "<|start_header_id|>" in t:
        return True
    if _CODE_PREFIX_RE.match(t):
        return True

    code_tokens = ["%dw", "<mule", "</", "{", "}", "();", "=>", "==", "!=", "/*", "*/", "BEGIN:VEVENT"]
    if any(tok in t for tok in code_tokens) and len(t) >= 60:
        return True

    symbols = sum(1 for ch in t if ch in "{}[]();=<>$#@\\")
    if len(t) >= 120 and symbols >= 14:
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
    author = "Interviewer" if speaker.lower() in ("unknown", "desconhecido") else speaker
    return {"author": author, "text": msg, "raw": s}


def parse_line_author_and_text(line: str):
    s = (line or "").strip()
    if not s or ":" not in s:
        return None
    p = _parse_teams_inline(s)
    if p:
        return p
    if _INTERVIEWER_PREFIX_RE.match(s):
        _, rest = s.split(":", 1)
        return {"author": "Interviewer", "text": rest.strip(), "raw": s}
    parts = [p.strip() for p in s.rsplit(":", 2)]
    if len(parts) == 3:
        _prefix, speaker, msg = parts
        if speaker and msg:
            author = "Interviewer" if speaker.lower() in ("unknown", "desconhecido") else speaker
            return {"author": author, "text": msg, "raw": s}
    author, rest = s.split(":", 1)
    author = author.strip()
    text = rest.strip()
    if not author or not text:
        return None
    author = "Interviewer" if author.lower() in ("unknown", "desconhecido") else author
    return {"author": author, "text": text, "raw": s}


def _is_ignored_line(ln: str) -> bool:
    s = (ln or "").strip()
    if not s:
        return True
    if _IGNORE_LINE_RE.match(s):
        return True
    if _PS_PROMPT_RE.match(s):
        return True
    return False


def extract_last_valid(raw: str):
    raw = raw or ""

    p_inline = _parse_teams_inline(raw.strip())
    if p_inline:
        if FILTER_NOISE and is_noise_text(p_inline["text"]):
            pass
        elif is_code_like(p_inline["text"]):
            pass
        else:
            return p_inline

    lines_all = [ln.strip() for ln in raw.splitlines() if ln and ln.strip()]
    lines = [ln for ln in lines_all if not _is_ignored_line(ln)]

    for ln in reversed(lines):
        if _INTERVIEWER_PREFIX_RE.match(ln):
            p = parse_line_author_and_text(ln)
            if p and not (FILTER_NOISE and is_noise_text(p["text"])) and not is_code_like(p["text"]):
                return p

    for ln in reversed(lines):
        p = parse_line_author_and_text(ln)
        if not p:
            continue
        if FILTER_NOISE and is_noise_text(p["text"]):
            continue
        if is_code_like(p["text"]):
            continue
        return p

    return None


def build_profile_user_text(raw_prompt: str, draft: str = "", context: str = "", mode: str = "positivo") -> str:
    last = extract_last_valid(raw_prompt)
    if not last:
        author = "Interviewer"
        speech = (raw_prompt or "").strip()
    else:
        author = (last.get("author") or "").strip() or "Interviewer"
        speech = (last.get("text") or "").strip()

    if author.lower() in ("unknown", "desconhecido"):
        author = "Interviewer"
    if is_code_like(speech):
        speech = "No clear spoken interview question found in the input."
    if len(speech) > 900:
        speech = speech[:900].rstrip() + "…"

    draft_safe = (draft or "").replace("\r", " ").strip()
    context_safe = (context or "").replace("\r", " ").strip()

    m = (mode or "positivo").strip().lower()
    mood_tag = "NEGATIVE" if m == "negativo" else "POSITIVE"
    tc = time_context_line()

    out = (
        f"MOOD={mood_tag}; "
        f"TIME={tc}; "
        f"AUTHOR={author}; "
        f"SPEECH={speech}; "
        f"INSTRUCTION=Answer the AUTHOR. Line one starts with '{author}, ' only once; lines two and onward must not repeat the author name. "
        f"Never ask questions and never use '?'. Do not add sign-offs or signatures. "
    )
    if draft_safe:
        out += f"DRAFT={draft_safe}; "
    if context_safe:
        out += f"CONTEXT={context_safe}; "
    return out.strip()


def build_stage1_user_text(raw_prompt: str, mode: str) -> Tuple[str, str, str]:
    last = extract_last_valid(raw_prompt)
    if not last:
        author = "Interviewer"
        speech = (raw_prompt or "").strip()
    else:
        author = (last.get("author") or "Interviewer").strip() or "Interviewer"
        speech = (last.get("text") or "").strip()

    if author.lower() in ("unknown", "desconhecido"):
        author = "Interviewer"
    if is_code_like(speech):
        speech = "No clear spoken interview question found."

    m = (mode or "positivo").strip().lower()
    rules = STAGE1_RULES_NEGATIVE() if m == "negativo" else STAGE1_RULES_POSITIVE()
    mood_tag = "NEGATIVE" if m == "negativo" else "POSITIVE"
    tc = time_context_line()

    return (
        author,
        speech,
        (
            "You are Leonel Dorneles Porto answering as a candidate in a technical interview.\n"
            f"MOOD: {mood_tag}\n"
            f"AUTHOR: {author}\n"
            f"SPEECH: {speech}\n"
            f"TIME: {tc}\n"
            f"{rules}\n"
            "Answer now:"
        ).strip(),
    )


# =========================
# 🧠 Context memory
# =========================
STATE_LOCK = threading.Lock()
CLEAN_BUFFER = []
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
    return f"MESSAGES={s}"


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
        SYSTEM_PROMPT_CONSOLIDATOR(),
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
        log.info("[context] failed: %s", e)


# =========================
# 🌊 Stage 2 streaming (Ollama)
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
# 🧠 Stage 1: llama.cpp /completion (stream + capture, delta-safe)
# =========================
_ANSI_RE = re.compile(r"\x1b\[[0-9;]*[A-Za-z]")


def _clean_stage1_text(raw: str) -> str:
    s = raw or ""
    s = _ANSI_RE.sub("", s)
    s = s.replace("\r\n", "\n").replace("\r", "\n").strip()
    if "```" in s:
        s = s.split("```", 1)[0].strip()

    cleaned_lines = []
    for ln in s.split("\n"):
        if _is_ignored_line(ln):
            continue
        cleaned_lines.append(ln.strip())

    s = "\n".join([ln for ln in cleaned_lines if ln]).strip()
    s = re.sub(r"[ \t]+", " ", s).strip()

    if len(s) > STAGE1_DRAFT_MAX_CHARS:
        s = s[:STAGE1_DRAFT_MAX_CHARS].rstrip() + "…"
    if len(s) > MAX_DRAFT_CHARS:
        s = s[:MAX_DRAFT_CHARS].rstrip() + "…"
    return s


def _effective_stage1_n_predict(req: AskRequest) -> int:
    base = req.n_predict if req.n_predict is not None else LLAMA_DEFAULT_NPREDICT
    try:
        base_i = int(base)
    except Exception:
        base_i = LLAMA_DEFAULT_NPREDICT
    base_i = max(base_i, 1)
    return min(base_i, STAGE1_MAX_NPREDICT)


def _get_delta_from_obj(obj: dict) -> str:
    if not obj or not isinstance(obj, dict):
        return ""
    for k in ("content", "response", "completion", "text"):
        v = obj.get(k)
        if isinstance(v, str) and v:
            return v
    choices = obj.get("choices")
    if isinstance(choices, list) and choices:
        c0 = choices[0] or {}
        if isinstance(c0, dict):
            delta = c0.get("delta") or {}
            if isinstance(delta, dict):
                v = delta.get("content")
                if isinstance(v, str) and v:
                    return v
            v = c0.get("text")
            if isinstance(v, str) and v:
                return v
            msg = c0.get("message") or {}
            if isinstance(msg, dict):
                v = msg.get("content")
                if isinstance(v, str) and v:
                    return v
    return ""


def _is_done_obj(obj: dict) -> bool:
    if not obj or not isinstance(obj, dict):
        return False
    for k in ("done", "stop", "stopped", "isFinal", "final"):
        v = obj.get(k)
        if v is True:
            return True
        if isinstance(v, str) and v.strip().lower() in ("true", "1", "done", "stop"):
            return True
    return False


def stream_and_collect_llama_api(req: AskRequest, mode: str) -> Tuple[Iterator[bytes], bytearray]:
    url = (req.url or LLAMA_DEFAULT_URL).strip() or LLAMA_DEFAULT_URL

    author, speech, stage1_user = build_stage1_user_text(req.prompt, mode=mode)
    canned = _stage1_canned(author, speech, mode=mode)
    if canned:
        b = canned.encode("utf-8", errors="ignore")
        buf = bytearray(b)

        def _gen_canned() -> Iterator[bytes]:
            yield b

        return _gen_canned(), buf

    # ✅ Stage1 system gets profile + timestamp context
    final_prompt = build_llama3_chat_prompt(_with_profile_and_time(STAGE1_SYSTEM()), stage1_user)

    body = {
        "prompt": final_prompt,
        "stream": True,
        "echo": False,
        "n_predict": _effective_stage1_n_predict(req),
        "temperature": float(req.temperature if req.temperature is not None else LLAMA_DEFAULT_TEMPERATURE),
        "top_k": int(LLAMA_DEFAULT_TOPK),
        "top_p": float(req.top_p if req.top_p is not None else LLAMA_DEFAULT_TOPP),
        "typical_p": float(LLAMA_DEFAULT_TYPICALP),
        "min_p": float(LLAMA_DEFAULT_MINP),
        "repeat_last_n": int(LLAMA_DEFAULT_REPEAT_LAST_N),
        "repeat_penalty": float(LLAMA_DEFAULT_REPEAT_PENALTY),
        "presence_penalty": float(LLAMA_DEFAULT_PRESENCE_PENALTY),
        "frequency_penalty": float(LLAMA_DEFAULT_FREQUENCY_PENALTY),
        "stop": STAGE1_STOP,
    }

    log.info(
        "[stage1] url=%s mode=%s n_predict=%s temp=%.3f top_p=%.3f",
        url,
        mode,
        body["n_predict"],
        body["temperature"],
        body["top_p"],
    )

    buf = bytearray()

    def _gen() -> Iterator[bytes]:
        acc = ""
        printed = 0
        headers = {"Accept": "text/event-stream,application/json"}
        try:
            with requests.post(
                url,
                json=body,
                stream=True,
                headers=headers,
                timeout=(STAGE1_CONNECT_TIMEOUT, STAGE1_TIMEOUT),
            ) as r:
                r.raise_for_status()
                for raw_line in r.iter_lines(decode_unicode=True):
                    if not raw_line:
                        continue
                    line = _maybe_strip_sse_prefix(raw_line)
                    if not line:
                        continue
                    if line.strip() == "[DONE]":
                        break

                    obj = None
                    try:
                        obj = json.loads(line)
                    except Exception:
                        obj = None

                    txt = ""
                    done = False
                    if isinstance(obj, dict):
                        txt = _get_delta_from_obj(obj)
                        done = _is_done_obj(obj)
                    else:
                        txt = str(line)

                    if not txt and not done:
                        continue

                    if txt:
                        if len(txt) >= len(acc) and txt.startswith(acc):
                            acc = txt
                        else:
                            acc += txt

                    one = strip_prompt_echo(acc.replace("\r", "").replace("\n", " ").strip())
                    cut = find_stop_index(one, STAGE1_STOP)
                    if cut >= 0:
                        one = one[:cut].strip()

                    if len(one) > printed:
                        out = one[printed:]
                        b = out.encode("utf-8", errors="ignore")
                        buf.extend(b)
                        yield b
                        printed = len(one)

                    if STAGE1_STREAM_MAX_BYTES > 0 and len(buf) >= STAGE1_STREAM_MAX_BYTES:
                        break
                    if cut >= 0 or done:
                        break

        except Exception as e:
            msg = f"[stage1_http_error] {e}\n"
            b = msg.encode("utf-8", errors="ignore")
            buf.extend(b)
            yield b

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
        raise HTTPException(status_code=400, detail="Body is not valid JSON")

    if not isinstance(data, dict):
        raise HTTPException(status_code=400, detail="JSON must be an object")

    try:
        payload = AskRequest.model_validate(data)
    except ValidationError:
        raise HTTPException(status_code=400, detail="Invalid payload (expected: {prompt: string, ...})")

    prompt = (payload.prompt or "").strip()
    if not prompt:
        raise HTTPException(status_code=400, detail="Missing/empty 'prompt'")

    if len(prompt) > MAX_PROMPT_CHARS:
        payload.prompt = prompt[:MAX_PROMPT_CHARS]

    return payload


# =========================
# 🌐 HTML
# =========================
@app.get("/")
def serve_root():
    if not INDEX_PATH.exists():
        return JSONResponse({"error": "index.html not found"}, status_code=404)
    return FileResponse(str(INDEX_PATH), media_type="text/html")


@app.get("/index.html")
def serve_index():
    if not INDEX_PATH.exists():
        return JSONResponse({"error": "index.html not found"}, status_code=404)
    return FileResponse(str(INDEX_PATH), media_type="text/html")


# =========================
# ✅ HEALTH
# =========================
@app.get("/health")
def health():
    return {
        "ok": True,
        "prompts": {
            "dir": str(PROMPTS_DIR),
            "strict": PROMPTS_STRICT,
            "auto_reload": PROMPTS_AUTO_RELOAD,
            "files": {k: str(PROMPTS_DIR / v) for k, v in PROMPT_FILES.items()},
        },
        "time_context": {
            "enabled": TIME_CONTEXT_ENABLED,
            "tz": TIME_CONTEXT_TZ,
            "location": TIME_CONTEXT_LOCATION,
            "include_iso": TIME_CONTEXT_INCLUDE_ISO,
        },
        "profile_context": {
            "enabled": PROFILE_CONTEXT_ENABLED,
        },
        "stage1": {
            "default_url": LLAMA_DEFAULT_URL,
            "stream_stage1_default": STREAM_STAGE1_DEFAULT,
            "stage1_max_n_predict": STAGE1_MAX_NPREDICT,
            "stage1_stream_max_bytes": STAGE1_STREAM_MAX_BYTES,
            "stage1_draft_max_chars": STAGE1_DRAFT_MAX_CHARS,
            "timeouts": {"connect_s": STAGE1_CONNECT_TIMEOUT, "total_s": STAGE1_TIMEOUT},
        },
        "stage2": {"ollama_url": OLLAMA_URL, "model": MODEL},
    }


# =========================
# ✅ STAGE 1 ONLY
# =========================
@app.post("/ask_llama")
async def ask_llama(req: Request):
    payload = await _read_payload(req)
    try:
        mode = resolve_mode(payload.route or "", "positivo")
        gen, _buf = stream_and_collect_llama_api(payload, mode=mode)
        return StreamingResponse(gen, media_type="text/plain; charset=utf-8", headers=STREAM_HEADERS)
    except Exception as e:
        return JSONResponse({"error": f"Stage1 HTTP call failed: {e}"}, status_code=500)


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
        stream_ollama_chat(SYSTEM_PROMPT_CORRECTOR(), prompt, OPTIONS_CORRECTOR, sanitize_newlines=True),
        media_type="text/plain; charset=utf-8",
        headers=STREAM_HEADERS,
    )


# =========================
# ✅ CHAIN CORE
# =========================
def chain_stream(payload: AskRequest, background_tasks: BackgroundTasks, mode: str) -> Iterator[bytes]:
    last = extract_last_valid(payload.prompt)
    if last:
        push_clean_message(last["author"], last["text"])
    background_tasks.add_task(refresh_context_background)

    with STATE_LOCK:
        ctx_now = CONTEXT_TEXT

    # ---- Stage 1: stream + capture (HTTP)
    draft = ""
    try:
        gen1, buf = stream_and_collect_llama_api(payload, mode=mode)
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

    # ---- Stage 2: stream 120b (starts only after stage1 finishes)
    sys_prompt = get_stage2_profile_prompt(mode)
    options = OPTIONS_PROFILE_NEGATIVE if mode == "negativo" else OPTIONS_PROFILE_POSITIVE
    user_text = build_profile_user_text(payload.prompt, draft=draft, context=ctx_now, mode=mode)

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
    route = str((body or {}).get("route", "")).strip().lower()
    mode = resolve_mode(route, mode)
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
# ▶️ RUN
# =========================
if __name__ == "__main__":
    import uvicorn

    port = int(os.getenv("PORT", "8000"))
    uvicorn.run(app, host="0.0.0.0", port=port, reload=False)
