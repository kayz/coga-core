import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import type {
  ArchivedEvidenceKind,
  EvidenceArchiveReceipt,
  EvidenceArchiveRequest,
  ImmutableEvidenceStore,
} from "./operations-types.js";
import { FACTORY_OPERATIONS_SCHEMA_VERSION } from "./operations-types.js";
import type { Sha256Digest } from "./types.js";

const DIGEST = /^sha256:[0-9a-f]{64}$/u;
const RECEIPT_NAME = /^([0-9a-f]{64})\.json$/u;
const DEFAULT_MAX_EVIDENCE_BYTES = 5 * 1024 * 1024;
const DEFAULT_MAX_RECEIPT_BYTES = 64 * 1024;
const DEFAULT_MAX_JSON_NODES = 100_000;
const DEFAULT_MAX_JSON_DEPTH = 64;
const DEFAULT_MAX_RECEIPTS = 10_000;
const utf8 = new TextDecoder("utf-8", { fatal: true });

export interface ImmutableEvidenceStoreOptions {
  root: string;
  sourceRoot?: string;
  now?: () => Date;
  maxEvidenceBytes?: number;
  maxReceiptBytes?: number;
  maxJsonNodes?: number;
  maxJsonDepth?: number;
  maxReceipts?: number;
}

function digest(value: Buffer | string): Sha256Digest {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalValue(value: unknown, depth = 0): unknown {
  if (depth > DEFAULT_MAX_JSON_DEPTH)
    throw new Error("Evidence JSON exceeds its canonical depth budget.");
  if (Array.isArray(value))
    return value.map((child) => canonicalValue(child, depth + 1));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => compareText(left, right))
        .map(([key, child]) => [key, canonicalValue(child, depth + 1)]),
    );
  }
  return value;
}

function canonicalJson(value: unknown): string {
  return `${JSON.stringify(canonicalValue(value), null, 2)}\n`;
}

function isWithin(root: string, candidate: string): boolean {
  const difference = relative(root, candidate);
  return (
    difference === "" ||
    (!difference.startsWith(`..${sep}`) &&
      difference !== ".." &&
      !isAbsolute(difference))
  );
}

function assertBudget(
  value: number,
  minimum: number,
  maximum: number,
  label: string,
): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${label} is outside its supported budget.`);
  }
  return value;
}

function readBoundedRegularFile(
  path: string,
  maxBytes: number,
  label: string,
): Buffer {
  const before = lstatSync(path);
  if (before.isSymbolicLink() || !before.isFile()) {
    throw new Error(
      `${label} must be a regular file, not a link or special object.`,
    );
  }
  if (before.size > maxBytes)
    throw new Error(`${label} exceeds the ${maxBytes}-byte limit.`);
  const noFollow = "O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0;
  const handle = openSync(path, constants.O_RDONLY | noFollow);
  try {
    const opened = fstatSync(handle);
    if (
      !opened.isFile() ||
      opened.size !== before.size ||
      opened.size > maxBytes
    ) {
      throw new Error(`${label} changed while it was being opened.`);
    }
    const output = Buffer.alloc(opened.size);
    let offset = 0;
    while (offset < output.length) {
      const count = readSync(
        handle,
        output,
        offset,
        output.length - offset,
        offset,
      );
      if (count === 0)
        throw new Error(`${label} changed while it was being read.`);
      offset += count;
    }
    const after = fstatSync(handle);
    if (after.size !== opened.size || after.mtimeMs !== opened.mtimeMs) {
      throw new Error(`${label} changed while it was being read.`);
    }
    return output;
  } finally {
    closeSync(handle);
  }
}

function preflightJson(
  text: string,
  maxDepth: number,
  maxNodes: number,
  label: string,
): void {
  let depth = 0;
  let nodes = 0;
  let inString = false;
  let escaped = false;
  for (const character of text) {
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      inString = true;
      nodes += 1;
    } else if (character === "{" || character === "[") {
      depth += 1;
      nodes += 1;
      if (depth > maxDepth)
        throw new Error(`${label} exceeds the JSON depth budget.`);
    } else if (character === "}" || character === "]") {
      depth -= 1;
      if (depth < 0)
        throw new Error(`${label} contains malformed JSON structure.`);
    } else if (character === "," || character === ":") {
      nodes += 1;
    }
    if (nodes > maxNodes * 3)
      throw new Error(`${label} exceeds the JSON node budget.`);
  }
  if (inString || depth !== 0)
    throw new Error(`${label} contains incomplete JSON.`);
}

function countJsonNodes(
  value: unknown,
  maxDepth: number,
  maxNodes: number,
  label: string,
): void {
  const stack: Array<{ value: unknown; depth: number }> = [{ value, depth: 1 }];
  let nodes = 0;
  while (stack.length) {
    const current = stack.pop();
    if (!current) break;
    nodes += 1;
    if (nodes > maxNodes)
      throw new Error(`${label} exceeds the JSON node budget.`);
    if (current.depth > maxDepth)
      throw new Error(`${label} exceeds the JSON depth budget.`);
    if (Array.isArray(current.value)) {
      for (const child of current.value)
        stack.push({ value: child, depth: current.depth + 1 });
    } else if (current.value && typeof current.value === "object") {
      for (const child of Object.values(
        current.value as Record<string, unknown>,
      )) {
        stack.push({ value: child, depth: current.depth + 1 });
      }
    }
  }
}

function parseBoundedJson(
  value: Buffer,
  maxDepth: number,
  maxNodes: number,
  label: string,
): Record<string, unknown> {
  let text: string;
  try {
    text = utf8.decode(value);
  } catch {
    throw new Error(`${label} is not valid UTF-8 JSON.`);
  }
  preflightJson(text, maxDepth, maxNodes, label);
  let document: unknown;
  try {
    document = JSON.parse(text) as unknown;
  } catch {
    throw new Error(`${label} is not valid JSON.`);
  }
  if (!document || typeof document !== "object" || Array.isArray(document)) {
    throw new Error(`${label} must contain a JSON object.`);
  }
  countJsonNodes(document, maxDepth, maxNodes, label);
  return document as Record<string, unknown>;
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} is invalid.`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  label: string,
): void {
  if (
    JSON.stringify(Object.keys(value).sort(compareText)) !==
    JSON.stringify([...expected].sort(compareText))
  ) {
    throw new Error(`${label} contains missing or additional fields.`);
  }
}

function logicalEvidence(
  document: Record<string, unknown>,
  requestedKind?: ArchivedEvidenceKind,
): { kind: ArchivedEvidenceKind; logicalDigest: Sha256Digest } {
  const kind = document.kind;
  if (
    kind !== "EvidenceBundle" &&
    kind !== "RemoteEvidence" &&
    kind !== "PlatformEvidence"
  ) {
    throw new Error("Evidence document kind is not archivable.");
  }
  if (requestedKind && requestedKind !== kind)
    throw new Error(
      "Evidence document kind does not match the archive request.",
    );
  const metadata = object(document.metadata, "Evidence metadata");
  const field =
    kind === "EvidenceBundle"
      ? "bundleDigest"
      : kind === "RemoteEvidence"
        ? "remoteEvidenceDigest"
        : "evidenceDigest";
  const declared = metadata[field];
  if (typeof declared !== "string" || !DIGEST.test(declared)) {
    throw new Error(`${kind} has an invalid logical digest.`);
  }
  const { [field]: _ignored, ...metadataPayload } = metadata;
  const actual = digest(
    canonicalJson({ ...document, metadata: metadataPayload }),
  );
  if (actual !== declared) throw new Error(`${kind} logical digest mismatch.`);
  return { kind, logicalDigest: declared as Sha256Digest };
}

function receiptPayload(receipt: EvidenceArchiveReceipt): unknown {
  const { receiptDigest: _ignored, ...metadata } = receipt.metadata;
  return { ...receipt, metadata };
}

function receiptDigest(receipt: EvidenceArchiveReceipt): Sha256Digest {
  return digest(canonicalJson(receiptPayload(receipt)));
}

function receiptRelativePath(receipt: EvidenceArchiveReceipt): string {
  return `receipts/sha256/${receipt.metadata.receiptDigest.slice("sha256:".length)}.json`;
}

function validateReceiptShape(
  document: Record<string, unknown>,
): EvidenceArchiveReceipt {
  if (
    document.schemaVersion !== FACTORY_OPERATIONS_SCHEMA_VERSION ||
    document.kind !== "EvidenceArchiveReceipt"
  ) {
    throw new Error("Evidence archive receipt identity is invalid.");
  }
  const metadata = object(
    document.metadata,
    "Evidence archive receipt metadata",
  );
  const subject = object(document.subject, "Evidence archive receipt subject");
  const retention = object(
    document.retention,
    "Evidence archive receipt retention",
  );
  exactKeys(
    document,
    ["schemaVersion", "kind", "metadata", "subject", "retention"],
    "Evidence archive receipt",
  );
  exactKeys(
    metadata,
    ["archivedAt", "receiptDigest"],
    "Evidence archive receipt metadata",
  );
  exactKeys(
    subject,
    [
      "kind",
      "logicalDigest",
      "byteDigest",
      "bytes",
      "objectPath",
      "sourceName",
    ],
    "Evidence archive receipt subject",
  );
  exactKeys(
    retention,
    ["immutable", "policy", "retainUntil"],
    "Evidence archive receipt retention",
  );
  if (
    typeof metadata.archivedAt !== "string" ||
    !Number.isFinite(Date.parse(metadata.archivedAt)) ||
    typeof metadata.receiptDigest !== "string" ||
    !DIGEST.test(metadata.receiptDigest) ||
    (subject.kind !== "EvidenceBundle" &&
      subject.kind !== "RemoteEvidence" &&
      subject.kind !== "PlatformEvidence") ||
    typeof subject.logicalDigest !== "string" ||
    !DIGEST.test(subject.logicalDigest) ||
    typeof subject.byteDigest !== "string" ||
    !DIGEST.test(subject.byteDigest) ||
    !Number.isSafeInteger(subject.bytes) ||
    Number(subject.bytes) < 1 ||
    typeof subject.objectPath !== "string" ||
    !/^objects\/sha256\/[0-9a-f]{64}\.bin$/u.test(subject.objectPath) ||
    typeof subject.sourceName !== "string" ||
    subject.sourceName.length < 1 ||
    subject.sourceName.length > 255 ||
    retention.immutable !== true ||
    typeof retention.policy !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,199}$/u.test(retention.policy) ||
    typeof retention.retainUntil !== "string" ||
    !Number.isFinite(Date.parse(retention.retainUntil)) ||
    Date.parse(retention.retainUntil) <= Date.parse(metadata.archivedAt)
  ) {
    throw new Error("Evidence archive receipt fields are invalid.");
  }
  return document as unknown as EvidenceArchiveReceipt;
}

function writeExclusiveOrCompare(
  path: string,
  value: Buffer | string,
  maxBytes: number,
  label: string,
): void {
  const bytes = typeof value === "string" ? Buffer.from(value, "utf8") : value;
  try {
    writeFileSync(path, bytes, { flag: "wx", mode: 0o444 });
  } catch (error) {
    const code =
      error && typeof error === "object" && "code" in error
        ? String(error.code)
        : "";
    if (code !== "EEXIST") throw error;
    const existing = readBoundedRegularFile(path, maxBytes, label);
    if (!existing.equals(bytes))
      throw new Error(`${label} content-address collision detected.`);
  }
}

export class FileSystemImmutableEvidenceStore
  implements ImmutableEvidenceStore
{
  readonly #root: string;
  readonly #sourceRoot: string;
  readonly #objects: string;
  readonly #receipts: string;
  readonly #now: () => Date;
  readonly #maxEvidenceBytes: number;
  readonly #maxReceiptBytes: number;
  readonly #maxJsonNodes: number;
  readonly #maxJsonDepth: number;
  readonly #maxReceipts: number;

  constructor(options: ImmutableEvidenceStoreOptions) {
    this.#maxEvidenceBytes = assertBudget(
      options.maxEvidenceBytes ?? DEFAULT_MAX_EVIDENCE_BYTES,
      1,
      50 * 1024 * 1024,
      "Evidence byte limit",
    );
    this.#maxReceiptBytes = assertBudget(
      options.maxReceiptBytes ?? DEFAULT_MAX_RECEIPT_BYTES,
      1024,
      1024 * 1024,
      "Receipt byte limit",
    );
    this.#maxJsonNodes = assertBudget(
      options.maxJsonNodes ?? DEFAULT_MAX_JSON_NODES,
      10,
      1_000_000,
      "Evidence JSON node limit",
    );
    this.#maxJsonDepth = assertBudget(
      options.maxJsonDepth ?? DEFAULT_MAX_JSON_DEPTH,
      4,
      128,
      "Evidence JSON depth limit",
    );
    this.#maxReceipts = assertBudget(
      options.maxReceipts ?? DEFAULT_MAX_RECEIPTS,
      1,
      100_000,
      "Evidence receipt count limit",
    );
    this.#now = options.now ?? (() => new Date());
    mkdirSync(resolve(options.root), { recursive: true, mode: 0o700 });
    this.#root = realpathSync(resolve(options.root));
    this.#sourceRoot = realpathSync(
      resolve(options.sourceRoot ?? process.cwd()),
    );
    this.#objects = this.#directory("objects/sha256");
    this.#receipts = this.#directory("receipts/sha256");
  }

  #directory(portablePath: string): string {
    let current = this.#root;
    for (const segment of portablePath.split("/")) {
      const candidate = join(current, segment);
      mkdirSync(candidate, { mode: 0o700 });
      const info = lstatSync(candidate);
      if (info.isSymbolicLink() || !info.isDirectory()) {
        throw new Error(
          "Evidence store path contains a link or non-directory.",
        );
      }
      const actual = realpathSync(candidate);
      if (!isWithin(this.#root, actual))
        throw new Error("Evidence store path escapes its root.");
      current = actual;
    }
    return current;
  }

  #assertStoreStable(): void {
    if (realpathSync(this.#root) !== this.#root)
      throw new Error("Evidence store root identity changed.");
    for (const directory of [this.#objects, this.#receipts]) {
      const info = lstatSync(directory);
      if (
        info.isSymbolicLink() ||
        !info.isDirectory() ||
        !isWithin(this.#root, realpathSync(directory))
      ) {
        throw new Error("Evidence store directory identity changed.");
      }
    }
  }

  #source(path: string): string {
    const absolute = resolve(this.#sourceRoot, path);
    if (!isWithin(this.#sourceRoot, absolute))
      throw new Error("Evidence source escapes the configured source root.");
    const info = lstatSync(absolute);
    if (info.isSymbolicLink() || !info.isFile())
      throw new Error("Evidence source must be a regular file, not a link.");
    const actual = realpathSync(absolute);
    if (!isWithin(this.#sourceRoot, actual))
      throw new Error("Evidence source resolves outside its configured root.");
    return actual;
  }

  #readReceipt(path: string): EvidenceArchiveReceipt {
    const raw = readBoundedRegularFile(
      path,
      this.#maxReceiptBytes,
      "Evidence archive receipt",
    );
    const document = parseBoundedJson(
      raw,
      this.#maxJsonDepth,
      this.#maxJsonNodes,
      "Evidence archive receipt",
    );
    const receipt = validateReceiptShape(document);
    if (receiptDigest(receipt) !== receipt.metadata.receiptDigest) {
      throw new Error("Evidence archive receipt digest mismatch.");
    }
    return receipt;
  }

  #existingReceipt(
    kind: ArchivedEvidenceKind,
    logicalDigest: Sha256Digest,
    byteDigest: Sha256Digest,
    retentionPolicy: string,
    retainUntil: string,
  ): EvidenceArchiveReceipt | undefined {
    const names = readdirSync(this.#receipts);
    if (names.length > this.#maxReceipts)
      throw new Error("Evidence receipt store exceeds its enumeration budget.");
    for (const name of names.sort(compareText)) {
      if (!RECEIPT_NAME.test(name))
        throw new Error(
          "Evidence receipt store contains an unclassified entry.",
        );
      const receipt = this.#readReceipt(join(this.#receipts, name));
      if (
        receipt.subject.kind === kind &&
        receipt.subject.logicalDigest === logicalDigest &&
        receipt.subject.byteDigest === byteDigest &&
        receipt.retention.policy === retentionPolicy &&
        receipt.retention.retainUntil === retainUntil
      ) {
        this.verify(receiptRelativePath(receipt));
        return receipt;
      }
    }
    if (names.length >= this.#maxReceipts) {
      throw new Error(
        "Evidence receipt store has reached its receipt count limit.",
      );
    }
    return undefined;
  }

  archive(request: EvidenceArchiveRequest): EvidenceArchiveReceipt {
    this.#assertStoreStable();
    if (
      !/^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,199}$/u.test(request.retentionPolicy)
    ) {
      throw new Error("Evidence retention policy is invalid.");
    }
    const now = this.#now();
    const retainUntil = new Date(request.retainUntil);
    if (
      !Number.isFinite(now.getTime()) ||
      !Number.isFinite(retainUntil.getTime()) ||
      retainUntil.getTime() <= now.getTime()
    ) {
      throw new Error(
        "Evidence retention deadline must be after archive time.",
      );
    }
    const source = this.#source(request.path);
    const raw = readBoundedRegularFile(
      source,
      this.#maxEvidenceBytes,
      "Evidence source",
    );
    if (raw.byteLength < 1) throw new Error("Evidence source cannot be empty.");
    const document = parseBoundedJson(
      raw,
      this.#maxJsonDepth,
      this.#maxJsonNodes,
      "Evidence source",
    );
    const logical = logicalEvidence(document, request.kind);
    const byteDigest = digest(raw);
    const normalizedRetainUntil = retainUntil.toISOString();
    const sourceName = basename(source);
    if (
      sourceName.length < 1 ||
      sourceName.length > 255 ||
      /[/\\\u0000-\u001f\u007f]/u.test(sourceName)
    ) {
      throw new Error("Evidence source name is invalid.");
    }
    const existing = this.#existingReceipt(
      logical.kind,
      logical.logicalDigest,
      byteDigest,
      request.retentionPolicy,
      normalizedRetainUntil,
    );
    if (existing) return existing;

    const objectPath = `objects/sha256/${byteDigest.slice("sha256:".length)}.bin`;
    writeExclusiveOrCompare(
      join(this.#objects, basename(objectPath)),
      raw,
      this.#maxEvidenceBytes,
      "Evidence object",
    );
    const receipt: EvidenceArchiveReceipt = {
      schemaVersion: FACTORY_OPERATIONS_SCHEMA_VERSION,
      kind: "EvidenceArchiveReceipt",
      metadata: {
        archivedAt: now.toISOString(),
        receiptDigest: `sha256:${"0".repeat(64)}`,
      },
      subject: {
        kind: logical.kind,
        logicalDigest: logical.logicalDigest,
        byteDigest,
        bytes: raw.byteLength,
        objectPath,
        sourceName,
      },
      retention: {
        immutable: true,
        policy: request.retentionPolicy,
        retainUntil: normalizedRetainUntil,
      },
    };
    receipt.metadata.receiptDigest = receiptDigest(receipt);
    const content = canonicalJson(receipt);
    if (Buffer.byteLength(content, "utf8") > this.#maxReceiptBytes) {
      throw new Error("Evidence archive receipt exceeds its byte budget.");
    }
    writeExclusiveOrCompare(
      join(
        this.#receipts,
        `${receipt.metadata.receiptDigest.slice("sha256:".length)}.json`,
      ),
      content,
      this.#maxReceiptBytes,
      "Evidence archive receipt",
    );
    return this.verify(receiptRelativePath(receipt));
  }

  verify(receiptPath: string): EvidenceArchiveReceipt {
    this.#assertStoreStable();
    if (!/^receipts\/sha256\/[0-9a-f]{64}\.json$/u.test(receiptPath)) {
      throw new Error(
        "Evidence receipt path is not a canonical content-addressed path.",
      );
    }
    const absolute = resolve(this.#root, receiptPath);
    if (!isWithin(this.#root, absolute))
      throw new Error("Evidence receipt path escapes the store root.");
    const receiptInfo = lstatSync(absolute);
    if (receiptInfo.isSymbolicLink() || !receiptInfo.isFile()) {
      throw new Error("Evidence receipt must be a regular file, not a link.");
    }
    const actual = realpathSync(absolute);
    if (!isWithin(this.#receipts, actual))
      throw new Error("Evidence receipt is outside the receipt archive.");
    const name = basename(actual);
    const match = RECEIPT_NAME.exec(name);
    if (!match)
      throw new Error("Evidence receipt path is not content-addressed.");
    const receipt = this.#readReceipt(actual);
    if (match[1] !== receipt.metadata.receiptDigest.slice("sha256:".length)) {
      throw new Error("Evidence receipt path does not match its digest.");
    }
    const objectAbsolute = resolve(
      this.#root,
      ...receipt.subject.objectPath.split("/"),
    );
    if (!isWithin(this.#objects, objectAbsolute))
      throw new Error("Evidence object path escapes its archive.");
    const objectInfo = lstatSync(objectAbsolute);
    if (objectInfo.isSymbolicLink() || !objectInfo.isFile()) {
      throw new Error("Evidence object must be a regular file, not a link.");
    }
    const objectActual = realpathSync(objectAbsolute);
    if (!isWithin(this.#objects, objectActual))
      throw new Error("Evidence object resolves outside its archive.");
    const raw = readBoundedRegularFile(
      objectActual,
      this.#maxEvidenceBytes,
      "Evidence object",
    );
    if (
      raw.byteLength !== receipt.subject.bytes ||
      digest(raw) !== receipt.subject.byteDigest
    ) {
      throw new Error("Evidence object byte integrity verification failed.");
    }
    const document = parseBoundedJson(
      raw,
      this.#maxJsonDepth,
      this.#maxJsonNodes,
      "Evidence object",
    );
    const logical = logicalEvidence(document, receipt.subject.kind);
    if (logical.logicalDigest !== receipt.subject.logicalDigest) {
      throw new Error("Evidence object logical integrity verification failed.");
    }
    return receipt;
  }
}

export { FileSystemImmutableEvidenceStore as ImmutableFileEvidenceStore };
export function evidenceArchiveReceiptPath(
  receipt: EvidenceArchiveReceipt,
): string {
  return receiptRelativePath(receipt);
}
