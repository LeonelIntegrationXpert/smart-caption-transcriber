console.log("✅ Transcriber content script carregado!");

let transcriptData = '';
let lastSavedData = '';
let filename = 'transcription-' + new Date().toISOString().replace(/[:.]/g, '-') + '.txt';

let lastLine = "";

// 🔁 Função para capturar transcrição com nome do falante no Google Meet e Microsoft Teams
const captureTranscript = () => {
  let found = false;

  // 🔹 Captura para Microsoft Teams (chat com nome + fala)
  document.querySelectorAll('.ui-chat__item').forEach(item => {
    const speakerEl = item.querySelector('.ui-chat__message__author');
    const textEl = item.querySelector('[data-tid="closed-caption-text"]');

    if (speakerEl && textEl) {
      const speaker = speakerEl.innerText.trim();
      const text = textEl.innerText.trim();
      const fullText = `${speaker}: ${text}`;

      if (
        fullText !== lastLine &&
        !transcriptData.includes(fullText) &&
        !lastLine.includes(fullText)
      ) {
        transcriptData += fullText + '\n';
        lastLine = fullText;
        console.log("🎤 [Teams] Capturado:", fullText);
        found = true;
      }
    }
  });

  // 🔹 Captura para Google Meet (legenda com nome do falante)
  document.querySelectorAll('div[jsname="tgaKEf"]').forEach(line => {
    const text = line.innerText?.trim();
    if (!text) return;

    const container = line.closest('.nMcdL');
    let speaker = 'Desconhecido';

    if (container) {
      const nameEl = container.querySelector('span.NWpY1d');
      if (nameEl) {
        speaker = nameEl.innerText.trim();
      }
    }

    const fullText = `${speaker}: ${text}`;
    if (
      fullText !== lastLine &&
      !transcriptData.includes(fullText) &&
      !lastLine.includes(fullText)
    ) {
      transcriptData += fullText + '\n';
      lastLine = fullText;
      console.log("🎤 [Meet] Capturado:", fullText);
      found = true;
    }
  });

  if (!found) {
    console.log("🔍 Nenhum texto novo encontrado...");
  }
};

// ⏱️ Executa a cada 2 segundos
setInterval(() => {
  console.log("⏳ Executando captura de transcrição...");
  captureTranscript();
}, 2000);

// 💾 Salva a cada 1 minuto
setInterval(() => {
  console.log("💾 Verificando se há novas transcrições para salvar...");

  if (transcriptData && transcriptData !== lastSavedData) {
    console.log("📤 Novo conteúdo detectado, salvando...");

    const blob = new Blob([transcriptData], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);

    try {
      chrome.runtime.sendMessage({
        action: 'download',
        url: url,
        filename: filename
      });
      console.log("✅ Mensagem enviada (sem callback).");
    } catch (err) {
      console.error("❌ Erro ao enviar mensagem:", err.message);
    }

    lastSavedData = transcriptData;
  } else {
    console.log("⚠️ Nada novo para salvar...");
  }
}, 60000);
