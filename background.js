chrome.runtime.onInstalled.addListener(() => {
  console.log("🧠 Background iniciado");
});

// 📥 Recebe transcrição (histórico + última linha) e aciona o download
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'transcriptData') {
    const { fullHistory, latestLine, filename } = request.payload;

    console.log("📡 Transcrição recebida para download:", request.payload);

    const fullText =
      `==== HISTÓRICO COMPLETO ====\n${fullHistory}\n\n` +
      `==== ÚLTIMA LINHA CAPTURADA ====\n${latestLine}\n`;

    const blob = new Blob([fullText], { type: 'text/plain' });
    const reader = new FileReader();

    reader.onloadend = function () {
      const base64Data = reader.result.split(',')[1];

      chrome.downloads.download({
        url: 'data:text/plain;base64,' + base64Data,
        filename: filename,
        saveAs: false
      }, (downloadId) => {
        if (chrome.runtime.lastError) {
          console.error("❌ Erro no download:", chrome.runtime.lastError.message);
          sendResponse({ status: "erro", mensagem: chrome.runtime.lastError.message });
        } else {
          console.log("✅ Download iniciado com ID:", downloadId);
          sendResponse({ status: "ok", downloadId });
        }
      });
    };

    reader.readAsDataURL(blob);
    return true; // Mantém sendResponse vivo
  }
});

// 🧠 Detecta janelas novas (Slack Huddle abre uma aba com about:blank → injetar script)
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (
    changeInfo.status === "complete" &&
    tab.url &&
    (tab.url.includes("slack.com") || tab.url.startsWith("about:blank"))
  ) {
    console.log(`📌 Tentando injetar em: ${tab.url}`);

    chrome.scripting.executeScript(
      {
        target: { tabId },
        files: ["content.js"]
      },
      () => {
        if (chrome.runtime.lastError) {
          console.error("❌ Erro ao injetar script:", chrome.runtime.lastError.message);
        } else {
          console.log("✅ Script injetado com sucesso no Slack/Huddle.");
        }
      }
    );
  }
});
