# Adion Browse 🦁🛡️🤖

**Adion Browse** is a high-performance, privacy-first web browser built on top of the real **Chromium** engine and **Electron**, featuring a built-in **Adion Shields** ad & tracker blocking engine, an **Asynchronous AI Control Plane** with continuous hands-free voice control, a native **Model Context Protocol (MCP)** server for autonomous LLM operators, and a **Multi-Model Provider Registry** (ChatGPT, Claude, Gemini/Antigravity, Groq, and local models).

---

## 🚀 Key Architectural Highlights

### 1. 🎙️ Continuous Voice Stream & Acoustic VAD Pipeline
- **Continuous Hands-Free Interaction**: Stays listening across multiple commands and automatically re-arms after executing actions.
- **Hardware Sample Rate Downsampler**: Downsamples Windows hardware microphone rates (48kHz / 44.1kHz) in real time to clean 16kHz Linear PCM using linear interpolation.
- **Voice Activity Detection (VAD)**: Real-time acoustic energy analysis with live frame telemetry (`Frame #`, `RMS`, `Speech: true/false`).
- **Software Automatic Gain Control (AGC)**: Dynamic digital pre-amp and AGC boost quiet microphone signals up to 4.5× for optimal acoustic transcription.
- **Whisper-Large-v3-Turbo on Groq LPU**: Ultra-low-latency speech transcription with English greedy decoding (`language: 'en'`, `temperature: 0.0`) to eliminate foreign language hallucinations.
- **Acoustic & Hallucination Filters**: Rejects ambient video outro subtitles (`"Thank you for watching"`, `"gracias por ver el video"`) and word-repetition loops.

### 2. ⚡ Zero-Latency Query Preprocessor (<0.5ms)
- **Linguistic Cleaning & Filler Stripping**: Strips conversational preambles (*"can you please"*, *"hey adion"*, *"ok fine"*, etc.) in sub-millisecond time.
- **Universal, Unbiased Navigation**: 
  - `open <domain>` or `navigate to <domain>`: Direct navigation for any valid domain (`web.whatsapp.com`, `github.com`, `reddit.com`, `wikipedia.org`).
  - `search <query>`: Universal web search on configured search engines (Brave, Google, DuckDuckGo).
  - Explicit platform search: `search google for <query>`, `search youtube for <query>`.
- **Compound Command Decomposition**: Executes multi-action utterances sequentially (e.g., *"shut down this and now search for youtube.com"* $\rightarrow$ `CLOSE_TAB` then `NAVIGATE`).
- **Instant DOM & Audio Slider Manipulation**: Directly targets DOM elements, dark/light mode themes, and audio DSP sliders (e.g., *"change bass frequency boost from 0 to 10 dB"*, *"change button color to yellow"*).
- **LRU Plan Cache**: Caches recent query execution plans for $<0.05\text{ms}$ replay.

### 3. 📡 Native Model Context Protocol (MCP) Server
- **Universal Standard**: Implements Anthropic's Model Context Protocol over HTTP and Server-Sent Events (SSE) at `http://127.0.0.1:9224`.
- **Browser Automation Tools**: Exposes `browser_navigate`, `browser_click`, `browser_type`, `browser_scroll`, `browser_get_dom`, `browser_screenshot`, `browser_tabs`, and `browser_summarize`.
- **99.4% Token Reduction**: Emits clean semantic DOM summaries and accessibility trees, slashing payload bloat compared to raw Playwright HTML.
- **Optional Standby Toggle**: Defaults to standby mode; toggled dynamically on/off via the Jarvis GUI or browser Settings without restarting.
- **Claude Web & Desktop Integration**: Built-in port forwarding and public tunnel manager (`npm run mcp:tunnel`) for direct Claude integration.

### 4. 🧠 Multi-Model Provider Registry & Autonomous Operator
- **Multi-Provider Support**: Supports dynamic switching between:
  - **OpenAI**: `gpt-4o`, `gpt-4o-mini`
  - **Anthropic**: `claude-3-5-sonnet`, `claude-3-5-haiku`
  - **Google Gemini / Antigravity**: `gemini-2.0-flash`
  - **Groq LPU**: `llama-3.3-70b-versatile`, `openai/gpt-oss-120b`, `qwen/qwen3.8-27b`
  - **Custom / Local**: OpenAI-compatible local endpoints (`Ollama`, `vLLM`, `DeepSeek`)
- **Exponential Backoff & Failover**: Automatic retry with model rotation upon encountering rate limits (429) or service degradation (503).

### 5. 🛡️ Adion Shields & Privacy Engine
- **EasyList & Ghostery Engine**: Integrated `@ghostery/adblocker-electron` engine for network-level tracker, banner, and script blocking.
- **Zero-Knowledge Privacy Mesh**: ZKP identity commitments for anonymous sync and private ad replacement rewards (**ADION** tokens).
- **Episodic Session Memory**: Persistent session interaction logs stored locally at `.data/session_interactions.json` without cloud telemetry.

### 6. 🛠️ Process Resilience & Developer Experience
- **Process Supervisor**: `scripts/supervisor.js` with unbuffered real-time stdout/stderr (`stdio: 'inherit'`) and persistent logging tee (`.data/browser.log`).
- **Detached Developer Tools**: `F12`, `Ctrl+Shift+I`, or the `<>` toolbar button opens a detached DevTools window that works whether focus is inside a webpage or the browser toolbar.
- **Real-Time Telemetry Dashboard**: Access `adion://dashboard` for network analytics, latency graphs, and shield metrics.

---

## 📦 Getting Started

### Prerequisites
- Node.js 18+ (tested on Node 20 / 22 / 24)
- Python 3.10+ (for benchmark verification)
- Windows / macOS / Linux

### Installation
```bash
# Clone the repository
git clone https://github.com/adityasingh03rajput/adion-browse.git
cd adion-browse

# Install dependencies
npm install
```

### Running the Browser
```bash
# Standard launch with process resilience supervisor
npm start

# Or double-click the one-click Windows launcher (redirects cache to D: drive)
run-adion.bat
```

### Running Model Context Protocol (MCP) Server
```bash
# Standalone MCP server
npm run mcp

# Port forwarding / tunnel for Claude Web
npm run mcp:tunnel
```

---

## 🧪 Testing & Verification

Adion Browse includes 7 automated verification suites covering resilience, session memory, query preprocessing, MCP protocol, optional toggles, 3rd-party model providers, and toolbar interactions:

```bash
# Run all 7 JavaScript test suites
npm test

# Run Python token reduction benchmark (Playwright vs Adion MCP)
py -m pytest bench_tokens.py
```

---

## 📂 Architecture & Directory Layout

```
Adion Browse/
├── .data/                     # Local session interactions, profile, and browser.log
├── .cache/                    # Local cache directory on D: drive (isolated)
├── scripts/
│   ├── supervisor.js          # Process resilience monitor & unbuffered stdout relay
│   ├── mcp-server.js          # Standalone Model Context Protocol server entry
│   ├── port-forward.js        # Port forwarding and public tunnel manager for Claude
│   └── test-mcp-e2e.js        # End-to-end MCP benchmark & tool validation
├── src/
│   ├── control-plane/         # Decoupled AI Autonomous Control Plane
│   │   ├── agentRuntime.js    # Continuous voice stream, VAD state machine & intent executor
│   │   ├── sttEngine.js       # Whisper-large-v3-turbo, software AGC & audio normalization
│   │   ├── queryPreprocessor.js # <0.5ms zero-latency linguistic cleaner & fast-path router
│   │   ├── modelClient.js     # Autonomous multi-step function calling & backoff coordinator
│   │   ├── protocol.js        # Typed action contracts, IPC event types & agent states
│   │   ├── sessionManager.js  # Local session memory & prompt fidelity logger
│   │   ├── cdpBridge.js       # Chrome DevTools Protocol link for clicks, scrolls & frames
│   │   ├── visionGrounder.js  # Multimodal stream & spatial element grounding
│   │   ├── contextEngine.js   # Episodic session graph & tab clustering
│   │   ├── securityVault.js   # Voice biometric vault & DOM prompt injection filter
│   │   └── providers/         # 3rd-Party LLM Provider implementations
│   │       ├── providerRegistry.js
│   │       ├── openaiProvider.js
│   │       ├── anthropicProvider.js
│   │       ├── geminiProvider.js
│   │       └── customProvider.js
│   ├── main/
│   │   ├── index.js           # Electron main process, IPC coordinator & global shortcuts
│   │   ├── tabManager.js      # Isolated BrowserView management & detached DevTools
│   │   ├── shield.js          # Adion Shields ad & tracker blocker engine
│   │   └── store.js           # Local bookmarks, history, settings & shield stats
│   ├── mcp/
│   │   └── mcpServer.js       # Native HTTP / SSE Model Context Protocol server
│   ├── preload/
│   │   └── preload.js         # Context bridge exposing window.adionAPI securely
│   ├── renderer/
│   │   ├── index.html         # Browser chrome UI with Voice HUD & Omnibox Status Pill
│   │   ├── styles.css         # Dark cyberpunk theme, tactile feedback & HUD animations
│   │   └── app.js             # UI chrome controller, 16kHz downsampling & audio processor
│   ├── newtab/
│   │   └── newtab.html        # Privacy dashboard with live stats & search
│   └── dashboard/
│       └── dashboard.html     # Live Telemetry & Network Diagnostics (adion://dashboard)
├── tests/                     # 8 automated test suites
├── bench_tokens.py            # Token reduction benchmark vs Playwright
└── run-adion.bat              # One-click Windows launcher
```

---

## 🧠 Context-Aware In-Page Intelligence

Adion Browse goes beyond rigid regex matching: it grounds natural language instructions in active webpage context to execute human intention:
- **WhatsApp Web Contact Search & Dispatch**: Entering commands like `say hi to pidduk`, `text contact hello`, or `message pidduk are you coming` automatically searches WhatsApp Web's chat list, activates the contact conversation, populates the composer, and dispatches Send without premature task termination.
- **Autonomous Gateway Navigation**: Automatically detects and taps through intermediate gateway prompts (e.g. `Use WhatsApp Web`, `Continue to chat`, `Continue on browser`).
- **Live Autonomous Step Streaming**: Every progress step (`Searching for contact`, `Opening chat`, `Message sent`) streams in real-time into the Chrome Gemini-style Copilot side panel timeline (`Ctrl + J`).

---

## 📜 Keyboard Shortcuts

| Shortcut | Action |
|---|---|
| `Ctrl + Space` | Toggle AI Voice Commander (start / stop microphone stream) |
| `Ctrl + K` | Open AI Text Task Commander (type a task / command without speaking) |
| `Ctrl + J` | Toggle Jarvis Copilot Side Panel (Chrome Gemini-style side-by-side assistant) |
| `F12` or `Ctrl + Shift + I` | Toggle Detached Developer Tools (works on webpage or browser UI) |
| `Ctrl + T` | Open New Tab (`adion://newtab`) |
| `Ctrl + W` | Close Active Tab |
| `Ctrl + R` | Reload Current Page |
| `Ctrl + L` | Focus Omnibox / Address Bar |
| `Ctrl + H` | Open Browsing History |
| `Ctrl + Tab` | Switch to Next Tab |
| `Ctrl + Shift + Tab` | Switch to Previous Tab |
| `Ctrl + 1-9` | Switch to Tab by Index |
| `Escape` | Close Open Overlays and Modals |

---

## 📄 License
ISC © Adion Browse
