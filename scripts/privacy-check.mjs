import {
  enumerateTrackedFiles,
  formatPublicIssue,
  inspectPublicCandidate,
  loadPublicReleaseManifest,
} from "./lib/public-candidate.mjs";

const forbidden = [
  { label: "private product name", pattern: /\u4fe1\u8c1b\u542c/iu },
  {
    label: "private client application name",
    pattern: /\u873b\u8713\u70b9\u91d1/iu,
  },
  {
    label: "private source path",
    pattern: /(?:C:\\\\|C:\/)(?:OneDrive|WorkBuddy)/iu,
  },
  { label: "private document portal", pattern: /yundoc\.csc\.com\.cn/iu },
  { label: "private source image", pattern: /image-2026080[67]/iu },
  {
    label: "private provider label",
    pattern: /DT\s*\u641c\u7d22|\u4e1c\u8d22\u63a5\u53e3/iu,
  },
];

const root = process.cwd();
let candidate;
try {
  const manifest = loadPublicReleaseManifest(root);
  candidate = inspectPublicCandidate({ manifest, root });
} catch (error) {
  console.error(`public.invalid-manifest: ${error.message}`);
  process.exit(1);
}

const violations = candidate.issues.map(formatPublicIssue);
let scannedTextFiles = 0;
for (const file of candidate.files) {
  if (file.kind !== "text" || file.content === undefined) continue;
  scannedTextFiles += 1;
  for (const rule of forbidden) {
    if (rule.pattern.test(file.content)) {
      violations.push(`${file.path}: ${rule.label}`);
    }
  }
}

let tracked = [];
try {
  tracked = enumerateTrackedFiles(root);
} catch {
  // A pre-commit workspace may have no tracked files yet; candidate scanning still runs.
}

for (const file of tracked) {
  if (file === "private" || file.startsWith("private/")) {
    violations.push(`${file}: local-only path is tracked`);
  }
}

if (violations.length > 0) {
  console.error(
    "Public-boundary violations detected:\n" +
      violations.map((item) => `- ${item}`).join("\n"),
  );
  process.exit(1);
}

console.log(
  `Privacy check passed (${scannedTextFiles} public text files scanned).`,
);
