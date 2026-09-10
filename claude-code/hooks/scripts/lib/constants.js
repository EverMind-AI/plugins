/** Every tunable in one place. Nothing here is user-configurable; see lib/config.js for what is. */

/** Cross-host partition on the EverOS side. One EverOS serves OpenClaw, Hermes and us. */
export const APP_ID = "claude-code";
/** Agent-track identity. Cases and skills land under agents/<AGENT_ID>/. */
export const AGENT_ID = "claude-code";

export const DEFAULT_BASE_URL = "http://127.0.0.1:8000";

export const HEALTH_TIMEOUT_MS = 2000;
export const START_WAIT_MS = 5000;
export const START_POLL_MS = 500;

export const RECALL_DEADLINE_MS = 3000;
export const CAPTURE_DEADLINE_MS = 20000;
export const FLUSH_DEADLINE_MS = 10000;

export const SECTION_MAX_ITEMS = 5;
export const ID_MAX_LEN = 128;
export const ADD_MAX_MESSAGES = 500;
export const TOOL_RESULT_MAX_CHARS = 20000;
export const QUERY_MAX_CHARS = 500;
export const MIN_QUERY_TOKENS = 3;

export const STATE_MAX_PROMPT_IDS = 200;
export const STATE_TTL_DAYS = 30;

export const TRANSCRIPT_READ_ATTEMPTS = 5;
export const TRANSCRIPT_READ_DELAY_MS = 100;
