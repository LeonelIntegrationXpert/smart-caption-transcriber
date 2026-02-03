# Meeting Transcriber (UI + Llama Suggestion)

## What it does
- Content script captures captions/transcriptions (Meet/Teams/Slack selectors as in your original code).
- Background stores the last transcript batch in `chrome.storage.local`, downloads a TXT file each minute (same behavior).
- Popup shows the latest transcript and can call your local Llama API to generate a suggested reply.
- "Open Tab" opens a larger viewer (viewer.html).

## Setup
1. Load the folder as an unpacked extension (chrome://extensions -> Developer mode -> Load unpacked).
2. In the popup, configure:
   - Mode:
     - OpenAI = OpenAI-compatible `/v1/chat/completions`
     - Ollama = Ollama `/api/chat`
   - Endpoint and model
3. Ensure manifest host_permissions allow your endpoint (defaults include localhost).

## Example endpoints
- llama.cpp (OpenAI-compatible): http://localhost:8080/v1/chat/completions
- Ollama: http://localhost:11434/api/chat
