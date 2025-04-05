console.log("✅ Transcriber content script carregado!");

let transcriptData = '';
let lastSavedData = '';
let lastLine = '';
let latestLine = '';
let historyList = [];

let seenLines = new Set(); // 🔁 controle de repetições
let latestBySpeaker = new Map(); // 🧠 última fala por pessoa
let receivedMessages = new Map(); // 📨 registro completo por pessoa

// 🧍‍♂️ Lista de nomes que representam você
const myKnownNames = new Set(["Você", "Leonel Dorneles Porto"]);

// 🔧 Processa nova fala, evita duplicatas e registra
function appendNewTranscript(speaker, fullText, origin) {
  if (!speaker || myKnownNames.has(speaker)) {
    console.debug(`[IGNORADO] Fala própria: '${speaker}'`);
    return;
  }

  const cleanText = fullText.trim();
  if (!cleanText) return;

  const key = `${origin}::${speaker}::${cleanText}`;
  if (seenLines.has(key)) return;
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

  // 🧠 Armazena a última fala no ciclo
  const previous = latestBySpeaker.get(speaker) || '';
  latestBySpeaker.set(speaker, previous ? `${previous} ${newContent}` : newContent);

  // 📥 Armazena fala recebida
  if (!receivedMessages.has(speaker)) receivedMessages.set(speaker, []);
  receivedMessages.get(speaker).push({
    origin,
    text: newContent,
    timestamp: new Date().toISOString()
  });

  console.log(singleLine);
  console.log(`📥 Nova mensagem registrada de '${speaker}': "${newContent}"`);

  // 🤖 Gera resposta parcial simulada
  const quickReply = generateQuickReply(speaker, newContent);
  console.log(`🤖 Reply to ${speaker}: ${quickReply}`);
}

// 🔮 Gera resumo do bot com base nas últimas falas
function generateBotReply(latestBySpeaker) {
  if (latestBySpeaker.size === 0) return "🤖 No new messages to respond to.";
  let context = '';
  for (const [speaker, text] of latestBySpeaker.entries()) {
    context += `- ${speaker}: ${text}\n`;
  }
  return (
    "🤖 Here's my summary based on what I heard so far:\n" +
    context +
    "\nThanks everyone for the contributions! Let's keep going. 💬"
  );
}

// 🧠 Gera resposta curta simulada
function generateQuickReply(speaker, message) {
  const lower = message.toLowerCase();
  if (lower.includes("hello") || lower.includes("hi")) return "Hey there! 👋";
  if (lower.includes("problem") || lower.includes("issue")) return "I’m here to help, could you explain more?";
  if (lower.includes("?")) return "That’s a good question. Let’s look into it.";
  if (lower.length < 8) return "Could you tell me more?";
  return "Thanks for sharing! 👍";
}

// 🔊 Capturas
const captureMeet = () => {
  document.querySelectorAll('div[jsname="tgaKEf"]').forEach(line => {
    const text = line.innerText?.trim();
    if (!text) return;
    const speaker = line.closest('.nMcdL')?.querySelector('span.NWpY1d')?.innerText.trim() || 'Desconhecido';
    appendNewTranscript(speaker, text, 'Meet');
  });
};

const captureTeamsOld = () => {
  document.querySelectorAll('[data-tid="closed-caption-text"]').forEach(caption => {
    const text = caption.innerText?.trim();
    if (!text) return;
    const speaker = caption.closest('[data-focuszone-id]')?.querySelector('.ui-chat__message__author')?.innerText.trim() || 'Desconhecido';
    appendNewTranscript(speaker, text, 'Teams (chat)');
  });
};

const captureTeamsNew = () => {
  document.querySelectorAll('[data-tid="closed-caption-text"]').forEach(caption => {
    const text = caption?.innerText?.trim();
    if (!text) return;
    const speaker = caption.closest('.ui-chat__message')?.querySelector('.ui-chat__message__author')?.innerText.trim() || 'Desconhecido';
    appendNewTranscript(speaker, text, 'Teams (v2)');
  });
};

const captureSlack = () => {
  document.querySelectorAll('.p-huddle_event_log__base_event').forEach(event => {
    const speaker = event.querySelector('.p-huddle_event_log__member_name')?.innerText.trim() || 'Desconhecido';
    const text = event.querySelector('.p-huddle_event_log__transcription')?.innerText.trim();
    if (text) appendNewTranscript(speaker, text, 'Slack');
  });
};

// 🔁 Captura por origem
const captureTranscript = () => {
  const url = window.location.href;
  if (url.includes("meet.google.com")) captureMeet();
  else if (url.includes("teams.microsoft.com")) captureTeamsOld();
  else if (url.includes("teams.live.com")) captureTeamsNew();
  else if (url.includes("slack.com") || url.startsWith("about:blank")) captureSlack();
  else console.warn("⚠️ Página não reconhecida.");
};

// ⏱️ Inicia após 3s, captura a cada 2s
setTimeout(() => {
  setInterval(captureTranscript, 2000);
}, 3000);

// 💾 A cada 60s, envia e limpa ciclo
setInterval(() => {
  if (transcriptData && transcriptData !== lastSavedData) {
    const filename = `transcription-${new Date().toISOString().replace(/[:.]/g, '-')}.txt`;
    const sortedLatest = Array.from(latestBySpeaker.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([speaker, text]) => `🎤 ${speaker}: ${text}`)
      .join('\n');

    latestLine = sortedLatest;

    const botReply = generateBotReply(latestBySpeaker);
    console.log("==== BOT RESPONSE ====");
    console.log(botReply);

    try {
      if (chrome?.runtime?.sendMessage) {
        chrome.runtime.sendMessage(
          {
            action: 'transcriptData',
            payload: {
              fullHistory: transcriptData,
              latestLine,
              filename
            }
          },
          (response) => {
            console.log("📬 Resposta do background:", response);
          }
        );
        console.log("💾 Enviados: histórico completo + últimas falas por pessoa.");
      } else {
        console.debug("🔒 Contexto sem acesso a chrome.runtime.sendMessage.");
      }
    } catch (err) {
      console.error("❌ Erro ao enviar transcrição:", err);
    }

    latestBySpeaker.clear();
    latestLine = '';
    lastSavedData = transcriptData;
  } else {
    console.debug("[sendInterval] Nenhuma nova transcrição para enviar.");
  }
}, 60000);
