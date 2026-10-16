import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';

export type RpcRecord = Record<string, unknown>;
export class RpcError extends Error {
  constructor(message: string, readonly command?: string) { super(message); this.name = 'RpcError'; }
}

/** JSONL is LF-delimited, not Unicode-line-delimited. Shared by transport and session readers. */
export class JsonlDecoder {
  private readonly decoder = new StringDecoder('utf8');
  private buffer = '';
  constructor(private readonly receive: (record: RpcRecord) => void, private readonly maxLength = 64 * 1024 * 1024) {}
  push(chunk: Buffer): void { this.consume(this.decoder.write(chunk)); }
  end(): void {
    this.consume(this.decoder.end());
    if (this.buffer.trim()) throw new RpcError('Pi closed an incomplete protocol record.');
  }
  private consume(text: string): void {
    this.buffer += text;
    let index: number;
    while ((index = this.buffer.indexOf('\n')) !== -1) {
      let line = this.buffer.slice(0, index);
      this.buffer = this.buffer.slice(index + 1);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      if (!line.trim()) continue;
      if (line.length > this.maxLength) throw new RpcError('Pi protocol record exceeds the supported size.');
      let value: unknown;
      try { value = JSON.parse(line); } catch { throw new RpcError('Pi emitted an invalid JSON protocol record.'); }
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new RpcError('Pi emitted a non-object protocol record.');
      this.receive(value as RpcRecord);
    }
    if (this.buffer.length > this.maxLength) throw new RpcError('Pi protocol record exceeds the supported size.');
  }
}

interface Pending {
  command: string;
  resolve: (value: RpcRecord) => void;
  reject: (error: Error) => void;
  timer?: NodeJS.Timeout;
}
export interface TransportOptions {
  execPath: string;
  args: string[];
  cwd: string;
  onEvent: (event: RpcRecord) => void;
  onFailure: (error: Error) => void;
}

/** Owns one process epoch. No raw diagnostics or wire records leave this transport in errors. */
export class RpcTransport {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<string, Pending>();
  private failed: Error | null = null;
  private closing = false;
  private readonly exited: Promise<void>;
  private writeTail: Promise<void> = Promise.resolve();

  constructor(private readonly options: TransportOptions) {
    this.child = spawn(options.execPath, options.args, { cwd: options.cwd, stdio: ['pipe', 'pipe', 'pipe'], env: process.env });
    const decoder = new JsonlDecoder(value => this.receive(value));
    this.child.stdout.on('data', (chunk: Buffer) => {
      if (this.failed) return;
      try { decoder.push(chunk); } catch { this.fail(new RpcError('Pi emitted an invalid or oversized RPC stream.')); }
    });
    this.child.stdout.on('end', () => {
      if (this.closing || this.failed) return;
      try { decoder.end(); } catch { this.fail(new RpcError('Pi closed an incomplete RPC stream.')); }
    });
    // Always drain stderr, but never retain, print, or expose private diagnostic bytes.
    this.child.stderr.on('data', () => {});
    this.child.stdin.on('error', () => this.fail(new RpcError('Cannot write to the Pi process.')));
    this.child.on('error', () => this.fail(new RpcError('Cannot start Pi. Check the Pi executable and working directory.')));
    const exit = Promise.withResolvers<void>();
    this.exited = exit.promise;
    this.child.once('close', (code, signal) => {
      if (!this.closing) this.fail(new RpcError(`Pi exited unexpectedly${signal ? ` (${signal})` : ` (code ${code ?? 'unknown'})`}.`));
      this.rejectPending(new RpcError('Pi process closed.'));
      exit.resolve();
    });
  }

  request(command: string, fields: RpcRecord = {}, timeoutMs = 30_000): Promise<RpcRecord> {
    if (this.failed || this.closing) return Promise.reject(this.failed ?? new RpcError('Pi process is closed.'));
    const id = randomUUID();
    const { promise, resolve, reject } = Promise.withResolvers<RpcRecord>();
    const pending: Pending = { command, resolve, reject };
    if (timeoutMs > 0) pending.timer = setTimeout(() => {
      this.pending.delete(id);
      reject(new RpcError(`Pi did not respond to ${command} before the deadline.`, command));
    }, timeoutMs);
    this.pending.set(id, pending);
    void this.write({ ...fields, id, type: command }).catch(error => {
      const current = this.pending.get(id);
      if (!current) return;
      clearTimeout(current.timer); this.pending.delete(id); reject(error);
    });
    return promise;
  }

  write(value: RpcRecord): Promise<void> {
    const operation = this.writeTail.then(() => {
      if (this.failed || this.closing) throw this.failed ?? new RpcError('Pi process is closed.');
      const { promise, resolve, reject } = Promise.withResolvers<void>();
      this.child.stdin.write(`${JSON.stringify(value)}\n`, error => {
        if (error) reject(new RpcError('Cannot write to the Pi process.')); else resolve();
      });
      return promise;
    });
    this.writeTail = operation.catch(() => {});
    return operation;
  }

  async close(): Promise<void> {
    if (this.closing) return this.exited;
    this.closing = true;
    this.rejectPending(new RpcError('Pi process closed.'));
    this.child.stdin.end();
    const term = setTimeout(() => this.child.kill('SIGTERM'), 1500);
    const kill = setTimeout(() => this.child.kill('SIGKILL'), 4000);
    try { await this.exited; } finally { clearTimeout(term); clearTimeout(kill); }
  }

  private receive(value: RpcRecord): void {
    if (value.type !== 'response') { this.options.onEvent(value); return; }
    if (typeof value.id !== 'string') {
      this.fail(new RpcError('Pi returned an uncorrelated RPC response.')); return;
    }
    const pending = this.pending.get(value.id);
    if (!pending) return; // Timed-out requests and old responses cannot affect a newer request.
    if (value.command !== pending.command || typeof value.success !== 'boolean') {
      this.fail(new RpcError('Pi returned a mismatched RPC response.')); return;
    }
    clearTimeout(pending.timer); this.pending.delete(value.id);
    if (value.success) pending.resolve(value);
    else pending.reject(new RpcError(`Pi rejected ${pending.command}. Check Pi configuration or extension behavior.`, pending.command));
  }

  private fail(error: Error): void {
    if (this.failed || this.closing) return;
    this.failed = error;
    this.rejectPending(error);
    this.options.onFailure(error);
    void this.close();
  }
  private rejectPending(error: Error): void {
    for (const item of this.pending.values()) { clearTimeout(item.timer); item.reject(error); }
    this.pending.clear();
  }
}
