/**
 * Per-goalType heuristic assertions used to score the *downstream*
 * curriculum quality once the classifier has emitted its verdict.
 *
 * The classifier loop (Step 2 + Step 2b) is already strict-asserted
 * upstream. These assertions cover the gap the audit flagged: that
 * once a goalType is decided, the rest of the pipeline (clarify
 * answers, generated structure, lesson shape) is treated as
 * interchangeable. A regression that breaks only `pass` exam-mock
 * shaping or only `build` project-spine ordering would otherwise
 * pass the orchestrator suite cleanly.
 *
 * Heuristics are deterministic keyword/regex matches — no LLM-judge.
 * Cheaper, faster, and free of inter-run flakiness, but with the
 * usual false-negative caveats. Each assertion is annotated with a
 * `verdict: 'pass' | 'fail' | 'n-a'` and an evidence string so the
 * markdown report stays honest about what was checked.
 *
 * Source-of-truth contracts:
 *  - Clarify-question tilt:
 *      api/src/services/courseService.ts:206-213
 *  - Structure tilt:
 *      api/src/services/courseService.ts:856-867
 */

import type { CourseStructure, GoalType } from './types';

// ── Clarify-answer prompt tilt ───────────────────────────
//
// Surfaced into `answerQuestionsAsPersona`'s system prompt so the
// persona LLM behaves *like a learner from the named bucket* when
// answering free-text questions, not just like a generic learner
// with the persona's surveyStyle on top. Without this, a `pass`
// persona answers "what's your timeline?" with "soon" and the
// orchestrator never asserts the exam name made it into any answer.

export const GOAL_TYPE_ANSWER_TILT: Record<GoalType, string> = {
  master:
    'No special tilt — answer questions about your background, prior tools, and learning preferences with the level of detail your survey style would produce.',
  monetize:
    'You are a learner whose deliverable is REVENUE / AUDIENCE / CHANNEL / CLIENTS. When a free-text question asks about your goal, niche, audience, or product — name something concrete and specific (e.g. "silver-jewelry ecomm store", "B2B SaaS founders on LinkedIn", "Spanish-speaking parents on TikTok"). Don\'t answer in topic-of-study terms.',
  pass:
    'You are studying for a NAMED EXAM with a real (or self-imposed) deadline. When a free-text question asks about your goal, timeline, or what you\'re preparing for — name the exam (e.g. "AWS-SAA", "BITSAT", "JEE Mains", "CPA REG", "CCNA") AND a date/month/timeframe (e.g. "by October", "before finals", "in 8 weeks", "spring 2026"). Don\'t hide the exam name behind generic phrasing.',
  build:
    'You are building a SPECIFIC NAMED PROJECT. When a free-text question asks about your goal, deliverable, or what you\'re working on — name the project concretely (e.g. "a Chrome extension that summarises PDFs", "a 2D platformer in Godot", "a Discord bot for our gaming server"). Mention scope or MVP shape if asked.',
  fluency:
    'You are learning a NATURAL LANGUAGE for real conversational use. When a free-text question asks about your goal, target level, or use-case — name the language AND a concrete fluency target or scenario (e.g. "B1 conversational Spanish for travel", "business-level Japanese for client meetings", "enough French to chat with my partner\'s family"). Reference CEFR levels (A1/A2/B1/B2/C1) when self-assessing.',
};

// ── Clarify-cue assertion ────────────────────────────────
//
// After the persona answers Step 3, walk the free-text answers and
// check that the per-bucket cue tokens appear at least once across
// the answer set. False negatives are possible — a learner can
// answer a `pass`-shaped question without using any of these
// keywords — but a *systematic* drop in cue rate across many `pass`
// personas surfaces a regression in the clarify question shape
// (e.g. the api stopped tilting questions toward exam name + date).
//
// `master` returns 'n-a' — no specific cue is expected for the
// default bucket.

interface CueAssertionPattern {
  /** Human-readable name of the cue category, surfaced in the report. */
  label: string;
  /** Regex matched against each free-text answer. Case-insensitive. */
  pattern: RegExp;
}

const CUE_PATTERNS: Record<GoalType, CueAssertionPattern[]> = {
  master: [],
  monetize: [
    {
      label: 'audience / channel / product noun',
      pattern:
        /\b(audience|niche|product|client|customer|service|brand|channel|launch|sell|sold|selling|buyer|subscriber|follower|revenue|monetize|monetise|youtube|instagram|tiktok|twitter|x\.com|linkedin|substack|patreon|gumroad|shopify|store|shop|coach|consult|freelance|agency|saas|ad|ads)\b/i,
    },
  ],
  pass: [
    {
      label: 'exam name',
      pattern:
        /\b(exam|test|cert(?:ification)?|license|gmat|mcat|sat|act|bitsat|jee|neet|cat|cpa|aws|azure|gcp|ccna|comptia|sec\+|net\+|usmle|nclex|fe|pe|board|bar|midterm|finals|qualifier|interview|screen|assessment)\b/i,
    },
    {
      label: 'deadline / timeframe',
      pattern:
        /\b(by\s+[a-z\d]+|before\s+[a-z]+|after\s+[a-z]+|deadline|due\s+\w+|q[1-4]|january|february|march|april|may|june|july|august|september|october|november|december|spring|summer|fall|autumn|winter|\d+\s*(?:weeks?|months?|days?))\b/i,
    },
  ],
  build: [
    {
      label: 'project deliverable noun',
      pattern:
        /\b(app|application|saas|product|website|web\s*app|site|extension|plugin|tool|game|portfolio|landing|api|service|bot|script|library|package|prototype|mvp|demo|repo|deploy|ship|launch|build|create|hack|hackathon)\b/i,
    },
  ],
  fluency: [
    {
      label: 'fluency target / CEFR level',
      pattern:
        /\b(a1|a2|b1|b2|c1|c2|beginner|intermediate|advanced|native|conversational|fluent|basic|business(-|\s)?level|travel|formal|casual|listening|speaking|reading|writing|cefr)\b/i,
    },
  ],
};

export interface ClarifyCueAssertion {
  goalType: GoalType;
  /** All free-text answers that were scanned, joined for the report. */
  scanned: string;
  /** One row per cue category — pass = pattern matched at least once across the answer corpus. */
  checks: { label: string; passed: boolean; evidence: string }[];
  /** 'pass' = all categories matched; 'fail' = any missed; 'n-a' = master (no expected cues). */
  verdict: 'pass' | 'fail' | 'n-a';
}

/**
 * Walks the free-text answers and asserts that each per-bucket cue
 * category matches at least once. Multiple-choice / multiple-select
 * answers are excluded — the cue must surface in something the
 * persona *typed*, since the clarify-tilt regression we're guarding
 * against only manifests in question-shape changes that elicit
 * (or fail to elicit) typed responses.
 */
export function assertClarifyCuePresence({
  answers,
  freeTextQuestionIds,
  goalType,
}: {
  answers: Record<string, unknown>;
  /** Question ids whose `type === 'text'` — caller must compute. */
  freeTextQuestionIds: string[];
  goalType: GoalType;
}): ClarifyCueAssertion {
  const patterns = CUE_PATTERNS[goalType];

  // Collect free-text answers only — multi-choice answers don't count
  // toward cue presence (the cue can leak through pre-canned options
  // independent of question-shape quality).
  const corpus = freeTextQuestionIds
    .map((id) => answers[id])
    .filter((a) => typeof a === 'string')
    .join(' \n ');

  if (patterns.length === 0) {
    return {
      goalType,
      scanned: corpus,
      checks: [],
      verdict: 'n-a',
    };
  }

  const checks = patterns.map(({ label, pattern }) => {
    const m = corpus.match(pattern);
    return {
      label,
      passed: m !== null,
      evidence: m ? `matched "${m[0]}"` : 'no match in free-text answers',
    };
  });

  const allPassed = checks.every((c) => c.passed);
  return {
    goalType,
    scanned: corpus,
    checks,
    verdict: allPassed ? 'pass' : 'fail',
  };
}

// ── Structure conformance assertion ──────────────────────
//
// After Step 6 (structure ready), walks the generated modules +
// lessons and asserts the per-bucket structural contract from
// `GOAL_TYPE_STRUCTURE_GUIDANCE` in courseService.ts:856-867.
// Heuristics check NAMING — the source contract is enforced via
// the LLM's structure prompt, not via post-generation validation,
// so we're verifying the prompt's instructions made it through to
// the output names. False negatives possible (a `monetize` capstone
// could ship a real artifact under a non-action-verb name).

interface StructureCheck {
  name: string;
  passed: boolean;
  evidence: string;
}

export interface StructureConformanceAssertion {
  goalType: GoalType;
  checks: StructureCheck[];
  verdict: 'pass' | 'fail' | 'n-a';
}

const ACTION_VERB_RE =
  /\b(run|launch|publish|post|ship|sell|pitch|reach|grow|engage|convert|measure|optimi[sz]e|iterate|deploy|share|promote|advertis|email|broadcast|stream|record|negotiate|close|onboard|monetiz|outreach|cold|funnel|upsell|cross-?sell)\b/i;
const MOCK_EXAM_RE = /\b(mock|past[\s-]?paper|simulation|simulated|timed|final\s+exam|practice\s+(?:exam|test)|dress\s+rehears)\b/i;
const PROJECT_SETUP_RE =
  /\b(set[\s-]?up|skeleton|scaffold|initiali[sz]e|bootstrap|prereq|environment|repo|project[\s-]?structure|getting[\s-]?started|kick[\s-]?off|hello[\s-]?world|first[\s-]?steps|foundation|starter)\b/i;
const CHECKPOINT_VERB_RE =
  /\b(implement|build|add|create|wire|connect|integrate|deploy|ship|test|debug|extend|polish|hook[\s-]?up|migrate|refactor)\b/i;
const FLUENCY_DOMAIN_RE =
  /\b(greet|small[\s-]?talk|order|food|drink|direction|travel|work|study|home|family|shop|market|hotel|restaurant|airport|phone|date|time|weather|hobby|holidays?|conversat|introduc|meet|appoint|describ)\b/i;
const FLUENCY_SKILL_RE = /\b(listen|speak|read|writ|vocab|grammar|pronunc|conjugat|tense|verb|noun|phrase)\b/i;

export function assertStructureForGoalType({
  structure,
  goalType,
}: {
  structure: CourseStructure;
  goalType: GoalType;
}): StructureConformanceAssertion {
  const modules = structure.modules;
  if (modules.length === 0) {
    return {
      goalType,
      checks: [{ name: 'has modules', passed: false, evidence: 'structure has zero modules' }],
      verdict: 'fail',
    };
  }

  const checks: StructureCheck[] = [];

  switch (goalType) {
    case 'master':
      // The master tilt is "no special structural constraint" — nothing
      // to assert beyond the universal sanity check above.
      return { goalType, checks: [], verdict: 'n-a' };

    case 'monetize': {
      // Contract: "Every module must end in a TACTICAL ACTION lesson".
      // Heuristic: each module's *last* lesson name contains an action verb.
      const tail = modules.map((m) => m.lessons[m.lessons.length - 1]).filter(Boolean);
      const matched = tail.filter((l) => ACTION_VERB_RE.test(l.name));
      const ratio = matched.length / Math.max(tail.length, 1);
      checks.push({
        name: 'every module ends in an action-verb lesson',
        passed: ratio >= 0.75, // allow 1-of-4 slip
        evidence: `${matched.length}/${tail.length} module-tail lessons match action verb (${(ratio * 100).toFixed(0)}%)`,
      });
      // Contract: "capstone module ships a public, revenue-relevant artifact".
      // Heuristic: last module's name OR last lesson contains `launch`, `ship`,
      // `publish`, `release`, `go-live`, or similar.
      const capstone = modules[modules.length - 1];
      const capstoneText = `${capstone.name} ${capstone.lessons.map((l) => l.name).join(' ')}`;
      const capstoneMatch = capstoneText.match(/\b(launch|ship|publish|release|go[\s-]?live|first[\s-]?sale|first[\s-]?revenue|first[\s-]?customer|live\s+campaign|posted)\b/i);
      checks.push({
        name: 'capstone names a shippable artifact',
        passed: capstoneMatch !== null,
        evidence: capstoneMatch ? `capstone matches "${capstoneMatch[0]}"` : `capstone "${capstone.name}" has no ship-shaped token`,
      });
      break;
    }

    case 'pass': {
      // Contract: "Modules must map to the exam's SYLLABUS sections" + final
      // module is a timed mock. Naming-shape heuristics only.
      const finalModule = modules[modules.length - 1];
      const finalText = `${finalModule.name} ${finalModule.lessons.map((l) => l.name).join(' ')}`;
      const mockMatch = finalText.match(MOCK_EXAM_RE);
      checks.push({
        name: 'final module is a timed-mock / practice exam',
        passed: mockMatch !== null,
        evidence: mockMatch ? `final module matches "${mockMatch[0]}"` : `final module "${finalModule.name}" has no mock/practice token`,
      });
      // Soft check: scopeDecisions mentions the deadline/exam (a strong
      // signal the structure prompt absorbed the goal context). The
      // CourseStructure type doesn't expose `scopeDecisions` reliably as a
      // string here — fold into reasoning.scopeDecisions if present.
      const scope = structure.reasoning?.scopeDecisions ?? '';
      const scopeMentionsExam = /\b(exam|cert|test|deadline|by\s+\w+|months?|weeks?|finals?|board)\b/i.test(scope);
      checks.push({
        name: 'scopeDecisions references exam / deadline',
        passed: scopeMentionsExam,
        evidence: scopeMentionsExam ? `scopeDecisions: "${scope.slice(0, 120)}..."` : 'no exam/deadline language in scopeDecisions',
      });
      break;
    }

    case 'build': {
      // Contract: "Module 1 always sets up the project (skeleton, dev env...)".
      const m1 = modules[0];
      const m1Text = `${m1.name} ${m1.description ?? ''} ${m1.lessons.map((l) => `${l.name} ${l.description ?? ''}`).join(' ')}`;
      const m1Match = m1Text.match(PROJECT_SETUP_RE);
      checks.push({
        name: 'module 1 is project setup / skeleton',
        passed: m1Match !== null,
        evidence: m1Match ? `module 1 matches "${m1Match[0]}"` : `module 1 "${m1.name}" has no setup-shaped token`,
      });
      // Contract: "Each subsequent module ships a CHECKPOINT" — every module
      // (post-1) description should contain a build-verb.
      const post1 = modules.slice(1);
      const checkpointMatched = post1.filter((m) => CHECKPOINT_VERB_RE.test(`${m.name} ${m.description ?? ''}`));
      const ratio = checkpointMatched.length / Math.max(post1.length, 1);
      checks.push({
        name: 'subsequent modules each ship a checkpoint',
        passed: ratio >= 0.7,
        evidence: `${checkpointMatched.length}/${post1.length} post-module-1 modules match a checkpoint verb (${(ratio * 100).toFixed(0)}%)`,
      });
      break;
    }

    case 'fluency': {
      // Contract: "Modules organize around CONVERSATIONAL DOMAINS … or SKILL TRACKS".
      // Either branch satisfies the contract — accept whichever has higher coverage.
      const allText = modules.map((m) => `${m.name} ${m.description ?? ''}`).join(' ');
      const domainHits = (allText.match(new RegExp(FLUENCY_DOMAIN_RE.source, 'gi')) ?? []).length;
      const skillHits = (allText.match(new RegExp(FLUENCY_SKILL_RE.source, 'gi')) ?? []).length;
      const totalHits = domainHits + skillHits;
      // Expect at least one domain/skill cue per module on average.
      const passed = totalHits >= modules.length;
      const branch = domainHits >= skillHits ? 'conversational-domain' : 'skill-track';
      checks.push({
        name: `modules organised around ${branch} themes`,
        passed,
        evidence: `${totalHits} domain/skill tokens across ${modules.length} modules (${domainHits} domain, ${skillHits} skill)`,
      });
      break;
    }
  }

  const allPassed = checks.every((c) => c.passed);
  return {
    goalType,
    checks,
    verdict: allPassed ? 'pass' : 'fail',
  };
}
