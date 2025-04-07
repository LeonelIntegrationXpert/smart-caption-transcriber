<!--
  Gerado com auxílio de:
    ✅ Readme.so (https://readme.so/pt)
    ✅ Shields.io (https://shields.io)
    ✅ Readme Typing SVG (https://readme-typing-svg.demolab.com)
    ✅ Capsule Render (https://capsule-render.vercel.app)
-->

<h1 align="center">🧠 Smart Caption Transcriber - Multi-Platform CC Extension 🎙️</h1>

<p align="center">
  <img src="https://capsule-render.vercel.app/api?type=waving&color=0:147AD6,100:47e3ff&height=220&section=header&text=Smart%20Caption%20Transcriber&fontSize=40&fontColor=ffffff&animation=fadeIn" alt="Banner animado" />
</p>

<p align="center">
  <a href="https://developer.chrome.com/docs/extensions/mv3/">
    <img src="https://img.shields.io/badge/Chrome%20Extension-MV3-blue.svg?logo=googlechrome" alt="Chrome Manifest V3" />
  </a>
  <a href="#">
    <img src="https://img.shields.io/badge/Multi-Plataformas-green?logo=googlemeet" alt="Suporte a múltiplas plataformas com CC" />
  </a>
  <a href="https://www.salesforce.com/trailblazer/leonelporto">
    <img src="https://img.shields.io/badge/Trailblazer-Leonel%20Porto-blue?logo=salesforce" alt="Trailblazer" />
  </a>
</p>

<p align="center">
  <img src="https://readme-typing-svg.demolab.com?font=Fira+Code&size=22&pause=1000&color=47E3FF&center=true&vCenter=true&width=800&lines=Captura+autom%C3%A1tica+de+Closed+Captions+em+tempo+real;Identifica+falantes+em+reuni%C3%B5es+digitais;Salva+transcri%C3%A7%C3%B5es+locais+automaticamente" alt="Typing" />
</p>

---

## 🧠 Visão Geral

O **Smart Caption Transcriber** é uma extensão para Google Chrome projetada para capturar automaticamente as legendas de reuniões com Closed Captions (CC), em plataformas como:

- Google Meet
- Microsoft Teams
- Slack Huddles
- Zoom (em breve)

A extensão identifica os falantes, evita repetições e salva tudo em arquivos `.txt`, organizados e prontos para análise, IA ou integração com bots como o Rasa 🤖

---

### ✨ Funcionalidades principais

- 📌 Captura contínua de Closed Captions (legendas CC)
- 🧍 Identificação automática dos falantes
- 🧠 Evita duplicações
- 💾 Salvamento automático em `.txt` a cada minuto
- 📁 Armazenamento direto no computador do usuário
- 🔁 Compatível com múltiplas plataformas sem necessidade de adaptação

---

## 📂 Exemplo de saída

```txt
Você: Hello everyone!
Lucas Silva: Let's get started.
Você: Sure! I’ll share my screen.
```

---

## 🚀 Como instalar

1. Clone este repositório:
   ```bash
   git clone https://github.com/LeonelIntegrationXpert/smart-caption-transcriber.git
   ```
2. Acesse `chrome://extensions`
3. Ative o **Modo do desenvolvedor**
4. Clique em **Carregar sem compactação** e selecione a pasta clonada
5. Participe de uma reunião (Meet, Teams, etc.) com legendas ativadas
6. A extensão cuidará do resto automaticamente 🎉

> O arquivo `.txt` será salvo automaticamente via `chrome.downloads` API.

---

## 🛠️ Tecnologias utilizadas

- 📜 JavaScript moderno (ES6+)
- 🧩 Chrome Extension APIs (`content_scripts`, `downloads`, `runtime`)
- 🧠 Captura de CC baseada em DOM real-time
- ⚙️ Manifest V3 (último padrão do Chrome)

---

## 🗃️ Estrutura do Projeto

```
smart-caption-transcriber/
├── background.js       # Gerencia downloads e eventos
├── content.js          # Lê legendas e identifica falantes
├── manifest.json       # Declaração da extensão (MV3)
├── icon.png            # Ícone (opcional)
└── README.md
```

---

## 🧑‍💻 Autor

Desenvolvido com 💙 por [**Leonel Dorneles Porto**](https://www.linkedin.com/in/leonelporto)

- 🧩 Especialista em Integrações com MuleSoft & Salesforce
- 🤖 Explorador apaixonado por IA, automações e bots conversacionais
- 🧠 Trailblazer em constante evolução: [salesforce.com/trailblazer/leonelporto](https://www.salesforce.com/trailblazer/leonelporto)

---

## 📬 Contato

<p align="center">
  <a href="mailto:leoneldornelesporto@outlook.com.br" target="_blank" rel="noopener noreferrer">
    <img src="https://img.shields.io/badge/Email-leoneldornelesporto%40outlook.com.br-D14836?style=for-the-badge&logo=gmail&logoColor=white" alt="Email"/>
  </a>
  <a href="https://www.linkedin.com/in/leonel-dorneles-porto-b88600122" target="_blank" rel="noopener noreferrer">
    <img src="https://img.shields.io/badge/LinkedIn-Leonel%20Porto-0077B5?style=for-the-badge&logo=linkedin&logoColor=white" alt="LinkedIn"/>
  </a>
  <a href="https://github.com/LeonelIntegrationXpert" target="_blank" rel="noopener noreferrer">
    <img src="https://img.shields.io/badge/GitHub-LeonelIntegrationXpert-181717?style=for-the-badge&logo=github" alt="GitHub"/>
  </a>
</p>

---

<p align="center">
  <img src="https://capsule-render.vercel.app/api?type=waving&color=0:47e3ff,100:147AD6&height=100&section=footer" alt="Footer Wave Animation" />
</p>
