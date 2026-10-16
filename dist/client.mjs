// src/main.ts
import { readFile as readFile2, mkdir as mkdir2, writeFile as writeFile2, rename as rename2 } from "node:fs/promises";
import { homedir as homedir3 } from "node:os";
import { join as join3, resolve as resolve4 } from "node:path";
import { parseArgs, stripVTControlCharacters } from "node:util";
import { Composer } from "@oh-my-pi/pi-tui/prompt/composer";
import { AttachmentChipsBand } from "@oh-my-pi/pi-tui/prompt/attachment-chips";
import { CombinedAutocompleteProvider } from "@oh-my-pi/pi-tui/autocomplete";
import { ErrorBannerComponent } from "@oh-my-pi/pi-tui/overlays/error-banner";
import { EMPTY_NODE as EMPTY_NODE3, node as node6, span } from "@oh-my-pi/pi-tui/native/describe";
import { encodeTspJson, TSP_PREFIX } from "@oh-my-pi/pi-tui/native/encode";
import { actionButton as actionButton2 } from "@oh-my-pi/pi-tui/native/overlay";
import { onNativeRenderingChange } from "@oh-my-pi/pi-tui/native/state";
import { styledSpans } from "@oh-my-pi/pi-tui/native/spans";
import { stopSharedSpinnerTicker } from "@oh-my-pi/pi-tui/chat/tool-execution";

// src/backend.ts
import { randomUUID as randomUUID3 } from "node:crypto";
import { resolve as resolve2 } from "node:path";

// src/pi-sessions.ts
import { createReadStream } from "node:fs";
import { readdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";

// src/transcript.ts
function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : {};
}
function messageUsage(value) {
  const usage = record(value);
  const fields = ["input", "output", "cacheRead", "cacheWrite", "totalTokens"];
  if (!fields.every((key) => typeof usage[key] === "number" && Number.isFinite(usage[key]))) return void 0;
  const cost = record(usage.cost);
  return {
    input: usage.input,
    output: usage.output,
    cacheRead: usage.cacheRead,
    cacheWrite: usage.cacheWrite,
    totalTokens: usage.totalTokens,
    ...["input", "output", "cacheRead", "cacheWrite", "total"].every((key) => typeof cost[key] === "number" && Number.isFinite(cost[key])) ? { cost: {
      input: cost.input,
      output: cost.output,
      cacheRead: cost.cacheRead,
      cacheWrite: cost.cacheWrite,
      total: cost.total
    } } : {}
  };
}
function serial(value) {
  if (typeof value === "string") return value;
  return value === void 0 ? "" : JSON.stringify(value);
}
function messageKey(value) {
  return `${String(value.role)}:${String(value.timestamp)}:${typeof value.toolCallId === "string" ? value.toolCallId : ""}`;
}
function activeBranch(entries, leafId) {
  if (leafId === null) return [];
  if (typeof leafId !== "string") throw new Error("Pi did not report the active session branch.");
  const byId = /* @__PURE__ */ new Map();
  for (const raw of entries) {
    const entry = record(raw);
    if (typeof entry.id === "string") byId.set(entry.id, entry);
  }
  const branch = [];
  const visited = /* @__PURE__ */ new Set();
  let id = leafId;
  while (id !== null) {
    if (visited.has(id)) throw new Error("Pi reported a cyclic session branch.");
    visited.add(id);
    const entry = byId.get(id);
    if (!entry) throw new Error("Pi reported an incomplete session branch.");
    branch.push(entry);
    if (entry.parentId !== null && typeof entry.parentId !== "string") throw new Error("Pi reported an invalid session parent.");
    id = entry.parentId;
  }
  return branch.reverse();
}
function selectVisibleBranch(branch) {
  const index = branch.findLastIndex((entry) => entry.type === "compaction");
  if (index < 0) return branch;
  const compaction = branch[index];
  const firstKept = branch.findIndex((entry, position) => position < index && entry.id === compaction.firstKeptEntryId);
  const retained = firstKept < 0 ? [] : branch.slice(firstKept, index).filter((entry) => !(entry.type === "message" && record(entry.message).role === "system"));
  return [compaction, ...retained, ...branch.slice(index + 1)];
}
var Transcript = class {
  messages = [];
  identities = /* @__PURE__ */ new Map();
  current = /* @__PURE__ */ new Map();
  persisted = /* @__PURE__ */ new Set();
  persistedTools = /* @__PURE__ */ new Set();
  counter = 0;
  liveAssistant = null;
  hydrate(entries, leafId, runtimeMessages = []) {
    const branch = activeBranch(entries, leafId);
    const visible = selectVisibleBranch(branch);
    this.messages = [];
    this.identities.clear();
    this.current.clear();
    this.persisted.clear();
    this.persistedTools.clear();
    this.liveAssistant = null;
    const visibleIds = new Set(visible.map((entry) => entry.id));
    const compactionId = visible[0]?.type === "compaction" ? visible[0].id : null;
    const summaries = [];
    const selected = [];
    for (const entry of branch) {
      let message = null;
      if (entry.type === "message") message = record(entry.message);
      else if (entry.type === "custom_message") message = { ...entry, role: "custom", timestamp: Date.parse(String(entry.timestamp)) };
      else if (entry.type === "compaction" || entry.type === "branch_summary") message = {
        role: entry.type === "compaction" ? "compactionSummary" : "branchSummary",
        summary: entry.summary,
        timestamp: Date.parse(String(entry.timestamp))
      };
      if (!message) continue;
      this.persisted.add(messageKey(message));
      if (message.role === "toolResult" && typeof message.toolCallId === "string") this.persistedTools.add(message.toolCallId);
      if (Array.isArray(message.content)) for (const value of message.content) {
        const block = record(value);
        if (block.type === "toolCall" && typeof block.id === "string") this.persistedTools.add(block.id);
      }
      if (!visibleIds.has(entry.id)) continue;
      const source = { id: String(entry.id), message };
      if (entry.type === "compaction" && compactionId === entry.id) summaries.push(source);
      else selected.push(source);
    }
    for (const source of [...summaries, ...selected]) this.snapshot(source.message, source.id, false);
    for (const value of runtimeMessages) {
      const message = record(value);
      const key = messageKey(message);
      if (!this.persisted.has(key)) this.snapshot(message, `context:${key}:${++this.counter}`, false);
    }
    this.settle();
  }
  /** Replay fast bootstrap events without appending deltas to already authoritative final snapshots. */
  replay(events) {
    let suppressAssistant = false;
    for (const event of events) {
      const message = record(event.message);
      if (event.type === "message_start") {
        const exists = this.persisted.has(messageKey(message)) || this.identities.has(messageKey(message));
        if (message.role === "assistant") suppressAssistant = exists;
        if (exists) continue;
      }
      if (event.type === "message_update" && suppressAssistant) continue;
      if (event.type === "message_end") {
        const exists = this.persisted.has(messageKey(message)) || !this.current.has(String(message.role)) && this.identities.has(messageKey(message));
        if (message.role === "assistant") suppressAssistant = false;
        if (exists) continue;
      }
      if (typeof event.toolCallId === "string" && this.persistedTools.has(event.toolCallId)) {
        const target = this.findTool(event.toolCallId);
        if (!target || event.type === "tool_execution_start" && target.block.resultReceived) continue;
      }
      this.apply(event);
    }
  }
  apply(event) {
    const message = record(event.message);
    if (event.type === "message_start") {
      const key = messageKey(message);
      const id = `live:${++this.counter}:${key}`;
      this.current.set(String(message.role), id);
      if (message.role === "assistant") {
        this.liveAssistant = id;
        for (const key2 of this.current.keys()) if (key2.startsWith("block:")) this.current.delete(key2);
      }
      this.snapshot(message, id, message.role === "assistant");
    } else if (event.type === "message_end") {
      const key = messageKey(message);
      const id = this.current.get(String(message.role)) ?? this.identities.get(key)?.at(-1) ?? `live:${++this.counter}:${key}`;
      this.snapshot(message, id, false);
      this.current.delete(String(message.role));
      if (message.role === "assistant") this.liveAssistant = null;
    } else if (event.type === "message_update") this.update(record(event.assistantMessageEvent), event.usage);
    else if (event.type === "tool_execution_start" || event.type === "tool_execution_update" || event.type === "tool_execution_end") {
      const id = typeof event.toolCallId === "string" ? event.toolCallId : "";
      if (!id) return;
      let target = this.findTool(id);
      if (!target) {
        const owner2 = { id: `tool:${id}`, role: "assistant", blocks: [{ id, kind: "tool", name: String(event.toolName ?? ""), args: serial(event.args), output: "", status: "running" }] };
        this.messages.push(owner2);
        target = { owner: owner2, block: owner2.blocks[0] };
      }
      if (event.type === "tool_execution_start") {
        target.block.name = String(event.toolName ?? target.block.name);
        target.block.args = serial(event.args);
        target.block.status = "running";
      } else this.toolResult(
        id,
        record(event.type === "tool_execution_end" ? event.result : event.partialResult),
        event.type === "tool_execution_end",
        event.isError === true
      );
    } else if (event.type === "agent_settled") this.settle();
  }
  settle() {
    for (const message of this.messages) {
      delete message.streaming;
      for (const block of message.blocks) if (block.kind === "tool" && block.status === "running") block.status = "interrupted";
    }
    this.current.clear();
    this.liveAssistant = null;
  }
  snapshot(raw, id, streaming) {
    if (!["user", "assistant", "toolResult", "bashExecution", "custom", "branchSummary", "compactionSummary"].includes(String(raw.role))) return;
    if (raw.role === "toolResult") {
      this.toolResult(String(raw.toolCallId ?? ""), raw, true, raw.isError === true);
      return;
    }
    if (raw.role === "custom" && raw.display === false) return;
    const role = raw.role === "user" ? "user" : raw.role === "assistant" ? "assistant" : "system";
    if (raw.role === "bashExecution") {
      this.replace({ id, role: "system", blocks: [{
        id: `${id}:bash`,
        kind: "tool",
        name: "bash",
        args: serial({ command: raw.command }),
        output: typeof raw.output === "string" ? raw.output : "",
        status: raw.cancelled ? "interrupted" : raw.exitCode === 0 ? "done" : "error",
        resultReceived: true
      }] });
      return;
    }
    const previous = this.messages.find((item) => item.id === id);
    const content = typeof raw.content === "string" ? [{ type: "text", text: raw.content }] : Array.isArray(raw.content) ? raw.content : [];
    const blocks = [];
    for (let index = 0; index < content.length; index++) {
      const block = record(content[index]);
      const blockId = `${id}:${index}`;
      if (block.type === "text" || block.type === "code" || block.type === "diff") blocks.push({ id: blockId, kind: block.type, text: typeof block.text === "string" ? block.text : "", ...typeof block.path === "string" ? { path: block.path } : {} });
      else if (block.type === "thinking") blocks.push({ id: blockId, kind: "thinking", text: typeof block.thinking === "string" ? block.thinking : "" });
      else if (block.type === "image" && typeof block.data === "string" && typeof block.mimeType === "string") blocks.push({ id: blockId, kind: "image", data: block.data, mime: block.mimeType });
      else if (block.type === "toolCall" && typeof block.id === "string") {
        const old = previous?.blocks.find((item) => item.kind === "tool" && item.id === block.id);
        blocks.push({
          id: block.id,
          kind: "tool",
          name: typeof block.name === "string" ? block.name : "",
          args: serial(block.arguments),
          output: old?.kind === "tool" ? old.output : "",
          status: old?.kind === "tool" ? old.status : "running",
          ...old?.kind === "tool" && old.resultReceived ? { resultReceived: true } : {},
          ...old?.kind === "tool" && old.details !== void 0 ? { details: old.details } : {},
          ...old?.kind === "tool" && old.diff ? { diff: old.diff } : {}
        });
      }
    }
    if (raw.role === "branchSummary" || raw.role === "compactionSummary") blocks.push({ id: `${id}:summary`, kind: "text", text: typeof raw.summary === "string" ? raw.summary : "" });
    if (previous) blocks.push(...previous.blocks.filter((block) => block.id.startsWith("tool-image:")));
    if (raw.role === "assistant" && raw.stopReason === "error") blocks.push({ id: `${id}:error`, kind: "text", text: "Pi could not complete this response." });
    const usage = messageUsage(raw.usage);
    const result = {
      id,
      role,
      blocks,
      ...streaming ? { streaming: true } : {},
      ...usage ? { usage } : {},
      ...typeof raw.model === "string" ? { model: raw.model } : {},
      ...typeof raw.provider === "string" ? { provider: raw.provider } : {}
    };
    if (blocks.length || role === "assistant") this.replace(result);
    const key = messageKey(raw);
    const ids = this.identities.get(key) ?? [];
    if (!ids.includes(id)) {
      ids.push(id);
      this.identities.set(key, ids);
    }
  }
  replace(message) {
    const index = this.messages.findIndex((item) => item.id === message.id);
    if (index === -1) this.messages.push(message);
    else this.messages[index] = message;
  }
  findTool(id) {
    for (const owner2 of this.messages) for (const block of owner2.blocks) if (block.kind === "tool" && block.id === id) return { owner: owner2, block };
    return void 0;
  }
  toolResult(id, result, final, error) {
    if (!id) return;
    let target = this.findTool(id);
    if (!target) {
      const block = { id, kind: "tool", name: typeof result.toolName === "string" ? result.toolName : "", args: "", output: "", status: "running" };
      const owner2 = { id: `tool:${id}`, role: "assistant", blocks: [block] };
      this.messages.push(owner2);
      target = { owner: owner2, block };
    }
    if (!final && target.block.resultReceived) return;
    const content = Array.isArray(result.content) ? result.content.map(record) : [];
    target.block.output = content.filter((block) => block.type === "text").map((block) => typeof block.text === "string" ? block.text : "").join("\n");
    target.block.details = result.details;
    const details = record(result.details);
    if (typeof details.diff === "string") target.block.diff = details.diff;
    else delete target.block.diff;
    if (final) {
      target.block.status = error ? "error" : "done";
      target.block.resultReceived = true;
    }
    const prefix = `tool-image:${id}:`;
    target.owner.blocks = target.owner.blocks.filter((block) => !block.id.startsWith(prefix));
    content.forEach((block, index) => {
      if (block.type === "image" && typeof block.data === "string" && typeof block.mimeType === "string") target.owner.blocks.push({ id: `${prefix}${index}`, kind: "image", data: block.data, mime: block.mimeType });
    });
  }
  update(event, usage) {
    const message = this.messages.find((item) => item.id === this.liveAssistant);
    if (!message) return;
    const latestUsage = messageUsage(usage);
    if (latestUsage) message.usage = latestUsage;
    if (event.type === "done" || event.type === "error") {
      this.snapshot(record(event.type === "done" ? event.message : event.error), message.id, false);
      return;
    }
    if (typeof event.contentIndex !== "number" || !Number.isSafeInteger(event.contentIndex) || event.contentIndex < 0) return;
    const id = `${message.id}:${event.contentIndex}`;
    let index = message.blocks.findIndex((block) => block.id === id || block.kind === "tool" && block.id === event.id);
    if (event.type === "text_start" || event.type === "thinking_start") {
      if (index === -1) message.blocks.push({ id, kind: event.type === "text_start" ? "text" : "thinking", text: "" });
    } else if (event.type === "text_delta" || event.type === "thinking_delta" || event.type === "text_end" || event.type === "thinking_end") {
      if (index === -1) {
        message.blocks.push({ id, kind: String(event.type).startsWith("text") ? "text" : "thinking", text: "" });
        index = message.blocks.length - 1;
      }
      const block = message.blocks[index];
      if (block && (block.kind === "text" || block.kind === "thinking")) block.text = String(event.type).endsWith("_end") ? typeof event.content === "string" ? event.content : "" : block.text + (typeof event.delta === "string" ? event.delta : "");
    } else if (event.type === "toolcall_start") {
      if (index === -1) message.blocks.push({ id: typeof event.id === "string" ? event.id : id, kind: "tool", name: String(event.toolName ?? ""), args: "", output: "", status: "running" });
      this.current.set(`block:${event.contentIndex}`, typeof event.id === "string" ? event.id : id);
    } else if (event.type === "toolcall_delta" || event.type === "toolcall_end") {
      const toolId = this.current.get(`block:${event.contentIndex}`);
      const tool = message.blocks.find((block) => block.kind === "tool" && block.id === toolId);
      if (tool?.kind !== "tool") return;
      if (event.type === "toolcall_delta") tool.args += typeof event.delta === "string" ? event.delta : "";
      else {
        const call = record(event.toolCall);
        tool.id = typeof call.id === "string" ? call.id : tool.id;
        tool.name = typeof call.name === "string" ? call.name : tool.name;
        tool.args = serial(call.arguments);
      }
    }
    message.streaming = String(event.type).endsWith("_delta") || String(event.type).endsWith("_start");
  }
};

// src/pi-sessions.ts
function expandPath(path) {
  return resolve(path === "~" ? homedir() : path.startsWith("~/") ? join(homedir(), path.slice(2)) : path);
}
function sessionDirectory(options) {
  const explicit = options.sessionDir ?? process.env.PI_CODING_AGENT_SESSION_DIR;
  if (explicit) return expandPath(explicit);
  const agentDir = expandPath(options.agentDir ?? process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"));
  return join(agentDir, "sessions", `--${resolve(options.cwd).replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`);
}
async function* sessionRecords(path) {
  const stream = createReadStream(path);
  const decoder = new StringDecoder("utf8");
  let buffer = "";
  const parse = (line) => {
    try {
      const value = record(JSON.parse(line));
      return typeof value.type === "string" ? value : null;
    } catch {
      return null;
    }
  };
  try {
    for await (const chunk of stream) {
      buffer += decoder.write(chunk);
      let index;
      while ((index = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        const value2 = parse(line);
        if (value2) yield value2;
      }
    }
    buffer += decoder.end();
    const value = parse(buffer);
    if (value) yield value;
  } finally {
    stream.destroy();
  }
}
async function readSessionHeader(path) {
  const actualPath = await realpath(expandPath(path));
  for await (const entry of sessionRecords(actualPath)) {
    if (entry.type !== "session" || typeof entry.id !== "string" || !entry.id || typeof entry.cwd !== "string" || !isAbsolute(entry.cwd)) break;
    const cwdStats = await stat(entry.cwd);
    if (!cwdStats.isDirectory()) throw new Error("The saved Pi working directory is not a directory.");
    return { id: entry.id, cwd: entry.cwd, path: actualPath };
  }
  throw new Error("The selected file is not a valid Pi session.");
}
async function listPiSessions(options, all) {
  const explicit = options.sessionDir ?? process.env.PI_CODING_AGENT_SESSION_DIR;
  const agentDir = expandPath(options.agentDir ?? process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"));
  let directories;
  if (explicit || !all) directories = [sessionDirectory(options)];
  else {
    const root = join(agentDir, "sessions");
    try {
      directories = (await readdir(root, { withFileTypes: true })).filter((entry) => entry.isDirectory() || entry.isSymbolicLink()).map((entry) => join(root, entry.name));
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return [];
      throw new Error("Cannot read the Pi session directory.");
    }
  }
  const results = [];
  for (const directory of directories) {
    let names;
    try {
      names = await readdir(directory);
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") continue;
      throw new Error("Cannot read the Pi session directory.");
    }
    for (const name of names) {
      if (!name.endsWith(".jsonl")) continue;
      const path = join(directory, name);
      try {
        const stats = await stat(path);
        if (!stats.isFile()) continue;
        let header;
        let title;
        let firstMessage = "";
        let activity = 0;
        for await (const entry of sessionRecords(path)) {
          if (!header) {
            if (entry.type !== "session" || typeof entry.id !== "string" || typeof entry.cwd !== "string") break;
            header = entry;
            continue;
          }
          if (entry.type === "session_info") title = typeof entry.name === "string" && entry.name.trim() ? entry.name : void 0;
          if (entry.type !== "message") continue;
          const message = record(entry.message);
          if (message.role !== "user" && message.role !== "assistant") continue;
          const time = typeof message.timestamp === "number" ? message.timestamp : Date.parse(String(entry.timestamp));
          if (Number.isFinite(time)) activity = Math.max(activity, time);
          if (!firstMessage && message.role === "user") {
            firstMessage = typeof message.content === "string" ? message.content : Array.isArray(message.content) ? message.content.map(record).filter((block) => block.type === "text" && typeof block.text === "string").map((block) => block.text).join(" ") : "";
          }
        }
        if (!header || !all && resolve(String(header.cwd)) !== resolve(options.cwd)) continue;
        const actualPath = await realpath(path);
        results.push({
          id: actualPath,
          path: actualPath,
          cwd: String(header.cwd),
          title: title ?? firstMessage ?? "",
          modifiedTime: activity || Date.parse(String(header.timestamp)) || stats.mtimeMs,
          size: stats.size
        });
      } catch {
      }
    }
  }
  return results.sort((a, b) => b.modifiedTime - a.modifiedTime || a.path.localeCompare(b.path));
}

// src/rpc-transport.ts
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { StringDecoder as StringDecoder2 } from "node:string_decoder";
var RpcError = class extends Error {
  constructor(message, command) {
    super(message);
    this.command = command;
    this.name = "RpcError";
  }
};
var JsonlDecoder = class {
  constructor(receive, maxLength = 64 * 1024 * 1024) {
    this.receive = receive;
    this.maxLength = maxLength;
  }
  decoder = new StringDecoder2("utf8");
  buffer = "";
  push(chunk) {
    this.consume(this.decoder.write(chunk));
  }
  end() {
    this.consume(this.decoder.end());
    if (this.buffer.trim()) throw new RpcError("Pi closed an incomplete protocol record.");
  }
  consume(text3) {
    this.buffer += text3;
    let index;
    while ((index = this.buffer.indexOf("\n")) !== -1) {
      let line = this.buffer.slice(0, index);
      this.buffer = this.buffer.slice(index + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (!line.trim()) continue;
      if (line.length > this.maxLength) throw new RpcError("Pi protocol record exceeds the supported size.");
      let value;
      try {
        value = JSON.parse(line);
      } catch {
        throw new RpcError("Pi emitted an invalid JSON protocol record.");
      }
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new RpcError("Pi emitted a non-object protocol record.");
      this.receive(value);
    }
    if (this.buffer.length > this.maxLength) throw new RpcError("Pi protocol record exceeds the supported size.");
  }
};
var RpcTransport = class {
  constructor(options) {
    this.options = options;
    this.child = spawn(options.execPath, options.args, { cwd: options.cwd, stdio: ["pipe", "pipe", "pipe"], env: process.env });
    const decoder = new JsonlDecoder((value) => this.receive(value));
    this.child.stdout.on("data", (chunk) => {
      if (this.failed) return;
      try {
        decoder.push(chunk);
      } catch {
        this.fail(new RpcError("Pi emitted an invalid or oversized RPC stream."));
      }
    });
    this.child.stdout.on("end", () => {
      if (this.closing || this.failed) return;
      try {
        decoder.end();
      } catch {
        this.fail(new RpcError("Pi closed an incomplete RPC stream."));
      }
    });
    this.child.stderr.on("data", () => {
    });
    this.child.stdin.on("error", () => this.fail(new RpcError("Cannot write to the Pi process.")));
    this.child.on("error", () => this.fail(new RpcError("Cannot start Pi. Check the Pi executable and working directory.")));
    const exit = Promise.withResolvers();
    this.exited = exit.promise;
    this.child.once("close", (code2, signal) => {
      if (!this.closing) this.fail(new RpcError(`Pi exited unexpectedly${signal ? ` (${signal})` : ` (code ${code2 ?? "unknown"})`}.`));
      this.rejectPending(new RpcError("Pi process closed."));
      exit.resolve();
    });
  }
  child;
  pending = /* @__PURE__ */ new Map();
  failed = null;
  closing = false;
  exited;
  writeTail = Promise.resolve();
  request(command, fields = {}, timeoutMs = 3e4) {
    if (this.failed || this.closing) return Promise.reject(this.failed ?? new RpcError("Pi process is closed."));
    const id = randomUUID();
    const { promise, resolve: resolve5, reject } = Promise.withResolvers();
    const pending = { command, resolve: resolve5, reject };
    if (timeoutMs > 0) pending.timer = setTimeout(() => {
      this.pending.delete(id);
      reject(new RpcError(`Pi did not respond to ${command} before the deadline.`, command));
    }, timeoutMs);
    this.pending.set(id, pending);
    void this.write({ ...fields, id, type: command }).catch((error) => {
      const current = this.pending.get(id);
      if (!current) return;
      clearTimeout(current.timer);
      this.pending.delete(id);
      reject(error);
    });
    return promise;
  }
  write(value) {
    const operation = this.writeTail.then(() => {
      if (this.failed || this.closing) throw this.failed ?? new RpcError("Pi process is closed.");
      const { promise, resolve: resolve5, reject } = Promise.withResolvers();
      this.child.stdin.write(`${JSON.stringify(value)}
`, (error) => {
        if (error) reject(new RpcError("Cannot write to the Pi process."));
        else resolve5();
      });
      return promise;
    });
    this.writeTail = operation.catch(() => {
    });
    return operation;
  }
  async close() {
    if (this.closing) return this.exited;
    this.closing = true;
    this.rejectPending(new RpcError("Pi process closed."));
    this.child.stdin.end();
    const term = setTimeout(() => this.child.kill("SIGTERM"), 1500);
    const kill = setTimeout(() => this.child.kill("SIGKILL"), 4e3);
    try {
      await this.exited;
    } finally {
      clearTimeout(term);
      clearTimeout(kill);
    }
  }
  receive(value) {
    if (value.type !== "response") {
      this.options.onEvent(value);
      return;
    }
    if (typeof value.id !== "string") {
      this.fail(new RpcError("Pi returned an uncorrelated RPC response."));
      return;
    }
    const pending = this.pending.get(value.id);
    if (!pending) return;
    if (value.command !== pending.command || typeof value.success !== "boolean") {
      this.fail(new RpcError("Pi returned a mismatched RPC response."));
      return;
    }
    clearTimeout(pending.timer);
    this.pending.delete(value.id);
    if (value.success) pending.resolve(value);
    else pending.reject(new RpcError(`Pi rejected ${pending.command}. Check Pi configuration or extension behavior.`, pending.command));
  }
  fail(error) {
    if (this.failed || this.closing) return;
    this.failed = error;
    this.rejectPending(error);
    this.options.onFailure(error);
    void this.close();
  }
  rejectPending(error) {
    for (const item of this.pending.values()) {
      clearTimeout(item.timer);
      item.reject(error);
    }
    this.pending.clear();
  }
};

// src/session-lock.ts
import { createHash, randomUUID as randomUUID2 } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join as join2 } from "node:path";
var SessionLockError = class extends Error {
};
function errno(error, code2) {
  return !!error && typeof error === "object" && "code" in error && error.code === code2;
}
function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !errno(error, "ESRCH");
  }
}
async function owner(path) {
  try {
    const value = JSON.parse(await readFile(join2(path, "owner.json"), "utf8"));
    if (value && typeof value === "object" && "pid" in value && "token" in value && typeof value.pid === "number" && Number.isSafeInteger(value.pid) && value.pid > 0 && typeof value.token === "string") {
      return { pid: value.pid, token: value.token };
    }
  } catch {
  }
  return null;
}
var SessionLock = class _SessionLock {
  constructor(path, token, sessionId) {
    this.path = path;
    this.token = token;
    this.sessionId = sessionId;
  }
  released = false;
  static async acquire(dataDir, sessionId) {
    const root = join2(dataDir, "session-locks");
    await mkdir(root, { recursive: true, mode: 448 });
    const path = join2(root, `${createHash("sha256").update(sessionId).digest("hex")}.lock`);
    const token = randomUUID2();
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await mkdir(path, { mode: 448 });
        await writeFile(join2(path, "owner.json"), JSON.stringify({ pid: process.pid, token }), { flag: "wx", mode: 384 });
        return new _SessionLock(path, token, sessionId);
      } catch (error) {
        if (!errno(error, "EEXIST")) throw new SessionLockError("Cannot create the Pi session lock. Check the plugin data directory permissions.");
      }
      const gate = join2(path, "reclaim");
      try {
        await mkdir(gate, { mode: 448 });
      } catch {
        throw new SessionLockError("Another plugin process is opening this Pi session.");
      }
      let moved = false;
      try {
        const current = await owner(path);
        if (!current || alive(current.pid)) throw new SessionLockError(current ? `This Pi session is owned by plugin process ${current.pid}. Close it before resuming here.` : "The Pi session lock has no verifiable owner. Confirm all plugin instances are closed before removing that lock.");
        const retired = `${path}.retired-${token}`;
        await rename(path, retired);
        moved = true;
        await rm(retired, { recursive: true, force: true });
      } finally {
        if (!moved) await rm(gate, { recursive: true, force: true });
      }
    }
    throw new SessionLockError("The Pi session lock changed while opening. Choose the session again.");
  }
  async release() {
    if (this.released) return;
    this.released = true;
    if ((await owner(this.path))?.token === this.token) await rm(this.path, { recursive: true, force: true });
  }
};

// src/backend.ts
function modelChoice(value) {
  const model = record(value);
  if (typeof model.id !== "string" || typeof model.provider !== "string") return null;
  return {
    id: JSON.stringify([model.provider, model.id]),
    provider: model.provider,
    modelId: model.id,
    label: typeof model.name === "string" ? model.name : model.id,
    reasoning: model.reasoning === true,
    ...Array.isArray(model.input) ? { noImageSupport: !model.input.includes("image") } : {},
    ...typeof model.contextWindow === "number" ? { contextWindow: model.contextWindow } : {}
  };
}
var PiBridge = class {
  constructor(options) {
    this.options = options;
    this.cwd = resolve2(options.cwd);
  }
  state = {
    phase: "disconnected",
    needsInterrupt: false,
    workingState: null,
    session: null,
    messages: [],
    models: [],
    commands: [],
    dialog: null,
    widgets: [],
    statuses: [],
    editorText: null,
    windowTitle: null,
    error: null,
    notice: null,
    context: null,
    usage: null
  };
  transport = null;
  transcript = new Transcript();
  scope = 0;
  processEpoch = 0;
  lock = null;
  runActive = false;
  changing = false;
  sending = false;
  stopping = false;
  submission = 0;
  activity = 0;
  settledActivity = 0;
  settingsVersion = 0;
  nameActivity = 0;
  thinkingActivity = 0;
  contextInvalidationActivity = 0;
  bootstrapEvents = null;
  refreshPromise = null;
  refreshAgain = false;
  refreshScope = 0;
  closingTransport = null;
  dialogs = [];
  contextValue = { used: null, limit: 0, percent: null };
  cwd;
  async open(sessionPath) {
    if (this.changing || this.sending || this.stopping || this.runActive || this.dialogs.length) throw new Error("Stop the current Pi operation before switching sessions.");
    this.changing = true;
    const openingScope = this.scope;
    try {
      await this.closingTransport;
    } catch (error) {
      if (openingScope === this.scope) this.changing = false;
      throw this.safeError(error);
    }
    if (openingScope !== this.scope) return;
    if (this.transport) {
      let targetLock = null;
      try {
        const header = sessionPath ? await readSessionHeader(sessionPath) : null;
        if (openingScope !== this.scope) return;
        if (header && header.id !== this.lock?.sessionId) targetLock = await SessionLock.acquire(this.options.dataDir, header.id);
        if (openingScope !== this.scope) return;
        await this.mutateSession(header ? "switch_session" : "new_session", header ? { sessionPath: header.path } : {}, header?.cwd, targetLock, true);
        targetLock = null;
      } finally {
        await targetLock?.release();
        if (openingScope === this.scope) this.changing = false;
      }
      return;
    }
    const scope = ++this.scope;
    const epoch = ++this.processEpoch;
    this.state.phase = "connecting";
    this.state.error = null;
    this.changed();
    try {
      const header = sessionPath ? await readSessionHeader(sessionPath) : null;
      if (scope !== this.scope) return;
      if (header) {
        const lock = await SessionLock.acquire(this.options.dataDir, header.id);
        if (scope !== this.scope) {
          await lock.release();
          return;
        }
        this.lock = lock;
        this.cwd = header.cwd;
      }
      if (scope !== this.scope) return;
      const args = ["--mode", "rpc"];
      if (header) args.push("--session", header.path);
      if (this.options.sessionDir) args.push("--session-dir", this.options.sessionDir);
      this.bootstrapEvents = [];
      this.transport = new RpcTransport({
        execPath: this.options.execPath ?? "pi",
        args,
        cwd: this.cwd,
        onEvent: (event) => {
          if (epoch === this.processEpoch) this.event(event);
        },
        onFailure: (error) => {
          if (epoch === this.processEpoch) void this.retire(error);
        }
      });
      await this.reload(true, scope);
      if (scope !== this.scope) return;
      this.state.phase = this.runActive ? "running" : this.dialogs.length ? "question" : "idle";
      this.state.needsInterrupt = this.runActive || this.dialogs.length > 0;
      this.changed();
    } catch (error) {
      if (scope === this.scope) {
        this.failure(error);
        const transport = this.transport;
        this.transport = null;
        ++this.processEpoch;
        const lock = this.lock;
        this.lock = null;
        await transport?.close();
        await lock?.release();
      }
      throw this.safeError(error);
    } finally {
      if (scope === this.scope) this.changing = false;
    }
  }
  sessions(all) {
    return listPiSessions({ cwd: this.cwd, sessionDir: this.options.sessionDir }, all);
  }
  async contextDetails() {
    const scope = this.scope;
    const version = this.settingsVersion;
    const activity = this.activity;
    const response = await this.rpc().request("get_session_stats");
    if (scope !== this.scope || version !== this.settingsVersion) throw new Error("The Pi session or settings changed.");
    const stats = record(response.data);
    if (typeof stats.sessionId === "string" && stats.sessionId !== this.state.session?.id) throw new Error("Pi returned context for a different session.");
    this.applyStats(stats, activity);
    this.changed();
    return { ...this.contextValue };
  }
  async send(text3, onAccepted, images = []) {
    if (this.changing || this.sending || this.stopping || this.runActive || this.dialogs.length) throw new Error("Pi is busy. Stop or wait before sending another message.");
    const transport = this.rpc();
    if (!text3.trim() && !images.length) throw new Error("Enter a message or attach an image before sending.");
    if (images.some((image) => !["image/jpeg", "image/png", "image/gif", "image/webp"].includes(image.mimeType) || !image.data || image.data.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(image.data))) {
      throw new Error("Image attachments must contain valid base64 data in JPEG, PNG, GIF or WebP format.");
    }
    const model = this.state.models.find((item) => item.id === this.state.session?.settings.modelId);
    if (images.length && model?.noImageSupport) throw new Error("The selected Pi model does not support image attachments. Choose an image-capable model or remove the images.");
    const scope = this.scope;
    const submission = ++this.submission;
    const beforeActivity = this.activity;
    this.sending = true;
    this.state.error = null;
    this.state.notice = null;
    this.state.needsInterrupt = true;
    this.state.phase = "running";
    this.state.workingState = null;
    this.changed();
    try {
      const response = await transport.request("prompt", {
        message: text3,
        ...images.length ? { images: images.map((image) => ({ type: "image", data: image.data, mimeType: image.mimeType })) } : {}
      }, 0);
      if (scope !== this.scope || transport !== this.transport) return;
      const disposition = record(response.data).disposition;
      if (disposition !== "handled" && disposition !== "started" && disposition !== "queued") throw new RpcError("Pi returned an unsupported prompt disposition.");
      if (submission !== this.submission) {
        await this.stopCommands(transport, scope);
        return;
      }
      onAccepted(disposition);
      if (disposition !== "handled" && this.settledActivity <= beforeActivity) this.runActive = true;
      if (!this.runActive && !this.dialogs.length) {
        this.state.phase = "idle";
        this.state.needsInterrupt = false;
        this.state.workingState = null;
      } else {
        this.state.phase = this.dialogs.length ? "question" : "running";
        this.state.needsInterrupt = true;
      }
      this.changed();
      if (!this.runActive) await this.refresh();
    } catch (error) {
      if (scope === this.scope) {
        this.state.error = this.safeError(error).message;
        this.state.phase = this.runActive ? "running" : "error";
        this.state.needsInterrupt = this.runActive || this.dialogs.length > 0;
        this.changed();
      }
      throw this.safeError(error);
    } finally {
      if (scope === this.scope) {
        this.sending = false;
        this.idlePhase();
        this.changed();
      }
    }
  }
  async interrupt() {
    const transport = this.rpc();
    if (this.stopping) return;
    const scope = this.scope;
    ++this.submission;
    this.stopping = true;
    this.state.phase = "stopping";
    this.state.needsInterrupt = true;
    this.changed();
    try {
      await this.cancelDialogs(transport);
      await this.stopCommands(transport, scope);
      if (scope === this.scope) await this.refresh();
    } catch (error) {
      if (scope === this.scope) await this.retire(error);
      throw this.safeError(error);
    } finally {
      if (scope === this.scope) {
        this.stopping = false;
        this.idlePhase();
        this.changed();
      }
    }
  }
  async resolveDialog(requestId, response) {
    const entry = this.dialogs[0];
    if (!entry || entry.scope !== this.scope || entry.dialog.id !== requestId) throw new Error("This Pi dialog is no longer active.");
    if (entry.dialog.deadline !== void 0 && Date.now() >= entry.dialog.deadline) {
      this.removeDialog(entry);
      throw new Error("This Pi dialog timed out.");
    }
    if (!("cancelled" in response)) {
      if (entry.dialog.method === "confirm" ? !("confirmed" in response) : !("value" in response)) throw new Error("The response does not match the Pi dialog.");
      if (entry.dialog.method === "select" && "value" in response && !entry.dialog.options?.includes(response.value)) throw new Error("Choose one of the exact Pi options.");
    }
    const transport = this.rpc();
    this.removeDialog(entry);
    await transport.write({ type: "extension_ui_response", id: requestId, ...response });
  }
  async updateSettings(patch) {
    this.requireIdle();
    const scope = this.scope;
    this.changing = true;
    ++this.settingsVersion;
    try {
      if (patch.modelId !== void 0) {
        const model = this.state.models.find((item) => item.id === patch.modelId);
        if (!model) throw new Error("Choose an available Pi model.");
        await this.rpc().request("set_model", { provider: model.provider, modelId: model.modelId }, 0);
      }
      if (scope !== this.scope) return;
      const levels = record((await this.rpc().request("get_available_thinking_levels")).data).levels;
      if (scope !== this.scope) return;
      if (patch.reasoningEffort !== void 0) {
        if (!Array.isArray(levels) || !levels.includes(patch.reasoningEffort)) throw new Error("That thinking level is not available for the selected Pi model.");
        await this.rpc().request("set_thinking_level", { level: patch.reasoningEffort });
      }
    } catch (error) {
      if (scope === this.scope) {
        this.state.error = this.safeError(error).message;
        this.changed();
      }
      throw this.safeError(error);
    } finally {
      if (scope === this.scope) {
        try {
          await this.reload(true, scope);
        } catch (error) {
          if (scope === this.scope) await this.retire(error);
          throw this.safeError(error);
        } finally {
          if (scope === this.scope) this.changing = false;
        }
      }
    }
  }
  async rename(title) {
    this.requireIdle();
    if (!title.trim()) throw new Error("The Pi session name cannot be empty.");
    const scope = this.scope;
    this.changing = true;
    try {
      await this.rpc().request("set_session_name", { name: title }, 0);
      if (scope === this.scope) await this.reload(false, scope);
    } catch (error) {
      if (scope === this.scope) await this.retire(error);
      throw this.safeError(error);
    } finally {
      if (scope === this.scope) this.changing = false;
    }
  }
  async forkMessages() {
    this.requireIdle();
    const scope = this.scope;
    const data = record((await this.rpc().request("get_fork_messages")).data);
    if (scope !== this.scope) throw new Error("The Pi session changed.");
    return (Array.isArray(data.messages) ? data.messages : []).map(record).filter((item) => typeof item.entryId === "string" && typeof item.text === "string").map((item) => ({ entryId: item.entryId, text: item.text }));
  }
  async fork(entryId) {
    const choices = await this.forkMessages();
    if (!choices.some((item) => item.entryId === entryId)) throw new Error("Choose a user message on the active Pi branch.");
    await this.mutateSession("fork", { entryId });
  }
  async clone() {
    await this.mutateSession("clone");
  }
  async compact(instructions) {
    this.requireIdle();
    const scope = this.scope;
    this.changing = true;
    this.runActive = true;
    this.state.phase = "running";
    this.state.needsInterrupt = true;
    this.state.workingState = "compacting_conversation";
    this.changed();
    try {
      await this.rpc().request("compact", instructions === void 0 ? {} : { customInstructions: instructions }, 0);
    } catch (error) {
      if (scope === this.scope) {
        this.state.error = this.safeError(error).message;
        this.changed();
      }
      throw this.safeError(error);
    } finally {
      if (scope === this.scope) {
        this.runActive = false;
        this.state.workingState = null;
        try {
          await this.reload(true, scope);
          this.idlePhase();
          this.changed();
        } catch (error) {
          if (scope === this.scope) await this.retire(error);
          throw this.safeError(error);
        } finally {
          if (scope === this.scope) this.changing = false;
        }
      }
    }
  }
  async close() {
    const scope = ++this.scope;
    ++this.processEpoch;
    ++this.submission;
    const transport = this.transport;
    this.transport = null;
    const lock = this.lock;
    this.lock = null;
    this.changing = true;
    try {
      if (transport) {
        try {
          await this.cancelDialogs(transport);
        } finally {
          await transport.close();
        }
      }
      await this.closingTransport;
    } finally {
      try {
        await lock?.release();
      } finally {
        if (scope === this.scope) {
          this.clearExtensionState();
          this.bootstrapEvents = null;
          this.transcript.settle();
          this.state.messages = this.transcript.messages;
          this.runActive = false;
          this.changing = false;
          this.sending = false;
          this.stopping = false;
          this.state.phase = "disconnected";
          this.state.needsInterrupt = false;
          this.state.workingState = null;
          this.changed();
        }
      }
    }
  }
  async mutateSession(command, fields = {}, cwd, targetLock, reserved = false) {
    if (!reserved) this.requireIdle();
    else this.rpc();
    let scope = this.scope;
    this.changing = true;
    const extensionState = { widgets: this.state.widgets, statuses: this.state.statuses, editorText: this.state.editorText, windowTitle: this.state.windowTitle, notice: this.state.notice };
    this.clearExtensionState();
    try {
      const data = record((await this.rpc().request(command, fields, 0)).data);
      if (scope !== this.scope) return;
      if (data.cancelled !== false) {
        if (data.cancelled !== true) throw new Error("Pi did not confirm the session operation.");
        Object.assign(this.state, extensionState);
        this.state.notice = "Pi cancelled the session operation.";
        this.changed();
        return;
      }
      ++this.scope;
      ++this.submission;
      const nextScope = this.scope;
      scope = nextScope;
      await this.cancelDialogs(this.rpc());
      if (nextScope !== this.scope) return;
      if (targetLock) {
        const previous = this.lock;
        this.lock = targetLock;
        await previous?.release();
      } else if (command !== "switch_session") {
        const previous = this.lock;
        this.lock = null;
        await previous?.release();
      }
      if (nextScope !== this.scope) return;
      if (cwd) this.cwd = cwd;
      this.state.error = null;
      this.runActive = false;
      this.transcript = new Transcript();
      this.state.messages = [];
      this.bootstrapEvents = [];
      this.state.context = null;
      this.state.usage = null;
      this.contextValue = { used: null, limit: 0, percent: null };
      await this.reload(true, nextScope);
      if (command === "fork" && typeof data.text === "string" && nextScope === this.scope) this.state.editorText = { id: randomUUID3(), text: data.text };
      if (nextScope === this.scope) {
        this.idlePhase();
        this.changed();
      }
    } catch (error) {
      if (scope === this.scope) await this.retire(error);
      throw this.safeError(error);
    } finally {
      if (scope === this.scope) this.changing = false;
      if (targetLock && this.lock !== targetLock) await targetLock.release();
    }
  }
  async stopCommands(transport, scope) {
    const cleared = record((await transport.request("clear_queue")).data);
    if (scope !== this.scope) return;
    const restored = [cleared.steering, cleared.followUp].flatMap((value) => Array.isArray(value) ? value.filter((text3) => typeof text3 === "string") : []);
    if (restored.length) this.state.editorText = { id: randomUUID3(), text: restored.join("\n\n") };
    await transport.request("abort", {}, 0);
    if (scope !== this.scope) return;
    this.runActive = false;
    this.transcript.settle();
    this.state.messages = this.transcript.messages;
    this.state.workingState = null;
    this.idlePhase();
    this.changed();
  }
  async reload(full, scope) {
    const transport = this.rpc();
    const activity = this.activity;
    const version = this.settingsVersion;
    const bootstrap = this.bootstrapEvents;
    const [stateResponse, entriesResponse, messagesResponse, statsResponse, levelsResponse, modelsResponse, commandsResponse] = await Promise.all([
      transport.request("get_state"),
      transport.request("get_entries"),
      transport.request("get_messages"),
      transport.request("get_session_stats"),
      transport.request("get_available_thinking_levels"),
      full ? transport.request("get_available_models") : null,
      full ? transport.request("get_commands") : null
    ]);
    if (scope !== this.scope || transport !== this.transport || version !== this.settingsVersion) return;
    const data = record(stateResponse.data);
    if (typeof data.sessionId !== "string" || !data.sessionId) throw new Error("Pi did not report a session identity.");
    if (this.lock?.sessionId !== data.sessionId) {
      const next = await SessionLock.acquire(this.options.dataDir, data.sessionId);
      if (scope !== this.scope) {
        await next.release();
        return;
      }
      const previous2 = this.lock;
      this.lock = next;
      await previous2?.release();
    }
    if (typeof data.sessionFile === "string") {
      try {
        const header = await readSessionHeader(data.sessionFile);
        if (scope !== this.scope) return;
        this.cwd = header.cwd;
      } catch {
      }
    }
    if (scope !== this.scope || version !== this.settingsVersion) return;
    if (modelsResponse) this.state.models = (Array.isArray(record(modelsResponse.data).models) ? record(modelsResponse.data).models : []).map(modelChoice).filter((model2) => model2 !== null);
    const model = modelChoice(data.model);
    if (model && !this.state.models.some((item) => item.id === model.id)) this.state.models.push(model);
    const levels = record(levelsResponse.data).levels;
    const thinkingLevels = Array.isArray(levels) ? levels.filter((level) => typeof level === "string") : [];
    const previous = this.state.session?.id === data.sessionId ? this.state.session : null;
    this.state.session = {
      id: data.sessionId,
      ...typeof data.sessionFile === "string" ? { file: data.sessionFile } : {},
      title: previous && this.nameActivity > activity ? previous.title : typeof data.sessionName === "string" ? data.sessionName : "",
      cwd: this.cwd,
      settings: {
        modelId: model?.id ?? "",
        reasoningEffort: previous && this.thinkingActivity > activity ? previous.settings.reasoningEffort : typeof data.thinkingLevel === "string" ? data.thinkingLevel : "",
        thinkingLevels,
        ...typeof data.autoCompactionEnabled === "boolean" ? { autoCompactionEnabled: data.autoCompactionEnabled } : {}
      }
    };
    if (commandsResponse) this.state.commands = (Array.isArray(record(commandsResponse.data).commands) ? record(commandsResponse.data).commands : []).map(record).filter((item) => typeof item.name === "string" && (item.source === "extension" || item.source === "prompt" || item.source === "skill")).map((item) => ({ name: item.name, source: item.source, ...typeof item.description === "string" ? { description: item.description } : {} }));
    if (activity === this.activity && (data.isStreaming === true || data.isCompacting === true || typeof data.pendingMessageCount === "number" && data.pendingMessageCount > 0)) this.runActive = true;
    if (bootstrap || activity === this.activity && !this.runActive) {
      const entries = record(entriesResponse.data);
      const messages = record(messagesResponse.data).messages;
      this.transcript.hydrate(Array.isArray(entries.entries) ? entries.entries : [], entries.leafId, Array.isArray(messages) ? messages : []);
      if (bootstrap) {
        this.transcript.replay(bootstrap);
        if (this.bootstrapEvents === bootstrap) this.bootstrapEvents = null;
      }
      this.state.messages = this.transcript.messages;
    }
    this.applyStats(record(statsResponse.data), activity);
    this.idlePhase();
    this.changed();
  }
  refresh() {
    if (this.refreshPromise && this.refreshScope === this.scope) {
      this.refreshAgain = true;
      return this.refreshPromise;
    }
    const scope = this.scope;
    this.refreshScope = scope;
    const operation = (async () => {
      do {
        this.refreshAgain = false;
        try {
          await this.reload(false, scope);
        } catch (error) {
          if (scope === this.scope) {
            this.state.error = this.safeError(error).message;
            this.changed();
          }
        }
      } while (this.refreshAgain && scope === this.scope && !this.runActive);
    })().finally(() => {
      if (this.refreshPromise === operation) this.refreshPromise = null;
    });
    this.refreshPromise = operation;
    return operation;
  }
  applyStats(stats, requestedActivity) {
    const usage = record(stats.contextUsage);
    const stale = this.contextInvalidationActivity > requestedActivity;
    this.contextValue = {
      used: !stale && typeof usage.tokens === "number" ? usage.tokens : null,
      limit: typeof usage.contextWindow === "number" ? usage.contextWindow : 0,
      percent: !stale && typeof usage.percent === "number" ? usage.percent : null,
      ...this.state.session ? {
        modelLabel: this.state.models.find((model) => model.id === this.state.session?.settings.modelId)?.label,
        autoCompactionEnabled: this.state.session.settings.autoCompactionEnabled
      } : {}
    };
    this.state.context = this.contextValue.used !== null && this.contextValue.limit > 0 ? { used: this.contextValue.used, limit: this.contextValue.limit } : null;
    const tokens = record(stats.tokens);
    this.state.usage = ["input", "output", "cacheRead", "cacheWrite", "total"].every((key) => typeof tokens[key] === "number") ? {
      input: tokens.input,
      output: tokens.output,
      cacheRead: tokens.cacheRead,
      cacheWrite: tokens.cacheWrite,
      totalTokens: tokens.total
    } : null;
  }
  event(event) {
    if (typeof event.sessionId === "string" && this.state.session && event.sessionId !== this.state.session.id) return;
    ++this.activity;
    if (event.type === "extension_ui_request") {
      this.extensionUi(event);
      return;
    }
    this.bootstrapEvents?.push(event);
    this.transcript.apply(event);
    this.state.messages = this.transcript.messages;
    if ((event.type === "message_start" || event.type === "message_end") && record(event.message).role === "user") this.options.onUserMessage?.();
    switch (event.type) {
      case "agent_start":
      case "turn_start":
        this.runActive = true;
        this.state.workingState = "thinking";
        break;
      case "message_update": {
        const type = record(event.assistantMessageEvent).type;
        if (type === "thinking_start" || type === "thinking_delta") this.state.workingState = "thinking";
        else if (type === "text_start" || type === "text_delta") this.state.workingState = "streaming_assistant_message";
        break;
      }
      case "tool_execution_start":
      case "tool_execution_update":
        this.state.workingState = "executing_tool";
        break;
      case "tool_execution_end":
        this.state.workingState = null;
        break;
      case "message_end":
        if (record(event.message).role === "assistant" && record(event.message).stopReason === "error") this.state.error = "Pi could not complete the response. Check the Pi provider or extension configuration.";
        this.state.workingState = null;
        break;
      case "agent_end":
        this.state.workingState = event.willRetry === true ? "retrying" : null;
        break;
      case "agent_settled":
        this.settledActivity = this.activity;
        this.runActive = false;
        this.state.workingState = null;
        if (!this.changing && !this.bootstrapEvents) void this.refresh();
        break;
      case "queue_update":
        if (Array.isArray(event.steering) && event.steering.length > 0 || Array.isArray(event.followUp) && event.followUp.length > 0) this.runActive = true;
        break;
      case "compaction_start":
        this.runActive = true;
        this.state.workingState = "compacting_conversation";
        break;
      case "compaction_end":
        this.contextInvalidationActivity = this.activity;
        this.state.context = null;
        this.contextValue = { ...this.contextValue, used: null, percent: null };
        if (typeof event.errorMessage === "string") this.state.error = "Pi compaction failed.";
        this.state.workingState = event.willRetry === true ? "retrying" : null;
        break;
      case "auto_retry_start":
      case "summarization_retry_scheduled":
      case "summarization_retry_attempt_start":
        this.runActive = true;
        this.state.workingState = "retrying";
        break;
      case "auto_retry_end":
        if (event.success === false) this.state.error = "Pi exhausted its automatic retries.";
        this.state.workingState = null;
        break;
      case "summarization_retry_finished":
        this.state.workingState = null;
        break;
      case "thinking_level_changed":
        this.thinkingActivity = this.activity;
        if (this.state.session && typeof event.level === "string") this.state.session.settings.reasoningEffort = event.level;
        break;
      case "session_info_changed":
        this.nameActivity = this.activity;
        if (this.state.session) this.state.session.title = typeof event.name === "string" ? event.name : "";
        break;
      case "extension_error":
        this.state.notice = "A Pi extension reported an error.";
        break;
    }
    this.idlePhase();
    this.changed();
  }
  extensionUi(event) {
    if (typeof event.id !== "string" || typeof event.method !== "string") return;
    const method = event.method;
    if (method === "select" || method === "confirm" || method === "input" || method === "editor") {
      if (this.dialogs.some((entry2) => entry2.dialog.id === event.id)) return;
      const timeout = typeof event.timeout === "number" && Number.isFinite(event.timeout) && event.timeout >= 0 ? event.timeout : void 0;
      const dialog = {
        id: event.id,
        method,
        title: typeof event.title === "string" ? event.title : "",
        ...typeof event.message === "string" ? { message: event.message } : {},
        ...Array.isArray(event.options) && event.options.every((value) => typeof value === "string") ? { options: event.options } : {},
        ...typeof event.placeholder === "string" ? { placeholder: event.placeholder } : {},
        ...typeof event.prefill === "string" ? { prefill: event.prefill } : {},
        ...timeout === void 0 ? {} : { deadline: Date.now() + timeout }
      };
      const entry = { dialog, scope: this.scope };
      if (timeout !== void 0) entry.timer = setTimeout(() => {
        if (entry.scope === this.scope) this.removeDialog(entry);
      }, timeout);
      this.dialogs.push(entry);
      this.state.dialog = this.dialogs[0]?.dialog ?? null;
      if (this.stopping) void this.cancelDialogs(this.rpc()).catch((error) => this.failure(error));
    } else if (method === "notify") {
      if (typeof event.message === "string") this.state.notice = event.message;
    } else if (method === "setStatus" && typeof event.statusKey === "string") {
      this.state.statuses = this.state.statuses.filter((item) => item.key !== event.statusKey);
      if (typeof event.statusText === "string") this.state.statuses.push({ key: event.statusKey, text: event.statusText });
    } else if (method === "setWidget" && typeof event.widgetKey === "string") {
      this.state.widgets = this.state.widgets.filter((item) => item.key !== event.widgetKey);
      if (Array.isArray(event.widgetLines) && event.widgetLines.every((line) => typeof line === "string")) this.state.widgets.push({
        key: event.widgetKey,
        lines: event.widgetLines,
        placement: event.widgetPlacement === "belowEditor" ? "belowEditor" : "aboveEditor"
      });
    } else if (method === "setTitle" && typeof event.title === "string") this.state.windowTitle = event.title;
    else if (method === "set_editor_text" && typeof event.text === "string") this.state.editorText = { id: event.id, text: event.text };
    this.idlePhase();
    this.changed();
  }
  removeDialog(entry) {
    clearTimeout(entry.timer);
    this.dialogs = this.dialogs.filter((item) => item !== entry);
    this.state.dialog = this.dialogs[0]?.dialog ?? null;
    this.idlePhase();
    this.changed();
  }
  async cancelDialogs(transport) {
    const dialogs = this.dialogs;
    this.dialogs = [];
    this.state.dialog = null;
    for (const entry of dialogs) {
      clearTimeout(entry.timer);
      await transport.write({ type: "extension_ui_response", id: entry.dialog.id, cancelled: true });
    }
  }
  clearExtensionState() {
    for (const entry of this.dialogs) clearTimeout(entry.timer);
    this.dialogs = [];
    this.state.dialog = null;
    this.state.widgets = [];
    this.state.statuses = [];
    this.state.editorText = null;
    this.state.windowTitle = null;
    this.state.notice = null;
  }
  idlePhase() {
    this.state.needsInterrupt = this.runActive || this.sending || this.stopping || this.dialogs.length > 0;
    if (this.dialogs.length) this.state.workingState = null;
    if (this.state.phase === "disconnected" || this.state.phase === "connecting" && !this.state.session) return;
    this.state.phase = this.stopping ? "stopping" : this.dialogs.length ? "question" : this.runActive || this.sending ? "running" : this.state.error ? "error" : "idle";
  }
  requireIdle() {
    this.rpc();
    if (this.changing || this.sending || this.stopping || this.runActive || this.dialogs.length) throw new Error("Stop or finish the current Pi operation first.");
  }
  rpc() {
    if (!this.transport) throw new Error("Pi is not connected.");
    return this.transport;
  }
  retire(error) {
    this.failure(error);
    const transport = this.transport;
    this.transport = null;
    const lock = this.lock;
    this.lock = null;
    ++this.processEpoch;
    ++this.scope;
    ++this.submission;
    const scope = this.scope;
    this.changing = false;
    this.sending = false;
    this.stopping = false;
    this.bootstrapEvents = null;
    const cleanup = (async () => {
      try {
        await transport?.close();
      } finally {
        await lock?.release();
      }
    })();
    this.closingTransport = cleanup;
    void cleanup.catch(() => {
      if (scope === this.scope) {
        this.state.error = "Pi closed, but its session lock could not be released. Check the plugin data directory permissions.";
        this.changed();
      }
    });
    return cleanup;
  }
  failure(error) {
    this.runActive = false;
    this.transcript.settle();
    this.state.messages = this.transcript.messages;
    this.state.phase = "error";
    this.state.error = this.safeError(error).message;
    this.state.needsInterrupt = false;
    this.state.workingState = null;
    this.clearExtensionState();
    this.changed();
  }
  safeError(error) {
    return error instanceof RpcError || error instanceof SessionLockError || error instanceof Error && (error.message.startsWith("Pi ") || error.message.startsWith("The Pi ") || error.message.startsWith("Choose ") || error.message.startsWith("That thinking ") || error.message.startsWith("This Pi ")) ? error : new Error("Pi operation failed. Check the Pi executable, working directory, session lock, or configuration.");
  }
  changed() {
    this.options.onChange();
  }
};

// src/omp-transcript.ts
import { Container } from "@oh-my-pi/pi-tui/tui";
import { TranscriptContainer } from "@oh-my-pi/pi-tui/chrome/transcript-container";
import { UserMessageComponent } from "@oh-my-pi/pi-tui/chat/user-message";
import { SkillMessageComponent } from "@oh-my-pi/pi-tui/chat/skill-message";
import { AssistantMessageComponent } from "@oh-my-pi/pi-tui/chat/assistant-message";
import { ToolExecutionComponent } from "@oh-my-pi/pi-tui/chat/tool-execution";
import { Markdown, fencedCode } from "@oh-my-pi/pi-tui/components/markdown";
import { Disclosure } from "@oh-my-pi/pi-tui/components/disclosure";
import { Image } from "@oh-my-pi/pi-tui/components/image";
import { Text } from "@oh-my-pi/pi-tui/components/text";
import { nativeDiff, renderDiff } from "@oh-my-pi/pi-tui/chrome/diff";
import { describeCodeCell, renderCodeCell } from "@oh-my-pi/pi-tui/render/code-cell";
import { rootToggleExpanded } from "@oh-my-pi/pi-tui/native/node";
import { ansi, code, col, keyed } from "@oh-my-pi/pi-tui/native/describe";
import { numberedCode } from "@oh-my-pi/pi-tui/tools/grouped-file-output";
import { fileRow } from "@oh-my-pi/pi-tui/tools/native-view";
import { ensureThemeSync, getLanguageFromPath, getMarkdownTheme, getThemeEpoch, theme } from "@oh-my-pi/pi-tui/theme";

// src/tool-source.ts
function toolSourceParts(tool, args, languageForPath) {
  if (tool.status === "error" || !tool.output) return void 0;
  const input = record(args);
  if (tool.name === "read") {
    const path = typeof input.path === "string" ? input.path : void 0;
    const lang = path ? languageForPath(path) : void 0;
    return lang ? [{ kind: "read", text: tool.output, lang }] : void 0;
  }
  if (tool.name !== "grep") return void 0;
  const location = /([:-])([1-9]\d*)\1 /g;
  const parts = [];
  let hasSource = false;
  for (const line of tool.output.split("\n")) {
    let source;
    location.lastIndex = 0;
    for (let match = location.exec(line); match; match = location.exec(line)) {
      const path = line.slice(0, match.index);
      const lang = languageForPath(path);
      if (!lang) continue;
      const n = Number(match[2]);
      if (Number.isSafeInteger(n)) source = { path, lang, line: { n, text: line.slice(match.index + match[0].length), mark: match[1] === ":" } };
      break;
    }
    const previous = parts.at(-1);
    if (source) {
      hasSource = true;
      if (previous?.kind === "matches" && previous.path === source.path && previous.lines.at(-1).n < source.line.n) {
        previous.lines.push(source.line);
      } else parts.push({ kind: "matches", path: source.path, lang: source.lang, lines: [source.line] });
    } else if (previous?.kind === "plain") previous.lines.push(line);
    else parts.push({ kind: "plain", lines: [line] });
  }
  return hasSource ? parts : void 0;
}

// src/omp-skills.ts
function piSkillView(text3) {
  if (!text3.startsWith('<skill name="')) return;
  const match = /^<skill name="([^"\r\n]+)" location="([^"\r\n]+)">\n([\s\S]*?)\n<\/skill>(?:\n\n([\s\S]+))?$/.exec(text3);
  if (!match || match[0] !== text3 || !/^References are relative to [^\r\n]+\.\n\n/.test(match[3])) return;
  const args = match[4]?.trim() || void 0;
  return {
    role: "custom",
    customType: "skill-prompt",
    display: true,
    attribution: "user",
    timestamp: 0,
    content: text3,
    details: { name: match[1], path: match[2], args, lineCount: match[3].split("\n").length }
  };
}

// src/omp-transcript.ts
var PiToolCard = class extends ToolExecutionComponent {
  expanded = false;
  sourceArgs;
  sourceOutput;
  sourceError = false;
  sourceParts;
  sourceBody;
  projection;
  setSource(block, args) {
    const error = block.status === "error";
    if (this.sourceArgs === args && this.sourceOutput === block.output && this.sourceError === error) return;
    this.sourceArgs = args;
    this.sourceOutput = block.output;
    this.sourceError = error;
    this.sourceParts = toolSourceParts(block, args, getLanguageFromPath);
    this.sourceBody = void 0;
    this.projection = void 0;
  }
  describe(cx) {
    const original = super.describe(cx);
    if (!this.sourceParts || original.k !== "tool" || !original.c?.length || !cx?.supports("code")) return original;
    if (this.projection?.original === original) return this.projection.node;
    const body = this.sourceBody ??= this.sourceParts.flatMap((part, index) => {
      if (part.kind === "read") return [keyed(code(part.text, { lang: part.lang }), "source")];
      if (part.kind === "plain") return [keyed(ansi(part.lines.join("\n")), `notice-${index}`)];
      return [keyed(col([
        fileRow(part.path, { key: "file" }),
        ...numberedCode(part.lines, { lang: part.lang })
      ], { gap: "xs", role: "omp.tool.search.file" }), `source-${index}`)];
    });
    const node7 = { ...original, c: [...body, ...original.c.slice(1)] };
    this.projection = { original, node: node7 };
    return node7;
  }
  setExpanded(expanded) {
    this.expanded = expanded;
    super.setExpanded(expanded);
  }
};
var SharedCodeCell = class {
  constructor(source, path) {
    this.source = source;
    this.path = path;
  }
  expanded = false;
  native;
  nativeEpoch = -1;
  rows;
  rowsEpoch = -1;
  width = 0;
  update(source, path) {
    this.source = source;
    this.path = path;
    this.invalidate();
  }
  setExpanded(expanded) {
    if (this.expanded === expanded) return;
    this.expanded = expanded;
    this.invalidate();
  }
  handleNativeEvent(event) {
    const expanded = rootToggleExpanded(event);
    if (expanded !== void 0) this.setExpanded(expanded);
  }
  describe() {
    const epoch = getThemeEpoch();
    if (!this.native || this.nativeEpoch !== epoch) {
      this.native = describeCodeCell({
        code: this.source,
        language: this.path ? getLanguageFromPath(this.path) : void 0,
        title: this.path,
        expanded: this.expanded
      }, theme);
      this.nativeEpoch = epoch;
    }
    return this.native;
  }
  render(width) {
    const epoch = getThemeEpoch();
    if (!this.rows || this.width !== width || this.rowsEpoch !== epoch) {
      this.rows = renderCodeCell({
        code: this.source,
        language: this.path ? getLanguageFromPath(this.path) : void 0,
        title: this.path,
        expanded: this.expanded,
        width
      }, theme);
      this.width = width;
      this.rowsEpoch = epoch;
    }
    return this.rows;
  }
  invalidate() {
    this.native = void 0;
    this.rows = void 0;
  }
};
var SharedDiff = class {
  constructor(source, path) {
    this.source = source;
    this.path = path;
    this.update(source, path);
  }
  fallback = new Markdown("", 0, 0, getMarkdownTheme());
  terminal = new Text("", 0, 0);
  compact = false;
  native;
  ansiEpoch = -1;
  update(source, path) {
    this.source = source;
    this.path = path;
    this.native = void 0;
    this.ansiEpoch = -1;
    this.compact = /[+\- ]\s*\d+\|/.test(source) && source.split("\n").every((line) => /^[+\- ]\s*\d+\|/.test(line) || /^\s*(?:…|\.\.\.)?\s*$/.test(line));
    if (!this.compact) this.fallback.setText(fencedCode("diff", source));
  }
  describe(cx) {
    if (!this.compact) return this.fallback.describe(cx);
    this.native ??= nativeDiff(this.source, { filePath: this.path });
    return this.native;
  }
  render(width) {
    if (!this.compact) return this.fallback.render(width);
    const epoch = getThemeEpoch();
    if (this.ansiEpoch !== epoch) {
      this.terminal.setText(renderDiff(this.source, { theme }));
      this.ansiEpoch = epoch;
    }
    return this.terminal.render(width);
  }
  invalidate() {
    this.native = void 0;
    this.ansiEpoch = -1;
    this.fallback.invalidate();
    this.terminal.invalidate();
  }
  releaseRenderCaches() {
    this.fallback.releaseRenderCaches();
    this.terminal.releaseRenderCaches();
  }
};
function sameBlock(previous, next) {
  if (previous.kind !== next.kind) return false;
  if (previous.kind === "tool" && next.kind === "tool") {
    return previous.name === next.name && previous.args === next.args && previous.output === next.output && previous.status === next.status && previous.diff === next.diff && previous.details === next.details;
  }
  if (previous.kind === "image" && next.kind === "image") return previous.data === next.data && previous.mime === next.mime;
  return "text" in previous && "text" in next && previous.text === next.text && previous.path === next.path;
}
function toolArgs(source) {
  try {
    return JSON.parse(source);
  } catch {
    return source;
  }
}
var UNKNOWN_ASSISTANT_USAGE = Object.freeze({});
function isAssistantContent(block) {
  return block.kind === "text" || block.kind === "thinking" || block.kind === "image";
}
var PiAssistantMessage = class extends AssistantMessageComponent {
  constructor(ui, persistenceKey, expanded) {
    super(void 0, false, () => ui.requestRender(), void 0, ui.imageBudget, false, void 0, expanded);
    this.persistenceKey = persistenceKey;
    this.setMidStreamPublication(false);
  }
  seen = 0;
  snapshots = [];
  content = [];
  view = {
    role: "assistant",
    content: this.content,
    usage: UNKNOWN_ASSISTANT_USAGE
  };
  metadataKey = "";
  live = false;
  messagePersistenceKey() {
    return this.persistenceKey;
  }
  sync(message, start, end, live, finalized) {
    const blocks = message.blocks;
    const count = end - start;
    const metadataKey = JSON.stringify([message.usage, message.model, message.provider]);
    let changed = this.snapshots.length !== count || this.metadataKey !== metadataKey;
    if (this.metadataKey !== metadataKey) {
      this.metadataKey = metadataKey;
      this.view.usage = message.usage ?? UNKNOWN_ASSISTANT_USAGE;
      this.view.model = message.model;
      this.view.provider = message.provider;
    }
    for (let index = 0; index < count; index++) {
      const block = blocks[start + index];
      const previous = this.snapshots[index];
      if (previous && sameBlock(previous, block)) continue;
      this.snapshots[index] = { ...block };
      this.content[index] = block.kind === "image" ? { type: "image", data: block.data, mimeType: block.mime } : block.kind === "thinking" ? { type: "thinking", thinking: block.text } : { type: "text", text: block.text };
      changed = true;
    }
    this.snapshots.length = count;
    this.content.length = count;
    if (!changed && this.live === live && (!finalized || this.isTranscriptBlockFinalized())) return false;
    this.live = live;
    this.updateContent(this.view, { transient: live });
    if (finalized && !this.isTranscriptBlockFinalized()) this.markTranscriptBlockFinalized();
    return true;
  }
  setExpanded(expanded) {
    super.setExpanded(expanded);
    this.setExpandThinkingBlocks(expanded);
  }
};
var PiSkillCard = class extends SkillMessageComponent {
  expanded = false;
  hasArgs;
  projection;
  constructor(message) {
    super(message);
    this.hasArgs = Boolean(message.details?.args?.trim());
  }
  describe() {
    const original = super.describe();
    if (!this.hasArgs || this.expanded || original.k !== "card") return original;
    if (this.projection?.original === original) return this.projection.node;
    const node7 = { ...original, p: { ...original.p, preview: { lines: 3 } } };
    this.projection = { original, node: node7 };
    return node7;
  }
  setExpanded(expanded) {
    this.expanded = expanded;
    super.setExpanded(expanded);
  }
};
var PiBlock = class extends Container {
  constructor(ui, cwd, role, imageKey, expanded) {
    super();
    this.ui = ui;
    this.cwd = cwd;
    this.role = role;
    this.imageKey = imageKey;
    this.expanded = expanded;
  }
  seen = 0;
  snapshot;
  markdown;
  thinking;
  code;
  tool;
  skill;
  toolInput;
  diff;
  live = false;
  expanded = false;
  imageRevision = 0;
  currentImageKey;
  sync(block, live) {
    const previous = this.snapshot;
    const changed = !previous || !sameBlock(previous, block);
    if (!changed && this.live === live) return false;
    const reconstruct = !previous || previous.kind !== block.kind || previous.kind === "tool" && block.kind === "tool" && (previous.name !== block.name || previous.status === "interrupted" && block.status !== "interrupted");
    if (reconstruct) {
      this.expanded = this.tool?.expanded ?? this.thinking?.expanded ?? this.skill?.expanded ?? this.expanded;
      if (this.currentImageKey) {
        this.ui.imageBudget.release(this.currentImageKey);
        this.currentImageKey = void 0;
      }
      this.disposeChildren();
      this.markdown = void 0;
      this.thinking = void 0;
      this.code = void 0;
      this.tool = void 0;
      this.skill = void 0;
      this.diff = void 0;
    }
    if (block.kind === "tool") this.syncTool(block, previous?.kind === "tool" ? previous : void 0);
    else if (block.kind === "image") {
      if (changed) {
        this.disposeChildren();
        if (this.currentImageKey) this.ui.imageBudget.release(this.currentImageKey);
        this.currentImageKey = `${this.imageKey}:${++this.imageRevision}`;
        this.addChild(new Image(block.data, block.mime, { fallbackColor: (text3) => theme.fg("dim", text3) }, {
          imageKey: this.currentImageKey,
          budget: this.ui.imageBudget,
          requestRender: () => this.ui.requestRender()
        }));
      }
    } else if (block.kind === "code") {
      if (!this.code) {
        this.code = new SharedCodeCell(block.text, block.path);
        this.code.setExpanded(this.expanded);
        this.addChild(this.code);
      } else if (changed) this.code.update(block.text, block.path);
    } else if (block.kind === "diff") {
      if (!this.diff) {
        this.diff = new SharedDiff(block.text, block.path);
        this.addChild(this.diff);
      } else if (changed) this.diff.update(block.text, block.path);
    } else if (block.kind === "thinking") {
      if (!this.markdown) {
        this.markdown = new Markdown(block.text, 1, 0, getMarkdownTheme());
        const body = this.markdown;
        this.thinking = new Disclosure({ summary: new Text("Thinking", 0, 0), body: () => body, expanded: this.expanded });
        this.addChild(this.thinking);
      } else if (changed) this.markdown.setText(block.text);
      this.markdown.transientRenderCache = live;
    } else if (this.role === "user") {
      if (changed) {
        this.expanded = this.skill?.expanded ?? this.expanded;
        this.disposeChildren();
        const skill = piSkillView(block.text);
        this.skill = skill ? new PiSkillCard(skill) : void 0;
        this.skill?.setExpanded(this.expanded);
        this.addChild(this.skill ?? new UserMessageComponent(block.text));
      }
    } else {
      if (!this.markdown) {
        this.markdown = new Markdown(block.text, 1, 0, getMarkdownTheme());
        this.addChild(this.markdown);
      } else if (changed) this.markdown.setText(block.text);
      this.markdown.transientRenderCache = live;
    }
    if (changed) this.snapshot = { ...block };
    this.live = live;
    return true;
  }
  syncTool(block, previous) {
    if (!this.tool || block.args !== previous?.args) this.toolInput = toolArgs(block.args);
    if (!this.tool) {
      this.tool = new PiToolCard(
        block.name,
        this.toolInput,
        { useBuiltInRenderer: false },
        void 0,
        this.ui,
        this.cwd,
        block.id
      );
      this.tool.setExpanded(this.expanded);
      this.addChild(this.tool);
    } else if (block.args !== previous?.args) this.tool.updateArgs(this.toolInput, block.id);
    this.tool.setSource(block, this.toolInput);
    if (!previous || previous.output !== block.output || previous.status !== block.status || previous.details !== block.details || !this.snapshot || previous.name !== block.name || previous.status === "interrupted" && block.status !== "interrupted") {
      this.tool.updateResult(
        { content: [{ type: "text", text: block.output }], details: block.details, isError: block.status === "error" },
        block.status === "running" || block.status === "interrupted",
        block.id
      );
      if (block.status === "interrupted") this.tool.seal();
    }
    if (block.diff !== void 0) {
      if (!this.diff) {
        this.diff = new SharedDiff(block.diff);
        this.addChild(this.diff);
      } else if (block.diff !== previous?.diff) this.diff.update(block.diff);
    } else if (this.diff) {
      this.removeChild(this.diff);
      this.diff = void 0;
    }
  }
  setExpanded(expanded) {
    this.expanded = expanded;
    this.tool?.setExpanded(expanded);
    this.thinking?.setExpanded(expanded);
    this.code?.setExpanded(expanded);
    this.skill?.setExpanded(expanded);
  }
  dispose() {
    if (this.currentImageKey) {
      this.ui.imageBudget.release(this.currentImageKey);
      this.currentImageKey = void 0;
    }
    super.dispose();
  }
};
var PiTranscript = class {
  constructor(ui, cwd) {
    this.ui = ui;
    this.cwd = cwd;
    ensureThemeSync();
  }
  container = new TranscriptContainer();
  messages = /* @__PURE__ */ new Map();
  sessionId;
  generation = 0;
  epoch = 0;
  expanded = false;
  disposed = false;
  sync(state, pending) {
    if (this.disposed) return;
    const sessionId = state.session?.id ?? null;
    if (this.sessionId !== sessionId) {
      this.clear();
      this.sessionId = sessionId;
      this.generation++;
      this.ui.requestRender();
    }
    const epoch = ++this.epoch;
    let messageIndex = 0;
    let order;
    const last = state.messages.at(-1);
    for (const message of state.messages) {
      let entry = this.messages.get(message.id);
      if (entry && entry.role !== message.role) {
        entry.container.dispose();
        this.messages.delete(message.id);
        entry = void 0;
      }
      if (!entry) {
        entry = { role: message.role, container: new Container(), blocks: /* @__PURE__ */ new Map(), seen: epoch };
        this.messages.set(message.id, entry);
      }
      entry.seen = epoch;
      const live = state.needsInterrupt && message === last && message.streaming === true;
      let blockIndex = 0;
      let blockOrder;
      for (let sourceIndex = 0; sourceIndex < message.blocks.length; ) {
        const block = message.blocks[sourceIndex];
        const assistant = message.role === "assistant" && isAssistantContent(block);
        const key = assistant ? `assistant:${sourceIndex === 0 ? "" : message.blocks[sourceIndex - 1].id}` : `block:${block.id}`;
        let component = entry.blocks.get(key);
        let changed;
        if (assistant) {
          const start = sourceIndex++;
          while (sourceIndex < message.blocks.length && isAssistantContent(message.blocks[sourceIndex])) sourceIndex++;
          if (!(component instanceof PiAssistantMessage)) {
            component?.dispose();
            component = new PiAssistantMessage(this.ui, JSON.stringify([sessionId, message.id, key]), this.expanded);
            entry.blocks.set(key, component);
          }
          changed = component.sync(
            message,
            start,
            sourceIndex,
            live && sourceIndex === message.blocks.length,
            message.streaming === void 0 || sourceIndex < message.blocks.length
          );
        } else {
          sourceIndex++;
          if (!(component instanceof PiBlock)) {
            component?.dispose();
            component = new PiBlock(
              this.ui,
              state.session?.cwd || this.cwd,
              message.role,
              JSON.stringify([this.generation, sessionId, message.id, block.id]),
              this.expanded
            );
            entry.blocks.set(key, component);
          }
          changed = component.sync(block, live);
        }
        component.seen = epoch;
        if (changed) this.ui.requestComponentRender(component);
        if (!blockOrder && entry.container.children[blockIndex] !== component) blockOrder = entry.container.children.slice(0, blockIndex);
        blockOrder?.push(component);
        blockIndex++;
      }
      for (const [id, component] of entry.blocks) {
        if (component.seen !== epoch) {
          component.dispose();
          entry.blocks.delete(id);
        }
      }
      if (blockOrder || entry.container.children.length !== blockIndex) {
        entry.container.children = blockOrder ?? entry.container.children.slice(0, blockIndex);
        this.ui.requestComponentRender(entry.container);
      }
      if (!order && this.container.children[messageIndex] !== entry.container) order = this.container.children.slice(0, messageIndex);
      order?.push(entry.container);
      messageIndex++;
    }
    for (const [id, entry] of this.messages) {
      if (entry.seen !== epoch) {
        entry.container.dispose();
        this.messages.delete(id);
      }
    }
    if (pending) {
      if (!order && this.container.children[messageIndex] !== pending) order = this.container.children.slice(0, messageIndex);
      order?.push(pending);
      messageIndex++;
    }
    if (order || this.container.children.length !== messageIndex) {
      this.container.children = order ?? this.container.children.slice(0, messageIndex);
      this.ui.requestRender();
    }
  }
  setExpanded(expanded) {
    if (this.disposed) return;
    this.expanded = expanded;
    for (const entry of this.messages.values()) for (const component of entry.blocks.values()) component.setExpanded(expanded);
    this.ui.requestRender();
  }
  clear() {
    for (const entry of this.messages.values()) entry.container.dispose();
    this.messages.clear();
    this.container.clear();
  }
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.clear();
  }
};

// src/omp-dialogs.ts
import { ApprovalDialogComponent } from "@oh-my-pi/pi-tui/overlays/approval-dialog";
import { HookEditorComponent } from "@oh-my-pi/pi-tui/overlays/hook-editor";
import { HookSelectorComponent } from "@oh-my-pi/pi-tui/overlays/hook-selector";
import { SessionSelectorComponent } from "@oh-my-pi/pi-tui/overlays/session-selector";
import { Text as Text3 } from "@oh-my-pi/pi-tui/components/text";

// src/i18n.ts
var en = {
  identity: "Pi",
  untitled: "Untitled session",
  sessions: "Sessions",
  welcomeHint: "Enter a task or question to start a conversation.",
  welcomeCommands: "Commands",
  welcomeNewline: "New line",
  welcomeDetails: "Toggle details",
  welcomeStop: "Stop task",
  model: "Model",
  reasoning: "Thinking",
  default: "Default",
  send: "Send",
  stop: "Stop",
  imagePathInvalid: "Cannot read this local image. Check the file path and permissions.",
  imageInvalid: "Paste a valid JPEG, PNG, GIF or WebP image.",
  imageTooLarge: "This image exceeds the 20 MiB attachment limit.",
  imageClipboardFailed: "Cannot read the clipboard. Copy the image again, then paste it into the message.",
  imageUnsupportedModel: "This Pi model does not support images. Choose an image-capable model or remove the images.",
  imageEmptyDraft: "Enter a message or paste an image before sending.",
  context: "Context",
  contextLoading: "Loading context usage\u2026",
  contextFailed: "Context usage is unavailable. Check the Pi CLI connection, then retry.",
  contextUnavailable: "Pi has not reported a context estimate. After compaction, it may remain unavailable until the next model response.",
  contextAggregate: "Reported context estimate",
  contextCapacity: "Model context window",
  contextPolicy: "Pi reports aggregate usage, not a category breakdown or compaction threshold.",
  autoCompaction: "Automatic compaction",
  enabled: "Enabled",
  disabled: "Disabled",
  retry: "Retry",
  tasks: "Tasks",
  working: "Working\u2026",
  workingThinking: "Thinking\u2026",
  workingCompaction: "Compacting context\u2026",
  workingRetry: "Retrying\u2026",
  user: "You",
  close: "Close",
  cancel: "Cancel",
  loading: "Loading sessions\u2026",
  rename: "Rename session",
  renameHint: "Session title",
  compact: "Compact context",
  fork: "Fork from a user message",
  reconnect: "Reconnect session",
  reconnectHint: "Reconnect only; your message will not be sent again.",
  unknown: "Not reported",
  language: "Language"
};
var zh = {
  identity: "Pi",
  untitled: "\u672A\u547D\u540D\u4F1A\u8BDD",
  sessions: "\u4F1A\u8BDD",
  welcomeHint: "\u8F93\u5165\u4EFB\u52A1\u6216\u95EE\u9898\uFF0C\u5F00\u59CB\u5BF9\u8BDD\u3002",
  welcomeCommands: "\u547D\u4EE4\u83DC\u5355",
  welcomeNewline: "\u6362\u884C",
  welcomeDetails: "\u5C55\u5F00/\u6536\u8D77\u8BE6\u60C5",
  welcomeStop: "\u505C\u6B62\u4EFB\u52A1",
  model: "\u6A21\u578B",
  reasoning: "\u601D\u8003\u5F3A\u5EA6",
  default: "\u9ED8\u8BA4",
  send: "\u53D1\u9001",
  stop: "\u505C\u6B62",
  imagePathInvalid: "\u65E0\u6CD5\u8BFB\u53D6\u672C\u5730\u56FE\u7247\uFF0C\u8BF7\u68C0\u67E5\u6587\u4EF6\u8DEF\u5F84\u548C\u8BFB\u53D6\u6743\u9650\u3002",
  imageInvalid: "\u8BF7\u7C98\u8D34\u6709\u6548\u7684 JPEG\u3001PNG\u3001GIF \u6216 WebP \u56FE\u7247\u3002",
  imageTooLarge: "\u56FE\u7247\u8D85\u8FC7 20 MiB \u9644\u4EF6\u4E0A\u9650\u3002",
  imageClipboardFailed: "\u65E0\u6CD5\u8BFB\u53D6\u526A\u8D34\u677F\uFF0C\u8BF7\u91CD\u65B0\u590D\u5236\u56FE\u7247\u540E\u7C98\u8D34\u5230\u8F93\u5165\u6846\u3002",
  imageUnsupportedModel: "\u5F53\u524D Pi \u6A21\u578B\u4E0D\u652F\u6301\u56FE\u7247\uFF0C\u8BF7\u9009\u62E9\u652F\u6301\u56FE\u7247\u7684\u6A21\u578B\uFF0C\u6216\u79FB\u9664\u56FE\u7247\u540E\u53D1\u9001\u3002",
  imageEmptyDraft: "\u8BF7\u8F93\u5165\u6D88\u606F\u6216\u7C98\u8D34\u56FE\u7247\u540E\u518D\u53D1\u9001\u3002",
  context: "\u4E0A\u4E0B\u6587",
  contextLoading: "\u6B63\u5728\u8BFB\u53D6\u4E0A\u4E0B\u6587\u7528\u91CF\u2026",
  contextFailed: "\u6682\u65F6\u65E0\u6CD5\u8BFB\u53D6\u4E0A\u4E0B\u6587\u7528\u91CF\uFF0C\u8BF7\u68C0\u67E5 Pi CLI \u8FDE\u63A5\u540E\u91CD\u8BD5\u3002",
  contextUnavailable: "Pi \u5C1A\u672A\u63D0\u4F9B\u4E0A\u4E0B\u6587\u4F30\u7B97\u3002\u538B\u7F29\u540E\uFF0C\u53EF\u80FD\u9700\u8981\u7B49\u4E0B\u4E00\u6B21\u6A21\u578B\u56DE\u590D\u624D\u80FD\u91CD\u65B0\u83B7\u53D6\u3002",
  contextAggregate: "\u5DF2\u62A5\u544A\u7684\u4E0A\u4E0B\u6587\u4F30\u7B97",
  contextCapacity: "\u6A21\u578B\u4E0A\u4E0B\u6587\u5BB9\u91CF",
  contextPolicy: "Pi \u4EC5\u63D0\u4F9B\u603B\u7528\u91CF\uFF0C\u4E0D\u63D0\u4F9B\u5206\u7C7B\u660E\u7EC6\u6216\u538B\u7F29\u9608\u503C\u3002",
  autoCompaction: "\u81EA\u52A8\u538B\u7F29",
  enabled: "\u5DF2\u5F00\u542F",
  disabled: "\u5DF2\u5173\u95ED",
  retry: "\u91CD\u8BD5",
  tasks: "\u4EFB\u52A1",
  working: "\u6B63\u5728\u5904\u7406\u2026",
  workingThinking: "\u601D\u8003\u4E2D\u2026",
  workingCompaction: "\u6B63\u5728\u538B\u7F29\u4E0A\u4E0B\u6587\u2026",
  workingRetry: "\u6B63\u5728\u91CD\u8BD5\u2026",
  user: "\u4F60",
  close: "\u5173\u95ED",
  cancel: "\u53D6\u6D88",
  loading: "\u6B63\u5728\u52A0\u8F7D\u4F1A\u8BDD\u2026",
  rename: "\u91CD\u547D\u540D\u4F1A\u8BDD",
  renameHint: "\u4F1A\u8BDD\u540D\u79F0",
  compact: "\u538B\u7F29\u4E0A\u4E0B\u6587",
  fork: "\u4ECE\u7528\u6237\u6D88\u606F\u5206\u53C9",
  reconnect: "\u91CD\u65B0\u8FDE\u63A5\u4F1A\u8BDD",
  reconnectHint: "\u53EA\u91CD\u65B0\u8FDE\u63A5\uFF0C\u4E0D\u4F1A\u518D\u6B21\u53D1\u9001\u4F60\u7684\u6D88\u606F\u3002",
  unknown: "\u672A\u63D0\u4F9B",
  language: "\u8BED\u8A00"
};
function dictionary(locale) {
  return locale === "zh-CN" ? zh : en;
}

// src/omp-context.ts
import { Text as Text2 } from "@oh-my-pi/pi-tui/components/text";
import { ReportPanel } from "@oh-my-pi/pi-tui/overlays/report-panel";
import { actionBar, actionButton } from "@oh-my-pi/pi-tui/native/overlay";
import { col as col2, node, text } from "@oh-my-pi/pi-tui/native/describe";
var PiContextView = class extends Text2 {
  native;
  constructor(details, locale) {
    const t = dictionary(locale);
    const count = (value) => value.toLocaleString(locale);
    const estimate = details.used === null ? t.unknown : count(details.used);
    const capacity = details.limit > 0 ? count(details.limit) : t.unknown;
    const percentage = details.percent === null ? t.unknown : `${new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(details.percent)}%`;
    const policy = details.autoCompactionEnabled === void 0 ? t.unknown : details.autoCompactionEnabled ? t.enabled : t.disabled;
    const lines = [
      `${t.contextAggregate}: ${estimate} (${percentage})`,
      `${t.contextCapacity}: ${capacity}`,
      `${t.autoCompaction}: ${policy}`,
      ...details.used === null ? [t.contextUnavailable] : [],
      t.contextPolicy
    ];
    super(lines.join("\n"), 0, 0);
    this.native = col2([
      node("meter", {
        role: "pi.context.aggregate",
        style: "bar",
        aria: t.context,
        value: details.percent === null ? null : Math.max(0, Math.min(1, details.percent / 100)),
        label: percentage
      }),
      ...lines.map((line) => text(line))
    ], { gap: "md" });
  }
  describe() {
    return this.native;
  }
};
var PiContextLoading = class extends Text2 {
  native;
  constructor(locale) {
    const label = dictionary(locale).contextLoading;
    super(label, 0, 0);
    this.native = node("row", { gap: "sm", align: "center" }, [node("spinner", {}), text(label)]);
  }
  describe() {
    return this.native;
  }
};
var PiContextReport = class extends ReportPanel {
  constructor(title, body, locale, close, retry) {
    super({ title, body, closeKey: "Esc", onClose: close });
    this.locale = locale;
    this.retry = retry;
    this.holdFocus();
  }
  projected;
  describe() {
    const original = super.describe();
    if (this.projected?.original === original) return this.projected.node;
    const t = dictionary(this.locale);
    const projected = { ...original, c: [
      original.c[0],
      actionBar([
        ...this.retry ? [actionButton(t.retry, "context.retry")] : [],
        null,
        actionButton(t.close, "close", { keys: "escape" })
      ])
    ] };
    this.projected = { original, node: projected };
    return projected;
  }
  handleNativeEvent(event) {
    if (event.type === "action" && event.act === "context.retry") this.retry?.();
    else super.handleNativeEvent(event);
  }
};

// src/omp-dialogs.ts
var PiModalSelector = class extends HookSelectorComponent {
  nativeSheet(cx) {
    return cx.supports("picker");
  }
};
var PiSessionSelector = class extends SessionSelectorComponent {
  loadingMessage;
  describe(cx) {
    const original = super.describe(cx);
    return original.k === "picker" && this.loadingMessage ? { ...original, p: { ...original.p, state: "loading", message: this.loadingMessage } } : original;
  }
};
var PiDialogs = class {
  constructor(composer, backend, options) {
    this.composer = composer;
    this.backend = backend;
    this.options = options;
  }
  modal;
  prompt;
  disposed = false;
  async sessions() {
    this.syncPrompts();
    await this.showModal((controls) => {
      const t = dictionary(this.options.locale());
      let opening = false;
      const close = () => controls.finish(void 0);
      const entries = (items) => items.map((item) => ({
        path: item.path,
        id: item.id,
        cwd: item.cwd,
        title: item.title,
        modified: new Date(item.modifiedTime),
        size: item.size,
        firstMessage: "",
        allMessagesText: ""
      }));
      const picker = (items, loading = false) => {
        const component = new PiSessionSelector(items, (session) => {
          if (!controls.active() || opening || loading) return;
          opening = true;
          component.lockInput();
          void this.options.openSession(session.path).then(() => {
            if (controls.active()) close();
          }).catch((error) => {
            if (!controls.active()) return;
            opening = false;
            component.unlockInput();
            this.options.onError(error);
            this.options.onChange();
          });
        }, close, close, {
          title: loading ? t.loading : t.sessions,
          showCwd: false,
          currentSessionPath: () => this.backend.state.session?.file,
          getTerminalRows: () => this.composer.ui.terminal.rows,
          ...loading ? {} : { loadAllSessions: async () => {
            const all = await this.backend.sessions(true);
            if (!controls.active()) throw new Error("Session selector was closed.");
            return entries(all);
          } }
        });
        component.loadingMessage = loading ? t.loading : void 0;
        component.getSessionList().onDeleteRequest = void 0;
        component.setOnRequestRender(() => {
          if (controls.active()) this.options.onChange();
        });
        return component;
      };
      const load = async () => {
        try {
          const items = await this.backend.sessions(false);
          if (controls.active()) controls.replace(picker(entries(items)));
        } catch (error) {
          if (!controls.active()) return;
          this.options.onError(error);
          controls.replace(new PiModalSelector(t.sessions, [t.retry, t.cancel], (selected) => {
            if (!controls.active()) return;
            if (selected !== t.retry) {
              close();
              return;
            }
            controls.replace(picker([], true));
            void load();
          }, close, { tui: this.composer.ui }));
        }
      };
      queueMicrotask(() => {
        if (controls.active()) void load();
      });
      return picker([], true);
    });
  }
  async context() {
    this.syncPrompts();
    const sessionId = this.backend.state.session?.id ?? null;
    await this.showModal((controls) => {
      const locale = this.options.locale();
      const t = dictionary(locale);
      const close = () => controls.finish(void 0);
      const loading = () => new PiContextReport(t.context, new PiContextLoading(locale), locale, close);
      let pending = false;
      const load = async () => {
        if (!controls.active() || pending) return;
        pending = true;
        try {
          const details = await this.backend.contextDetails();
          if (controls.active()) controls.replace(new PiContextReport(
            details.modelLabel ? `${t.context} \xB7 ${details.modelLabel}` : t.context,
            new PiContextView(details, locale),
            locale,
            close
          ));
        } catch {
          if (controls.active()) controls.replace(new PiContextReport(t.context, new Text3(t.contextFailed, 0, 0), locale, close, () => {
            if (!controls.active() || pending) return;
            controls.replace(loading());
            void load();
          }));
        } finally {
          pending = false;
        }
      };
      queueMicrotask(() => {
        if (controls.active()) void load();
      });
      return loading();
    }, sessionId);
  }
  async choose(title, choices) {
    this.syncPrompts();
    const offered = choices.map((choice) => ({ ...choice }));
    return this.showModal((controls) => {
      const rows = this.choiceRows(offered);
      return new PiModalSelector(title, rows, (label) => {
        if (!controls.active()) return;
        const choice = offered[rows.findIndex((row) => row.label === label)];
        if (choice && !choice.disabledReason) controls.finish(choice.value);
      }, () => controls.finish(void 0), {
        tui: this.composer.ui,
        disabledIndices: offered.flatMap((choice, index) => choice.disabledReason ? [index] : [])
      });
    }, this.backend.state.session?.id ?? null);
  }
  input(title, initial, detail) {
    this.syncPrompts();
    return this.showModal(
      (controls) => new HookEditorComponent(
        this.composer.ui,
        title,
        initial,
        (value) => {
          if (controls.active()) controls.finish(value);
        },
        () => controls.finish(void 0),
        { question: detail }
      ),
      this.backend.state.session?.id ?? null
    );
  }
  async confirm(title, detail) {
    this.syncPrompts();
    return await this.showModal((controls) => new ApprovalDialogComponent(`${title}
${detail}`, {
      onApprove: () => {
        if (controls.active()) controls.finish(true);
      },
      onDeny: () => controls.finish(false)
    }, { tui: this.composer.ui, fullPrompt: `${title}
${detail}` }), this.backend.state.session?.id ?? null) === true;
  }
  syncPrompts() {
    if (this.disposed) return void 0;
    const live = this.livePrompt();
    const sessionId = this.backend.state.session?.id;
    if (this.modal?.sessionId !== void 0 && this.modal.sessionId !== (sessionId ?? null)) this.modal.cancel();
    const signature = live ? JSON.stringify(live) : "";
    if (this.prompt && (!live || this.prompt.sessionId !== sessionId || this.prompt.signature !== signature)) {
      this.prompt.settled = true;
      this.prompt.component?.dispose?.();
      this.prompt = void 0;
    }
    if (!live) return void 0;
    if (this.modal) this.modal.cancel();
    if (!this.prompt) {
      const prompt = { source: live, sessionId, signature, settled: false, processing: false };
      this.prompt = prompt;
      this.mountPrompt(prompt);
    }
    return this.prompt.component;
  }
  hasOverlay() {
    return !!this.modal && !this.modal.handle.isHidden() && this.modalCurrent(this.modal);
  }
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.modal?.cancel();
    if (this.prompt) {
      this.prompt.settled = true;
      this.prompt.component?.dispose?.();
      this.prompt = void 0;
    }
  }
  livePrompt() {
    const state = this.backend.state;
    return ["question", "approval"].includes(state.phase) ? state.dialog ?? void 0 : void 0;
  }
  current(prompt) {
    const live = this.livePrompt();
    return !this.disposed && this.prompt === prompt && !prompt.settled && this.backend.state.session?.id === prompt.sessionId && live?.id === prompt.source.id && JSON.stringify(live) === prompt.signature && (live.deadline === void 0 || Date.now() < live.deadline);
  }
  modalCurrent(modal) {
    return !this.disposed && this.modal === modal && !this.livePrompt() && (modal.sessionId === void 0 || modal.sessionId === (this.backend.state.session?.id ?? null));
  }
  focus() {
    if (!this.disposed && !this.modal) this.composer.ui.setFocus(this.prompt?.component ?? this.composer.editor);
  }
  showModal(create, sessionId) {
    if (this.disposed || this.livePrompt()) return Promise.resolve(void 0);
    this.modal?.cancel();
    const { promise, resolve: resolve5 } = Promise.withResolvers();
    let modal;
    let closed = false;
    const finish = (value) => {
      if (closed) return;
      closed = true;
      const valid = this.modalCurrent(modal);
      if (this.modal === modal) this.modal = void 0;
      modal.handle.hide();
      modal.component.dispose?.();
      this.focus();
      resolve5(valid ? value : void 0);
      if (!this.disposed) this.options.onChange();
    };
    const component = create({
      finish,
      active: () => !closed && this.modalCurrent(modal),
      replace: (replacement) => {
        if (closed || !this.modalCurrent(modal)) {
          replacement.dispose?.();
          return;
        }
        modal.handle.hide();
        modal.component.dispose?.();
        modal.component = replacement;
        modal.handle = this.composer.ui.showOverlay(replacement, { width: "90%", maxHeight: "90%" });
        this.options.onChange();
      }
    });
    modal = {
      component,
      sessionId,
      cancel: () => finish(void 0),
      handle: this.composer.ui.showOverlay(component, { width: "90%", maxHeight: "90%" })
    };
    this.modal = modal;
    this.options.onChange();
    return promise;
  }
  choiceRows(choices) {
    const used = /* @__PURE__ */ new Set();
    return choices.map((choice) => {
      let label = choice.label;
      let suffix = 2;
      while (used.has(label)) label = `${choice.label} [${suffix++}]`;
      used.add(label);
      const description = [choice.description, choice.disabledReason].filter(Boolean).join("\n");
      return { label, ...description ? { description } : {} };
    });
  }
  mountPrompt(prompt) {
    const request = prompt.source;
    const cancel = () => {
      void this.settlePrompt(prompt, { cancelled: true });
    };
    if (request.method === "confirm") {
      prompt.component = new ApprovalDialogComponent([request.title, request.message].filter(Boolean).join("\n"), {
        onApprove: () => {
          void this.settlePrompt(prompt, { confirmed: true });
        },
        onDeny: () => {
          void this.settlePrompt(prompt, { confirmed: false });
        }
      }, { tui: this.composer.ui, fullPrompt: [request.title, request.message].filter(Boolean).join("\n") });
    } else if (request.method === "select") {
      const offered = [...request.options ?? []];
      prompt.component = new HookSelectorComponent(
        request.title,
        offered,
        (selected) => {
          if (offered.includes(selected)) void this.settlePrompt(prompt, { value: selected });
        },
        cancel,
        { tui: this.composer.ui, inline: true }
      );
    } else {
      prompt.component = new HookEditorComponent(
        this.composer.ui,
        request.title,
        request.prefill,
        (value) => {
          void this.settlePrompt(prompt, { value });
        },
        cancel,
        { question: request.message ?? request.placeholder, promptStyle: request.method === "input" }
      );
    }
    this.focus();
  }
  async settlePrompt(prompt, response) {
    if (!this.current(prompt) || prompt.processing) return;
    prompt.processing = true;
    try {
      await this.backend.resolveDialog(prompt.source.id, response);
      prompt.settled = true;
    } catch (error) {
      if (this.current(prompt)) this.options.onError(error);
    } finally {
      prompt.processing = false;
      if (!this.disposed) this.options.onChange();
    }
  }
};

// src/omp-todos.ts
import { Text as Text4 } from "@oh-my-pi/pi-tui/components/text";
import { EMPTY_NODE, node as node2, stableKey } from "@oh-my-pi/pi-tui/native/describe";
import { todoChecklistPhases } from "@oh-my-pi/pi-tui/tools/todo";

// src/pi-todos.ts
function parsePiTodos(details) {
  const todos = record(details).todos;
  if (!Array.isArray(todos)) return void 0;
  const result = [];
  for (const entry of todos) {
    const item = record(entry);
    if (typeof item.content !== "string" || !item.content.trim() || item.status !== "pending" && item.status !== "in_progress" && item.status !== "completed") return void 0;
    result.push({ content: item.content, status: item.status });
  }
  return result;
}
function latestPiTodo(messages) {
  for (let m = messages.length - 1; m >= 0; m--) {
    const message = messages[m];
    if (message.role !== "assistant") continue;
    for (let b = message.blocks.length - 1; b >= 0; b--) {
      const block = message.blocks[b];
      if (block.kind === "tool" && block.status === "done" && block.resultReceived && parsePiTodos(block.details) !== void 0) return block;
    }
  }
  return void 0;
}

// src/omp-todos.ts
var PiTodoHud = class extends Text4 {
  native = EMPTY_NODE;
  source;
  locale;
  sessionId;
  constructor() {
    super("", 0, 0);
  }
  sync(state, locale) {
    const sessionId = state.session?.id ?? null;
    const source = sessionId ? latestPiTodo(state.messages)?.details : void 0;
    if (this.source === source && this.locale === locale && this.sessionId === sessionId) return;
    this.source = source;
    this.locale = locale;
    this.sessionId = sessionId;
    const tasks = source === void 0 ? void 0 : parsePiTodos(source);
    this.native = tasks?.length ? node2("checklist", {
      mode: "hud",
      role: "omp.todo.hud",
      phases: todoChecklistPhases([{ name: dictionary(locale).tasks, tasks }])
    }, void 0, stableKey(sessionId)) : EMPTY_NODE;
    this.setText(tasks?.map((task) => `${task.status === "completed" ? "[x]" : task.status === "in_progress" ? "[>]" : "[ ]"} ${task.content}`).join("\n") ?? "");
  }
  hasTasks() {
    return this.native !== EMPTY_NODE;
  }
  describe() {
    return this.native;
  }
};

// src/omp-working.ts
import { Text as Text5 } from "@oh-my-pi/pi-tui/components/text";
import { describeWorkingRow } from "@oh-my-pi/pi-tui/components/loader";
import { col as col3, node as node3, EMPTY_NODE as EMPTY_NODE2 } from "@oh-my-pi/pi-tui/native/describe";

// src/work-state.ts
var IDLE = Object.freeze({ active: false });
function isPiWorking(state) {
  return state.session !== null && (state.phase === "running" || state.phase === "stopping");
}
var PiWorkTracker = class {
  sessionId;
  startedAt;
  lastTool;
  lastArgs;
  lastName;
  toolStep;
  snapshot = IDLE;
  sync(state, now = Date.now()) {
    const sessionId = state.session?.id ?? null;
    if (sessionId !== this.sessionId || !["running", "stopping", "approval", "question"].includes(state.phase)) {
      this.sessionId = sessionId;
      this.startedAt = void 0;
      this.lastTool = void 0;
      this.lastArgs = void 0;
      this.lastName = void 0;
      this.toolStep = void 0;
    }
    if (!isPiWorking(state)) return this.snapshot = IDLE;
    this.startedAt ??= now;
    let tool;
    let latest;
    let thinking = false;
    let liveReply = false;
    for (let m = state.messages.length - 1; m >= 0; m--) {
      const message = state.messages[m];
      if (message.role === "user") break;
      if (message.role !== "assistant") continue;
      if (!latest) {
        latest = message.blocks.at(-1);
        thinking = message.streaming === true && latest?.kind === "thinking";
        liveReply = message.streaming !== void 0 && latest?.kind === "text";
      }
      for (let b = message.blocks.length - 1; b >= 0; b--) {
        const block = message.blocks[b];
        if (block.kind === "tool" && block.status === "running" && !block.resultReceived) {
          tool = block;
          break;
        }
      }
      if (tool) break;
    }
    if (tool && (tool !== this.lastTool || tool.args !== this.lastArgs || tool.name !== this.lastName)) {
      this.lastTool = tool;
      this.lastArgs = tool.args;
      this.lastName = tool.name;
      let summary;
      try {
        const args = record(JSON.parse(tool.args));
        summary = args.summary ?? (tool.name === "bash" ? args.command : tool.name === "grep" ? args.pattern : args.path);
      } catch {
      }
      this.toolStep = typeof summary === "string" && summary.trim() ? `${tool.name} \xB7 ${summary}` : tool.name;
    }
    const stage = state.phase === "stopping" ? "stopping" : state.workingState === "compacting_conversation" ? "compaction" : state.workingState === "retrying" ? "retry" : tool ? "tool" : thinking || state.workingState === "thinking" ? "thinking" : "response";
    const step = stage === "tool" ? this.toolStep : stage === "response" && liveReply && latest?.kind === "text" ? latest.text.trim().split(/\r?\n/, 1)[0] || void 0 : void 0;
    const previous = this.snapshot;
    if (previous.active && previous.startedAt === this.startedAt && previous.stage === stage && previous.step === step) return previous;
    return this.snapshot = { active: true, startedAt: this.startedAt, stage, ...step ? { step } : {} };
  }
};

// src/omp-working.ts
var PiWorkingHud = class extends Text5 {
  constructor(todos) {
    super("", 0, 0);
    this.todos = todos;
  }
  tracker = new PiWorkTracker();
  snapshot = { active: false };
  locale;
  label = "";
  native;
  sync(state, locale) {
    const snapshot = this.tracker.sync(state);
    if (snapshot === this.snapshot && locale === this.locale) return;
    this.snapshot = snapshot;
    this.locale = locale;
    this.native = void 0;
    const t = dictionary(locale);
    this.label = !snapshot.active ? "" : snapshot.stage === "stopping" ? t.stop : snapshot.stage === "compaction" ? t.workingCompaction : snapshot.stage === "retry" ? t.workingRetry : snapshot.step ?? (snapshot.stage === "thinking" ? t.workingThinking : t.working);
    this.setText(this.label);
  }
  describe(cx) {
    if (!this.snapshot.active) return this.todos.hasTasks() ? node3("row", { role: "omp.hud", justify: "end", gap: "sm" }, [this.todos]) : EMPTY_NODE2;
    if (!this.native) {
      const original = describeWorkingRow({
        label: this.label,
        startedAt: this.snapshot.startedAt,
        ...this.snapshot.stage === "compaction" ? { variant: { kind: "compaction" } } : {}
      }, cx);
      const working = original.k === "row" ? { ...original, p: { ...original.p, grow: 1, basis: "content", min: { w: 0 } } } : original;
      this.native = col3([
        node3("row", { align: "center", gap: "sm", wrap: true }, [
          working,
          this.todos
        ])
      ], { role: "omp.hud.status" });
    }
    return this.native;
  }
};

// src/omp-welcome.ts
import { WelcomeComponent } from "@oh-my-pi/pi-tui/prompt/welcome";
import { Text as Text6 } from "@oh-my-pi/pi-tui/components/text";
import { text as text2 } from "@oh-my-pi/pi-tui/native/describe";
import { hintsRow } from "@oh-my-pi/pi-tui/native/overlay";
var PiWelcome = class extends WelcomeComponent {
  constructor(locale) {
    super("");
    this.locale = locale;
  }
  sessionTitle = "";
  fallback = new Text6("\u03C0  Pi", 0, 0);
  projected;
  get tip() {
    return dictionary(this.locale).welcomeHint;
  }
  sync(title, locale) {
    if (title === this.sessionTitle && locale === this.locale) return;
    this.sessionTitle = title;
    this.locale = locale;
    this.fallback.setText(title ? `Pi \xB7 ${title}` : "\u03C0  Pi");
    this.invalidate();
  }
  invalidate() {
    super.invalidate();
    this.projected = void 0;
  }
  render(width) {
    return this.fallback.render(width);
  }
  describe(cx) {
    const original = super.describe(cx);
    if (this.projected?.original === original) return this.projected.node;
    const project = (source) => {
      if (source.k === "row" && source.p?.role === "omp.welcome.lockup") return {
        ...source,
        p: { ...source.p, max: { w: 1 } },
        c: [text2("\u03C0  Pi", { role: "pi.welcome.wordmark" })]
      };
      if (source.k === "text" && source.p?.role === "omp.welcome.tip-text" && this.sessionTitle) return {
        ...source,
        p: { ...source.p, text: this.sessionTitle, spans: void 0 }
      };
      const children = source.c?.filter((child) => !this.sessionTitle || !("k" in child) || child.p?.role !== "omp.welcome.tip-icon").map((child) => "k" in child ? project(child) : child);
      return { ...source, ...children ? { c: children } : {} };
    };
    const t = dictionary(this.locale);
    const shortcuts = hintsRow([
      { keys: ["/"], label: t.welcomeCommands },
      { keys: ["enter"], label: t.send },
      { keys: ["shift+enter"], label: t.welcomeNewline },
      { keys: ["ctrl+o"], label: t.welcomeDetails },
      { keys: ["escape"], label: t.welcomeStop }
    ], "shortcuts");
    const welcome = project(original);
    const shortcutRow = shortcuts.k === "row" ? { ...shortcuts, p: { ...shortcuts.p, role: "pi.welcome.shortcuts" } } : shortcuts;
    const result = { ...welcome, c: [...welcome.c ?? [], shortcutRow] };
    this.projected = { original, node: result };
    return result;
  }
};

// src/omp-extension-text.ts
import { Text as Text7 } from "@oh-my-pi/pi-tui/components/text";
import { node as node4 } from "@oh-my-pi/pi-tui/native/describe";
var PiExtensionText = class extends Text7 {
  source;
  native;
  describe(cx) {
    const source = super.describe(cx);
    if (source !== this.source) {
      this.source = source;
      this.native = node4("col", { role: "omp.hud.status" }, [
        node4("col", { role: "pi.extension.text" }, [source])
      ]);
    }
    return this.native;
  }
};

// src/omp-images.ts
import { AsyncLocalStorage } from "node:async_hooks";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { homedir as homedir2 } from "node:os";
import { resolve as resolve3 } from "node:path";
import { fileURLToPath } from "node:url";
import { readImageFromClipboard, readTextFromClipboard } from "@oh-my-pi/pi-natives/clipboard";
import { parseImageMetadata } from "@oh-my-pi/pi-utils/mime";
import { imageDecodeFailureReason, MAX_IMAGE_INPUT_BYTES } from "@oh-my-pi/pi-tui/chat/image-loading";
import { chipLabel, compactImageMarkers, formatVisionMarker, PLACEHOLDER_REGEX } from "@oh-my-pi/pi-tui/prompt/composer-attachments";
import { extractImagePastePathsFromText, extractImagePathFromText } from "@oh-my-pi/pi-tui/prompt/custom-editor";
import { cachedImageDimensions, setCachedImageDimensions } from "@oh-my-pi/pi-tui/prompt/image-references";
import { tagImageAttachmentSource } from "@oh-my-pi/pi-tui/prompt/image-source";
var AttachmentError = class extends Error {
  constructor(key) {
    super(key);
    this.key = key;
  }
};
var PiImageComposer = class {
  constructor(editor, options) {
    this.editor = editor;
    this.options = options;
    this.#rawDraft = editor.getText();
    this.#originalChange = editor.onChange;
    this.#originalSubmit = editor.onSubmit;
    this.#originalPasteImage = editor.onPasteImage;
    this.#originalPastePath = editor.onPasteImagePath;
    this.#originalClearPasteState = editor.clearPasteState;
    this.#originalHandleInput = editor.handleInput;
    this.#originalHandleDraftEdit = editor.handleDraftEdit;
    editor.handleInput = this.#handleInput;
    editor.handleDraftEdit = this.#handleDraftEdit;
    editor.clearPasteState = this.#clearPasteState;
    editor.onChange = this.#change;
    editor.onSubmit = this.#submit;
    editor.onPasteImage = this.#pasteImage;
    editor.onPasteImagePath = this.#pastePath;
  }
  #submissions = /* @__PURE__ */ new WeakMap();
  #inputLifetime = new AsyncLocalStorage();
  #originalHandleInput;
  #originalHandleDraftEdit;
  #originalChange;
  #originalSubmit;
  #originalPasteImage;
  #originalPastePath;
  #originalClearPasteState;
  #rawDraft;
  #restoringDraft;
  #generation = 0;
  #disposed = false;
  #transition;
  #pendingAttachments = 0;
  #lifetime() {
    return { generation: this.#generation, session: this.options.currentSession(), cwd: this.options.cwd(), transition: this.#transition };
  }
  #alive(lifetime) {
    const transition = lifetime.transition;
    return !this.#disposed && lifetime.generation === this.#generation && (transition?.active || (transition ? transition.session : lifetime.session) === this.options.currentSession() && (transition ? transition.cwd : lifetime.cwd) === this.options.cwd());
  }
  #report(error, fallback) {
    this.options.onError(new Error(dictionary(this.options.locale())[error instanceof AttachmentError ? error.key : fallback]));
  }
  // Editor.#submitValue empties its buffer, calls this public hook, then emits
  // onChange/onSubmit. Defer only that clearing so the original private paste
  // table and atom expansions survive; rebuilding from expanded text loses chips.
  #clearPasteState = () => {
    if (!this.#disposed && this.#rawDraft !== "" && this.editor.getText() === "") {
      this.#restoringDraft = this.#rawDraft;
      return;
    }
    this.#originalClearPasteState.call(this.editor);
  };
  #change = (text3) => {
    if (this.#restoringDraft !== void 0 && text3 === "") return;
    this.#rawDraft = text3;
    this.#originalChange?.(text3);
    this.options.onChange();
  };
  #submit = (text3) => {
    const submission = this.captureSubmission(text3);
    this.options.onSubmit(submission);
  };
  // The native multi-path router awaits each load before calling the next hook.
  // Its complete async chain must retain the originating session, not re-sample
  // the newly opened session halfway through a dropped group of files.
  #handleInput = (data) => {
    this.#inputLifetime.run(this.#lifetime(), () => this.#originalHandleInput.call(this.editor, data));
  };
  #handleDraftEdit = (data) => {
    this.#inputLifetime.run(this.#lifetime(), () => this.#originalHandleDraftEdit.call(this.editor, data));
  };
  #pastePath = (path) => this.#loadPath(path, this.#inputLifetime.getStore() ?? this.#lifetime());
  #pasteImage = () => this.pasteClipboard();
  /** Called synchronously from omp's onSubmit; restores the untouched chip draft. */
  captureSubmission(message) {
    const rawDraft = this.#restoringDraft;
    this.#restoringDraft = void 0;
    if (rawDraft !== void 0) this.editor.setText(rawDraft);
    const compacted = compactImageMarkers(message, this.editor.pendingImages.length, { byAppearance: true });
    const retained = compacted ? compacted.keep.map((index) => this.editor.pendingImages[index]) : this.editor.pendingImages;
    const expanded = compacted?.text ?? message;
    const text3 = expanded.replace(PLACEHOLDER_REGEX, (marker, kind, index) => kind === "Image" && Number(index) <= retained.length ? "" : marker).trim();
    const images = Object.freeze(retained.map((image) => {
      if (!image || !isInputMime(image.mimeType)) throw new AttachmentError("imageInvalid");
      return Object.freeze({ data: image.data, mimeType: image.mimeType });
    }));
    const submission = Object.freeze({ text: text3, images });
    this.#submissions.set(submission, {
      ...this.#lifetime(),
      revision: this.editor.textRevision,
      atomsRevision: this.editor.atomsRevision,
      images: [...this.editor.pendingImages],
      historyText: this.editor.getExpandedText()
    });
    return submission;
  }
  /** Clear immediately, retaining the complete native draft in local ↑ navigation. */
  stage(submission) {
    const state = this.#submissions.get(submission);
    if (!state || state.staged || !this.#alive(state) || state.revision !== this.editor.textRevision || state.atomsRevision !== this.editor.atomsRevision) return false;
    this.editor.clearDraftForRecall();
    state.staged = { revision: this.editor.textRevision, atomsRevision: this.editor.atomsRevision };
    this.options.onChange();
    return true;
  }
  /** Restore only an untouched composer; newer input keeps the original in local recall. */
  restore(submission) {
    const state = this.#submissions.get(submission);
    this.#submissions.delete(submission);
    if (!state?.staged || !this.#alive(state) || this.#pendingAttachments !== 0 || state.staged.revision !== this.editor.textRevision || state.staged.atomsRevision !== this.editor.atomsRevision) return false;
    this.editor.setDraft(state.historyText, state.images);
    this.options.onChange();
    return true;
  }
  /** Acceptance commits this submission, never clearing a newer draft. */
  accept(submission) {
    const state = this.#submissions.get(submission);
    this.#submissions.delete(submission);
    if (!state || !this.#alive(state)) return false;
    if (state.staged) return true;
    if (state.revision !== this.editor.textRevision || state.atomsRevision !== this.editor.atomsRevision || state.images.length !== this.editor.pendingImages.length || state.images.some((image, index) => image !== this.editor.pendingImages[index])) {
      this.editor.addToHistory(state.historyText);
      return false;
    }
    this.editor.clearDraft(state.historyText);
    this.options.onChange();
    return true;
  }
  hasAttachments() {
    return this.editor.composerChips().some((chip) => chip.kind === "image");
  }
  /** Detach the old draft while a session opens, without destroying native paste tables. */
  beginSessionChange() {
    let previous = {
      text: this.editor.getText(),
      images: this.editor.pendingImages,
      links: this.editor.pendingImageLinks,
      imageLinks: this.editor.imageLinks,
      texts: this.editor.pendingTexts
    };
    const generation = ++this.#generation;
    this.#pendingAttachments = 0;
    this.#restoringDraft = void 0;
    const transition = {
      active: true,
      session: this.options.currentSession(),
      cwd: this.options.cwd()
    };
    this.#transition = transition;
    this.editor.pendingImages = [];
    this.editor.pendingImageLinks = [];
    this.editor.imageLinks = void 0;
    this.editor.pendingTexts = [];
    this.editor.setText("");
    const revision = this.editor.textRevision;
    const atomsRevision = this.editor.atomsRevision;
    let settled = false;
    const finish = (restore) => {
      if (settled) return;
      settled = true;
      transition.active = false;
      transition.session = this.options.currentSession();
      transition.cwd = this.options.cwd();
      if (this.#transition === transition) this.#transition = void 0;
      if (!this.#disposed && generation === this.#generation) {
        const unchanged = revision === this.editor.textRevision && atomsRevision === this.editor.atomsRevision && this.#pendingAttachments === 0;
        if (restore && unchanged && previous) {
          this.editor.pendingImages = previous.images;
          this.editor.pendingImageLinks = previous.links;
          this.editor.imageLinks = previous.imageLinks;
          this.editor.pendingTexts = previous.texts;
          this.editor.setText(previous.text);
        } else if (unchanged) {
          this.#originalClearPasteState.call(this.editor);
        }
        this.options.onChange();
      }
      previous = void 0;
    };
    return { complete: () => finish(false), rollback: () => finish(true) };
  }
  /** Call only after a session change succeeds; also fences work from the old session. */
  resetSession() {
    this.#generation++;
    this.#transition = void 0;
    this.#pendingAttachments = 0;
    this.#restoringDraft = void 0;
    this.editor.clearDraft();
    this.options.onChange();
  }
  async #loadPath(path, lifetime) {
    if (!this.#alive(lifetime)) return;
    this.#pendingAttachments++;
    try {
      const extracted = extractImagePathFromText(path) ?? path.trim();
      const normalized = extracted.length > 1 && (extracted[0] === '"' || extracted[0] === "'") && extracted.at(-1) === extracted[0] ? extracted.slice(1, -1) : extracted;
      const localPath = normalized.startsWith("file:") ? fileURLToPath(normalized) : normalized;
      if (!localPath || localPath.includes("\0") || /^[a-z][a-z\d+.-]*:/i.test(localPath)) throw new AttachmentError("imagePathInvalid");
      const fullPath = resolve3(lifetime.cwd, localPath.startsWith("~/") ? resolve3(homedir2(), localPath.slice(2)) : localPath);
      const file = await open(fullPath, constants.O_RDONLY | constants.O_NONBLOCK);
      let bytes;
      try {
        const stat2 = await file.stat();
        if (!stat2.isFile()) throw new AttachmentError("imagePathInvalid");
        if (stat2.size > MAX_IMAGE_INPUT_BYTES) throw new AttachmentError("imageTooLarge");
        bytes = await file.readFile();
      } finally {
        await file.close();
      }
      if (bytes.length > MAX_IMAGE_INPUT_BYTES) throw new AttachmentError("imageTooLarge");
      if (!this.#alive(lifetime)) return;
      const image = await decodedImage(bytes, fullPath);
      if (!this.#alive(lifetime)) return;
      this.#attach(image, fullPath);
    } catch (error) {
      if (this.#alive(lifetime)) this.#report(error, "imagePathInvalid");
    } finally {
      if (lifetime.generation === this.#generation) this.#pendingAttachments--;
    }
  }
  /** Invoked only by an explicit native paste action, never at startup. */
  async pasteClipboard() {
    const lifetime = this.#inputLifetime.getStore() ?? this.#lifetime();
    if (!this.#alive(lifetime)) return false;
    this.#pendingAttachments++;
    try {
      let text3;
      let textFailed = false;
      try {
        text3 = await readTextFromClipboard();
      } catch {
        textFailed = true;
      }
      if (!this.#alive(lifetime)) return false;
      const paths = text3 ? extractImagePastePathsFromText(text3) : void 0;
      if (paths?.length) {
        for (const path of paths) {
          if (!this.#alive(lifetime)) return false;
          await this.#loadPath(path, lifetime);
        }
        return true;
      }
      let imageFailed = false;
      let clipboard;
      try {
        clipboard = await readImageFromClipboard();
      } catch {
        imageFailed = true;
      }
      if (!this.#alive(lifetime)) return false;
      if (clipboard) {
        const image = await decodedImage(clipboard.data);
        if (!this.#alive(lifetime)) return false;
        this.#attach(image);
        return true;
      }
      if (text3) {
        this.editor.pasteText(text3);
        this.options.onChange();
        return true;
      }
      if (textFailed || imageFailed) throw new AttachmentError("imageClipboardFailed");
      return false;
    } catch (error) {
      if (this.#alive(lifetime)) this.#report(error, "imageClipboardFailed");
      return false;
    } finally {
      if (lifetime.generation === this.#generation) this.#pendingAttachments--;
    }
  }
  #attach(image, path) {
    const dims = cachedImageDimensions(image) ?? void 0;
    this.editor.pendingImages.push(image);
    this.editor.pendingImageLinks.push(path);
    this.editor.imageLinks = this.editor.pendingImageLinks;
    const n = this.editor.pendingImages.length;
    this.editor.insertAtom(chipLabel("image", n), formatVisionMarker("image", n, dims));
    this.options.onChange();
  }
  dispose() {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#generation++;
    if (this.editor.clearPasteState === this.#clearPasteState) this.editor.clearPasteState = this.#originalClearPasteState;
    if (this.editor.onChange === this.#change) this.editor.onChange = this.#originalChange;
    if (this.editor.onSubmit === this.#submit) this.editor.onSubmit = this.#originalSubmit;
    if (this.editor.onPasteImage === this.#pasteImage) this.editor.onPasteImage = this.#originalPasteImage;
    if (this.editor.onPasteImagePath === this.#pastePath) this.editor.onPasteImagePath = this.#originalPastePath;
    if (this.editor.handleInput === this.#handleInput) this.editor.handleInput = this.#originalHandleInput;
    if (this.editor.handleDraftEdit === this.#handleDraftEdit) this.editor.handleDraftEdit = this.#originalHandleDraftEdit;
    queueMicrotask(() => this.#inputLifetime.disable());
    this.editor.clearDraft();
  }
};
function isInputMime(mimeType) {
  return mimeType === "image/jpeg" || mimeType === "image/png" || mimeType === "image/gif" || mimeType === "image/webp";
}
async function decodedImage(bytes, path) {
  if (bytes.byteLength > MAX_IMAGE_INPUT_BYTES) throw new AttachmentError("imageTooLarge");
  const metadata = parseImageMetadata(bytes);
  if (!metadata || !isInputMime(metadata.mimeType)) throw new AttachmentError("imageInvalid");
  const image = {
    type: "image",
    data: Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64"),
    mimeType: metadata.mimeType
  };
  if (await imageDecodeFailureReason(image) !== null) throw new AttachmentError("imageInvalid");
  const attached = path ? tagImageAttachmentSource(image, path, "image") : image;
  setCachedImageDimensions(attached, metadata.width && metadata.height ? { width: metadata.width, height: metadata.height } : null);
  return attached;
}
function imageAdmissionError(error, locale) {
  const message = error instanceof Error ? error.message : String(error);
  const labels = dictionary(locale);
  switch (message) {
    case "The selected Pi model does not support image attachments. Choose an image-capable model or remove the images.":
      return labels.imageUnsupportedModel;
    case "Image attachments must contain valid base64 data in JPEG, PNG, GIF or WebP format.":
      return labels.imageInvalid;
    case "Enter a message or attach an image before sending.":
      return labels.imageEmptyDraft;
    default:
      return void 0;
  }
}

// src/omp-send-feedback.ts
import { Container as Container2 } from "@oh-my-pi/pi-tui/tui";
import { UserMessageComponent as UserMessageComponent2 } from "@oh-my-pi/pi-tui/chat/user-message";
import { Text as Text8 } from "@oh-my-pi/pi-tui/components/text";
import { node as node5 } from "@oh-my-pi/pi-tui/native/describe";
var SendStatus = class extends Text8 {
  label = "";
  describe(_cx) {
    return node5("row", { justify: "end" }, [node5("text", { role: "pi.send.status", text: this.label })]);
  }
  update(label) {
    this.label = label;
    this.setText(label);
  }
};
var PiSendFeedback = class {
  constructor(backend, images, options) {
    this.backend = backend;
    this.images = images;
    this.options = options;
  }
  pending;
  sync() {
    const pending = this.pending;
    if (!pending) return;
    if (!this.sameSession(pending) || pending.finished && !this.backend.state.needsInterrupt) {
      this.reset();
      return;
    }
    pending.status.update(this.options.locale() === "zh-CN" ? pending.accepted ? "\u5DF2\u53D1\u9001\uFF0C\u7B49\u5F85 Pi \u56DE\u663E\u2026" : "\u53D1\u9001\u4E2D\u2026" : pending.accepted ? "Sent; waiting for Pi\u2026" : "Sending\u2026");
    return pending.visible ? pending.view : void 0;
  }
  /** Only live protocol events call this; loading historical messages cannot acknowledge a send. */
  recorded() {
    const pending = this.pending;
    if (!pending || !this.sameSession(pending)) return;
    pending.accepted = true;
    this.images.accept(pending.submission);
    this.hide(pending);
    this.options.onChange();
  }
  async send(submission) {
    if (!this.images.stage(submission)) throw new Error(this.options.locale() === "zh-CN" ? "\u8349\u7A3F\u5DF2\u66F4\u6539\uFF0C\u8BF7\u91CD\u65B0\u53D1\u9001\u3002" : "The draft changed. Please submit it again.");
    this.reset();
    const view = new Container2();
    const status = new SendStatus("", 0, 0);
    view.addChild(new UserMessageComponent2(submission.text, {
      images: submission.images.map((image) => ({ type: "image", ...image }))
    }));
    view.addChild(status);
    const pending = {
      submission,
      session: this.backend.state.session?.id,
      file: this.backend.state.session?.file,
      view,
      status,
      accepted: false,
      finished: false,
      visible: true
    };
    this.pending = pending;
    this.options.onChange();
    try {
      await this.backend.send(submission.text, (disposition) => {
        if (this.pending !== pending || !this.sameSession(pending)) return;
        pending.accepted = true;
        this.images.accept(submission);
        if (disposition === "handled") this.hide(pending);
        this.options.onChange();
      }, submission.images);
    } finally {
      pending.finished = true;
      if (this.pending === pending) {
        if (!pending.accepted) {
          if (this.sameSession(pending)) this.options.onRecovery(this.images.restore(submission));
          this.reset();
        }
        this.options.onChange();
      }
    }
  }
  reset() {
    if (this.pending) this.hide(this.pending);
    this.pending = void 0;
  }
  hide(pending) {
    if (!pending.visible) return;
    pending.visible = false;
    pending.view.dispose();
  }
  sameSession(pending) {
    return pending.session === this.backend.state.session?.id && pending.file === this.backend.state.session?.file;
  }
};

// src/omp-commands.ts
var descriptions = {
  sessions: ["\u9009\u62E9\u5386\u53F2\u4F1A\u8BDD", "Saved sessions"],
  new: ["\u65B0\u5EFA\u4F1A\u8BDD", "New session"],
  resume: ["\u6309\u4F1A\u8BDD\u6587\u4EF6\u6062\u590D", "Resume by session file"],
  model: ["\u9009\u62E9 Pi \u6A21\u578B", "Select Pi model"],
  thinking: ["\u9009\u62E9\u771F\u5B9E\u601D\u8003\u5F3A\u5EA6", "Select thinking level"],
  rename: ["\u91CD\u547D\u540D\u4F1A\u8BDD", "Rename session"],
  fork: ["\u4ECE\u7528\u6237\u6D88\u606F\u5206\u53C9", "Fork from a user message"],
  clone: ["\u590D\u5236\u5F53\u524D\u4F1A\u8BDD\u5206\u652F", "Clone current session branch"],
  compact: ["\u538B\u7F29\u4E0A\u4E0B\u6587\uFF08\u53EF\u80FD\u6D88\u8017\u6A21\u578B\u989D\u5EA6\uFF09", "Compact context (may use model quota)"],
  context: ["\u67E5\u770B\u4E0A\u4E0B\u6587\u603B\u7528\u91CF", "Reported context usage"],
  retry: ["\u91CD\u65B0\u8FDE\u63A5\uFF0C\u4E0D\u91CD\u53D1\u6D88\u606F", "Reconnect without replay"],
  language: ["\u4E2D\u6587 / English", "\u4E2D\u6587 / English"],
  help: ["\u4F1A\u8BDD\u64CD\u4F5C", "Conversation actions"],
  quit: ["\u5173\u95ED\u5BA2\u6237\u7AEF", "Close client"]
};
function commandEntries(locale, discovered) {
  const remoteNames = new Set(discovered.map((command) => command.name));
  const local = Object.keys(descriptions).flatMap((name) => {
    const description = descriptions[name][locale === "zh-CN" ? 0 : 1];
    return [{ name: `bridge:${name}`, description }, ...remoteNames.has(name) ? [] : [{ name, description }]];
  });
  return [...discovered.filter((command) => !command.name.startsWith("bridge:")).map((command) => ({
    name: command.name,
    description: command.description ?? command.source
  })), ...local];
}
function routeCommand(message, discovered) {
  const match = /^\/([^\s]+)(?:\s+([\s\S]*))?$/.exec(message);
  if (!match) return { kind: "message" };
  const name = match[1];
  const localName = name.startsWith("bridge:") ? name.slice(7) : name;
  if (!name.startsWith("bridge:") && discovered.some((command) => command.name === name)) return { kind: "remote" };
  if (Object.hasOwn(descriptions, localName)) return { kind: "local", name: localName, argument: match[2] };
  return { kind: "unknown" };
}

// src/main.ts
var { values } = parseArgs({ options: {
  cwd: { type: "string" },
  "data-dir": { type: "string" },
  pi: { type: "string" },
  "session-dir": { type: "string" },
  session: { type: "string" },
  "pick-session": { type: "boolean" },
  locale: { type: "string" },
  help: { type: "boolean", short: "h" },
  version: { type: "boolean" }
} });
if (values.help || values.version) {
  process.stdout.write(values.version ? "tern-bridge-pi 0.1.1\n" : "tern-bridge-pi \u2014 Pi in Tern native surfaces\n\nUsage: bun dist/client.mjs [--cwd DIR] [--data-dir DIR] [--session FILE | --pick-session]\n       [--pi PATH] [--session-dir DIR] [--locale zh-CN|en-US]\n\nRequires Bun 1.3.14+, Tern native surfaces and an authenticated Pi CLI.\nSending messages or compacting can use model quota; normal Pi extensions remain enabled.\n");
} else await run();
async function run() {
  if (values.locale && values.locale !== "zh-CN" && values.locale !== "en-US") throw new Error("--locale must be zh-CN or en-US");
  if (values.session && values["pick-session"]) throw new Error("Choose --session or --pick-session, not both.");
  const cwd = resolve4(values.cwd ?? process.cwd());
  const config = process.env.TERN_CONFIG_DIR ?? (process.platform === "darwin" ? join3(homedir3(), "Library", "Application Support", "Tern") : join3(process.env.XDG_STATE_HOME ?? join3(homedir3(), ".local", "state"), "tern"));
  const dataDir = resolve4(values["data-dir"] ?? join3(config, "plugin-data", "tern-bridge-pi"));
  let preferences = {};
  try {
    const saved = JSON.parse(await readFile2(join3(dataDir, "preferences.json"), "utf8"));
    if (saved && typeof saved === "object" && !Array.isArray(saved)) preferences = saved;
  } catch (error) {
    if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
  }
  let locale = values.locale === "en-US" || !values.locale && preferences.locale === "en-US" ? "en-US" : "zh-CN";
  const text3 = (zh2, en2) => locale === "zh-CN" ? zh2 : en2;
  if (process.env.TERM_PROGRAM?.toLowerCase() !== "tern" || !process.stdin.isTTY) {
    process.stderr.write(text3("\u8BF7\u5728 Tern \u7684\u672C\u673A\u7A97\u683C\u4E2D\u6253\u5F00\u6B64\u5BA2\u6237\u7AEF\u3002\n", "Open this client in a local Tern pane.\n"));
    process.exitCode = 1;
    return;
  }
  delete process.env.PI_TUI_TSP_RECORD;
  process.title = "tern-bridge-pi";
  const ended = Promise.withResolvers();
  let closing = false;
  let scheduled = false;
  let submitting = false;
  let terminalProgress = false;
  let pendingNew = null;
  let uiError = null;
  let observedBackendError = null;
  let dismissedBackendError = null;
  let banner;
  let bannerMessage = null;
  let mountedPrompt;
  let facts;
  let factsKey = "";
  let expanded = false;
  let autocompleteCwd = "";
  let autocompleteCommands = "";
  let appliedEditorRequest;
  let editorSession;
  const widgetComponents = /* @__PURE__ */ new Map();
  const notice = new PiExtensionText("", 0, 0);
  const welcome = new PiWelcome(locale);
  const composer = new Composer({ preferences: { quiet: true, spellingAutocomplete: "off", spellingTypoDetection: false }, exit: (code2) => {
    process.exitCode = code2;
    void shutdown();
  } });
  const backend = new PiBridge({ cwd, dataDir, sessionDir: values["session-dir"], execPath: values.pi ?? (typeof preferences.piPath === "string" ? preferences.piPath : void 0), onChange: changed, onUserMessage: () => sendFeedback.recorded() });
  const surfaceOpen = `${TSP_PREFIX}o;`;
  const writeNative = composer.ui.terminal.write.bind(composer.ui.terminal);
  composer.ui.terminal.write = (data) => {
    if (data.startsWith(surfaceOpen) && data.endsWith("\x1B\\")) {
      const body = data.slice(surfaceOpen.length, -2);
      const opening = JSON.parse(body);
      const title = `Pi \xB7 ${backend.state.windowTitle ?? (backend.state.session?.title || dictionary(locale).untitled)}`;
      writeNative(encodeTspJson("o", { ...opening, title }, void 0, Buffer.byteLength(body)));
    } else writeNative(data);
  };
  const transcript = new PiTranscript(composer.ui, cwd);
  const todos = new PiTodoHud();
  const working = new PiWorkingHud(todos);
  const dialogs = new PiDialogs(composer, backend, { locale: () => locale, onError: report, onChange: changed, openSession: (id) => open2(id) });
  composer.setHeaderExtras([welcome], []);
  composer.editor.magicKeywordsEnabledOverride = false;
  composer.editor.attachmentChips = new AttachmentChipsBand(composer.editor, composer.ui.imageBudget, () => composer.ui.requestRender());
  composer.editor.composerState = () => ({ running: busy(), thinking: backend.state.session?.settings.reasoningEffort, title: backend.state.session?.title || void 0 });
  composer.editor.composerFacts = {
    describeComposerFacts: () => facts,
    handleNativeEvent(event) {
      if (event.type === "action" && event.act.startsWith("status.")) void perform(() => command(event.act.slice(7)));
    }
  };
  const images = new PiImageComposer(composer.editor, {
    locale: () => locale,
    currentSession: () => backend.state.session?.id ?? null,
    cwd: () => backend.state.session?.cwd ?? cwd,
    onChange: changed,
    onError: report,
    onSubmit: (submission) => {
      void perform(() => submit(submission));
    }
  });
  const sendFeedback = new PiSendFeedback(backend, images, {
    locale: () => locale,
    onChange: changed,
    onRecovery: (restored) => {
      backend.state.notice = restored ? text3("\u6D88\u606F\u5C1A\u672A\u786E\u8BA4\uFF0C\u5DF2\u6062\u590D\u8349\u7A3F\u3002", "The message was not confirmed. Your draft has been restored.") : text3("\u6D88\u606F\u5C1A\u672A\u786E\u8BA4\uFF0C\u5F53\u524D\u8349\u7A3F\u5DF2\u4FDD\u7559\uFF1B\u8F93\u5165\u6846\u4E3A\u7A7A\u65F6\u6309 \u2191 \u53EF\u627E\u56DE\u539F\u6D88\u606F\u3002", "The message was not confirmed. Your new draft is unchanged; press \u2191 in an empty composer to recall the original.");
    }
  });
  composer.editor.onEscape = () => {
    void perform(() => busy() ? backend.interrupt() : Promise.resolve());
  };
  const clearOrExit = composer.editor.onClear;
  composer.editor.onClear = () => {
    clearOrExit?.();
    if (closing) return;
    composer.editor.clearDraft();
    if (busy()) void perform(() => backend.interrupt());
  };
  composer.editor.onExit = () => {
    void perform(() => command("quit"));
  };
  composer.editor.onSelectModel = composer.editor.onSelectModelTemporary = () => {
    void perform(() => command("model"));
  };
  composer.editor.onCycleThinkingLevel = () => {
    void perform(() => command("thinking"));
  };
  composer.editor.onRetry = () => {
    void perform(() => command("retry"));
  };
  composer.editor.setCustomKeyHandler("ctrl+alt+shift+o", () => {
    void perform(() => dialogs.sessions());
  });
  composer.editor.setCustomKeyHandler("ctrl+alt+shift+n", () => {
    void perform(() => command("new"));
  });
  composer.editor.setCustomKeyHandler("ctrl+o", () => {
    expanded = !expanded;
    transcript.setExpanded(expanded);
    changed();
  });
  let commands = commandEntries(locale, []);
  const composerStyle = `${TSP_PREFIX}s;${JSON.stringify({
    name: "pi-composer",
    css: `
      .sf-place { display: none; }
      [data-role='omp.composer.model'], [data-role='omp.composer.effort'] { align-self: center; }
      /* Override the native chat button minimum without changing overlay buttons. */
      [data-role='omp.composer.extras'] > [data-role='omp.btn'] {
        box-sizing: border-box !important; height: 28px !important; min-height: 28px !important;
        padding: 0 10px !important; font-family: var(--sans); font-size: 12.5px; font-weight: 500; line-height: 26px;
      }
      [data-role='omp.composer.extras'] > [data-role='omp.btn'] > .sf-text { line-height: 26px; }
      [data-role='omp.welcome'] [data-role='omp.welcome.lockup'] { height: auto; }
      [data-role='omp.welcome'] [data-role='omp.welcome.tip'] { opacity: 1; animation: none; }
      [data-role='pi.welcome.wordmark'] { color: var(--accent); font-family: var(--sans); font-size: 48px; font-weight: 600; line-height: 56px; }
      [data-role='pi.welcome.shortcuts'] { justify-content: center; margin-top: 12px; font-family: var(--sans); font-size: 12px; }
      [data-role='pi.extension.text'], [data-role='pi.extension.text'] .sf-text {
        font-family: var(--sans); font-size: 12px; line-height: 18px; color: var(--sf-c-muted);
      }
      [data-role='pi.send.status'] { font-family: var(--sans); font-size: 12px; color: var(--sf-c-muted); }
      [data-role='pi.extension.status'] {
        font-family: var(--sans); font-size: 11px; line-height: 18px; color: var(--sf-c-muted);
        min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      }
    `
  })}\x1B\\`;
  const nativeChange = onNativeRenderingChange((on) => {
    if (on) {
      composer.ui.terminal.setTitle(`Pi \xB7 ${backend.state.windowTitle ?? (backend.state.session?.title || dictionary(locale).untitled)}`);
      composer.ui.terminal.write(composerStyle);
    }
  });
  function busy() {
    return submitting || backend.state.needsInterrupt || ["connecting", "running", "approval", "question", "stopping"].includes(backend.state.phase);
  }
  function report(error) {
    if (closing) return;
    uiError = imageAdmissionError(error, locale) ?? (error instanceof Error ? error.message : String(error));
    pendingNew = null;
    changed();
  }
  async function perform(work) {
    uiError = null;
    try {
      await work();
    } catch (error) {
      report(error);
    }
    changed();
  }
  function changed() {
    if (closing || scheduled) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      if (closing) return;
      try {
        update();
      } catch {
        process.exitCode = 1;
        process.stderr.write("Pi UI rendering failed. Saved messages were not replayed. Reopen the saved session.\n");
        void shutdown();
        return;
      }
      if (pendingNew) {
        if (backend.state.session?.id !== pendingNew || backend.state.phase === "error") pendingNew = null;
        else if (!busy() && backend.state.phase === "idle") {
          pendingNew = null;
          void perform(() => open2());
        }
      }
    });
  }
  function update() {
    const active = isPiWorking(backend.state);
    if (terminalProgress !== active) {
      terminalProgress = active;
      composer.ui.terminal.setProgress(active);
    }
    const b = backend.state;
    const t = dictionary(locale);
    const activeCwd = b.session?.cwd || cwd;
    const nextCommands = JSON.stringify([locale, b.commands]);
    if (activeCwd !== autocompleteCwd || nextCommands !== autocompleteCommands) {
      autocompleteCwd = activeCwd;
      autocompleteCommands = nextCommands;
      commands = commandEntries(locale, b.commands);
      composer.editor.setAutocompleteProvider(new CombinedAutocompleteProvider(commands, activeCwd));
    }
    if (b.error !== observedBackendError) {
      observedBackendError = b.error;
      dismissedBackendError = null;
    }
    const error = uiError || (b.error === dismissedBackendError ? null : b.error);
    if (error !== bannerMessage) {
      banner?.dispose();
      bannerMessage = error;
      banner = error ? new ErrorBannerComponent(error, () => {
        uiError = null;
        dismissedBackendError = b.error;
        changed();
      }) : void 0;
    }
    welcome.sync(b.session?.title ?? "", locale);
    notice.setText(b.notice ?? "");
    if (editorSession !== (b.session?.id ?? null)) {
      editorSession = b.session?.id ?? null;
      appliedEditorRequest = void 0;
    }
    if (b.editorText && b.editorText.id !== appliedEditorRequest) {
      appliedEditorRequest = b.editorText.id;
      composer.editor.setText(b.editorText.text);
    }
    const widgets = b.widgets.map((widget) => {
      let component = widgetComponents.get(widget.key);
      if (!component) {
        component = new PiExtensionText("", 0, 0);
        widgetComponents.set(widget.key, component);
      }
      component.setText(widget.lines.join("\n"));
      return { component, placement: widget.placement };
    });
    for (const key2 of widgetComponents.keys()) {
      if (!b.widgets.some((widget) => widget.key === key2)) widgetComponents.delete(key2);
    }
    transcript.sync(b, sendFeedback.sync());
    todos.sync(b, locale);
    working.sync(b, locale);
    const prompt = dialogs.syncPrompts();
    composer.editor.disableSubmit = submitting || ["connecting", "running", "approval", "question", "stopping"].includes(b.phase) || b.needsInterrupt;
    composer.setRuntimeChildren([
      transcript.container,
      ...banner ? [banner] : [],
      ...b.notice ? [notice] : [],
      ...widgets.filter((widget) => widget.placement === "aboveEditor").map((widget) => widget.component),
      working,
      prompt ?? composer.editor,
      ...widgets.filter((widget) => widget.placement === "belowEditor").map((widget) => widget.component)
    ]);
    if (prompt !== mountedPrompt) {
      mountedPrompt = prompt;
      if (!dialogs.hasOverlay()) composer.ui.setFocus(prompt ?? composer.editor);
    }
    const settings = b.session?.settings;
    const selected = b.models.find((model) => model.id === settings?.modelId);
    const key = JSON.stringify([locale, b.phase, b.context, b.session?.title, selected?.label, settings, b.statuses]);
    if (key !== factsKey) {
      factsKey = key;
      const controls = ["error", "disconnected"].includes(b.phase) ? [actionButton2(t.reconnect, "status.retry", { key: "retry", title: t.reconnectHint })] : [];
      const statuses = b.statuses.map((status) => node6("text", {
        role: "pi.extension.status",
        spans: styledSpans(status.text),
        wrap: "none",
        max: { w: 180 },
        title: stripVTControlCharacters(status.text)
      }, void 0, status.key));
      facts = {
        context: b.context && b.context.limit > 0 ? node6("meter", {
          role: "omp.composer.context",
          style: "bar",
          actions: { click: "status.context" },
          aria: t.context,
          value: Math.min(1, b.context.used / b.context.limit),
          label: `${Math.round(b.context.used / b.context.limit * 100)}%`,
          title: `${t.context}: ${b.context.used.toLocaleString(locale)} / ${b.context.limit.toLocaleString(locale)}`
        }, void 0, "context") : EMPTY_NODE3,
        model: { spans: [span(`Pi \xB7 ${selected?.label || settings?.modelId || t.default}`)], title: t.model },
        extras: node6("row", { role: "omp.composer.extras", grow: 1, gap: "sm", align: "center", min: { w: 0 } }, [...controls, ...statuses], "extras"),
        usage: EMPTY_NODE3
      };
    }
    composer.ui.terminal.setTitle(`Pi \xB7 ${b.windowTitle ?? (b.session?.title || t.untitled)}`);
    composer.ui.requestRender();
  }
  async function open2(id) {
    pendingNew = null;
    if (busy()) throw new Error(text3("\u8BF7\u5148\u505C\u6B62\u5F53\u524D\u4EFB\u52A1\uFF0C\u518D\u5207\u6362\u4F1A\u8BDD\u3002", "Stop the active turn before switching conversations."));
    if (id !== void 0 && id === backend.state.session?.file) {
      await backend.open(id);
      return;
    }
    await changeSession(() => backend.open(id));
  }
  async function changeSession(action) {
    const before = backend.state.session;
    const identity = [before?.id, before?.file];
    const transition = images.beginSessionChange();
    sendFeedback.reset();
    try {
      await action();
      const after = backend.state.session;
      if (identity[0] === after?.id && identity[1] === after?.file) transition.rollback();
      else transition.complete();
    } catch (error) {
      transition.rollback();
      throw error;
    }
  }
  async function submit(submission) {
    const message = submission.text;
    if (!message.trim() && !submission.images.length) return;
    const route = submission.images.length ? { kind: "message" } : routeCommand(message, backend.state.commands);
    if (route.kind === "unknown") throw new Error(text3("\u6B64\u547D\u4EE4\u4E0D\u5728 Pi \u5DF2\u53D1\u73B0\u7684\u547D\u4EE4\u4E2D\u3002\u8F93\u5165 /bridge:help \u67E5\u770B\u672C\u5730\u64CD\u4F5C\u3002", "Pi has not advertised this command. Use /bridge:help for local actions."));
    if (route.kind === "local") {
      images.accept(submission);
      await command(route.name, route.argument);
      return;
    }
    if (busy() || backend.state.phase !== "idle") throw new Error(text3("\u5F53\u524D\u65E0\u6CD5\u53D1\u9001\u3002\u8BF7\u5148\u505C\u6B62\u4EFB\u52A1\u6216\u91CD\u65B0\u8FDE\u63A5\u4F1A\u8BDD\u3002", "Cannot send now. Stop the active work or reconnect the session."));
    submitting = true;
    changed();
    try {
      await sendFeedback.send(submission);
    } finally {
      submitting = false;
      changed();
    }
  }
  async function command(name, argument) {
    const t = dictionary(locale);
    switch (name) {
      case "sessions":
        return dialogs.sessions();
      case "context":
        return dialogs.context();
      case "resume":
        return argument?.trim() ? open2(argument.trim()) : dialogs.sessions();
      case "help": {
        const selected = await dialogs.choose(text3("Pi \u4F1A\u8BDD\u64CD\u4F5C", "Pi conversation actions"), commands.filter((item) => item.name.startsWith("bridge:") && item.name !== "bridge:help").map((item) => ({ value: item.name.slice(7), label: `/${item.name}`, description: item.description })));
        if (selected) await command(selected);
        return;
      }
      case "new": {
        if (busy()) {
          if (!await dialogs.confirm(text3("\u505C\u6B62\u5E76\u65B0\u5EFA\u5BF9\u8BDD\uFF1F", "Stop and start a new conversation?"), text3("\u5DF2\u6267\u884C\u7684\u6587\u4EF6\u4FEE\u6539\u4E0D\u4F1A\u81EA\u52A8\u64A4\u9500\u3002", "File changes already made will not be undone."))) return;
          const source = backend.state.session?.id;
          await backend.interrupt();
          if (source && backend.state.session?.id === source) pendingNew = source;
          changed();
        } else await open2();
        return;
      }
      case "model": {
        const value = await dialogs.choose(t.model, backend.state.models.map((model) => ({ value: model.id, label: model.label, description: `${model.provider} / ${model.modelId}` })));
        if (value) await backend.updateSettings({ modelId: value });
        return;
      }
      case "thinking": {
        const value = await dialogs.choose(t.reasoning, (backend.state.session?.settings.thinkingLevels ?? []).map((value2) => ({ value: value2, label: value2 })));
        if (value) await backend.updateSettings({ reasoningEffort: value });
        return;
      }
      case "rename": {
        const value = argument ?? await dialogs.input(t.rename, backend.state.session?.title, t.renameHint);
        if (value?.trim()) await backend.rename(value);
        return;
      }
      case "fork": {
        const choices = await backend.forkMessages();
        const entryId = await dialogs.choose(t.fork, choices.map((choice) => ({ value: choice.entryId, label: choice.text || t.user, description: choice.entryId })));
        if (entryId) await changeSession(() => backend.fork(entryId));
        return;
      }
      case "clone":
        return changeSession(() => backend.clone());
      case "compact": {
        const value = await dialogs.input(t.compact, argument, text3("\u538B\u7F29\u53EF\u80FD\u8C03\u7528\u6240\u9009\u6A21\u578B\u5E76\u6D88\u8017\u63D0\u4F9B\u5546\u989D\u5EA6\u3002\u53EF\u586B\u5199\u989D\u5916\u8981\u6C42\u3002", "Compaction may call the selected model and use provider quota. Extra instructions are optional."));
        if (value !== void 0) await backend.compact(value || void 0);
        return;
      }
      case "retry":
        await backend.open(backend.state.session?.file);
        return;
      case "language": {
        const value = argument ?? await dialogs.choose(t.language, [{ value: "zh-CN", label: "\u7B80\u4F53\u4E2D\u6587" }, { value: "en-US", label: "English" }]);
        if (value !== "zh-CN" && value !== "en-US") return;
        await mkdir2(dataDir, { recursive: true, mode: 448 });
        const path = join3(dataDir, "preferences.json");
        const pending = `${path}.${process.pid}.tmp`;
        await writeFile2(pending, JSON.stringify({ ...preferences, locale: value }) + "\n", { mode: 384 });
        await rename2(pending, path);
        preferences = { ...preferences, locale: value };
        locale = value;
        factsKey = "";
        return;
      }
      case "quit":
        if ((busy() || composer.editor.getText()) && !await dialogs.confirm(text3("\u5173\u95ED\u5BA2\u6237\u7AEF\uFF1F", "Close the client?"), text3("\u4F1A\u505C\u6B62\u5F53\u524D\u4EFB\u52A1\uFF0C\u672A\u53D1\u9001\u8349\u7A3F\u4E0D\u4F1A\u4FDD\u5B58\uFF1B\u5386\u53F2\u4F1A\u8BDD\u4FDD\u7559\u3002", "The active turn will stop and unsent drafts will be lost. Saved conversations remain."))) return;
        return shutdown();
    }
  }
  async function shutdown() {
    if (closing) return;
    closing = true;
    pendingNew = null;
    composer.ui.terminal.setProgress(false);
    dialogs.dispose();
    sendFeedback.reset();
    images.dispose();
    try {
      await backend.close();
    } finally {
      nativeChange();
      transcript.dispose();
      stopSharedSpinnerTicker();
      composer.stop();
      ended.resolve();
    }
  }
  const signal = () => {
    void shutdown();
  };
  for (const signalName of ["SIGINT", "SIGTERM", "SIGHUP"]) process.once(signalName, signal);
  try {
    update();
    composer.start({ clearScrollback: false, playWelcomeIntro: false, deferInput: true });
    composer.ui.releaseHeldInput();
    if (values["pick-session"]) void perform(() => dialogs.sessions());
    else void perform(() => backend.open(values.session));
    await ended.promise;
  } finally {
    for (const signalName of ["SIGINT", "SIGTERM", "SIGHUP"]) process.off(signalName, signal);
    await shutdown();
  }
}
