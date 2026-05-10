import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import { getUtilityModel } from '@lib/langchain';
import { sanitizePromptInput } from '@lib/sanitize';
import { CourseDomain } from '@lib/constants';
import { genLog } from '@lib/loggers';
import { TopicPlan, topicPlanSchema } from './schemas';

// Per-domain steer for the planner. Keeps queries native to the subject —
// STEM skews toward primary literature, creative toward maker blogs, business
// toward practitioner + academic, etc. Typed Record so adding a new domain
// triggers a compile-time error in this file (same safety net used elsewhere
// in this repo for the quiz + summary prompts).
const DOMAIN_HINTS: Record<CourseDomain, string> = {
  programming: 'Favour official docs, framework/API reference, well-maintained open-source projects, canonical engineering blog posts.',
  stem: 'Favour university course notes (.edu), textbook chapters, arXiv/peer-reviewed references, authoritative expositions from working researchers.',
  humanities: 'Favour peer-reviewed articles, encyclopedic treatments, primary-source archives, essays by recognised scholars.',
  language: 'Favour pedagogically-oriented resources aimed at learners — reputable language-learning platforms, grammar references, teacher-written material — not linguistic research papers unless the lesson is about linguistics.',
  creative: 'Favour maker blogs, practitioner tutorials, tool documentation, worked examples from recognised artists or craftspeople in this specific medium.',
  business: 'Favour practitioner-written pieces (HBR, MIT Sloan Review, a16z, Stratechery), case studies, and reputable operator blogs; peer-reviewed management research where the lesson cites theory.',
  practical: 'Favour how-to guides from accredited tradespeople, safety authorities, tool manufacturers, and well-regarded practitioner forums; avoid listicle-style SEO content.',
  'practical-ai': 'Favour vendor cookbooks and prompt libraries (OpenAI Cookbook, Anthropic prompt library + docs, Google AI Studio guides), no-code platform docs (n8n, Zapier, Make, LangChain/LangGraph how-tos, LlamaIndex recipes), and respected practitioner sources (Simon Willison\'s blog, Latent Space, Eugene Yan, Hamel Husain). Avoid academic ML papers (arXiv, NeurIPS) unless the lesson is explicitly about a research technique, and avoid SEO listicles ("Top 10 ChatGPT prompts…").',
  'life-skills': 'Favour applied research from recognised psychologists/coaches, reputable long-form essays, and skill-specific coaching resources; avoid generic productivity listicles.',
  other: 'Pick sources appropriate to the subject as inferred from the lesson description.',
};

const NULL_DOMAIN_HINT = 'Pick sources appropriate to the subject as inferred from the lesson description.';

const PLANNER_SYSTEM_PROMPT = `You curate the *bonus reading* shelf for a lesson. After learning the lesson, what 2 threads would a curious learner most enjoy pulling on next?

Produce exactly 2 topics. Pick the flavor yourself: each topic can be:
- **adjacent** — around the lesson topic, related but not what the lesson literally covered
- **expanded read** — going deeper on a specific aspect the lesson touched but didn't fully unpack
- **surprising thread** — something a learner wouldn't expect to find here but would find delightful or memorable

Mix is welcome. Each topic should feel like a distinct bonus thread — not a rephrasing of the same noun, and not an exact restatement of the lesson's main subject.

For each topic produce:
- "topic": a short headline a learner could read on a tab title and feel pulled to click
- "angle": one sentence on what makes this engaging or worth their time
- "query": a 3–12-word natural-language search query (no operators, no quotes, no "site:") that a search engine will route well

Rules:
- Stay in the lesson's subject area. Do not broaden to the module or course level.
- Each query must be topically specific. Name the concept. Do NOT produce generic "learn X tutorial" queries.
- No two topics should produce essentially the same search.

Return ONLY a JSON object matching the schema { topics: [{ topic, angle, query }, ...] }.`;

interface QueryPlannerInput {
  lessonName: string;
  lessonDescription: string;
  contentSummary: string;
  domain: CourseDomain | null;
}

/**
 * Minimal fallback plan the orchestrator can fall back to if the LLM call fails.
 *
 * Uses the lesson name as a stable seed and emits 2 keyword-skeleton topics
 * covering complementary angles — pragmatic and contextual. Not as good as a
 * real plan, but it keeps the pipeline from stalling here.
 */
const fallbackPlan = (lessonName: string): TopicPlan => {
  const name = lessonName.trim() || 'this topic';
  return {
    topics: [
      {
        topic: `${name} in practice`,
        angle: 'A worked example or practitioner walk-through to ground the concept.',
        query: `${name} worked example tutorial`,
      },
      {
        topic: `Background and rationale of ${name}`,
        angle: 'Where the idea came from and why it works the way it does.',
        query: `${name} history rationale background`,
      },
    ],
  };
};

/**
 * Generate a 2-topic bonus-reading plan for the lesson.
 *
 * Uses Haiku 4.5 at temp 0.5 (room for varied, engaging picks without
 * drifting off-subject). If the call fails for any reason, returns a
 * keyword-skeleton fallback derived directly from the lesson name so
 * the pipeline never stalls here.
 */
export const planQueries = async ({
  lessonName,
  lessonDescription,
  contentSummary,
  domain,
}: QueryPlannerInput): Promise<TopicPlan> => {
  const domainHint = domain ? DOMAIN_HINTS[domain] : NULL_DOMAIN_HINT;
  const safeName = sanitizePromptInput(lessonName);
  const safeDescription = sanitizePromptInput(lessonDescription);
  const safeSummary = sanitizePromptInput(contentSummary);

  try {
    const model = getUtilityModel().withStructuredOutput(topicPlanSchema);
    const plan = await model.invoke(
      [
        new SystemMessage(PLANNER_SYSTEM_PROMPT),
        new HumanMessage(
          `## Lesson\n**Title:** ${safeName}\n\n**Description:** ${safeDescription}\n\n## Lesson summary\n${safeSummary || '(not yet generated)'}\n\n## Course domain\n${domain ?? 'unclassified'} — ${domainHint}\n\nProduce exactly 2 bonus-reading topics.`,
        ),
      ],
      { metadata: { llmLabel: 'lesson:links.plan' } },
    );
    if (!plan.topics.length) return fallbackPlan(lessonName);
    genLog.info(`links:plan topics=${plan.topics.length} queries=${plan.topics.map((t) => `"${t.query}"`).join(',')}`);
    return plan;
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    genLog.warn(`links:plan-fallback reason=${reason} — using keyword heuristic`);
    return fallbackPlan(lessonName);
  }
};
