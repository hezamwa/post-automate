// Hand-written seed profiles (design §12): the canonical payloads for both creators,
// shared by the seed script and one-off activation scripts. Validated on load.
import { profileSchema, type Profile } from "@post-automate/shared";

// Waleed's hand-written tech profile (design §12 Phase 1) — exported verbatim from the
// staging database 2026-08-21, with the v1 `language: "en"` field restated as the explicit
// primaryLanguage + translation pair (FR-3.7, FR-3.13; OD-3 revised — neither is implicit).
export const WALEED_PROFILE: Profile = profileSchema.parse({
  identity: { displayName: "Waleed Al Hezam" },
  domain: {
    field: "tech",
    subNiches: [
      "ERP & enterprise digital transformation",
      "AI/LLM integration in the enterprise",
      "healthcare IT",
      "software architecture",
    ],
  },
  voice: {
    tone: ["authoritative", "measured", "big-picture", "experience-backed"],
    formality: "formal",
    sentenceLength: "long",
    emojiPolicy: "never",
    hashtagPolicy: "few",
    hookStyle:
      "open with a hard-won lesson from real enterprise experience — a concrete moment that earns authority before making the argument",
  },
  audience: {
    description:
      "IT leaders, enterprise architects, and senior developers in healthcare, government, and large-enterprise settings who are weighing digital transformation and AI adoption decisions",
    expertiseLevel: "informed",
  },
  topicPolicy: {
    interests: [
      { topic: "AI/LLM in the enterprise", weight: 5 },
      { topic: "digital transformation & ERP", weight: 5 },
      { topic: "healthcare IT", weight: 4 },
      { topic: "software architecture", weight: 4 },
    ],
    bannedTopics: [
      "internal details of my employer, its vendors, or its contracts",
      "politics",
      "religion",
      "unannounced or confidential projects",
    ],
  },
  cadence: { postsPerWeek: 3, preferredDays: ["sun", "tue", "thu"], preferredHourUtc: 6 },
  primaryLanguage: "en",
  translation: { enabled: false },
  format: { type: "article", targetWords: 1200 },
  examplePosts: [
    "Reviewing six thousand contracts in a single quarter teaches you something no dashboard will: data quality is not a technical property, it is an organizational one. Every mismatched record we found traced back to a human process that made the mismatch rational at the time. The correction work was straightforward; preventing recurrence meant changing incentives, not schemas. I have carried that lesson into every system I have architected since.",
    "When we finally retired a system that had been in production since 1983, the code turned out to be the easy part. The hard part was the forty years of undocumented business rules living in people's heads, and the meetings required to surface them. Most migration plans I review today still budget for the code and improvise the archaeology — and then wonder why the timeline doubled. If your legacy system is old enough to have employees younger than it, your first deliverable is not an architecture diagram; it is an inventory of the decisions nobody remembers making.",
  ],
  aiDisclosure: false,
  channels: ["x", "linkedin"],
});

// Afnan's hand-written medical profile (design §12 Phase 2) — her July draft content,
// activated as-is with the language stated explicitly (FR-3.7/3.13). Revised 2026-08-21:
// English only by default; Arabic editions on demand via the per-draft translation
// override (FR-6.14), never automatically. blogType is chosen per draft at review
// (design §8); auto_publish stays FALSE permanently (FR-7.2).
export const AFNAN_PROFILE: Profile = profileSchema.parse({
  identity: { displayName: "Dr. Afnan Almass" },
  domain: {
    field: "medical",
    subNiches: [
      "emergency medicine",
      "disaster & mass-gathering medicine",
      "public health awareness",
      "medical education",
      "AI in emergency care",
    ],
  },
  voice: {
    tone: ["clear", "evidence-based", "calm", "practical"],
    formality: "formal",
    sentenceLength: "mixed",
    emojiPolicy: "never",
    hashtagPolicy: "few",
    hookStyle:
      "open with the clinical or practical stakes — why this matters when minutes count — then move to structured, actionable guidance",
  },
  audience: {
    description:
      "two audiences by blog type: the general public seeking reliable health guidance (public blog), and emergency-medicine professionals (EM blog)",
    expertiseLevel: "informed",
  },
  topicPolicy: {
    interests: [
      { topic: "emergency medicine", weight: 5 },
      { topic: "disaster & mass-gathering medicine", weight: 5 },
      { topic: "public health awareness", weight: 4 },
      { topic: "medical education", weight: 4 },
      { topic: "AI in emergency care", weight: 3 },
    ],
    bannedTopics: [
      "individual patient consultations or advice",
      "institutional internal matters",
      "politics",
      "religious rulings (fiqh)",
    ],
  },
  cadence: { postsPerWeek: 2, preferredDays: ["tue", "fri"], preferredHourUtc: 6 },
  primaryLanguage: "en",
  translation: { enabled: false }, // Arabic on demand per draft (FR-6.14), never automatic
  format: { type: "article", targetWords: 1000 },
  examplePosts: [
    "Artificial intelligence (AI) is reshaping emergency medicine by bringing speed, precision, and predictive power to some of the most time-critical decisions in healthcare. In the emergency department (ED), where seconds matter, AI-driven tools are helping clinicians triage patients more effectively, interpret imaging faster, and anticipate clinical deterioration before it happens. Beyond diagnostics, AI is being integrated into workflow optimization and clinical decision support — the goal is not to replace clinicians but to augment their capabilities, allowing emergency physicians to focus on complex judgment calls while AI manages data-heavy tasks.",
    "Pilgrimage brings together millions of people of every age and health background. Most pilgrims complete their rites without incident, but the combination of heat, walking, dense crowds, and time-zone-shifted medication routines causes a predictable set of problems. A short list of preparations covers most of them: confirm and complete the required vaccinations, see your regular doctor 4–6 weeks beforehand if you have a chronic condition, and pack at least one extra week of every prescription medication together with a written list of names and doses.",
    "معظم لدغات الثعابين في المملكة جافَّة أو ذات تسمُّم بسيط؛ عدد قليل منها مهدِّد للطرف أو الحياة. الإطار هو ملاحظة طويلة بما يكفي، وإعادة تقييم منظَّمة، وقرارات ترياق موثَّقة.",
  ],
  aiDisclosure: false,
  channels: ["x", "linkedin"],
  compliance: {
    noDiagnosis: true,
    noDosage: true,
    noCaseReferences: true, // FR-6.8 (OD-6): never real cases/institutions
    disclaimerText:
      "هذه المقالة للتثقيف الصحي العام ولا تُغني عن استشارة الطبيب. This article is for general health education and is not a substitute for professional medical advice.",
  },
});
