import type { ControlValidationIssue } from "./types.js";

const sensitiveKeys = new Set([
  "password",
  "passwd",
  "secret",
  "token",
  "apikey",
  "privatekey",
  "accesskey",
  "accesstoken",
  "authtoken",
  "refreshtoken",
  "idtoken",
  "clientsecret",
  "clienttoken",
  "credential",
  "credentials",
  "authorization",
]);
const sensitiveCliFlag =
  /^--?(?:password|passwd|secret|token|api[-_]?key|private[-_]?key|access[-_]?(?:key|token)|auth[-_]?token|refresh[-_]?token|client[-_]?(?:secret|token)|credential)(?:=|$)/i;
const forbiddenMetadataKey =
  /^(?:reasoning|rawPrompt|raw_prompt|prompt|chainOfThought|chain_of_thought)$/i;
const secretPatterns: Array<{ label: string; pattern: RegExp }> = [
  {
    label: "private key",
    pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  },
  {
    label: "GitHub token",
    pattern: /\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/,
  },
  { label: "AWS access key", pattern: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/ },
  {
    label: "JWT",
    pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/,
  },
  { label: "DeepSeek key", pattern: /\bsk-[A-Za-z0-9_-]{20,}\b/ },
];

function isReference(value: string): boolean {
  return (
    /^(?:env|vault|secret|keychain):\/\//i.test(value) ||
    /^\$\{[A-Z][A-Z0-9_]*\}$/.test(value) ||
    /^\$\{\{\s*secrets\.[A-Z0-9_]+\s*\}\}$/i.test(value)
  );
}

function isSensitiveKey(key: string): boolean {
  return sensitiveKeys.has(
    key.replaceAll("-", "").replaceAll("_", "").toLowerCase(),
  );
}

/** Scan control documents and opaque input objects without logging their values. */
export function scanControlSecrets(value: unknown): ControlValidationIssue[] {
  const issues: ControlValidationIssue[] = [];
  const visit = (node: unknown, path: string, key?: string): void => {
    if (key && forbiddenMetadataKey.test(key)) {
      issues.push({
        code: "control.metadata.forbidden-field",
        message:
          "Raw prompts and model reasoning are forbidden; record only safe digests and identifiers.",
        path,
      });
      return;
    }
    if (typeof node === "string") {
      if (isReference(node)) return;
      if (sensitiveCliFlag.test(node) && node.includes("=")) {
        const literal = node.slice(node.indexOf("=") + 1);
        if (literal.length > 0 && !isReference(literal)) {
          issues.push({
            code: "control.secret.literal-command-argument",
            message:
              "A command argument appears to contain a literal credential; inject it through process memory instead.",
            path,
          });
        }
      }
      if (key && isSensitiveKey(key) && node.trim().length > 0) {
        issues.push({
          code: "control.secret.literal-sensitive-field",
          message:
            "A possible literal credential was found; use process environment or in-memory secret injection.",
          path,
        });
      }
      for (const detector of secretPatterns) {
        if (detector.pattern.test(node)) {
          issues.push({
            code: "control.secret.detected",
            message: `A possible ${detector.label} was found; secret values are forbidden.`,
            path,
          });
        }
      }
      return;
    }
    if (Array.isArray(node)) {
      node.forEach((child, index) => {
        const previous = node[index - 1];
        if (
          typeof child === "string" &&
          typeof previous === "string" &&
          sensitiveCliFlag.test(previous) &&
          !previous.includes("=") &&
          child.trim().length > 0 &&
          !isReference(child)
        ) {
          issues.push({
            code: "control.secret.literal-command-argument",
            message:
              "A command argument appears to contain a literal credential; inject it through process memory instead.",
            path: `${path}/${index}`,
          });
        }
        visit(child, `${path}/${index}`);
      });
      return;
    }
    if (node !== null && typeof node === "object") {
      for (const [childKey, child] of Object.entries(node).sort(
        ([left], [right]) => (left < right ? -1 : left > right ? 1 : 0),
      )) {
        visit(child, `${path}/${childKey}`, childKey);
      }
    }
  };
  visit(value, "");
  return issues;
}
