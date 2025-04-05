console.log("✅ Transcriber content script carregado!");

let transcriptData = '';
let lastSavedData = '';
let lastLine = '';
let latestLine = '';
let historyList = [];

let currentSpeaker = '';
let currentBlock = '';
let seenLines = new Set(); // 🔁 controle de repetições exatas

// 🔧 Função para evitar duplicatas e construir histórico + última linha concatenada
function appendNewTranscript(speaker, fullText, origin) {
  const cleanText = fullText.trim();
  if (!cleanText) return;

  const key = `${origin}::${speaker}::${cleanText}`;
  if (seenLines.has(key)) return; // já capturado

  seenLines.add(key);

  let newContent = cleanText;
  if (lastLine && cleanText.startsWith(lastLine)) {
    newContent = cleanText.slice(lastLine.length).trim();
  }

  if (!newContent) return;

  const singleLine = `🎤 ${origin}: ${speaker}: ${newContent}`;
  transcriptData += singleLine + '\n';
  historyList.push(singleLine);
  lastLine = cleanText;

  if (speaker === currentSpeaker) {
    if (!currentBlock.includes(newContent)) {
      currentBlock += (currentBlock ? ' ' : '') + newContent;
    }
  } else {
    currentSpeaker = speaker;
    currentBlock = newContent;
  }

  latestLine = `🎤 ${origin}: ${speaker}: ${currentBlock}`;
  console.log(singleLine);
}

// 🔊 Google Meet
const captureMeet = () => {
  document.querySelectorAll('div[jsname="tgaKEf"]').forEach((line) => {
    const text = line.innerText?.trim();
    if (!text) return;
    const speaker = line.closest('.nMcdL')?.querySelector('span.NWpY1d')?.innerText.trim() || 'Desconhecido';
    appendNewTranscript(speaker, text, 'Meet');
  });
};

// 🔊 Microsoft Teams (antigo)
const captureTeamsOld = () => {
  document.querySelectorAll('[data-tid="closed-caption-text"]').forEach((caption) => {
    const text = caption.innerText?.trim();
    if (!text) return;
    const speaker = caption.closest('[data-focuszone-id]')?.querySelector('.ui-chat__message__author')?.innerText.trim() || 'Desconhecido';
    appendNewTranscript(speaker, text, 'Teams (chat)');
  });
};

// 🔊 Microsoft Teams (novo)
const captureTeamsNew = () => {
  document.querySelectorAll('[data-tid="closed-caption-text"]').forEach((caption) => {
    const text = caption?.innerText?.trim();
    if (!text) return;
    const speaker = caption.closest('.ui-chat__message')?.querySelector('.ui-chat__message__author')?.innerText.trim() || 'Desconhecido';
    appendNewTranscript(speaker, text, 'Teams (v2)');
  });
};

// 🔊 Slack Huddles
const captureSlack = () => {
  document.querySelectorAll('.p-huddle_event_log__base_event').forEach((event) => {
    const speaker = event.querySelector('.p-huddle_event_log__member_name')?.innerText.trim() || 'Desconhecido';
    const text = event.querySelector('.p-huddle_event_log__transcription')?.innerText.trim();
    if (text) appendNewTranscript(speaker, text, 'Slack');
  });
};

// 🔁 Função principal de captura
const captureTranscript = () => {
  const url = window.location.href;

  if (url.includes("meet.google.com")) captureMeet();
  else if (url.includes("teams.microsoft.com")) captureTeamsOld();
  else if (url.includes("teams.live.com")) captureTeamsNew();
  else if (url.includes("slack.com") || url.startsWith("about:blank")) captureSlack();
  else console.warn("⚠️ Página não reconhecida.");
};

// ⏱️ Aguarda 3s (Slack precisa carregar), depois captura a cada 2s
setTimeout(() => {
  setInterval(captureTranscript, 2000);
}, 3000);

// 💾 Envia transcrição para o background a cada 60s
setInterval(() => {
  if (transcriptData && transcriptData !== lastSavedData) {
    const filename = `transcription-${new Date().toISOString().replace(/[:.]/g, '-')}.txt`;

    try {
      if (typeof chrome !== 'undefined' && chrome.runtime?.sendMessage) {
        chrome.runtime.sendMessage(
          {
            action: 'transcriptData',
            payload: {
              fullHistory: transcriptData,
              latestLine: latestLine,
              filename: filename
            }
          },
          (response) => {
            console.log("📬 Resposta do background:", response);
          }
        );

        console.log("💾 Enviados: histórico completo + última linha nova.");
      } else {
        console.debug("🔒 Contexto sem acesso a chrome.runtime.sendMessage (possivelmente iframe ou sandbox).");
      }
    } catch (err) {
      console.error("❌ Erro ao enviar transcrição:", err);
    }

    lastSavedData = transcriptData;
  } else {
    console.debug("[sendInterval] Nenhuma nova transcrição para enviar.");
  }
}, 60000);
