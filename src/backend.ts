import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import type { BackendOptions, BackendState, BridgeBackend, ContextDetails, DialogResponse, ForkChoice, InputImage, ModelChoice, PendingDialog, PromptDisposition, SettingsPatch } from './contracts.js';
import { listPiSessions, readSessionHeader } from './pi-sessions.js';
import { RpcError, RpcTransport, type RpcRecord } from './rpc-transport.js';
import { SessionLock, SessionLockError } from './session-lock.js';
import { record, Transcript } from './transcript.js';

interface DialogEntry { dialog: PendingDialog; scope: number; timer?: NodeJS.Timeout }
function modelChoice(value: unknown): ModelChoice | null {
  const model = record(value);
  if (typeof model.id !== 'string' || typeof model.provider !== 'string') return null;
  return { id: JSON.stringify([model.provider, model.id]), provider: model.provider, modelId: model.id,
    label: typeof model.name === 'string' ? model.name : model.id, reasoning: model.reasoning === true,
    ...(Array.isArray(model.input) ? { noImageSupport: !model.input.includes('image') } : {}),
    ...(typeof model.contextWindow === 'number' ? { contextWindow: model.contextWindow } : {}) };
}

/** Pi alone owns execution, prompts, persistence, configuration, and provider accounting. */
export class PiBridge implements BridgeBackend {
  readonly state: BackendState = {
    phase: 'disconnected', needsInterrupt: false, workingState: null, session: null, messages: [], models: [], commands: [],
    dialog: null, widgets: [], statuses: [], editorText: null, windowTitle: null, error: null, notice: null, context: null, usage: null,
  };
  private transport: RpcTransport | null = null;
  private transcript = new Transcript();
  private scope = 0;
  private processEpoch = 0;
  private lock: SessionLock | null = null;
  private runActive = false;
  private changing = false;
  private sending = false;
  private stopping = false;
  private submission = 0;
  private activity = 0;
  private settledActivity = 0;
  private settingsVersion = 0;
  private nameActivity = 0;
  private thinkingActivity = 0;
  private contextInvalidationActivity = 0;
  private bootstrapEvents: RpcRecord[] | null = null;
  private refreshPromise: Promise<void> | null = null;
  private refreshAgain = false;
  private refreshScope = 0;
  private closingTransport: Promise<void> | null = null;
  private dialogs: DialogEntry[] = [];
  private contextValue: ContextDetails = { used: null, limit: 0, percent: null };
  private cwd: string;
  constructor(private readonly options: BackendOptions) { this.cwd = resolve(options.cwd); }

  async open(sessionPath?: string): Promise<void> {
    if (this.changing || this.sending || this.stopping || this.runActive || this.dialogs.length) throw new Error('Stop the current Pi operation before switching sessions.');
    this.changing = true;
    const openingScope = this.scope;
    try { await this.closingTransport; }
    catch (error) { if (openingScope === this.scope) this.changing = false; throw this.safeError(error); }
    if (openingScope !== this.scope) return;
    if (this.transport) {
      let targetLock: SessionLock | null = null;
      try {
        const header = sessionPath ? await readSessionHeader(sessionPath) : null;
        if (openingScope !== this.scope) return;
        if (header && header.id !== this.lock?.sessionId) targetLock = await SessionLock.acquire(this.options.dataDir, header.id);
        if (openingScope !== this.scope) return;
        await this.mutateSession(header ? 'switch_session' : 'new_session', header ? { sessionPath: header.path } : {}, header?.cwd, targetLock, true);
        targetLock = null;
      } finally {
        await targetLock?.release();
        if (openingScope === this.scope) this.changing = false;
      }
      return;
    }
    const scope = ++this.scope;
    const epoch = ++this.processEpoch;
    this.state.phase = 'connecting'; this.state.error = null; this.changed();
    try {
      const header = sessionPath ? await readSessionHeader(sessionPath) : null;
      if (scope !== this.scope) return;
      if (header) {
        const lock = await SessionLock.acquire(this.options.dataDir, header.id);
        if (scope !== this.scope) { await lock.release(); return; }
        this.lock = lock;
        this.cwd = header.cwd;
      }
      if (scope !== this.scope) return;
      const args = ['--mode', 'rpc'];
      if (header) args.push('--session', header.path);
      if (this.options.sessionDir) args.push('--session-dir', this.options.sessionDir);
      this.bootstrapEvents = [];
      this.transport = new RpcTransport({ execPath: this.options.execPath ?? 'pi', args, cwd: this.cwd,
        onEvent: event => { if (epoch === this.processEpoch) this.event(event); },
        onFailure: error => { if (epoch === this.processEpoch) void this.retire(error); } });
      await this.reload(true, scope);
      if (scope !== this.scope) return;
      this.state.phase = this.runActive ? 'running' : this.dialogs.length ? 'question' : 'idle';
      this.state.needsInterrupt = this.runActive || this.dialogs.length > 0;
      this.changed();
    } catch (error) {
      if (scope === this.scope) {
        this.failure(error);
        const transport = this.transport; this.transport = null; ++this.processEpoch;
        const lock = this.lock; this.lock = null;
        await transport?.close(); await lock?.release();
      }
      throw this.safeError(error);
    } finally { if (scope === this.scope) this.changing = false; }
  }

  sessions(all: boolean) { return listPiSessions({ cwd: this.cwd, sessionDir: this.options.sessionDir }, all); }

  async contextDetails(): Promise<ContextDetails> {
    const scope = this.scope;
    const version = this.settingsVersion;
    const activity = this.activity;
    const response = await this.rpc().request('get_session_stats');
    if (scope !== this.scope || version !== this.settingsVersion) throw new Error('The Pi session or settings changed.');
    const stats = record(response.data);
    if (typeof stats.sessionId === 'string' && stats.sessionId !== this.state.session?.id) throw new Error('Pi returned context for a different session.');
    this.applyStats(stats, activity); this.changed();
    return { ...this.contextValue };
  }

  async send(text: string, onAccepted: (disposition: PromptDisposition) => void, images: readonly InputImage[] = []): Promise<void> {
    if (this.changing || this.sending || this.stopping || this.runActive || this.dialogs.length) throw new Error('Pi is busy. Stop or wait before sending another message.');
    const transport = this.rpc();
    if (!text.trim() && !images.length) throw new Error('Enter a message or attach an image before sending.');
    if (images.some(image => !['image/jpeg', 'image/png', 'image/gif', 'image/webp'].includes(image.mimeType) ||
      !image.data || image.data.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(image.data))) {
      throw new Error('Image attachments must contain valid base64 data in JPEG, PNG, GIF or WebP format.');
    }
    const model = this.state.models.find(item => item.id === this.state.session?.settings.modelId);
    if (images.length && model?.noImageSupport) throw new Error('The selected Pi model does not support image attachments. Choose an image-capable model or remove the images.');
    const scope = this.scope;
    const submission = ++this.submission;
    const beforeActivity = this.activity;
    this.sending = true;
    this.state.error = null; this.state.notice = null;
    this.state.needsInterrupt = true; this.state.phase = 'running'; this.state.workingState = null; this.changed();
    try {
      const response = await transport.request('prompt', { message: text,
        ...(images.length ? { images: images.map(image => ({ type: 'image', data: image.data, mimeType: image.mimeType })) } : {}) }, 0);
      if (scope !== this.scope || transport !== this.transport) return;
      const disposition = record(response.data).disposition;
      if (disposition !== 'handled' && disposition !== 'started' && disposition !== 'queued') throw new RpcError('Pi returned an unsupported prompt disposition.');
      if (submission !== this.submission) {
        // Stop can race asynchronous extension/input preflight. A late acceptance is never replayed or allowed to retain a queue.
        await this.stopCommands(transport, scope); return;
      }
      onAccepted(disposition);
      // Extension/status events during preflight do not mean the accepted turn finished.
      if (disposition !== 'handled' && this.settledActivity <= beforeActivity) this.runActive = true;
      if (!this.runActive && !this.dialogs.length) { this.state.phase = 'idle'; this.state.needsInterrupt = false; this.state.workingState = null; }
      else { this.state.phase = this.dialogs.length ? 'question' : 'running'; this.state.needsInterrupt = true; }
      this.changed();
      if (!this.runActive) await this.refresh();
    } catch (error) {
      if (scope === this.scope) {
        this.state.error = this.safeError(error).message;
        this.state.phase = this.runActive ? 'running' : 'error'; this.state.needsInterrupt = this.runActive || this.dialogs.length > 0;
        this.changed();
      }
      throw this.safeError(error);
    } finally {
      if (scope === this.scope) { this.sending = false; this.idlePhase(); this.changed(); }
    }
  }

  async interrupt(): Promise<void> {
    const transport = this.rpc();
    if (this.stopping) return;
    const scope = this.scope;
    ++this.submission;
    this.stopping = true; this.state.phase = 'stopping'; this.state.needsInterrupt = true; this.changed();
    try {
      await this.cancelDialogs(transport);
      await this.stopCommands(transport, scope);
      if (scope === this.scope) await this.refresh();
    } catch (error) { if (scope === this.scope) await this.retire(error); throw this.safeError(error); }
    finally { if (scope === this.scope) { this.stopping = false; this.idlePhase(); this.changed(); } }
  }

  async resolveDialog(requestId: string, response: DialogResponse): Promise<void> {
    const entry = this.dialogs[0];
    if (!entry || entry.scope !== this.scope || entry.dialog.id !== requestId) throw new Error('This Pi dialog is no longer active.');
    if (entry.dialog.deadline !== undefined && Date.now() >= entry.dialog.deadline) {
      this.removeDialog(entry); throw new Error('This Pi dialog timed out.');
    }
    if (!('cancelled' in response)) {
      if (entry.dialog.method === 'confirm' ? !('confirmed' in response) : !('value' in response)) throw new Error('The response does not match the Pi dialog.');
      if (entry.dialog.method === 'select' && 'value' in response && !entry.dialog.options?.includes(response.value)) throw new Error('Choose one of the exact Pi options.');
    }
    const transport = this.rpc();
    this.removeDialog(entry);
    await transport.write({ type: 'extension_ui_response', id: requestId, ...response });
  }

  async updateSettings(patch: SettingsPatch): Promise<void> {
    this.requireIdle();
    const scope = this.scope;
    this.changing = true;
    ++this.settingsVersion;
    try {
      if (patch.modelId !== undefined) {
        const model = this.state.models.find(item => item.id === patch.modelId);
        if (!model) throw new Error('Choose an available Pi model.');
        await this.rpc().request('set_model', { provider: model.provider, modelId: model.modelId }, 0);
      }
      if (scope !== this.scope) return;
      // A model change changes the real thinking choices; never reuse choices from the prior model.
      const levels = record((await this.rpc().request('get_available_thinking_levels')).data).levels;
      if (scope !== this.scope) return;
      if (patch.reasoningEffort !== undefined) {
        if (!Array.isArray(levels) || !levels.includes(patch.reasoningEffort)) throw new Error('That thinking level is not available for the selected Pi model.');
        await this.rpc().request('set_thinking_level', { level: patch.reasoningEffort });
      }
    } catch (error) { if (scope === this.scope) { this.state.error = this.safeError(error).message; this.changed(); } throw this.safeError(error); }
    finally {
      if (scope === this.scope) {
        try { await this.reload(true, scope); }
        catch (error) { if (scope === this.scope) await this.retire(error); throw this.safeError(error); }
        finally { if (scope === this.scope) this.changing = false; }
      }
    }
  }
  async rename(title: string): Promise<void> {
    this.requireIdle();
    if (!title.trim()) throw new Error('The Pi session name cannot be empty.');
    const scope = this.scope;
    this.changing = true;
    try {
      await this.rpc().request('set_session_name', { name: title }, 0);
      if (scope === this.scope) await this.reload(false, scope);
    } catch (error) { if (scope === this.scope) await this.retire(error); throw this.safeError(error); }
    finally { if (scope === this.scope) this.changing = false; }
  }
  async forkMessages(): Promise<ForkChoice[]> {
    this.requireIdle();
    const scope = this.scope;
    const data = record((await this.rpc().request('get_fork_messages')).data);
    if (scope !== this.scope) throw new Error('The Pi session changed.');
    return (Array.isArray(data.messages) ? data.messages : []).map(record)
      .filter(item => typeof item.entryId === 'string' && typeof item.text === 'string')
      .map(item => ({ entryId: item.entryId as string, text: item.text as string }));
  }
  async fork(entryId: string): Promise<void> {
    const choices = await this.forkMessages();
    if (!choices.some(item => item.entryId === entryId)) throw new Error('Choose a user message on the active Pi branch.');
    await this.mutateSession('fork', { entryId });
  }
  async clone(): Promise<void> { await this.mutateSession('clone'); }
  async compact(instructions?: string): Promise<void> {
    this.requireIdle();
    const scope = this.scope;
    this.changing = true; this.runActive = true;
    this.state.phase = 'running'; this.state.needsInterrupt = true; this.state.workingState = 'compacting_conversation'; this.changed();
    try {
      await this.rpc().request('compact', instructions === undefined ? {} : { customInstructions: instructions }, 0);
    } catch (error) { if (scope === this.scope) { this.state.error = this.safeError(error).message; this.changed(); } throw this.safeError(error); }
    finally {
      if (scope === this.scope) {
        this.runActive = false; this.state.workingState = null;
        try { await this.reload(true, scope); this.idlePhase(); this.changed(); }
        catch (error) { if (scope === this.scope) await this.retire(error); throw this.safeError(error); }
        finally { if (scope === this.scope) this.changing = false; }
      }
    }
  }

  async close(): Promise<void> {
    const scope = ++this.scope; ++this.processEpoch; ++this.submission;
    const transport = this.transport; this.transport = null;
    const lock = this.lock; this.lock = null;
    this.changing = true;
    try {
      if (transport) { try { await this.cancelDialogs(transport); } finally { await transport.close(); } }
      await this.closingTransport;
    }
    finally {
      try { await lock?.release(); }
      finally {
        if (scope === this.scope) {
          this.clearExtensionState(); this.bootstrapEvents = null; this.transcript.settle();
          this.state.messages = this.transcript.messages; this.runActive = false; this.changing = false; this.sending = false; this.stopping = false;
          this.state.phase = 'disconnected'; this.state.needsInterrupt = false; this.state.workingState = null; this.changed();
        }
      }
    }
  }

  private async mutateSession(command: string, fields: RpcRecord = {}, cwd?: string, targetLock?: SessionLock | null, reserved = false): Promise<void> {
    if (!reserved) this.requireIdle(); else this.rpc();
    let scope = this.scope;
    this.changing = true;
    const extensionState = { widgets: this.state.widgets, statuses: this.state.statuses, editorText: this.state.editorText, windowTitle: this.state.windowTitle, notice: this.state.notice };
    this.clearExtensionState();
    try {
      const data = record((await this.rpc().request(command, fields, 0)).data);
      if (scope !== this.scope) return;
      if (data.cancelled !== false) {
        if (data.cancelled !== true) throw new Error('Pi did not confirm the session operation.');
        Object.assign(this.state, extensionState);
        this.state.notice = 'Pi cancelled the session operation.'; this.changed(); return;
      }
      ++this.scope; ++this.submission;
      const nextScope = this.scope;
      scope = nextScope;
      await this.cancelDialogs(this.rpc());
      if (nextScope !== this.scope) return;
      if (targetLock) { const previous = this.lock; this.lock = targetLock; await previous?.release(); }
      else if (command !== 'switch_session') { const previous = this.lock; this.lock = null; await previous?.release(); }
      if (nextScope !== this.scope) return;
      if (cwd) this.cwd = cwd;
      this.state.error = null;
      this.runActive = false; this.transcript = new Transcript(); this.state.messages = [];
      this.bootstrapEvents = [];
      this.state.context = null; this.state.usage = null; this.contextValue = { used: null, limit: 0, percent: null };
      await this.reload(true, nextScope);
      if (command === 'fork' && typeof data.text === 'string' && nextScope === this.scope) this.state.editorText = { id: randomUUID(), text: data.text };
      if (nextScope === this.scope) { this.idlePhase(); this.changed(); }
    } catch (error) { if (scope === this.scope) await this.retire(error); throw this.safeError(error); }
    finally {
      if (scope === this.scope) this.changing = false;
      if (targetLock && this.lock !== targetLock) await targetLock.release();
    }
  }

  private async stopCommands(transport: RpcTransport, scope: number): Promise<void> {
    const cleared = record((await transport.request('clear_queue')).data);
    if (scope !== this.scope) return;
    const restored = [cleared.steering, cleared.followUp].flatMap(value => Array.isArray(value) ? value.filter((text): text is string => typeof text === 'string') : []);
    if (restored.length) this.state.editorText = { id: randomUUID(), text: restored.join('\n\n') };
    await transport.request('abort', {}, 0);
    if (scope !== this.scope) return;
    this.runActive = false; this.transcript.settle(); this.state.messages = this.transcript.messages;
    this.state.workingState = null; this.idlePhase(); this.changed();
  }

  private async reload(full: boolean, scope: number): Promise<void> {
    const transport = this.rpc();
    const activity = this.activity;
    const version = this.settingsVersion;
    const bootstrap = this.bootstrapEvents;
    const [stateResponse, entriesResponse, messagesResponse, statsResponse, levelsResponse, modelsResponse, commandsResponse] = await Promise.all([
      transport.request('get_state'), transport.request('get_entries'), transport.request('get_messages'), transport.request('get_session_stats'),
      transport.request('get_available_thinking_levels'), full ? transport.request('get_available_models') : null,
      full ? transport.request('get_commands') : null,
    ]);
    if (scope !== this.scope || transport !== this.transport || version !== this.settingsVersion) return;
    const data = record(stateResponse.data);
    if (typeof data.sessionId !== 'string' || !data.sessionId) throw new Error('Pi did not report a session identity.');
    if (this.lock?.sessionId !== data.sessionId) {
      const next = await SessionLock.acquire(this.options.dataDir, data.sessionId);
      if (scope !== this.scope) { await next.release(); return; }
      const previous = this.lock; this.lock = next; await previous?.release();
    }
    if (typeof data.sessionFile === 'string') {
      // Unflushed fresh sessions can have an allocated filename without an on-disk header yet.
      try { const header = await readSessionHeader(data.sessionFile); if (scope !== this.scope) return; this.cwd = header.cwd; }
      catch { /* Pi's process cwd remains authoritative for an unflushed fresh session. */ }
    }
    if (scope !== this.scope || version !== this.settingsVersion) return;
    if (modelsResponse) this.state.models = (Array.isArray(record(modelsResponse.data).models) ? record(modelsResponse.data).models as unknown[] : []).map(modelChoice).filter((model): model is ModelChoice => model !== null);
    const model = modelChoice(data.model);
    if (model && !this.state.models.some(item => item.id === model.id)) this.state.models.push(model);
    const levels = record(levelsResponse.data).levels;
    const thinkingLevels = Array.isArray(levels) ? levels.filter((level): level is string => typeof level === 'string') : [];
    const previous = this.state.session?.id === data.sessionId ? this.state.session : null;
    this.state.session = { id: data.sessionId, ...(typeof data.sessionFile === 'string' ? { file: data.sessionFile } : {}),
      title: previous && this.nameActivity > activity ? previous.title : typeof data.sessionName === 'string' ? data.sessionName : '', cwd: this.cwd,
      settings: { modelId: model?.id ?? '', reasoningEffort: previous && this.thinkingActivity > activity ? previous.settings.reasoningEffort : typeof data.thinkingLevel === 'string' ? data.thinkingLevel : '', thinkingLevels,
        ...(typeof data.autoCompactionEnabled === 'boolean' ? { autoCompactionEnabled: data.autoCompactionEnabled } : {}) } };
    if (commandsResponse) this.state.commands = (Array.isArray(record(commandsResponse.data).commands) ? record(commandsResponse.data).commands as unknown[] : []).map(record)
      .filter(item => typeof item.name === 'string' && (item.source === 'extension' || item.source === 'prompt' || item.source === 'skill'))
      .map(item => ({ name: item.name as string, source: item.source as 'extension' | 'prompt' | 'skill', ...(typeof item.description === 'string' ? { description: item.description } : {}) }));
    if (activity === this.activity && (data.isStreaming === true || data.isCompacting === true || (typeof data.pendingMessageCount === 'number' && data.pendingMessageCount > 0))) this.runActive = true;
    if (bootstrap || activity === this.activity && !this.runActive) {
      const entries = record(entriesResponse.data);
      const messages = record(messagesResponse.data).messages;
      this.transcript.hydrate(Array.isArray(entries.entries) ? entries.entries : [], entries.leafId, Array.isArray(messages) ? messages : []);
      if (bootstrap) { this.transcript.replay(bootstrap); if (this.bootstrapEvents === bootstrap) this.bootstrapEvents = null; }
      this.state.messages = this.transcript.messages;
    }
    this.applyStats(record(statsResponse.data), activity); this.idlePhase(); this.changed();
  }

  private refresh(): Promise<void> {
    if (this.refreshPromise && this.refreshScope === this.scope) { this.refreshAgain = true; return this.refreshPromise; }
    const scope = this.scope;
    this.refreshScope = scope;
    const operation = (async () => {
      do {
        this.refreshAgain = false;
        try { await this.reload(false, scope); }
        catch (error) { if (scope === this.scope) { this.state.error = this.safeError(error).message; this.changed(); } }
      } while (this.refreshAgain && scope === this.scope && !this.runActive);
    })().finally(() => { if (this.refreshPromise === operation) this.refreshPromise = null; });
    this.refreshPromise = operation;
    return operation;
  }

  private applyStats(stats: RpcRecord, requestedActivity: number): void {
    const usage = record(stats.contextUsage);
    const stale = this.contextInvalidationActivity > requestedActivity;
    this.contextValue = { used: !stale && typeof usage.tokens === 'number' ? usage.tokens : null,
      limit: typeof usage.contextWindow === 'number' ? usage.contextWindow : 0, percent: !stale && typeof usage.percent === 'number' ? usage.percent : null,
      ...(this.state.session ? { modelLabel: this.state.models.find(model => model.id === this.state.session?.settings.modelId)?.label,
        autoCompactionEnabled: this.state.session.settings.autoCompactionEnabled } : {}) };
    this.state.context = this.contextValue.used !== null && this.contextValue.limit > 0 ? { used: this.contextValue.used, limit: this.contextValue.limit } : null;
    const tokens = record(stats.tokens);
    this.state.usage = ['input', 'output', 'cacheRead', 'cacheWrite', 'total'].every(key => typeof tokens[key] === 'number')
      ? { input: tokens.input as number, output: tokens.output as number, cacheRead: tokens.cacheRead as number,
        cacheWrite: tokens.cacheWrite as number, totalTokens: tokens.total as number } : null;
  }

  private event(event: RpcRecord): void {
    // RPC events normally have no scope tag. If an extension/peer supplies one, never accept a foreign identity.
    if (typeof event.sessionId === 'string' && this.state.session && event.sessionId !== this.state.session.id) return;
    ++this.activity;
    if (event.type === 'extension_ui_request') { this.extensionUi(event); return; }
    this.bootstrapEvents?.push(event);
    this.transcript.apply(event); this.state.messages = this.transcript.messages;
    if ((event.type === 'message_start' || event.type === 'message_end') && record(event.message).role === 'user') this.options.onUserMessage?.();
    switch (event.type) {
      case 'agent_start': case 'turn_start':
        this.runActive = true; this.state.workingState = 'thinking'; break;
      case 'message_update': {
        const type = record(event.assistantMessageEvent).type;
        if (type === 'thinking_start' || type === 'thinking_delta') this.state.workingState = 'thinking';
        else if (type === 'text_start' || type === 'text_delta') this.state.workingState = 'streaming_assistant_message';
        break;
      }
      case 'tool_execution_start': case 'tool_execution_update': this.state.workingState = 'executing_tool'; break;
      case 'tool_execution_end': this.state.workingState = null; break;
      case 'message_end':
        if (record(event.message).role === 'assistant' && record(event.message).stopReason === 'error') this.state.error = 'Pi could not complete the response. Check the Pi provider or extension configuration.';
        this.state.workingState = null; break;
      case 'agent_end': this.state.workingState = event.willRetry === true ? 'retrying' : null; break;
      case 'agent_settled':
        this.settledActivity = this.activity;
        this.runActive = false; this.state.workingState = null;
        if (!this.changing && !this.bootstrapEvents) void this.refresh();
        break;
      case 'queue_update':
        if ((Array.isArray(event.steering) && event.steering.length > 0) || (Array.isArray(event.followUp) && event.followUp.length > 0)) this.runActive = true;
        break;
      case 'compaction_start': this.runActive = true; this.state.workingState = 'compacting_conversation'; break;
      case 'compaction_end':
        this.contextInvalidationActivity = this.activity;
        this.state.context = null; this.contextValue = { ...this.contextValue, used: null, percent: null };
        if (typeof event.errorMessage === 'string') this.state.error = 'Pi compaction failed.';
        this.state.workingState = event.willRetry === true ? 'retrying' : null; break;
      case 'auto_retry_start': case 'summarization_retry_scheduled': case 'summarization_retry_attempt_start':
        this.runActive = true; this.state.workingState = 'retrying'; break;
      case 'auto_retry_end':
        if (event.success === false) this.state.error = 'Pi exhausted its automatic retries.';
        this.state.workingState = null; break;
      case 'summarization_retry_finished': this.state.workingState = null; break;
      case 'thinking_level_changed':
        this.thinkingActivity = this.activity;
        if (this.state.session && typeof event.level === 'string') this.state.session.settings.reasoningEffort = event.level; break;
      case 'session_info_changed':
        this.nameActivity = this.activity;
        if (this.state.session) this.state.session.title = typeof event.name === 'string' ? event.name : ''; break;
      case 'extension_error': this.state.notice = 'A Pi extension reported an error.'; break;
    }
    this.idlePhase(); this.changed();
  }

  private extensionUi(event: RpcRecord): void {
    if (typeof event.id !== 'string' || typeof event.method !== 'string') return;
    const method = event.method;
    if (method === 'select' || method === 'confirm' || method === 'input' || method === 'editor') {
      if (this.dialogs.some(entry => entry.dialog.id === event.id)) return;
      const timeout = typeof event.timeout === 'number' && Number.isFinite(event.timeout) && event.timeout >= 0 ? event.timeout : undefined;
      const dialog: PendingDialog = { id: event.id, method, title: typeof event.title === 'string' ? event.title : '',
        ...(typeof event.message === 'string' ? { message: event.message } : {}),
        ...(Array.isArray(event.options) && event.options.every(value => typeof value === 'string') ? { options: event.options as string[] } : {}),
        ...(typeof event.placeholder === 'string' ? { placeholder: event.placeholder } : {}), ...(typeof event.prefill === 'string' ? { prefill: event.prefill } : {}),
        ...(timeout === undefined ? {} : { deadline: Date.now() + timeout }) };
      const entry: DialogEntry = { dialog, scope: this.scope };
      if (timeout !== undefined) entry.timer = setTimeout(() => {
        if (entry.scope === this.scope) this.removeDialog(entry);
      }, timeout);
      this.dialogs.push(entry); this.state.dialog = this.dialogs[0]?.dialog ?? null;
      if (this.stopping) void this.cancelDialogs(this.rpc()).catch(error => this.failure(error));
    } else if (method === 'notify') {
      if (typeof event.message === 'string') this.state.notice = event.message;
    } else if (method === 'setStatus' && typeof event.statusKey === 'string') {
      this.state.statuses = this.state.statuses.filter(item => item.key !== event.statusKey);
      if (typeof event.statusText === 'string') this.state.statuses.push({ key: event.statusKey, text: event.statusText });
    } else if (method === 'setWidget' && typeof event.widgetKey === 'string') {
      this.state.widgets = this.state.widgets.filter(item => item.key !== event.widgetKey);
      if (Array.isArray(event.widgetLines) && event.widgetLines.every(line => typeof line === 'string')) this.state.widgets.push({ key: event.widgetKey,
        lines: event.widgetLines as string[], placement: event.widgetPlacement === 'belowEditor' ? 'belowEditor' : 'aboveEditor' });
    } else if (method === 'setTitle' && typeof event.title === 'string') this.state.windowTitle = event.title;
    else if (method === 'set_editor_text' && typeof event.text === 'string') this.state.editorText = { id: event.id, text: event.text };
    this.idlePhase(); this.changed();
  }
  private removeDialog(entry: DialogEntry): void {
    clearTimeout(entry.timer); this.dialogs = this.dialogs.filter(item => item !== entry);
    this.state.dialog = this.dialogs[0]?.dialog ?? null; this.idlePhase(); this.changed();
  }
  private async cancelDialogs(transport: RpcTransport): Promise<void> {
    const dialogs = this.dialogs; this.dialogs = []; this.state.dialog = null;
    for (const entry of dialogs) {
      clearTimeout(entry.timer);
      await transport.write({ type: 'extension_ui_response', id: entry.dialog.id, cancelled: true });
    }
  }
  private clearExtensionState(): void {
    for (const entry of this.dialogs) clearTimeout(entry.timer);
    this.dialogs = []; this.state.dialog = null; this.state.widgets = []; this.state.statuses = [];
    this.state.editorText = null; this.state.windowTitle = null; this.state.notice = null;
  }
  private idlePhase(): void {
    this.state.needsInterrupt = this.runActive || this.sending || this.stopping || this.dialogs.length > 0;
    if (this.dialogs.length) this.state.workingState = null;
    if (this.state.phase === 'disconnected' || this.state.phase === 'connecting' && !this.state.session) return;
    this.state.phase = this.stopping ? 'stopping' : this.dialogs.length ? 'question' : this.runActive || this.sending ? 'running' : this.state.error ? 'error' : 'idle';
  }
  private requireIdle(): void {
    this.rpc();
    if (this.changing || this.sending || this.stopping || this.runActive || this.dialogs.length) throw new Error('Stop or finish the current Pi operation first.');
  }
  private rpc(): RpcTransport {
    if (!this.transport) throw new Error('Pi is not connected.');
    return this.transport;
  }
  private retire(error: unknown): Promise<void> {
    this.failure(error);
    const transport = this.transport; this.transport = null;
    const lock = this.lock; this.lock = null;
    ++this.processEpoch; ++this.scope; ++this.submission;
    const scope = this.scope;
    this.changing = false; this.sending = false; this.stopping = false; this.bootstrapEvents = null;
    const cleanup = (async () => {
      try { await transport?.close(); }
      finally { await lock?.release(); }
    })();
    this.closingTransport = cleanup;
    void cleanup.catch(() => {
      if (scope === this.scope) {
        this.state.error = 'Pi closed, but its session lock could not be released. Check the plugin data directory permissions.';
        this.changed();
      }
    });
    return cleanup;
  }
  private failure(error: unknown): void {
    this.runActive = false; this.transcript.settle(); this.state.messages = this.transcript.messages;
    this.state.phase = 'error'; this.state.error = this.safeError(error).message; this.state.needsInterrupt = false; this.state.workingState = null;
    this.clearExtensionState(); this.changed();
  }
  private safeError(error: unknown): Error {
    // Errors created by this bridge contain no wire payload, stderr, provider error, or private exception text.
    return error instanceof RpcError || error instanceof SessionLockError || error instanceof Error && (error.message.startsWith('Pi ') || error.message.startsWith('The Pi ') || error.message.startsWith('Choose ') || error.message.startsWith('That thinking ') || error.message.startsWith('This Pi '))
      ? error : new Error('Pi operation failed. Check the Pi executable, working directory, session lock, or configuration.');
  }
  private changed(): void { this.options.onChange(); }
}
