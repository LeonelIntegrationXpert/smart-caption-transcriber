chrome.runtime.onInstalled.addListener(() => {
  console.log("🧠 Background iniciado");
});

// 🧠 Detecta janelas novas (Slack Huddle abre uma nova aba com about:blank → redireciona)
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

// 📥 Recebe transcrição
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'transcriptData') {
    console.log("📡 Transcrição recebida:", request.payload);
    sendResponse({ status: "ok" });
  }
});
