import type { Profile } from "@post-automate/shared";
import type { Article, QualityCheck, QualityFinding } from "./types";

// The deterministic half of quality-check (spec §3 step 8; design §16 "check shape"):
// what code can decide, code decides — the judge model covers the rest, and a code
// finding for the same check wins over the judge's.

export function wordCount(markdown: string): number {
  return markdown.split(/\s+/).filter(Boolean).length;
}

export function deterministicChecks(profile: Profile, article: Article): QualityFinding[] {
  const findings: QualityFinding[] = [];
  const target = profile.format?.targetWords ?? 1200;
  const words = wordCount(article.markdown);
  findings.push({
    check: "length",
    ok: words >= target * 0.6 && words <= target * 1.6,
    note: `${words} words against a target of ~${target}`,
  });
  if (profile.domain.field === "medical" && profile.compliance) {
    const present = article.markdown.includes(profile.compliance.disclaimerText);
    findings.push({ check: "disclaimer", ok: present, note: present ? "disclaimer block present" : "the required disclaimer block is missing (FR-6.6)" });
  }
  return findings;
}

/** Judge findings + code findings, code winning per check; passed = every check ok. */
export function mergeQuality(judge: QualityFinding[], code: QualityFinding[], autoRevised = false): QualityCheck {
  const byCheck = new Map(judge.map((f) => [f.check, f]));
  for (const f of code) byCheck.set(f.check, f);
  const findings = [...byCheck.values()];
  return { passed: findings.every((f) => f.ok), autoRevised, findings };
}

/** Findings as revision instructions for the one automatic revise. */
export function findingsAsInstructions(quality: QualityCheck): string {
  const failed = quality.findings.filter((f) => !f.ok);
  return `The quality check found these problems — fix every one of them:\n${failed.map((f) => `- ${f.check}: ${f.note}`).join("\n")}`;
}
