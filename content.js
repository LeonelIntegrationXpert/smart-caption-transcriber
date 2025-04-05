console.log("✅ Transcriber content script carregado!");

let transcriptData = '';
let lastSavedData = '';
let lastLine = "";

// 🔊 Google Meet
const captureMeet = () => {
  const lines = document.querySelectorAll('div[jsname="tgaKEf"]');
  lines.forEach((line) => {
    const text = line.innerText?.trim();
    if (!text) return;

    const container = line.closest('.nMcdL');
    let speaker = 'Desconhecido';

    if (container) {
      const nameEl = container.querySelector('span.NWpY1d');
      if (nameEl) speaker = nameEl.innerText.trim();
    }

    const fullText = `${speaker}: ${text}`;
    if (fullText !== lastLine && !transcriptData.includes(fullText)) {
      transcriptData += `🎤 Meet: ${fullText}\n`;
      lastLine = fullText;
      console.log(`🎤 Meet: ${fullText}`);
    }
  });
};

// 🔊 Microsoft Teams (antigo layout)
const captureTeamsOld = () => {
  const captions = document.querySelectorAll('[data-tid="closed-caption-text"]');
  captions.forEach((caption) => {
    const text = caption.innerText?.trim();
    if (!text) return;

    const speakerEl = caption.closest('[data-focuszone-id]')?.querySelector('.ui-chat__message__author');
    const speaker = speakerEl ? speakerEl.innerText.trim() : "Desconhecido";

    const fullText = `${speaker}: ${text}`;
    if (fullText !== lastLine && !transcriptData.includes(fullText)) {
      transcriptData += `🎤 Teams (chat): ${fullText}\n`;
      lastLine = fullText;
      console.log(`🎤 Teams (chat): ${fullText}`);
    }
  });
};

// 🔊 Microsoft Teams (novo layout)
const captureTeamsNew = () => {
  const captions = document.querySelectorAll('[data-tid="closed-caption-text"]');
  captions.forEach((caption) => {
    const text = caption?.innerText?.trim();
    if (!text) return;

    const messageEl = caption.closest('.ui-chat__message');
    const speakerEl = messageEl?.querySelector('.ui-chat__message__author');
    const speaker = speakerEl?.innerText?.trim() || "Desconhecido";

    const fullText = `${speaker}: ${text}`;
    if (fullText !== lastLine && !transcriptData.includes(fullText)) {
      transcriptData += `🎤 Teams (v2): ${fullText}\n`;
      lastLine = fullText;
      console.log(`🎤 Teams (v2): ${fullText}`);
    }
  });
};

// 🔊 Slack Huddles (layout atualizado)
const captureSlack = () => {
  const events = document.querySelectorAll('.p-huddle_event_log__base_event');
  events.forEach((event) => {
    const speakerEl = event.querySelector('.p-huddle_event_log__member_name');
    const textEl = event.querySelector('.p-huddle_event_log__transcription');

    if (!speakerEl || !textEl) return;

    const speaker = speakerEl.innerText.trim();
    const text = textEl.innerText.trim();
    const fullText = `${speaker}: ${text}`;

    if (fullText !== lastLine && !transcriptData.includes(fullText)) {
      transcriptData += `🎤 Slack: ${fullText}\n`;
      lastLine = fullText;
      console.log(`🎤 Slack: ${fullText}`);
    }
  });
};

// 🔁 Função principal de detecção
const captureTranscript = () => {
  const url = window.location.href;

  if (url.includes("meet.google.com")) captureMeet();
  else if (url.includes("teams.microsoft.com")) captureTeamsOld();
  else if (url.includes("teams.live.com")) captureTeamsNew();
  else if (url.includes("slack.com") || url.startsWith("about:blank")) captureSlack();
  else console.warn("⚠️ Página não reconhecida.");
};

// ⏱️ Atraso inicial para garantir que o DOM do Slack Huddles carregue
setTimeout(() => {
  setInterval(captureTranscript, 2000);
}, 3000);

// 🤖 Envia transcrição para o background a cada 60 segundos
setInterval(() => {
  if (transcriptData && transcriptData !== lastSavedData) {
    try {
      if (chrome.runtime?.sendMessage) {
        chrome.runtime.sendMessage(
          {
            action: 'transcriptData',
            payload: transcriptData
          },
          (response) => {
            console.log("📬 Resposta do background:", response);
          }
        );
        console.log("🤖 Transcrição enviada para o chatbot Rasa.");
      } else {
        console.warn("⚠️ chrome.runtime.sendMessage não disponível.");
      }
    } catch (err) {
      console.error("❌ Erro ao enviar para o background:", err);
    }

    lastSavedData = transcriptData;
  }
}, 60000);
