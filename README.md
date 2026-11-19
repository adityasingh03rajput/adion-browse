    # Adion Browse 🦁🛡️🤖

    **Adion Browse** is a production-grade, privacy-first web browser built on **Chromium** and **Electron**, featuring:
    - 🎙️ **Continuous Voice Assistant** with hardware VAD & Whisper transcription
    - 🛡️ **Adion Shields** - EasyList & Ghostery-based ad/tracker blocking
    - 🧠 **Multi-Model AI Backend** - Groq, OpenAI, Claude, Gemini, local models
    - 📡 **Native MCP Server** - Model Context Protocol for autonomous LLM operators
    - ⚡ **Zero-Latency Intent Understanding** - Direct user intent execution without reflex shortcuts
    - 🔒 **Privacy-First Architecture** - No cloud telemetry, local session memory only

    ---

    ## 🎯 Core Philosophy

    **Adion Browse respects user intent above all else.**
    - User speaks a command → **Full semantic understanding** by LLM
    - **Multi-step workflows** are decomposed and executed in sequence
    - **No reflex shortcuts** that break context or misinterpret intent
    - **Deterministic safety** through code-level guards, not probabilistic LLM filtering
    - **Honest error reporting** - if an action fails, explain why

    ---

    ## 🚀 Architecture Overview

    ### 1. 🎙️ Voice Pipeline
    - **Continuous Listening**: Stays active across multiple commands, auto-re-arms after execution
    - **Hardware VAD**: Real-time acoustic energy analysis (Frame RMS tracking, Speech: true/false)
    - **16kHz PCM Stream**: Automatic downsampling from 48kHz/44.1kHz hardware rates
    - **Whisper-Large-v3-Turbo**: Ultra-low-latency transcription on Groq LPU with English-greedy decoding
    - **Acoustic Filters**: Rejects ambient noise, video outros, and word-repetition loops

    ### 2. 🧠 Intent Understanding (LLM-Driven)
    **All user commands go directly to the language model** for full semantic understanding:
    - Parse multi-step workflows (e.g., "close this tab, then search for X")
    - Understand context-dependent instructions (pronouns, site-specific actions)
    - Generate structured action plans with task breakdown
    - Handle complex forms, authentication flows, and dynamic pages
    - **No aggressive reflex shortcuts** that break multi-step reasoning

    ### 3. ⚡ Action Execution
    Supports 40+ atomic operations:
    - **Navigation**: `NAVIGATE`, `BACK`, `FORWARD`, `RELOAD`
    - **DOM Interaction**: `CLICK_SELECTOR`, `INPUT_TEXT`, `SCROLL`, `MODIFY_DOM`
    - **Browser Control**: `NEW_TAB`, `CLOSE_TAB`, `SWITCH_TAB`, `TOGGLE_DEVTOOLS`
    - **Platform-Specific**: `WHATSAPP_CHAT_SEND`, `PLAY_VIDEO_FROM_THUMBNAIL`
    - **Desktop/PC Mode**: `TERMINAL_EXEC`, `OPEN_APP`, `PC_CLICK`, `PC_TYPE`, `SYSTEM_VOLUME`
    - **Intelligence**: `PAGE_ANALYSIS_OR_QA`, `RESEARCH_TOPIC`, `COMPARE_PRICES`

    ### 4. 🛡️ Adion Shields
    - **EasyList + Ghostery**: Network-level tracker and ad blocking
    - **Script Blocking**: Optional per-site JavaScript disable
    - **HTTPS Upgrade**: Automatic HTTP→HTTPS redirection
    - **Live Stats**: Real-time tracker count & blocked resources

    ### 5. 📡 Model Context Protocol (MCP)
    - **Standardized Interface**: HTTP/SSE at `http://127.0.0.1:9224`
    - **Semantic DOM Export**: 99.4% token reduction vs raw HTML
    - **Tool Suite**: Browser navigation, clicking, scrolling, DOM inspection, screenshots
    - **Optional Standby**: Disabled by default; toggle in Settings without restart

    ### 6. 🧩 Extensible AI Skills Engine (Claude / Antigravity Architecture)
    - **Modular Capabilities**: Add ANY custom skill simply by dropping a `SKILL.md` into the `skills/` directory or clicking **+ Add Skill** in Copilot.
    - **YAML Frontmatter + Markdown Directives**: Standard skill definition format:
      ```markdown
      ---
      name: my-researcher
      title: Specialized Market Researcher
      trigger: /market
      description: Scrapes pricing, competitors, and reviews
      ---
      # Execution Directives
      1. Formulate multiple distinct search queries...
      ```
    - **Zero-Latency Slash Dispatch**: Type `/` in the Copilot chat bar to launch the dynamic, filterable skills popover.
    - **Built-in Starter Skills**:
      - 🔍 `/research` (`deep-research`): Multi-source deep web intelligence & cross-referenced synthesis
      - 📑 `/summarize` (`page-summary`): High-signal cognitive thesis, empirical data, and action items
      - 📊 `/extract` (`data-extractor`): Scrapes repeating tables/cards into Markdown tables and JSON
      - 🏷️ `/price` (`price-tracker`): Price comparison, deal validation, and discount checking
      - 💻 `/review` (`code-reviewer`): GitHub/GitLab PR and code quality/security auditing
      - 📝 `/autofill` (`form-autofill`): Multi-field form completion with semantic field grounding
      - 🖥️ `/pc_use` (`computer-use`): Host PC PowerShell/Bash workspace automation

    ### 7. 🔄 Multi-Provider Routing
    - **OpenAI**: gpt-4o, gpt-4o-mini
    - **Anthropic**: claude-3-5-sonnet, claude-3-5-haiku
    - **Google Gemini**: gemini-2.0-flash
    - **Groq LPU**: llama-3.3-70b, openai/gpt-oss-120b, qwen/qwen3.8-27b
    - **Local/Custom**: Ollama, vLLM, DeepSeek (OpenAI-compatible)
    - **Failover**: Automatic retry & model rotation on rate limits (429) or service errors (503)

    ---

    ## 📦 Installation & Setup

    ### Prerequisites
    - Node.js 18+ (tested on 20, 22, 24)
    - Python 3.10+ (for benchmarks)
    - Windows / macOS / Linux

    ### Installation
    ```bash
    git clone https://github.com/adityasingh03rajput/adion-browse.git
    cd adion-browse
    npm install
    ```

    ### Running the Browser
    ```bash
    # Standard launch with process supervision
    npm start

    # Windows one-click launcher (caches to D: drive)
    run-adion.bat
    ```

    ### MCP Server
    ```bash
    # Standalone MCP server
    npm run mcp

    # Port forwarding for Claude Web integration
    npm run mcp:tunnel
    ```

    ---

    ## 📂 Directory Structure

    ```
    Adion Browse/
    ├── .data/                     # Local session logs & profile
    ├── scripts/
    │   ├── supervisor.js          # Process resilience & stdout relay
    │   ├── mcp-server.js          # MCP server entry point
    │   ├── port-forward.js        # Tunnel manager for Claude
    │   └── test-mcp-e2e.js        # MCP benchmark
    ├── src/
    │   ├── control-plane/         # AI Control Plane
    │   │   ├── agentRuntime.js    # Voice VAD, intent executor
    │   │   ├── modelClient.js     # LLM multi-step planner
    │   │   ├── sttEngine.js       # Whisper transcription
    │   │   ├── sessionManager.js  # Local session memory
    │   │   ├── cdpBridge.js       # Chrome DevTools Protocol
    │   │   ├── contextEngine.js   # Page context grounding
    │   │   ├── actionPlan.js      # Action schema & parser
    │   │   ├── queryPreprocessor.js # Linguistic cleaning
    │   │   ├── securityVault.js   # Injection filters
    │   │   └── providers/         # LLM provider implementations
    │   ├── main/                  # Electron main process
    │   │   ├── index.js           # IPC coordinator
    │   │   ├── tabManager.js      # BrowserView management
    │   │   └── shield.js          # Shields engine
    │   ├── mcp/
    │   │   └── mcpServer.js       # MCP HTTP/SSE server
    │   ├── renderer/              # Browser UI
    │   │   ├── index.html         # Chrome UI & HUD
    │   │   ├── app.js             # UI controller
    │   │   └── styles.css         # Cyberpunk theme
    │   └── companion/             # Unused reflex modules (kept for reference)
    ├── tests/                     # 7 automated suites
    ├── bench_tokens.py            # Token reduction benchmark
    └── README.md
    ```

    ---

    ## 🎙️ Voice Commands

    **Example workflows:**

    | Command | Execution |
    |---------|-----------|
    | "Open canva.com" | Navigate to Canva home |
    | "Search for web design tips" | Web search via Brave/Google |
    | "Click on create design button" | Grounded element click |
    | "Open your paragraph text project" | Multi-step: Click project from list → Wait for load → Enter edit mode |
    | "Send hello to alice on whatsapp" | Search contact → Click chat → Type message → Send |
    | "Mute volume" | System volume control |
    | "Switch to dark mode" | Theme toggle |
    | "What's the main topic of this page?" | PAGE_ANALYSIS_OR_QA - synthesizes answer |

    ---

    ## 🔧 Keyboard Shortcuts

    | Shortcut | Action |
    |----------|--------|
    | `Ctrl + Space` | Toggle Voice Commander |
    | `Ctrl + K` | Text Task Commander |
    | `Ctrl + J` | Copilot Side Panel |
    | `F12` / `Ctrl + Shift + I` | Developer Tools |
    | `Ctrl + T` | New Tab |
    | `Ctrl + W` | Close Tab |
    | `Ctrl + R` | Reload |
    | `Ctrl + L` | Focus Address Bar |
    | `Ctrl + H` | History |
    | `Ctrl + Tab` | Next Tab |
    | `Escape` | Close Overlays |

    ---

    ## 🧪 Testing

    ```bash
    # Run 7 automated test suites
    npm test

    # Token reduction benchmark (Playwright vs Adion MCP)
    py -m pytest bench_tokens.py
    ```

    ---

    ## 🔐 Privacy & Safety

    - ✅ **Local Processing**: Voice transcription & planning stays on-device or on user's chosen model provider
    - ✅ **No Cloud Telemetry**: Session interactions logged locally only
    - ✅ **Code-Level Guards**: Deterministic safety filters for sensitive actions (auth, payments, deletion)
    - ✅ **User Consent**: Multi-step confirmations for destructive operations
    - ✅ **HTTPS Upgrade**: Automatic secure connection enforcement

    ---

    ## 📄 License
    ISC © Adion Browse

    ---

    ## 🚀 Recent Improvements

    **v1.2.0 (Latest)**
    - ✅ Removed aggressive reflex shortcuts that misinterpreted multi-step commands
    - ✅ All commands now route through LLM for full semantic understanding
    - ✅ Better token coverage matching in element grounding (prevent wrong clicks)
    - ✅ Improved loop guards to prevent task repetition
    - ✅ Cleaner error reporting with actionable feedback


