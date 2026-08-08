import { canonicalJson, sha256, ZERO_DIGEST } from "./canonical.js";
import type { ActorRef, AuditEvent, Digest } from "./types.js";

export interface NewAuditEvent {
  occurredAt: string;
  actor: ActorRef;
  type: string;
  payload: Record<string, unknown>;
}

function eventHash(event: Omit<AuditEvent, "hash">): Digest {
  return sha256(canonicalJson(event));
}

/** Append without mutating the caller's trail. */
export function appendAuditEvent(
  trail: readonly AuditEvent[],
  input: NewAuditEvent,
): { trail: AuditEvent[]; head: Digest } {
  const currentHead = trail.at(-1)?.hash ?? ZERO_DIGEST;
  const verification = verifyAuditTrail(trail, currentHead);
  if (!verification.valid)
    throw new Error(
      `Cannot append to an invalid audit trail: ${verification.reason ?? "unknown"}.`,
    );
  const previousHash = currentHead;
  const actor = structuredClone(input.actor);
  const payload = structuredClone(input.payload);
  const withoutHash: Omit<AuditEvent, "hash"> = {
    sequence: trail.length,
    occurredAt: input.occurredAt,
    actor,
    type: input.type,
    payload,
    payloadDigest: sha256(payload),
    previousHash,
  };
  const event: AuditEvent = { ...withoutHash, hash: eventHash(withoutHash) };
  return { trail: [...trail, event], head: event.hash };
}

/** The expected head is the external anchor that also detects suffix truncation. */
export function verifyAuditTrail(
  trail: readonly AuditEvent[],
  expectedHead: Digest,
): { valid: boolean; index?: number; reason?: string } {
  let previousHash = ZERO_DIGEST;
  for (let index = 0; index < trail.length; index += 1) {
    const event = trail[index]!;
    if (event.sequence !== index)
      return { valid: false, index, reason: "sequence mismatch" };
    if (event.previousHash !== previousHash)
      return { valid: false, index, reason: "previous hash mismatch" };
    if (event.payloadDigest !== sha256(event.payload))
      return { valid: false, index, reason: "payload digest mismatch" };
    const { hash: _hash, ...withoutHash } = event;
    if (event.hash !== eventHash(withoutHash))
      return { valid: false, index, reason: "event hash mismatch" };
    previousHash = event.hash;
  }
  if (previousHash !== expectedHead)
    return {
      valid: false,
      index: trail.length,
      reason: "anchored head mismatch",
    };
  return { valid: true };
}
