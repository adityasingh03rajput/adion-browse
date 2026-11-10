# Adion Browse 🦁🛡️🤖

**Adion Browse** is a high-performance, privacy-first web browser built on top of the real **Chromium** engine and **Electron**, featuring a built-in **Adion Shields** ad & tracker blocking engine and a **Decoupled Asynchronous Control Plane** for local AI voice control, continuous multimodal vision grounding, and edge multi-agent orchestration.

---

## 🚀 Key Framework Features

### 1. 🎙️ AI Voice Commander & Decoupled Control Plane
- **Decoupled Architecture**: Keeps Chromium's 60+ FPS rendering pipeline isolated from asynchronous AI and agent execution.
- **Chrome DevTools Protocol (CDP) Bridge**: Directly executes synthetic mouse kinematics, pixel clicks, smooth scroll wheel deltas, and high-definition viewport screenshots.
- **Voice Hotkey & Ambient HUD**: Press `Ctrl + Space` or click the microphone icon in the omnibox to activate the floating glassmorphic AI HUD.
- **Natural Language Intent Parsing**: Translates commands like *"Scroll down"*, *"Open YouTube"*, *"Click search"*, and *"Close tab"* into deterministic browser actions.

### 2. 👁️ Continuous Multimodal Stream & Vision Grounding
- **Spatial Element Locator**: Grounds descriptive references to pixel-level bounding boxes and dimensions.
- **Semantic Image Filtering**: Analyzes visible images on the active web page and scores them against user criteria.
- **Interactive Disambiguation Overlays**: Renders color-coded target badges (`Option 1`, `Option 2`) on the page when multiple candidates match.

### 3. 🧠 Local Context Engine & Session Memory
- **Episodic Session Graph**: Tracks domain transitions and user journey trajectories locally without cloud telemetry.
- **Autonomous Tab Clustering**: Automatically categorizes active tabs (*Development*, *Media*, *Shopping*, *Search*, *Social*) for workspace hibernation.
- **Predictive Navigation**: Pre-computes destination probabilities based on historical transition edges.

### 4. 🔒 Biometric Voice Vault & Prompt Injection Defense
- **Voice Biometric Verification**: Simulates 192-dimensional acoustic speaker embeddings before releasing credentials for autofill or checkouts.
- **Hardware-Backed AES-256-GCM Vault**: Session encryption with immediate memory zeroization.
- **Indirect Prompt Injection Neutralizer**: Sanitizes untrusted web content before it enters agent context, stopping prompt override attacks.

### 5. 👥 Distributed Edge Multi-Agent Pool
- **Specialized Parallel Agents**: Spawns isolated local workers for:
  - *Deep Research Agent*: Concurrently synthesizes findings across active documentation tabs.
  - *Comparative Shopping Agent*: Scans product candidates across multiple vendors to produce structured savings matrices.

### 6. 🛡️ Zero-Knowledge Mesh & Privacy Ad Economy
- **ZKP Identity Commitments**: Cryptographic zk-SNARK commitments for anonymous authentication and sync.
- **Privacy-Preserving Ad Replacement**: Replaces intrusive tracker ads with locally verified recommendations, granting users **ADION** token micropayments directly on the New Tab dashboard.

---

## 📦 How to Run

### One-Click Launch (Windows - D: Drive Cache Isolated)
Double-click `run-adion.bat` in this directory:
- Protects your `C:\` drive by redirecting `ELECTRON_CACHE`, `HF_HOME`, `TORCH_HOME`, and `TMP` to `D:\Adion Browse\.cache\`.

### Command Line
```powershell
npm start
```

---

## 🛠️ Architecture & Directory Layout

```
Adion Browse/
├── .cache/                    # Local cache directory on D: drive (Full User Permissions)
├── .npmrc                     # Redirects npm cache to D: drive
├── run-adion.bat              # One-click Windows launcher with cache isolation
├── setup-chromium-env.bat     # Chromium toolchain & depot_tools configuration
├── package.json               # Dependencies & scripts
├── src/
│   ├── control-plane/         # Decoupled Asynchronous AI Control Plane
│   │   ├── protocol.js        # Action types, Agent states & typed IPC contracts
│   │   ├── cdpBridge.js       # Chrome DevTools Protocol link for clicks, scrolls & frames
│   │   ├── visionGrounder.js  # Multimodal stream & spatial element grounding
│   │   ├── contextEngine.js   # Episodic session graph & tab clustering
│   │   ├── securityVault.js   # Voice biometric vault & prompt injection filter
│   │   ├── agentRuntime.js    # Asynchronous intent parser & coordinator
│   │   ├── multiAgentPool.js  # Distributed edge multi-agent pool
│   │   ├── dataSynthesizer.js # Differential privacy (DP-SGD) telemetry synthesis
│   │   ├── zkpMesh.js         # ZKP identity & privacy ad replacement economy
│   │   └── controlPlane.js    # Central orchestrator connecting Main, CDP & UI
│   ├── main/
│   │   ├── index.js           # Electron main process & IPC coordinator
│   │   ├── shield.js          # Adion Shields ad & tracker blocker engine
│   │   ├── tabManager.js      # Isolated BrowserView management & tab switching
│   │   └── store.js           # Local bookmarks, history & shields stats
│   ├── preload/
│   │   └── preload.js         # Context bridge exposing window.adionAPI (Shields + Agents)
│   ├── renderer/
│   │   ├── index.html         # Browser chrome UI with Voice HUD overlay
│   │   ├── styles.css         # Dark cyberpunk theme & agent pulse animations
│   │   └── app.js             # UI state controller, speech API & shortcuts
│   └── newtab/
│       ├── newtab.html        # Brave-style dashboard with ZKP rewards card
│       ├── newtab.css         # High-contrast typography & glassmorphism
│       └── newtab.js          # Live clock, search & rewards updater
```
