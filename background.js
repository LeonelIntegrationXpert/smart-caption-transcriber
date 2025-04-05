chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    console.log("📥 Background recebeu:", request);
  
    if (request.action === 'download') {
      console.log("💾 Iniciando download...");
  
      chrome.downloads.download({
        url: request.url,
        filename: request.filename,
        saveAs: false
      }, (downloadId) => {
        if (chrome.runtime.lastError) {
          console.error("❌ Erro no download:", chrome.runtime.lastError.message);
        } else {
          console.log("✅ Download iniciado. ID:", downloadId);
        }
      });
    }
  });
  