# tool scan — whole-screen scanner

Asks Windows what it put on screen. No npm install, no admin, stdlib only.

## What it does

| Flag | Source (OS) | Result |
|---|---|---|
| `--shot [file]` | Win32 virtual screen (`System.Drawing`) | PNG of **all monitors** + virtual-screen origin |
| `--windows` | Win32 `EnumWindows` via Adion's `probe.ps1` | hwnd, process, title, **rect (x,y,w,h)** for every visible window |
| `--uia [--hwnd N]` | UI Automation tree | every control's **name/type/rect** (+ normalized 0–1000) |
| `--text` | UIA TextPattern | readable text of the window |
| `--ocr [file]` | WinRT `Windows.Media.Ocr` (local, free) | text seen in the screenshot |
| `--find "Save"` | UIA search | best control + its rect + score |
| `--at X,Y` | `AutomationElement.FromPoint` | control under a screen point |
| `--describe "prompt"` | Groq vision model (`GROQ_VISION_MODEL`) | **"what is this image about"** in words |

Positions are physical screen pixels in virtual-screen coordinates, plus
`norm1000` (0–1000 fractions of the screenshot) so a model can point back.

## Use

```bat
cd /d "D:\Adion Browse\tool scan"
node scan.js --all
node scan.js --shot --windows --uia --ocr
node scan.js --find "Save"
node scan.js --at 960,540
node scan.js --all --describe "What app is this? List the key controls." --out report.json
```

Double-click `run-scan.bat` for the default full scan.

## Keys

Vision (`--describe`) reads `..\.env` (`GROQ_API_KEY`, `GROQ_API_URL`,
`GROQ_VISION_MODEL`). Everything else works with no key, fully offline.

## Files

- `scan.js` — the scanner (Node 18+, no deps)
- `screen-shot.ps1` — screenshot-only helper
- `run-scan.bat` — double-click full scan
- `probe.ps1` / `ocr.ps1` are reused from `..\src\pc\` (copied here as fallback)
