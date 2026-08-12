import {
  formatPublicIssue,
  inspectPublicCandidate,
  loadPublicReleaseManifest,
} from "./lib/public-candidate.mjs";

const root = process.cwd();

let manifest;
let candidate;
try {
  manifest = loadPublicReleaseManifest(root);
  candidate = inspectPublicCandidate({ manifest, root });
} catch (error) {
  console.error(`public.invalid-manifest: ${error.message}`);
  process.exit(1);
}

const issues = candidate.issues;

if (issues.length > 0) {
  console.error(
    "Public-boundary violations detected:\n" +
      issues.map((item) => `- ${formatPublicIssue(item)}`).join("\n"),
  );
  process.exit(1);
}

console.log(
  `Public boundary passed (${candidate.entries.length} candidate files, ${candidate.totalBytes} bytes).`,
);
