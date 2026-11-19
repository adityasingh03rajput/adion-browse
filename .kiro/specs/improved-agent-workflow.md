# Improved Agent Workflow Design

## Problem Statement

The current tool decision workflow had several issues:

1. **ModelRouter adds unnecessary complexity** - It added a routing layer that duplicated functionality
2. **Task classification was ad-hoc** - Pattern matching on keywords was fragile
3. **No separation of concerns** - Routing, planning, and execution were intertwined

## Solution: AI-Driven Tool Selection

### Removed Components
- ✅ Deleted `modelRouter.js` (~400 lines of complex routing logic)
- ✅ Removed `TaskType` enum from `protocol.js`
- ✅ Removed `this.router` from `agentRuntime.js`

### New Simplified Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         Agent Workflow Layer                            │
├─────────────────────────────────────────────────────────────────────────┤
│  1. Input Processing  →  2. Model Planning  →  3. Execution  →  4. Loop │
│                        (AI decides tools)                    (AgentLoop) │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                       Model Provider Layer                              │
├─────────────────────────────────────────────────────────────────────────┤
│  ProviderRegistry (OpenAI, Anthropic, Groq, Custom, Gemini, FreeModel) │
│                          ↓ Single Responsibility                        │
│                   plan(prompt, history) → JSON Plan                     │
└─────────────────────────────────────────────────────────────────────────┘
```

## Key Improvements

### 1. AI Decides Tools (Not Code)
The model receives full context (page elements, conversation history) and **decides which tools to use**:

```javascript
// System prompt now includes tool selection examples:
// | User Command | Current Page | Selected Tool | Why |
// |--------------|--------------|---------------|-----|
// | "Open Canva" | New tab      | NAVIGATE      | Need to go to canva.com |
// | "Search Square" | Canva   | INPUT_TEXT    | Search bar visible |
// | "Click Sign Up" | Canva  | CLICK_SELECTOR| "Sign Up" button visible |
```

### 2. Clean Decision Flow

```
User Input
    ↓
[AgentRuntime] processCommand()
    ↓
Gather Context (page, history, elements)
    ↓
Select Provider (ProviderRegistry.getActiveProvider())
    ↓
Call provider.plan(prompt, history)
    ↓
Model receives context + tool list + examples
    ↓
AI decides tools based on intent + available elements
    ↓
Parse JSON Response (with tools selected by AI)
    ↓
Validate Actions (Code-level safety)
    ↓
Execute Actions
    ↓
Verify Results
    ↓
Record Interaction
    ↓
[Loop: Repeat until goal accomplished]
```

### 3. Tool Selection Examples in System Prompt

The AI now gets explicit guidance:

```
## Tool Selection Logic (AI-Driven Decision)

### How to Choose Tools
The model SELECTS tools based on:
1. User Intent - What does the user want?
2. Current Page State - What elements are available?
3. Conversation History - What was done already?

### Examples
- "go to" → NAVIGATE
- "search for" → INPUT_TEXT (search field) or NAVIGATE (web search)
- "click" → CLICK_SELECTOR
- "type" → INPUT_TEXT
- "what is" → PAGE_ANALYSIS_OR_QA
- "scroll" → SCROLL
```

### 4. Provider Selection Strategy

**Priority Order (only if configured):**
1. **OpenAI** - gpt-4o, o1, o3-mini (best for complex planning)
2. **Anthropic** - claude-3-5-sonnet (reliable, safe)
3. **Gemini** - gemini-2.0-flash (fast, capable)
4. **Groq** - free tier fallback (always available)
5. **Custom** - user-configured endpoints

**Default (if none configured):** Groq Cloud (zero-cost)

### 5. Safety Layers (Code-Level, Not Model-Dependent)

```javascript
function validateIntent(intent) {
  // NEVER type into sensitive fields without explicit user permission
  if (isSensitiveField(intent.selector)) {
    return 'Cannot type into password, card, or OTP fields';
  }
  
  // NEVER click delete without confirmation
  if (isDeleteAction(intent)) {
    return 'Cannot delete without explicit user authorization';
  }
  
  // NEVER navigate off-site without permission
  if (isExternalNavigation(intent) && !isAllowedDomain(intent.url)) {
    return 'Cannot navigate to external domains without permission';
  }
  
  return null; // Intent is safe
}
```

## Implementation Results

### Files Modified

| File | Change |
|------|--------|
| `modelRouter.js` | **DELETED** (400+ lines removed) |
| `agentRuntime.js` | Removed ModelRouter import and `this.router` |
| `protocol.js` | Removed unused TaskType enum |
| `modelClient.js` | Added tool selection examples to system prompt |

### Benefits

1. **~400 lines of code removed** - Simpler, more maintainable
2. **Better AI decisions** - Model has full context to choose tools
3. **Easier debugging** - One less layer to trace through
4. **Zero-cost guaranteed** - Groq fallback still works
5. **Clearer documentation** - Tool selection examples in system prompt

## Testing Workflow

### Example: "Open Canva" → "Search for Square"

**Step 1: "Open Canva"**
```
Input: "Open Canva"
Context: URL=adion://newtab, Title=New Tab, No visible buttons
AI Decision: NAVIGATE to https://canva.com
Result: Page changes to Canva homepage
```

**Step 2: "Search for Square"**
```
Input: "Search for Square"
Context: URL=https://canva.com, Title=Home - Canva, Search input visible
History: [{user: "Open Canva", agent: "Navigated to canva.com"}]
AI Decision: INPUT_TEXT into search field
Result: Search box filled with "Square"
```

### Why This Works Better

1. **No hardcoded routing** - AI uses context to decide
2. **Conversation history preserved** - AI knows previous step
3. **Page elements visible** - AI sees available tools
4. **Examples guide selection** - Clear instructions in system prompt

## Future Improvements

1. Add visual grounding (screenshot analysis) for complex UIs
2. Add intent classification (optional preprocessing step)
3. Add tool validation before execution (more detailed checks)
## Future Improvements

1. Add visual grounding (screenshot analysis) for complex UIs
2. Add intent classification (optional preprocessing step)
3. Add tool validation before execution (more detailed checks)

## PAGE_ANALYSIS_OR_QA Implementation (Latest)

### Problem
When the model selected `PAGE_ANALYSIS_OR_QA` for conversational questions like "Tu vas ?", the system returned:
```
[AgentRuntime] Unhandled intent type: PAGE_ANALYSIS_OR_QA
```

### Root Cause
1. `PAGE_ANALYSIS_OR_QA` was defined in the system prompt and `actionPlan.js` aliases, but not in `TYPE_ALIASES` as a direct key
2. No handler existed in `executeIntent()` switch statement
3. No `synthesizeAnswer()` method in `modelClient.js`

### Fix Applied

#### 1. Updated TYPE_ALIASES in `actionPlan.js`
```javascript
const TYPE_ALIASES = {
  // ... existing aliases ...
  ANSWER: 'PAGE_ANALYSIS_OR_QA',
  CHAT: 'PAGE_ANALYSIS_OR_QA',
  PAGE_ANALYSIS: 'PAGE_ANALYSIS_OR_QA',
  PAGE_ANALYSIS_OR_QA: 'PAGE_ANALYSIS_OR_QA',  // NEW
  QA: 'PAGE_ANALYSIS_OR_QA'
};
```

#### 2. Added Handler in `agentRuntime.js`
```javascript
case 'PAGE_ANALYSIS_OR_QA': {
  this.emit('feedback', { message: `Answering: ${intent.query || 'analyzing page...'}`, level: 'info' });
  
  if (intent.query && this.modelClient) {
    try {
      const pageContext = await this.getGeneralPageContext();
      const history = this.sessionManager ? this.sessionManager.getHistory().interactions.slice(-5) : [];
      
      const response = await this.modelClient.synthesizeAnswer(intent.query, pageContext, history);
      
      this.emit('feedback', { message: response, level: 'success' });
      executionResult = { success: true, answer: response, verified: true };
    } catch (err) {
      this.emit('feedback', { message: 'Could not synthesize answer', level: 'warning' });
      executionResult = { success: false, reason: 'ANSWER_SYNTHESIS_FAILED', verified: false };
    }
  } else {
    executionResult = { success: true, answer: 'I can see the page content. How can I help?', verified: true };
  }
  break;
}
```

#### 3. Added `synthesizeAnswer()` in `modelClient.js`
```javascript
async synthesizeAnswer(query, pageContext = {}, conversationHistory = []) {
  // Build context from page buttons, headings, text
  // Build conversation history snippet
  // Query active provider or Groq fallback
  // Return concise answer (under 3 sentences)
}
```

### How It Works Now

**User Query: "Tu vas ?" (How are you?)**
```
1. User sends query via Ask Adion
2. AgentRuntime.processCommand() → modelClient.planActions()
3. Model receives context + system prompt with PAGE_ANALYSIS_OR_QA examples
4. Model selects PAGE_ANALYSIS_OR_QA (no actions needed, just answer)
5. intent = { type: 'PAGE_ANALYSIS_OR_QA', query: 'Tu vas ?' }
6. executeIntent() matches PAGE_ANALYSIS_OR_QA case
7. Calls modelClient.synthesizeAnswer(query, pageContext, history)
8. Provider returns conversational response
9. Feedback emitted: "I'm doing well, thank you for asking! How can I help you today?"
10. Task marked complete with verified: true
```

### Files Modified

| File | Change |
|------|--------|
| `actionPlan.js` | Added `PAGE_ANALYSIS_OR_QA`, `PAGE_ANALYSIS`, `QA` to TYPE_ALIASES |
| `agentRuntime.js` | Added PAGE_ANALYSIS_OR_QA case to executeIntent switch |
| `modelClient.js` | Added synthesizeAnswer() method |
| `.kiro/specs/improved-agent-workflow.md` | This document |

### Verification
- Model can now return PAGE_ANALYSIS_OR_QA for conversational questions
- Answer is synthesized using active provider or Groq fallback
- No actions executed, only conversational response
- User sees feedback message with the answer
### PAGE_ANALYSIS_OR_QA Usage Pattern

The `PAGE_ANALYSIS_OR_QA` tool is designed for:
1. **User asks "what is" or "tell me about" something on the page**
2. **User asks a conversational question that doesn't require UI interaction**
3. **User wants to know about page content without clicking anything**

The tool should NOT be used for:
- Directing the agent to click or interact with elements (use `CLICK_SELECTOR`)
- Navigating to a page (use `NAVIGATE`)
- Typing into forms (use `INPUT_TEXT`)

### Grounding Element Selection Improvements

**Problem:** The AXTree grounding was matching "See all your frequently used design types" instead of "Your paragraph text" because:
1. Token scoring didn't prioritize exact substring matches strongly enough
2. Length similarity wasn't considered in scoring
3. No penalty for much longer element names

**Solution:** Updated `groundClickAX` function to:
1. Give exact substring match a higher base score (2.0 instead of 1.0)
2. Add bonus for element names similar in length to query
3. Add penalty for element names much longer than query (likely metadata/descriptive text)
4. Increase minimum score threshold from 0.35 to 0.5 for more confident matches

**Result:** Elements like "Your paragraph text" now score significantly higher than surrounding UI text like "See all your frequently used design types".

### Files Modified

| File | Change |
|------|--------|
| `agentRuntime.js` | Updated `groundClickAX` with improved element scoring |
| `actionPlan.js` | Added `PAGE_ANALYSIS_OR_QA`, `PAGE_ANALYSIS`, `QA` to TYPE_ALIASES |
| `agentRuntime.js` | Added PAGE_ANALYSIS_OR_QA case to executeIntent switch |
| `modelClient.js` | Added synthesizeAnswer() method |