/**
 * Control Plane IPC Protocol & Schema Definitions
 * Defines the contract between Electron Main, the UI Renderer, and the Asynchronous Agent Runtime.
 */

const AgentState = {
  IDLE: 'IDLE',
  LISTENING: 'LISTENING',
  PARSING_INTENT: 'PARSING_INTENT',
  GROUNDING_UI: 'GROUNDING_UI',
  EXECUTING_ACTION: 'EXECUTING_ACTION',
  AWAITING_DISAMBIGUATION: 'AWAITING_DISAMBIGUATION',
  AWAITING_BIOMETRICS: 'AWAITING_BIOMETRICS',
  ERROR: 'ERROR',
  // Gemini Task Mode States
  PLANNING_NEXT: 'PLANNING_NEXT',
  EXECUTING: 'EXECUTING',
  VERIFYING: 'VERIFYING',
  PAUSED_FOR_USER: 'PAUSED_FOR_USER',
  COMPLETED: 'COMPLETED',
  STOPPED: 'STOPPED'
};

const ActionType = {
  THEME_SET: 'theme_set',
  THEME_TOGGLE: 'theme_toggle',
  // Navigation & Tabs
  NAVIGATE: 'NAVIGATE',
  NEW_TAB: 'NEW_TAB',
  CLOSE_TAB: 'CLOSE_TAB',
  SWITCH_TAB: 'SWITCH_TAB',
  RELOAD: 'RELOAD',
  GO_BACK: 'GO_BACK',
  GO_FORWARD: 'GO_FORWARD',

  // DOM & Viewport Interactions
  SCROLL: 'SCROLL',
  CLICK_COORDINATE: 'CLICK_COORDINATE',
  CLICK_SELECTOR: 'CLICK_SELECTOR',
  INPUT_TEXT: 'INPUT_TEXT',
  CAPTURE_VIEWPORT: 'CAPTURE_VIEWPORT',

  // Semantic Vision & Downloads
  ANALYZE_IMAGES: 'ANALYZE_IMAGES',
  DOWNLOAD_IMAGE: 'DOWNLOAD_IMAGE',
  PLAY_VIDEO_FROM_THUMBNAIL: 'PLAY_VIDEO_FROM_THUMBNAIL',

  // Browser Shell & Developer Controls
  TOGGLE_DEVTOOLS: 'TOGGLE_DEVTOOLS',
  DEVTOOLS_SWITCH_PANEL: 'DEVTOOLS_SWITCH_PANEL',
  FOCUS_PAGE: 'FOCUS_PAGE',
  FOCUS_DEVTOOLS: 'FOCUS_DEVTOOLS',
  OPEN_SETTINGS: 'OPEN_SETTINGS',
  OPEN_BOOKMARKS: 'OPEN_BOOKMARKS',
  OPEN_HISTORY: 'OPEN_HISTORY',
  TOGGLE_BOOKMARK: 'TOGGLE_BOOKMARK',
  OPEN_DASHBOARD: 'OPEN_DASHBOARD',
  SHOW_METRICS_OVERLAY: 'SHOW_METRICS_OVERLAY',
  MODIFY_DOM: 'MODIFY_DOM',
  INSPECT_ELEMENT: 'INSPECT_ELEMENT',

  // Local System & Terminal Bridge
  TERMINAL_EXEC: 'TERMINAL_EXEC',

  // Native PC & OS Controls
  OPEN_APP: 'OPEN_APP',
  PC_CLICK: 'PC_CLICK',
  PC_MOVE: 'PC_MOVE',
  PC_TYPE: 'PC_TYPE',
  PC_PRESS: 'PC_PRESS',
  PC_SCROLL: 'PC_SCROLL',
  PC_READ: 'PC_READ',
  SYSTEM_VOLUME: 'SYSTEM_VOLUME',
  DESKTOP_SCREENSHOT: 'DESKTOP_SCREENSHOT',

  // Multi-Agent & Synthesis
  RESEARCH_TOPIC: 'RESEARCH_TOPIC',
  COMPARE_PRICES: 'COMPARE_PRICES',

  // Security & Vault
  REQUEST_BIOMETRIC_AUTH: 'REQUEST_BIOMETRIC_AUTH',
  FILL_CREDENTIAL: 'FILL_CREDENTIAL'
};

const IPCChannels = {
  // Renderer -> Control Plane
  AGENT_SEND_COMMAND: 'agent:send-command',
  AGENT_VOICE_STREAM_START: 'agent:voice-start',
  AGENT_VOICE_STREAM_DATA: 'agent:voice-data',
  AGENT_VOICE_STREAM_STOP: 'agent:voice-stop',
  AGENT_DISAMBIGUATE_SELECT: 'agent:disambiguate-select',
  AGENT_BIOMETRIC_SUBMIT: 'agent:biometric-submit',
  AGENT_CANCEL_TASK: 'agent:cancel-task',

  // Control Plane -> Renderer
  AGENT_STATE_CHANGE: 'agent:state-change',
  AGENT_VOICE_TRANSCRIPT: 'agent:voice-transcript',
  AGENT_ACTION_STARTED: 'agent:action-started',
  AGENT_ACTION_FINISHED: 'agent:action-finished',
  AGENT_DISAMBIGUATION_REQUIRED: 'agent:disambiguation-required',
  AGENT_FEEDBACK_MESSAGE: 'agent:feedback-message',
  AGENT_INSPECTOR_TELEMETRY: 'agent:inspector-telemetry',

  // Gemini Task Mode (Stateful Observable Execution Loop & Work Panel)
  TASK_MODE_GET_STATUS: 'task-mode:get-status',
  TASK_MODE_TOGGLE: 'task-mode:toggle',
  TASK_MODE_USER_ACTION: 'task-mode:user-action',
  TASK_MODE_STATUS_CHANGE: 'task-mode:status-change',
  TASK_MODE_UPDATE: 'task-mode:update',
  TASK_MODE_PAUSED: 'task-mode:paused',
  TASK_MODE_RESUMED: 'task-mode:resumed',
  TASK_MODE_COMPLETED: 'task-mode:completed'
};

module.exports = {
  AgentState,
  ActionType,
  IPCChannels
};

