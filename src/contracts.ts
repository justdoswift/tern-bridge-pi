export type Locale = 'zh-CN' | 'en-US';
export type Phase = 'disconnected' | 'connecting' | 'idle' | 'running' | 'approval' | 'question' | 'stopping' | 'error';
export type MessageBlock =
  | { id: string; kind: 'text' | 'thinking' | 'code' | 'diff'; text: string; path?: string }
  | { id: string; kind: 'tool'; name: string; args: string; output: string; status: 'running' | 'done' | 'error' | 'interrupted'; resultReceived?: true; diff?: string; details?: unknown }
  | { id: string; kind: 'image'; data: string; mime: string };
export interface MessageUsage {
  input: number; output: number; cacheRead: number; cacheWrite: number; totalTokens: number;
  cost?: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
}
export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  blocks: MessageBlock[];
  /** Display state only: deltas are live; block gaps are settled; restored messages have no live state. */
  streaming?: boolean;
  usage?: MessageUsage;
  model?: string;
  provider?: string;
}
export interface InputImage { data: string; mimeType: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp' }
export interface ModelChoice {
  /** Opaque key; use provider/modelId below for Pi commands, never split this key. */
  id: string;
  provider: string;
  modelId: string;
  label: string;
  reasoning: boolean;
  noImageSupport?: boolean;
  contextWindow?: number;
}
export interface SettingsView { modelId: string; reasoningEffort: string; thinkingLevels: string[]; autoCompactionEnabled?: boolean }
export interface SessionInfo { id: string; file?: string; title: string; cwd: string; settings: SettingsView }
export interface SessionSummary { id: string; path: string; title: string; cwd: string; modifiedTime: number; size: number }
export interface ForkChoice { entryId: string; text: string }
export interface ContextDetails {
  used: number | null;
  limit: number;
  percent: number | null;
  modelLabel?: string;
  autoCompactionEnabled?: boolean;
}
export interface PiCommand { name: string; description?: string; source: 'extension' | 'prompt' | 'skill' }
export interface PendingDialog {
  id: string;
  method: 'select' | 'confirm' | 'input' | 'editor';
  title: string;
  message?: string;
  options?: string[];
  placeholder?: string;
  prefill?: string;
  deadline?: number;
}
export type DialogResponse = { cancelled: true } | { value: string } | { confirmed: boolean };
export interface ExtensionWidget { key: string; lines: string[]; placement: 'aboveEditor' | 'belowEditor' }
export interface BackendState {
  phase: Phase;
  needsInterrupt: boolean;
  workingState: 'thinking' | 'executing_tool' | 'streaming_assistant_message' | 'compacting_conversation' | 'retrying' | null;
  session: SessionInfo | null;
  messages: ChatMessage[];
  models: ModelChoice[];
  commands: PiCommand[];
  dialog: PendingDialog | null;
  widgets: ExtensionWidget[];
  statuses: { key: string; text: string }[];
  editorText: { id: string; text: string } | null;
  windowTitle: string | null;
  error: string | null;
  notice: string | null;
  context: { used: number; limit: number } | null;
  usage: MessageUsage | null;
}
export interface SettingsPatch { modelId?: string; reasoningEffort?: string }
export interface BridgeBackend {
  readonly state: BackendState;
  open(sessionPath?: string): Promise<void>;
  sessions(all: boolean): Promise<SessionSummary[]>;
  contextDetails(): Promise<ContextDetails>;
  send(text: string, onAccepted: () => void, images?: readonly InputImage[]): Promise<void>;
  interrupt(): Promise<void>;
  resolveDialog(requestId: string, response: DialogResponse): Promise<void>;
  updateSettings(patch: SettingsPatch): Promise<void>;
  rename(title: string): Promise<void>;
  forkMessages(): Promise<ForkChoice[]>;
  fork(entryId: string): Promise<void>;
  clone(): Promise<void>;
  compact(instructions?: string): Promise<void>;
  close(): Promise<void>;
}
export interface BackendOptions {
  cwd: string;
  dataDir: string;
  execPath?: string;
  /** Optional existing Pi session root; never a bridge-owned author store. */
  sessionDir?: string;
  onChange: () => void;
}
