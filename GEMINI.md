# Adion Browse — Autonomous Engineering & Agent Memory Guidelines

## 1. Prime Directive: General-Purpose Browser Architecture
Adion Browse is an autonomous, AI-first web browser designed to navigate, perceive, understand, and interact with **ANY website on the internet**. 
- **NO SITE-SPECIFIC HARDCODED HACKS**: Never hardcode site-specific CSS classes, mock responses, or fragile workarounds for one single website (e.g. WhatsApp, YouTube, Google, Twitter) to fake agent competence for a developer test.
- **GENERALIZE ALL CAPABILITIES**: Every browser agent feature—element finding, text input, button clicking, form submission, and verification—must be built as a general-purpose, site-agnostic primitive that works uniformly across modern single-page applications (React 18, Vue, Angular, Svelte, Lexical, Draft.js, ProseMirror, Shadow DOM, standard HTML).

## 2. Integrity & Developer Trust: NEVER Fake Completion
- **Verify Before Declaring Success**: An autonomous task is only complete when its outcome is verified in the live page DOM (e.g. input cleared, new element rendered, network request completed, or navigation occurred).
- **Absolute Honesty**: If an element is missing, an action timed out, or authentication is required (e.g. login, QR code scan), report the truth clearly and concisely. NEVER emit fake success notices like "prepared and ready" when the action did not actually execute.
- **No Deceptive Fallbacks**: Never swallow failures or cycle indefinitely in blind loops. Fail gracefully with adaptive analysis, and inform the developer exactly what happened.

## 3. Dual-Tier Input & Real Hardware Dispatch
Modern web applications ignore synthetic JavaScript DOM events (`el.value = ...`, `new Event(...)`). To interact reliably with any web app:
1. **Semantic Grounding**: Resolve elements by accessibility role, aria-label, title, placeholder, and text content across both standard DOM and Shadow DOM trees.
2. **DOM Insertion**: Use `document.execCommand('insertText')` and `InputEvent` for rich-text editors and controlled components.
3. **Chromium Hardware Input (`sendInputEvent`)**: Always dispatch real OS-level Chromium hardware keystrokes (`keyDown`, `char`, `keyUp`) and mouse clicks via `webContents.sendInputEvent` or CDP `Input.dispatchKeyEvent` / `Input.dispatchMouseEvent`. This guarantees that React synthetic event systems and framework state machines register the input.

## 4. Architectural Standards & Test Discipline
- Maintain 100% test pass rate across all test suites (`npm test`).
- Maintain zero-cost model routing and <0.5ms preprocessing benchmarks (`py -m pytest bench_tokens.py`).
- Keep code clean, modular, and maintainable.
