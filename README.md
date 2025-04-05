<!--
  Gerado com auxílio de:
    ✅ Readme.so (https://readme.so/pt)
    ✅ Shields.io (https://shields.io)
    ✅ Readme Typing SVG (https://readme-typing-svg.demolab.com)
    ✅ Capsule Render (https://capsule-render.vercel.app)
-->

<h1 align="center">📰 Meeting Transcriber Extension - Google Meet 📅</h1>

<p align="center">
  <img src="https://capsule-render.vercel.app/api?type=waving&color=0:147AD6,100:47e3ff&height=220&section=header&text=Google%20Meet%20Transcriber&fontSize=40&fontColor=ffffff&animation=fadeIn" alt="Banner animado" />
</p>

<p align="center">
  <a href="https://developer.chrome.com/docs/extensions/mv3/">
    <img src="https://img.shields.io/badge/Chrome%20Extension-MV3-blue.svg?logo=googlechrome" alt="Chrome Manifest V3" />
  </a>
  <a href="https://meet.google.com">
    <img src="https://img.shields.io/badge/Google%20Meet-AutoTranscript-green?logo=googlemeet" alt="Google Meet" />
  </a>
  <a href="https://www.salesforce.com/trailblazer/leonelporto">
    <img src="https://img.shields.io/badge/Trailblazer-Leonel%20Porto-blue?logo=salesforce" alt="Trailblazer" />
  </a>
</p>

<p align="center">
  <img src="https://readme-typing-svg.demolab.com?font=Fira+Code&size=22&pause=1000&color=47E3FF&center=true&vCenter=true&width=600&lines=Transcri%C3%A7%C3%A3o+autom%C3%A1tica+de+reuni%C3%B5es+no+Google+Meet;Captura+em+tempo+real+com+identifica%C3%A7%C3%A3o+do+falante;Salva+automaticamente+em+.txt+no+seu+PC" alt="Typing" />
</p>

---

## 🧠 Visão Geral
A Meeting Transcriber Extension é uma extensão para Google Chrome desenvolvida para capturar automaticamente as transcrições de reuniões realizadas no Google Meet. 

Ela identifica o nome do falante, evita repetições e salva o conteúdo de forma contínua em um arquivo `.txt` diretamente no seu computador.

### ✨ Principais funcionalidades:
- 📌 Captura automática das falas transcritas
- 🧍 Identifica o falante ("Você", "João", etc.)
- 🚫 Evita duplicações ou repetições parciais
- 💾 Salva automaticamente um arquivo `.txt` a cada 1 minuto
- ⚙️ 100% automática, sem precisar clicar em nada

---

## 🎬 Exemplo de saída
```txt
Você: Hello!
João: How are you?
Você: I'm fine, thank you!
```

---

## 💡 Como instalar e usar

1. Clone este repositório ou baixe como `.zip`:
   ```bash
   git clone https://github.com/seu-usuario/meeting-transcriber-extension.git
   ```
2. Acesse `chrome://extensions` no seu navegador
3. Ative o **Modo do desenvolvedor** (canto superior direito)
4. Clique em **Carregar sem compactação** e selecione a pasta do projeto
5. Abra o Google Meet, ative a transcrição e a extensão fará o trabalho automaticamente!

> O arquivo `.txt` será salvo automaticamente no seu computador via API `chrome.downloads`.

---

## 🔧 Tecnologias Utilizadas
- 📜 JavaScript ES6+
- 🧩 Chrome Manifest V3
- 🔌 Chrome Extension APIs (`downloads`, `content_scripts`, `runtime`)

---

## 🗂️ Estrutura do Projeto
```
meeting-transcriber-extension/
├── background.js       # Service Worker: gerencia downloads
├── content.js          # Captura e processa as transcrições
├── manifest.json       # Configuração principal da extensão
├── icon.png            # Ícone da extensão (opcional)
└── README.md
```

---

## 👨‍💻 Autor
Desenvolvido com ❤️ por [**Leonel Dorneles Porto**](https://www.linkedin.com/in/leonelporto)

- 💼 Desenvolvedor MuleSoft & Salesforce
- 🤖 Apaixonado por IA, integrações e automações
- 🏆 Trailblazer: [salesforce.com/trailblazer/leonelporto](https://www.salesforce.com/trailblazer/leonelporto)

---

## 📬 Contato

<p align="center">
  <a href="mailto:leoneldornelesporto@outlook.com.br">
    <img src="https://img.shields.io/badge/Email-leoneldornelesporto%40outlook.com.br-D14836?style=for-the-badge&logo=gmail&logoColor=white" alt="Email"/>
  </a>
  <a href="https://www.linkedin.com/in/leonelporto">
    <img src="https://img.shields.io/badge/LinkedIn-Leonel%20Porto-0077B5?style=for-the-badge&logo=linkedin&logoColor=white" alt="LinkedIn"/>
  </a>
  <a href="https://github.com/LeonelIntegrationXpert">
    <img src="https://img.shields.io/badge/GitHub-LeonelIntegrationXpert-181717?style=for-the-badge&logo=github" alt="GitHub"/>
  </a>
</p>

---

<p align="center">
  <img src="https://capsule-render.vercel.app/api?type=waving&color=0:47e3ff,100:147AD6&height=100&section=footer" alt="Footer Wave Animation" />
</p>

