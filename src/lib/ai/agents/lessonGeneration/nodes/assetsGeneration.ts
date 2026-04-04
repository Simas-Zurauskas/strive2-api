import { z } from 'zod';
import { RunnableConfig } from '@langchain/core/runnables';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import OpenAI from 'openai';
import { TavilySearch } from '@langchain/tavily';
import { OPENAI_API_KEY, TAVILY_API_KEY } from '@conf/env';
import { getUtilityModel } from '@lib/langchain';
import { uploadBuffer, getPresignedUrl } from '@services/s3Service';
import { ILessonBlock } from '@models/LessonContentModel';
import { LessonState } from '../state';

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

const tavilySearch = new TavilySearch({
  maxResults: 8,
  tavilyApiKey: TAVILY_API_KEY,
});

// ── Hero image ─────────────────────────────────────────

const generateHeroImage = async (
  lessonName: string,
  courseGoal: string,
  courseId: string,
  moduleIndex: number,
  lessonIndex: number,
): Promise<string | null> => {
  try {
    console.log(`[assetsGeneration] Generating hero image...`.cyan);
    const prompt = `Create an artistic, editorial-quality illustration that visually captures the essence of "${lessonName}" within the broader theme of "${courseGoal}".

Style: Hand-crafted feel, like a premium editorial illustration from a design magazine. Use a rich but restrained color palette (2-3 dominant colors with subtle accents). The composition should feel intentional and balanced, with organic textures — watercolor washes, ink splatters, paper grain, or risograph-style layering. Avoid the typical AI-generated glossy/smooth look.

Subject: Abstract visual metaphor that represents the concept — NOT a literal depiction. Think conceptual editorial art: flowing forms, overlapping translucent shapes, organic patterns, or symbolic compositions that evoke the idea without spelling it out.

Absolute restrictions: NO text, NO letters, NO numbers, NO words, NO characters, NO writing of any kind anywhere in the image. NO human faces or figures. NO generic tech imagery (no glowing circuits, no floating screens, no binary code). NO clipart-style icons.

Format: Wide banner composition (16:9), with visual weight distributed for use as a hero image with content below it.`;

    const response = await openai.images.generate({
      model: 'dall-e-3',
      prompt,
      n: 1,
      size: '1792x1024',
      quality: 'standard',
      response_format: 'b64_json',
    });

    const b64 = response.data?.[0]?.b64_json;
    if (!b64) return null;

    const key = `lessons/${courseId}/${moduleIndex}/${lessonIndex}/hero.png`;
    await uploadBuffer(key, Buffer.from(b64, 'base64'), 'image/png');

    console.log(`[assetsGeneration] ✓ Hero image uploaded to S3: ${key}`.green);
    return key;
  } catch (e) {
    console.warn(`[assetsGeneration] ✗ Hero image failed: ${e instanceof Error ? e.message : e}`.yellow);
    return null;
  }
};

// ── Curated links ──────────────────────────────────────

// ── Curated links (two-step: search → LLM curation) ───

interface CuratedLink {
  title: string;
  url: string;
  description: string;
}

const curatedLinksSchema = z.object({
  links: z.array(z.object({
    url: z.string(),
    title: z.string(),
    description: z.string(),
  })),
});

const LINKS_CURATION_PROMPT = `You are a learning resource curator. Given a lesson's content and a set of web search results, select ONLY the genuinely valuable resources a learner should read AFTER completing this lesson.

Rules:
- Select 3-5 resources maximum. Quality over quantity — fewer excellent links beat many mediocre ones.
- Each resource must add value BEYOND what the lesson already taught. Ask: "Why would a learner click this?"
- Prefer: official documentation, canonical tutorials, seminal articles/papers, authoritative references, well-maintained open-source repos
- Reject: SEO blog spam, low-effort listicles, paywalled content, outdated material, generic overviews that repeat what the lesson covered
- Write a thoughtful 1-sentence description for each — not a generic summary but WHY this specific resource is worth the learner's time after this lesson
- If none of the search results are genuinely valuable, return an empty links array. Do not pad with mediocre content.`;

const generateCuratedLinks = async (
  lessonName: string,
  lessonSummary: string,
  contentBlocks: ILessonBlock[],
): Promise<ILessonBlock | null> => {
  try {
    // Step 1: Extract key concepts from lesson content for targeted search
    const sectionContent = contentBlocks
      .filter((b) => b.type === 'section')
      .map((b) => b.content.slice(0, 200))
      .join(' ');
    const keyTerms = `${lessonName} ${sectionContent}`.slice(0, 300);

    console.log(`[linksGeneration] Searching with lesson context...`.cyan);
    const results = await tavilySearch.invoke({ query: `${keyTerms} learn guide resource tutorial` });

    // Parse Tavily results
    const raw = results as Record<string, unknown>;
    let items: Array<{ title?: string; url?: string; content?: string }> = [];
    if (raw && Array.isArray(raw.results)) {
      items = raw.results;
    } else if (Array.isArray(results)) {
      items = results;
    }

    const searchResults = items
      .filter((r) => r.url && r.title)
      .slice(0, 10) // Give the LLM more candidates to choose from
      .map((r) => ({
        title: r.title ?? '',
        url: r.url ?? '',
        snippet: (r.content ?? '').slice(0, 300),
      }));

    if (searchResults.length === 0) return null;

    // Step 2: LLM curation — Haiku selects and describes the best resources
    console.log(`[linksGeneration] Curating ${searchResults.length} candidates with LLM...`.cyan);

    const model = getUtilityModel().withStructuredOutput(curatedLinksSchema);
    const curationResult = await model.invoke([
      new SystemMessage(LINKS_CURATION_PROMPT),
      new HumanMessage(`## Lesson: ${lessonName}

## Lesson summary
${lessonSummary}

## Search results to evaluate

${searchResults.map((r, i) => `${i + 1}. **${r.title}**\n   URL: ${r.url}\n   Snippet: ${r.snippet}`).join('\n\n')}

Select the genuinely valuable resources from the list above.`),
    ]);

    const links: CuratedLink[] = curationResult.links;
    console.log(`[linksGeneration] ✓ Curated ${links.length} links from ${searchResults.length} candidates`.green);

    if (links.length === 0) return null;

    const content = links
      .map((l) => `- [${l.title}](${l.url}) — ${l.description}`)
      .join('\n');

    return {
      id: 'links-1',
      type: 'links',
      content,
      metadata: { links },
      order: 9999,
    };
  } catch (e) {
    console.warn(`[linksGeneration] ✗ Curated links failed: ${e instanceof Error ? e.message : e}`.yellow);
    return null;
  }
};

// ── Node: hero image (runs early, parallel with content) ──

export const imageGeneration = async (state: LessonState, config?: RunnableConfig): Promise<Partial<LessonState>> => {
  if (!state.includeImage) {
    console.log(`[imageGeneration] Skipped (user opted out)`.gray);
    return { heroImageUrl: null };
  }

  const writer = (config?.configurable?.writer as ((event: Record<string, unknown>) => void) | undefined);

  const s3Key = await generateHeroImage(
    state.lessonName, state.goal, state.courseId, state.moduleIndex, state.lessonIndex,
  );

  if (s3Key) {
    const presignedUrl = await getPresignedUrl(s3Key);
    writer?.({ type: 'hero_image', url: presignedUrl, s3Key });
  }

  return { heroImageUrl: s3Key };
};

// ── Node: curated links (runs at the end) ─────────────

export const linksGeneration = async (state: LessonState, config?: RunnableConfig): Promise<Partial<LessonState>> => {
  if (!state.includeLinks) {
    console.log(`[linksGeneration] Skipped (user opted out)`.gray);
    return { linksBlock: null };
  }

  const writer = (config?.configurable?.writer as ((event: Record<string, unknown>) => void) | undefined);

  const linksBlock = await generateCuratedLinks(state.lessonName, state.contentSummary, state.contentBlocks);

  if (linksBlock) {
    writer?.({ type: 'block', block: linksBlock });
  }

  return { linksBlock };
};
