import {
  appendFileSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

import { canonicalJson, digestJson, formatJson, sha256 } from "./canonical.js";
import { assertNoLiteralSecrets, assertSafeId } from "./security.js";
import type {
  Actor,
  AuditEvent,
  FactorySnapshot,
  StoreCollection,
} from "./types.js";

const collections: StoreCollection[] = [
  "tasks",
  "runs",
  "evidence",
  "assessment-results",
  "policy-decisions",
  "approvals",
  "observations",
  "incidents",
  "incident-controls",
  "promotions",
  "candidates",
  "metrics",
];

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8")) as unknown;
}

function auditHash(event: Omit<AuditEvent, "hash">): string {
  return digestJson(event);
}

export interface StoreOptions {
  now?: () => string;
  nonce?: () => string;
}

export class FileControlStore {
  readonly root: string;
  private readonly now: () => string;
  private readonly nonce: () => string;

  constructor(root: string, options: StoreOptions = {}) {
    this.root = resolve(root);
    this.now = options.now ?? (() => new Date().toISOString());
    this.nonce =
      options.nonce ??
      (() =>
        `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  }

  initialize(): void {
    mkdirSync(this.root, { recursive: true });
    for (const collection of collections)
      mkdirSync(join(this.root, collection), { recursive: true });
    const auditPath = this.auditPath();
    if (!existsSync(auditPath))
      writeFileSync(auditPath, "", { encoding: "utf8", flag: "wx" });
  }

  path(collection: StoreCollection, id: string): string {
    assertSafeId(id);
    return join(this.root, collection, `${id}.json`);
  }

  put(
    collection: StoreCollection,
    id: string,
    value: unknown,
    options: { createOnly?: boolean; expectedDigest?: string } = {},
  ): string {
    this.initialize();
    assertNoLiteralSecrets(value);
    const target = this.path(collection, id);
    if (options.createOnly && existsSync(target)) {
      const current = readJson(target);
      if (digestJson(current) === digestJson(value)) return digestJson(current);
      throw new Error(
        `${collection}/${id} already exists with different content.`,
      );
    }
    if (options.expectedDigest) {
      if (!existsSync(target))
        throw new Error(`${collection}/${id} does not exist.`);
      const currentDigest = digestJson(readJson(target));
      if (currentDigest !== options.expectedDigest) {
        throw new Error(`${collection}/${id} changed since it was read.`);
      }
    }
    const temporary = join(
      dirname(target),
      `.${basename(target)}.${this.nonce()}.tmp`,
    );
    try {
      writeFileSync(temporary, formatJson(value), {
        encoding: "utf8",
        flag: "wx",
      });
      renameSync(temporary, target);
    } finally {
      if (existsSync(temporary)) unlinkSync(temporary);
    }
    return digestJson(value);
  }

  get<T = unknown>(collection: StoreCollection, id: string): T | undefined {
    const target = this.path(collection, id);
    return existsSync(target) ? (readJson(target) as T) : undefined;
  }

  list<T = unknown>(collection: StoreCollection): T[] {
    const directory = join(this.root, collection);
    if (!existsSync(directory)) return [];
    return readdirSync(directory)
      .filter((name) => name.endsWith(".json"))
      .sort()
      .map((name) => readJson(join(directory, name)) as T);
  }

  appendAudit(input: {
    runId: string;
    type: string;
    actor: Actor;
    payload: unknown;
  }): AuditEvent {
    this.initialize();
    assertSafeId(input.runId);
    assertNoLiteralSecrets(input.payload);
    const events = this.readAudit();
    const previous = events.at(-1);
    const withoutHash: Omit<AuditEvent, "hash"> = {
      sequence: events.length + 1,
      timestamp: this.now(),
      runId: input.runId,
      type: input.type,
      actor: input.actor,
      payloadDigest: digestJson(input.payload),
      previousHash: previous?.hash ?? "0".repeat(64),
    };
    const event: AuditEvent = { ...withoutHash, hash: auditHash(withoutHash) };
    const descriptor = openSync(this.auditPath(), "a");
    try {
      writeSync(descriptor, `${canonicalJson(event)}\n`, undefined, "utf8");
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    return event;
  }

  readAudit(): AuditEvent[] {
    const path = this.auditPath();
    if (!existsSync(path)) return [];
    const source = readFileSync(path, "utf8");
    if (!source.trim()) return [];
    return source
      .split(/\r?\n/u)
      .filter(Boolean)
      .map((line) => JSON.parse(line) as AuditEvent);
  }

  verifyAudit(events = this.readAudit()): boolean {
    let previousHash = "0".repeat(64);
    for (let index = 0; index < events.length; index += 1) {
      const event = events[index];
      if (
        !event ||
        event.sequence !== index + 1 ||
        event.previousHash !== previousHash
      )
        return false;
      const { hash, ...withoutHash } = event;
      if (!/^[a-f0-9]{64}$/u.test(hash) || auditHash(withoutHash) !== hash)
        return false;
      previousHash = hash;
    }
    return true;
  }

  snapshot(): FactorySnapshot {
    const audit = this.readAudit();
    return {
      generatedAt: this.now(),
      tasks: this.list("tasks"),
      runs: this.list("runs"),
      evidence: this.list("evidence"),
      assessmentResults: this.list("assessment-results"),
      policyDecisions: this.list("policy-decisions"),
      approvals: this.list("approvals"),
      observations: this.list("observations"),
      incidents: this.list("incidents"),
      promotions: this.list("promotions"),
      candidates: this.list("candidates"),
      metrics: this.list("metrics"),
      audit,
      auditValid: this.verifyAudit(audit),
    };
  }

  digest(collection: StoreCollection, id: string): string | undefined {
    const value = this.get(collection, id);
    return value === undefined ? undefined : digestJson(value);
  }

  private auditPath(): string {
    return join(this.root, "audit.jsonl");
  }
}
