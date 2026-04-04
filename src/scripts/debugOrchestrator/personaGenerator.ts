import OpenAI from 'openai';
import type { Persona } from './types';

const PERSONA_SYSTEM_PROMPT = `You are generating realistic test personas for an AI-powered course creation platform. These personas will walk through a wizard that: asks clarifying questions → shows depth options (overview/comprehensive/deep_dive) → generates a course structure → lets user refine via chat → accept.

Your job is to create personas that behave like real humans interacting with this wizard. Not idealized students. Not AI-generated caricatures. Real people with real habits.

## What Real Users Actually Look Like

Study after study shows: most users of learning platforms fall into a handful of behavioral clusters. Your personas should be drawn from these REAL patterns, not invented archetypes:

**The Motivated Professional (most common, ~35% of users)**
Has a concrete reason to learn — job requirement, upcoming project, career transition. Types a specific goal that references their work context. Answers questions thoughtfully but quickly — they're busy. Usually picks the recommended depth because they trust the system and don't want to overthink it. Accepts the generated structure without feedback ~80% of the time because they came here to learn, not to design curricula.

**The Curious Browser (~25% of users)**
No deadline, no pressure. Saw something interesting and wants to explore. Goal is vague — sometimes just a topic name. Fills out surveys casually, picks whatever sounds fun without agonizing. Picks recommended or one level down. Usually accepts the structure — they're not invested enough to critique it. Might say "looks good" without reading it carefully.

**The Overambitious Beginner (~15% of users)**
Wants to learn everything. Writes a broad goal that's actually 3-4 courses worth of content. On multi-select questions, picks too many options. Claims more experience than they have. Picks deep_dive or comprehensive even if they're beginners. Might actually give structure feedback because the generated scope didn't match their (unrealistic) expectations.

**The Anxious Learner (~10% of users)**
Worried about wasting time on the wrong thing. Writes careful, specific goals. Reads every option thoroughly before answering. On multi-select, picks conservatively — doesn't want to overcommit. Picks the recommended depth or one below it. Might give feedback because they're worried something important was left out.

**The Skeptic / Returning User (~10% of users)**
Has tried other platforms or has existing knowledge. Writes goals that signal "I already know the basics, don't waste my time." Answers questions to demonstrate their existing knowledge. Might pick against the recommendation on purpose. Most likely persona to give structure feedback — they have opinions about how the topic should be taught.

**The Minimum-Effort User (~5% of users)**
Just wants to see what happens. Writes the shortest possible goal. Picks the first reasonable option on every question. Picks recommended depth without reading descriptions. Accepts structure without reading it. Will never give chat feedback.

## Generating Realistic Goals

The "goal" field is what the user LITERALLY TYPES into a text box. Study how real people type in forms:

- Most people write 5-20 words. Very few write more than 2 sentences.
- Capitalization is inconsistent. Some people capitalize properly, some don't bother.
- Grammar varies. Some write fragments ("python for data science"), some write full sentences.
- Specificity varies enormously: "coding" vs "I need to build a REST API in Go for our microservices migration at work"
- Some goals have implicit context: "learn SQL for the analytics role I'm interviewing for"
- Some are copy-pasted from job descriptions or course titles they saw elsewhere
- Almost nobody writes goals with perfect grammar AND perfect specificity AND perfect scope — there's always SOMETHING slightly off about how a real person would phrase it.

DO NOT: Write goals that sound like AI prompts. "I wish to acquire comprehensive knowledge of..." is not how humans type.

## Topic Diversity

Vary topics significantly. Don't default to programming. Real course platforms see:
- Technical: programming languages, frameworks, DevOps, data science, cybersecurity
- Creative: design, photography, music production, writing, illustration
- Professional: project management, leadership, negotiation, public speaking, finance
- Academic: math, physics, biology, statistics, linguistics
- Practical: cooking, gardening, fitness, home repair, personal finance
- Languages: Spanish, Japanese, sign language, technical writing

## Output Format

Return a JSON object with a "personas" array. Each persona has:

- **name**: First name + short descriptor. "Priya - Deadline-Driven PM" not "Priya - The Motivated Professional"
- **background**: 2-3 sentences. Their real situation. Include: what they actually do, why they want to learn this, any relevant constraints or contradictions. Write in third person.
- **goal**: What they literally type. In their voice. With their level of effort and specificity.
- **personality**: How they interact with forms and tools. Specific behavioral tendencies (reads carefully vs skims, trusts recommendations vs does own thing, gives detailed text answers vs one-word answers). NOT adjective lists.
- **priorities**: What they actually care about, stated honestly. It's OK to include contradictions ("wants depth but also wants it fast").
- **wizardBehavior**: An object with three fields predicting their SPECIFIC behavior in this wizard:
  - **surveyStyle**: How they'll answer the clarifying questions. E.g., "Reads all options carefully, picks conservatively on multi-select (1-2 choices). Text answers are 1-2 thoughtful sentences. Gets slightly more hasty on questions 4+."
  - **depthChoice**: What they'll pick and WHY. E.g., "Picks recommended without reading the other options. Just trusts the system." or "Picks deep_dive despite being a beginner because 'I want the real thing, not a watered-down version.'"
  - **structureReview**: What they'll do when shown the structure. E.g., "Accepts immediately without reading. Types 'looks good' in 2 seconds." or "Reads module names, notices there's no section on testing, asks to add it. Feedback is direct and specific."

## Crucial Constraints

1. DO NOT make all personas quirky or unusual. Most people are pretty normal. 2-3 personas should be straightforward motivated learners. The diversity comes from their topics, experience levels, and minor behavioral differences — not from everyone being a "character."

2. Every persona must produce a VALID goal (1-500 characters, non-empty). The goal must be about learning something — not a question, not a command, not nonsense.

3. The wizardBehavior predictions must be SPECIFIC and ACTIONABLE — not vague. "answers quickly" is vague. "Picks the first option that seems reasonable on multiple_choice, selects 3-4 options on multi_select because she wants breadth, text answers are 3-6 words" is actionable.

4. When generating 5 personas: ensure at least 2 are "normal" motivated learners, at least 1 has a vague/short goal, at least 1 has a very specific goal, and at least 1 will give structure feedback. Topics must all be different.`;

export async function generatePersonas(count: number = 5): Promise<Persona[]> {
  const client = new OpenAI();

  console.log(`${'[PersonaGen]'.magenta} Generating ${count} personas via GPT-4o...`);

  const response = await client.chat.completions.create({
    model: 'gpt-4o',
    messages: [
      { role: 'system', content: PERSONA_SYSTEM_PROMPT },
      { role: 'user', content: `Generate exactly ${count} personas.` },
    ],
    response_format: { type: 'json_object' },
    temperature: 0.9,
  });

  const content = response.choices[0]?.message?.content;
  if (!content) throw new Error('Empty response from persona generation');

  const parsed = JSON.parse(content) as { personas: Persona[] };
  if (!Array.isArray(parsed.personas) || parsed.personas.length !== count) {
    throw new Error(`Expected ${count} personas, got ${parsed.personas?.length ?? 0}`);
  }

  // Validate wizardBehavior exists on all personas
  for (const p of parsed.personas) {
    if (!p.wizardBehavior || !p.wizardBehavior.surveyStyle || !p.wizardBehavior.depthChoice || !p.wizardBehavior.structureReview) {
      throw new Error(`Persona "${p.name}" is missing wizardBehavior fields`);
    }
    console.log(`${'[PersonaGen]'.magenta}   → ${p.name.bold}`);
  }

  return parsed.personas;
}
