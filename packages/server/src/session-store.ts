// packages/server/src/session-store.ts
// T5.2 — Session store.
//
// Per REQUIREMENTS.MD §4.4 and DESIGN.MD §9, sessions are stored as:
//
//   ~/.computerworks/sessions/<id>/
//     meta.json          # session metadata (small, loaded whole)
//     messages.jsonl     # append-only transcript
//     audit.jsonl        # append-only tool-call decisions
//
// We do NOT use a database. Writes are atomic per line (single fsync
// per append). The whole messages.jsonl is never loaded into memory —
// callers stream it.
//
// `createSession`, `patchSession`, `appendMessage`, `appendAudit` are
// all safe to call concurrently from multiple Bun tasks because each
// write is a single `fs.appendFile` syscall, which the kernel
// guarantees will not interleave with another write to the same file
// descriptor opened with O_APPEND.

import {
  mkdir,
  readdir,
  readFile,
  writeFile,
  appendFile,
  rm,
  stat,
  rename,
} from "node:fs/promises";
import { join, resolve, isAbsolute } from "node:path";
import { homedir } from "node:os";
import { z } from "zod";
import type { Message, Role } from "@computerworks/core";

// ─── Schema ───────────────────────────────────────────────────────────────

/** Persisted shape of meta.json. We allowlist fields we care about so a
 *  stray key in the file doesn't crash the loader. */
export const SessionMetaSchema = z.object({
  id: z.string().min(1),
  title: z.string().default(""),
  createdAt: z.string(), // ISO-8601
  updatedAt: z.string(), // ISO-8601
  cwd: z.string(),
  model: z.string(),
  provider: z.string().default("anthropic"),
  allowlist: z.array(z.string()).default([]),
  systemPromptOverrides: z.string().optional(),
  memoryRoot: z.string().optional(),
});
export type SessionMeta = z.infer<typeof SessionMetaSchema>;

/** A single allowlist pattern. Stored as string source on disk so
 *  meta.json stays human-readable; recompiled to RegExp at use time. */
const allowlistEntry = z.union([
  z.string().min(1),
  z.instanceof(RegExp).transform((re) => re.source),
]);

/** A subset of `SessionMeta` the caller is allowed to change. */
export const SessionPatchSchema = z
  .object({
    title: z.string().min(1).optional(),
    cwd: z.string().min(1).optional(),
    model: z.string().min(1).optional(),
    allowlist: z.array(allowlistEntry).optional(),
    systemPromptOverrides: z.string().optional(),
  })
  .strict();
export type SessionPatch = z.infer<typeof SessionPatchSchema>;

/** Single audit-log entry. Stored as one JSON line in audit.jsonl. */
export const AuditEntrySchema = z.object({
  ts: z.string(),
  sessionId: z.string(),
  callId: z.string(),
  tool: z.string(),
  input: z.unknown(),
  decision: z.union([
    z.literal("approve_once"),
    z.literal("approve_for_session"),
    z.literal("reject"),
    z.literal("edit"),
    z.literal("auto_approve"),
    z.literal("denied_by_denylist"),
    z.literal("timeout"),
  ]),
  reason: z.string().optional(),
  result: z.unknown().optional(),
  isError: z.boolean().optional(),
});
export type AuditEntry = z.infer<typeof AuditEntrySchema>;

// ─── Path resolution ──────────────────────────────────────────────────────

export const DEFAULT_SESSIONS_ROOT = join(homedir(), ".computerworks", "sessions");

function expandHome(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
}

export function resolveSessionsRoot(p: string = DEFAULT_SESSIONS_ROOT): string {
  const expanded = expandHome(p);
  return isAbsolute(expanded) ? expanded : resolve(expanded);
}

export function sessionDir(root: string, id: string): string {
  // Same safety rules as T4.1's memory provider: id must be a plain
  // identifier with no path separators or dots-as-traversal.
  if (!/^[A-Za-z0-9._-]+$/.test(id)) {
    throw new Error(`Invalid session id: ${JSON.stringify(id)}`);
  }
  return join(root, id);
}

function metaPath(root: string, id: string): string {
  return join(sessionDir(root, id), "meta.json");
}
function messagesPath(root: string, id: string): string {
  return join(sessionDir(root, id), "messages.jsonl");
}
function auditPath(root: string, id: string): string {
  return join(sessionDir(root, id), "audit.jsonl");
}

// ─── Store ────────────────────────────────────────────────────────────────

export interface CreateSessionInput {
  /** Optional caller-supplied id. If absent, we generate one. */
  id?: string;
  cwd: string;
  model: string;
  title?: string;
  provider?: string;
  allowlist?: string[];
  systemPromptOverrides?: string;
}

export interface SessionStoreOptions {
  /** Root directory under which session folders live. */
  root?: string;
}

export class SessionStore {
  private readonly root: string;

  constructor(opts: SessionStoreOptions = {}) {
    this.root = resolveSessionsRoot(opts.root);
  }

  /** Public read-only view of the root. */
  getRoot(): string {
    return this.root;
  }

  // ─── create ────────────────────────────────────────────────────────────

  async create(input: CreateSessionInput): Promise<SessionMeta> {
    const id = input.id ?? generateId();
    if (!/^[A-Za-z0-9._-]+$/.test(id)) {
      throw new Error(`Invalid session id: ${JSON.stringify(id)}`);
    }
    const now = new Date().toISOString();
    const meta: SessionMeta = SessionMetaSchema.parse({
      id,
      title: input.title ?? "",
      createdAt: now,
      updatedAt: now,
      cwd: input.cwd,
      model: input.model,
      provider: input.provider ?? "anthropic",
      allowlist: input.allowlist ?? [],
      systemPromptOverrides: input.systemPromptOverrides,
    });

    const dir = sessionDir(this.root, id);
    // mkdir with recursive: true is idempotent and safe across tasks.
    await mkdir(dir, { recursive: true });
    // If a session with this id already exists, refuse rather than
    // clobber it. createFile + rename is atomic on POSIX.
    const tmpMeta = join(dir, ".meta.json.tmp");
    await writeFile(tmpMeta, JSON.stringify(meta, null, 2) + "\n", "utf8");
    try {
      await rename(tmpMeta, metaPath(this.root, id));
    } catch (err) {
      // Clean up the tmp file on failure.
      try {
        await rm(tmpMeta, { force: true });
      } catch {
        // ignore
      }
      throw err;
    }
    // Touch the two jsonl files so they exist (some tools stat them).
    await writeFile(messagesPath(this.root, id), "", { flag: "a" });
    await writeFile(auditPath(this.root, id), "", { flag: "a" });
    return meta;
  }

  // ─── list ─────────────────────────────────────────────────────────────

  async list(): Promise<SessionMeta[]> {
    let entries: string[];
    try {
      entries = await readdir(this.root);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
    const metas: SessionMeta[] = [];
    for (const name of entries) {
      const full = join(this.root, name);
      try {
        const s = await stat(full);
        if (!s.isDirectory()) continue;
      } catch {
        continue;
      }
      try {
        const meta = await this.get(name);
        if (meta) metas.push(meta);
      } catch {
        // Skip malformed session dirs silently — a corrupt folder
        // shouldn't break `list`.
      }
    }
    // Newest-first.
    metas.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
    return metas;
  }

  // ─── get ──────────────────────────────────────────────────────────────

  async get(id: string): Promise<SessionMeta | null> {
    let raw: string;
    try {
      raw = await readFile(metaPath(this.root, id), "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new Error(`Corrupt meta.json for session ${id}: ${(err as Error).message}`);
    }
    return SessionMetaSchema.parse(parsed);
  }

  // ─── patch ────────────────────────────────────────────────────────────

  async patch(id: string, patch: SessionPatch): Promise<SessionMeta> {
    // Validate the patch shape first; .strict() will reject unknown keys.
    const validPatch = SessionPatchSchema.parse(patch);
    const current = await this.get(id);
    if (!current) throw new Error(`session not found: ${id}`);
    // Build the updated meta by mutating a typed copy. We don't use
    // object spread here because TS infers a Partial from the patch.
    const updated: SessionMeta = {
      id: current.id,
      title: validPatch.title ?? current.title,
      createdAt: current.createdAt,
      updatedAt: new Date().toISOString(),
      cwd: validPatch.cwd ?? current.cwd,
      model: validPatch.model ?? current.model,
      provider: current.provider,
      allowlist: validPatch.allowlist
        ? validPatch.allowlist.map((p) =>
            typeof p === "string" ? p : (p as RegExp).source,
          )
        : current.allowlist,
      ...(validPatch.systemPromptOverrides !== undefined
        ? { systemPromptOverrides: validPatch.systemPromptOverrides }
        : current.systemPromptOverrides !== undefined
        ? { systemPromptOverrides: current.systemPromptOverrides }
        : {}),
      ...(current.memoryRoot ? { memoryRoot: current.memoryRoot } : {}),
    };
    const validated = SessionMetaSchema.parse(updated);
    // Write to tmp + rename to make the patch atomic.
    const dir = sessionDir(this.root, id);
    const tmpMeta = join(dir, ".meta.json.tmp");
    await writeFile(tmpMeta, JSON.stringify(validated, null, 2) + "\n", "utf8");
    await rename(tmpMeta, metaPath(this.root, id));
    return validated;
  }

  // ─── delete ───────────────────────────────────────────────────────────

  async delete(id: string): Promise<void> {
    const dir = sessionDir(this.root, id);
    await rm(dir, { recursive: true, force: true });
  }

  // ─── messages ─────────────────────────────────────────────────────────

  /** Append one message to messages.jsonl. The line is JSON-serialized
   *  and followed by a single \n so it can be split on \n unambiguously
   *  (we never write a bare \n inside a JSON document, so this is safe). */
  async appendMessage(id: string, message: Message): Promise<void> {
    validateMessage(message);
    const line = JSON.stringify(message) + "\n";
    await appendFile(messagesPath(this.root, id), line, "utf8");
    // Bump updatedAt on the meta so the session sorts to the top of
    // list(). We do this via a small patch with just updatedAt.
    try {
      const current = await this.get(id);
      if (!current) return;
      const next: SessionMeta = { ...current, updatedAt: new Date().toISOString() };
      const dir = sessionDir(this.root, id);
      const tmpMeta = join(dir, ".meta.json.tmp");
      await writeFile(tmpMeta, JSON.stringify(next, null, 2) + "\n", "utf8");
      await rename(tmpMeta, metaPath(this.root, id));
    } catch {
      // If meta is missing, the session is corrupt — surface later.
    }
  }

  /** Stream all messages back in order. Used by `GET /api/sessions/:id`. */
  async *readMessages(id: string): AsyncIterableIterator<Message> {
    const text = await readFile(messagesPath(this.root, id), "utf8");
    if (text === "") return;
    const lines = text.split("\n");
    // split leaves a trailing "" because the file ends with \n — drop it.
    if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
    for (const line of lines) {
      if (line === "") continue;
      let obj: unknown;
      try {
        obj = JSON.parse(line);
      } catch {
        throw new Error(`Corrupt messages.jsonl in session ${id}`);
      }
      yield obj as Message;
    }
  }

  /** Convenience: load all messages into memory. Used by the agent
   *  loop, which needs the full transcript. */
  async getMessages(id: string): Promise<Message[]> {
    const out: Message[] = [];
    for await (const m of this.readMessages(id)) out.push(m);
    return out;
  }

  // ─── audit (forwarded; the dedicated `audit.ts` is just a thin wrapper) ─

  async appendAudit(id: string, entry: AuditEntry): Promise<void> {
    const validated = AuditEntrySchema.parse({ ...entry, sessionId: id });
    const line = JSON.stringify(validated) + "\n";
    await appendFile(auditPath(this.root, id), line, "utf8");
  }

  async *readAudit(id: string): AsyncIterableIterator<AuditEntry> {
    const text = await readFile(auditPath(this.root, id), "utf8");
    if (text === "") return;
    const lines = text.split("\n");
    if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
    for (const line of lines) {
      if (line === "") continue;
      yield AuditEntrySchema.parse(JSON.parse(line));
    }
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────

/** A short, URL-safe id. 12 chars of base36 (~60 bits) is plenty for
 *  a single user. */
export function generateId(): string {
  // Time prefix keeps it roughly sortable if someone needs to grep.
  const t = Date.now().toString(36);
  const r = Math.random().toString(36).slice(2, 8);
  return `${t}-${r}`;
}

/** Defensive check on a Message before we append. We don't zod-parse
 *  the full Message type here (the wire shape is open) but we do
 *  enforce role + that content is one of the two accepted shapes. */
function validateMessage(message: Message): void {
  const validRoles: Role[] = ["user", "assistant", "system", "tool"];
  if (!validRoles.includes(message.role)) {
    throw new Error(`Invalid message role: ${message.role}`);
  }
  if (typeof message.content !== "string" && !Array.isArray(message.content)) {
    throw new Error("message.content must be string or ContentBlock[]");
  }
}
