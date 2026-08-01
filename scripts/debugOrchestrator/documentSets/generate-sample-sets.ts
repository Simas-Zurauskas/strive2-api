/**
 * yarn debug:orchestrator:sets — (re)builds the committed sample document
 * sets used by the orchestrator's documents mode.
 *
 * `documentSets/` is gitignored except this generator + its README, so the
 * corpora are produced on demand instead of checked in as binaries. Every
 * byte comes from the api's own extraction fixture builders
 * (`src/services/documentExtraction/__fixtures__/builders.ts`) — the same
 * ones the unit tests and `yarn debug:ingest` use — so a format the
 * extractor router supports is a format these files exercise.
 *
 * Sets produced:
 *   sample-basic — 3 text-rich files (pdf + docx + md) on ONE coherent
 *     topic (spaced repetition / retrieval practice). Enough substance for
 *     a small band (~3-6 lessons) with no deferred extraction, so
 *     `prepare_corpus` is a no-op and the run stays cheap.
 *   sample-mixed — the basic trio on a second topic (basic statistics)
 *     PLUS a scanned-look pdf (blank pages → the scanned-page detector
 *     fires → prepare_corpus has real work), a csv data table, and a
 *     wikipedia URL in manifest.json.
 *
 * Idempotent: re-running overwrites the folders in place.
 */

import { mkdir, writeFile, rm } from 'fs/promises';
import path from 'path';
import { buildPdf, buildDocx, buildZip } from '@src/services/documentExtraction/__fixtures__/builders';

const SETS_DIR = __dirname;

// ── Corpus prose ──────────────────────────────────────────
//
// Real topical writing (not lorem ipsum): the assessment's teachable-
// density scoring, topic extraction and suggested-goal synthesis all read
// this text, so it has to carry genuine teachable substance.

const SPACED_REPETITION_PAGES = [
  `Spaced repetition and the forgetting curve. Human memory decays predictably. In 1885 Hermann Ebbinghaus memorised lists of nonsense syllables and measured how much he could recall after minutes, hours and days. The resulting forgetting curve falls steeply at first and then flattens: most of what we lose, we lose in the first day. Ebbinghaus also noticed the countermeasure. When he relearned a list after partial forgetting, the second curve fell more slowly than the first. Each successful relearning episode flattens the curve further. This is the spacing effect: reviews distributed across days produce far more durable retention than the same total study time massed into one session.`,
  `Why massed practice feels better and works worse. Cramming produces high performance during the session, which learners misread as learning. Performance during study measures current accessibility, not durable storage. Bjork's distinction between storage strength and retrieval strength explains the illusion: rereading raises retrieval strength quickly and leaves storage strength almost untouched, so the material feels known and is gone within days. Spacing deliberately allows partial forgetting before the next encounter. Reconstructing a partly-forgotten memory is effortful, and that effort is what consolidates it. The practical rule is uncomfortable but reliable: if a review feels easy, it was scheduled too soon.`,
  `Retrieval practice. Actively recalling information is stronger than restudying it, a result robust enough to be called the testing effect. In Roediger and Karpicke's studies, students who read a passage once and then practised free recall outperformed students who read the same passage four times, and the gap widened as the delay before the final test grew. The mechanism is that retrieval is not a neutral readout. Each act of recall modifies the trace it retrieves, strengthening the cues that led to a successful search. Recognition — picking the right answer from a list — produces much weaker gains than free recall, because the cue does the work the learner should be doing.`,
  `The Leitner system. Sebastian Leitner's 1972 method implements spacing with physical boxes. Every card starts in box one. A card answered correctly is promoted to the next box; a card answered wrongly is demoted straight back to box one, no matter how far it had climbed. Each box is reviewed on its own interval — box one daily, box two every third day, box three weekly, and so on — so a learner's daily workload concentrates on exactly the material they keep failing. The Leitner system is a coarse approximation of the optimal schedule, and its virtue is that it needs no computation: the box number IS the interval, and the demotion rule handles lapses without any model of difficulty.`,
  `From boxes to algorithms. SuperMemo's SM-2 replaced fixed boxes with a per-card ease factor and a multiplicative interval: a correct answer multiplies the current interval by the ease factor, a lapse resets the interval and lowers the ease. Anki popularised a variant of SM-2 with four grades — Again, Hard, Good, Easy — mapping directly onto interval adjustments. FSRS, the modern successor, fits a three-component memory model (difficulty, stability, retrievability) to a learner's own review log and schedules each card for a target recall probability, typically ninety percent. The progression from Leitner to FSRS is a progression in personalisation, not in principle: all of them exploit the same spacing effect.`,
  `Writing cards that work. Wozniak's rules of formulation are where most spaced-repetition attempts fail. Keep each item atomic — one fact, one card — because a compound prompt cannot be graded honestly: partial recall produces an ambiguous verdict and a meaningless interval. Prefer questions whose answer is uniquely recoverable; "describe the French Revolution" is not a card. For cloze deletions, delete the load-bearing noun or verb, never the connective tissue, and make sure the surrounding sentence does not give the answer away. Include enough context that the card is readable standalone months later, and no more. Interference is the other common failure: two cards that differ only slightly will be confused with each other, and the fix is to make one of them more distinctive rather than to drill both harder.`,
  `Interleaving and desirable difficulty. Spacing is one member of a family of manipulations Bjork calls desirable difficulties — conditions that depress performance during practice while improving long-term retention and transfer. Interleaving is the closest relative: instead of blocking practice by topic, mix problem types so the learner must first decide which method applies. Blocked practice teaches execution, interleaved practice teaches discrimination, and only the latter survives contact with an exam where problems arrive unlabelled. Varying the practice context, generating an answer before being shown it, and testing rather than restudying all belong to the same family. Each feels worse and works better, which is why learners reliably choose against them when left to their own judgement.`,
  `Designing a review habit. A workable schedule has three parts: a daily cap so the queue never becomes a wall, a rule that new cards only enter when the due queue is clear, and honest grading. Overreporting success inflates intervals and produces a queue that looks healthy while retention quietly collapses; underreporting buries the learner in reviews they do not need. Expect roughly ten to fifteen reviews per mature card per year at a ninety percent retention target. The load is front-loaded: the first two weeks after a card is introduced generate most of its lifetime reviews, so introducing a hundred cards on one enthusiastic afternoon guarantees a punishing month. Add cards at the rate you can sustain, and treat lapses as scheduling information rather than as failure.`,
];

const SPACED_REPETITION_MD = `# Study notes — spaced repetition

## The core claim

Distributed practice beats massed practice for durable retention. The same
number of minutes spread across days produces substantially better recall
weeks later than the same minutes spent in one sitting. This is the single
most replicated finding in the learning-science literature and it is also
the one students most reliably ignore, because cramming feels productive
while it is happening.

## Terms I keep mixing up

- **Spacing effect** — distributing study across time improves retention.
- **Testing effect** — retrieving beats rereading, independent of spacing.
- **Storage strength vs retrieval strength** — Bjork's pair. Retrieval
  strength is how accessible the memory is right now; storage strength is
  how well learned it is. Rereading pumps retrieval strength and leaves
  storage strength alone, which is exactly why cramming feels like
  learning.
- **Desirable difficulty** — any manipulation that lowers performance
  during practice while raising long-term retention. Spacing,
  interleaving, generation, and testing all qualify.
- **Interference** — two similar cards degrade each other. The fix is to
  make one more distinctive, not to drill both more.

## Scheduling algorithms, shortest version

| Method | Interval rule | Notes |
| --- | --- | --- |
| Leitner boxes | box number IS the interval | correct → promote, wrong → box 1 |
| SM-2 | interval × per-card ease factor | ease drops on lapses |
| Anki (SM-2 variant) | four grades adjust interval + ease | Again / Hard / Good / Easy |
| FSRS | fits difficulty, stability, retrievability to your own log | targets ~90% recall |

## Card-writing rules I violated on my first deck

1. One fact per card. Compound prompts cannot be graded honestly.
2. The answer must be uniquely recoverable from the prompt.
3. Cloze: delete the load-bearing word, not the glue.
4. Enough context to be readable standalone in six months. No more.
5. Grade honestly — inflated grades inflate intervals and hide collapse.

## Practical schedule that survived a semester

- Daily cap on reviews so the queue never becomes a wall.
- New cards only when the due queue is clear.
- Expect the first two weeks after introducing a card to generate most of
  its lifetime reviews. Introducing 100 cards in one afternoon guarantees
  a bad month.
- A review that feels easy was scheduled too soon. Let intervals grow.
`;

const STATISTICS_PAGES = [
  `Describing a single variable. Before any inference, describe what you have. A distribution is summarised by centre, spread and shape. The mean is the balance point and is pulled by outliers; the median is the middle value and is not. When mean and median diverge substantially, the distribution is skewed and the median is usually the honest summary — this is why income is always reported as a median. Spread is standard deviation for roughly symmetric data and the interquartile range otherwise. Shape means modality and skew, and it is the reason to plot before computing: a bimodal distribution has a mean that describes nobody, and no summary statistic will tell you that. A histogram or a boxplot costs one line and prevents most misreadings.`,
  `Sampling and the standard error. A statistic computed from a sample varies from sample to sample. That variability, not the spread of the data itself, is what an inference is about. The standard error of the mean is the standard deviation divided by the square root of the sample size, which has two consequences worth internalising. First, precision improves with the square root of effort: quadrupling the sample halves the standard error. Second, the standard deviation describes individuals while the standard error describes your estimate — confusing them is the most common error in reported research. The central limit theorem is what makes this usable: for large enough samples, the sampling distribution of the mean is approximately normal even when the underlying data are not.`,
  `Confidence intervals. A ninety-five percent confidence interval is a range constructed so that, across repeated samples from the same population, ninety-five percent of such intervals contain the true parameter. It is a statement about the procedure, not about this particular interval, and it does not mean there is a ninety-five percent probability the parameter lies inside the one you computed. Interval width is driven by variability and sample size, so a wide interval is a report of ignorance rather than a mistake. Intervals are more informative than p-values for the same data because they carry the effect size and its precision together, which is why most style guides now ask for them.`,
  `Hypothesis testing and what p means. A p-value is the probability of observing data at least as extreme as yours if the null hypothesis were true. It is not the probability that the null is true, and it is not the probability your result was luck. Small p means the data are surprising under the null; it says nothing directly about effect size, and with a large enough sample a trivial difference produces a tiny p. Two errors are always in tension: rejecting a true null (type I, controlled by alpha) and failing to reject a false null (type II, controlled by power). Power depends on effect size, sample size and alpha, and an underpowered study is not merely inconclusive — it produces overestimated effect sizes when it does reach significance, because only the large-sample-noise cases clear the threshold.`,
  `Correlation, regression and the causal gap. Correlation measures the strength of a linear relationship between two variables on a scale from minus one to one. It is not causation, and the reasons are enumerable: a confounder may drive both, the causal arrow may run the other way, selection may have created the association, or it may be coincidence in a large search space. Simple linear regression fits a line by least squares and gives an interpretable slope: the expected change in the outcome for a one-unit change in the predictor, holding nothing else constant unless you added covariates. R-squared reports the share of variance explained and is easy to over-read; a high R-squared on a misspecified model is worse than a low one on an honest model. Always plot the residuals — the four Anscombe datasets share a regression line and share nothing else.`,
  `Common traps. Simpson's paradox: an association that holds in every subgroup can reverse in the aggregate, so aggregate-only analysis is unsafe whenever group sizes differ. Regression to the mean: extreme measurements are partly noise, so extremes drift toward the average on re-measurement without any intervention — the source of countless spurious claims about programmes that "fixed" the worst cases. Survivorship bias: conditioning on the survivors of a process removes exactly the evidence that would falsify your hypothesis. Multiple comparisons: testing twenty independent hypotheses at alpha of five percent yields roughly a two-in-three chance of at least one false positive, which is why pre-registration and correction procedures exist. Each of these is a reasoning error rather than a computational one, and no software will warn you.`,
];

const STATISTICS_MD = `# Course notes — intro statistics

## What the first half is really about

Two distributions get confused constantly and everything else follows from
keeping them apart:

1. The distribution of the **data** — described by mean/median, SD/IQR,
   shape.
2. The sampling distribution of a **statistic** — described by the
   standard error, and the thing every confidence interval and p-value is
   actually about.

SE = SD / sqrt(n). Precision improves with the square root of effort:
4× the sample, half the standard error.

## Vocabulary that trips me up in exams

| Term | One-line meaning | Common misreading |
| --- | --- | --- |
| p-value | P(data this extreme \\| null true) | "probability the null is true" |
| 95% CI | procedure covers the parameter 95% of the time | "95% chance it's in this interval" |
| power | P(reject \\| effect real) | assumed high by default |
| type I / II | false positive / false negative | conflated |
| R² | share of variance explained | treated as model correctness |

## Causation checklist before believing an association

- Confounder driving both?
- Reversed arrow?
- Selection or survivorship?
- How many hypotheses were searched? (20 tests at 5% ≈ 64% chance of one
  false positive.)
- Did group sizes differ? (Simpson's paradox.)
- Were the extremes selected on? (Regression to the mean.)

## Habits the lecturer keeps repeating

- Plot before you compute. Anscombe's quartet shares a regression line and
  nothing else.
- Report intervals, not just p-values — effect size and precision
  together.
- Residual plots are not optional.
- A wide interval is an honest report of ignorance, not an error.
`;

const STATISTICS_CSV = `dataset,n,mean,median,sd,iqr,skew,note
reaction_time_ms,120,412.4,398.0,88.7,101.5,0.62,right skew from a few slow trials
exam_score_pct,240,71.3,73.0,14.2,19.0,-0.41,left skew; ceiling at 100
household_income_eur,500,48210.0,36400.0,39880.0,31250.0,2.14,median is the honest summary
plant_height_cm,90,24.8,24.9,3.1,4.2,0.03,near symmetric
commute_minutes,300,34.6,29.0,21.9,24.0,1.35,long right tail
bimodal_pilot,80,50.1,50.0,24.4,44.0,0.01,mean describes nobody - two clusters
`;

// ── Builders ─────────────────────────────────────────────

/**
 * Minimal .docx via the fixture zip writer with real prose in the body.
 * `buildDocx` from the fixture builders hardcodes its own paragraph text;
 * the sample sets need topical content, so the OOXML skeleton is rebuilt
 * here with the same shape (Content_Types + rels + document.xml) using
 * the same reviewed `buildZip` primitive.
 */
const docxWithParagraphs = ({ heading, paragraphs }: { heading: string; paragraphs: string[] }): Buffer => {
  const escapeXml = (s: string) =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const body = paragraphs
    .map((p) => `    <w:p><w:r><w:t xml:space="preserve">${escapeXml(p)}</w:t></w:r></w:p>`)
    .join('\n');
  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>${escapeXml(heading)}</w:t></w:r></w:p>
${body}
  </w:body>
</w:document>`;
  return buildZip([
    {
      name: '[Content_Types].xml',
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`,
    },
    {
      name: '_rels/.rels',
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`,
    },
    { name: 'word/document.xml', data: documentXml },
  ]);
};

const writeSet = async ({
  name,
  files,
  manifest,
}: {
  name: string;
  files: { filename: string; data: Buffer | string }[];
  manifest?: { urls?: string[]; note: string; expectedTopics: string[] };
}) => {
  const dir = path.join(SETS_DIR, name);
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  for (const f of files) {
    await writeFile(path.join(dir, f.filename), f.data);
  }
  if (manifest) {
    await writeFile(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  }
  const total = files.reduce((sum, f) => sum + Buffer.byteLength(f.data as string | Buffer), 0);
  console.log(
    `  ${name}: ${files.length} file(s), ${(total / 1024).toFixed(1)} KB${manifest?.urls?.length ? ` + ${manifest.urls.length} URL(s)` : ''}`,
  );
};

async function main() {
  console.log('Building sample document sets…');

  // ── sample-basic: pdf + docx + md, one coherent topic ──
  await writeSet({
    name: 'sample-basic',
    files: [
      { filename: 'spaced-repetition-lecture.pdf', data: buildPdf(SPACED_REPETITION_PAGES) },
      {
        filename: 'memory-and-retrieval-handout.docx',
        data: docxWithParagraphs({
          heading: 'Memory, retrieval practice and scheduling',
          paragraphs: [
            SPACED_REPETITION_PAGES[2],
            SPACED_REPETITION_PAGES[5],
            SPACED_REPETITION_PAGES[6],
            SPACED_REPETITION_PAGES[7],
          ],
        }),
      },
      { filename: 'study-notes.md', data: SPACED_REPETITION_MD },
    ],
    manifest: {
      note: 'Lecture PDF, handout DOCX and personal markdown notes on spaced repetition and retrieval practice — one coherent cognitive-science topic.',
      expectedTopics: [
        'spaced repetition and the forgetting curve',
        'retrieval practice / testing effect',
        'the Leitner system',
        'SM-2 / Anki / FSRS scheduling algorithms',
        'card-writing rules (atomicity, cloze quality, interference)',
        'interleaving and desirable difficulty',
      ],
    },
  });

  // ── sample-mixed: adds a scanned-look pdf, a csv, and a URL ──
  await writeSet({
    name: 'sample-mixed',
    files: [
      { filename: 'statistics-lecture.pdf', data: buildPdf(STATISTICS_PAGES) },
      {
        filename: 'inference-handout.docx',
        data: docxWithParagraphs({
          heading: 'Inference: standard errors, intervals and tests',
          paragraphs: [STATISTICS_PAGES[1], STATISTICS_PAGES[2], STATISTICS_PAGES[3]],
        }),
      },
      { filename: 'lecture-notes.md', data: STATISTICS_MD },
      { filename: 'summary-statistics.csv', data: STATISTICS_CSV },
      {
        // Blank pages carry no text layer, so the scanned-page detector
        // (<~100 chars/page) flags them: ingest samples a few via vision
        // triage and leaves the rest for the debited prepare_corpus pass.
        // That is exactly the deferred-extraction path this set exists to
        // exercise. The first page carries a caption so the document is
        // not a total blank.
        filename: 'scanned-problem-sheets.pdf',
        data: buildPdf([
          'Problem sheets 1-6 (scanned from the printed course pack).',
          '',
          '',
          '',
          '',
          '',
        ]),
      },
    ],
    manifest: {
      urls: ['https://en.wikipedia.org/wiki/Standard_error'],
      note: 'Intro-statistics course pack: lecture PDF, inference handout, markdown notes, a summary-statistics CSV, a scanned problem-sheet PDF (triggers corpus preparation) and a Wikipedia reference URL.',
      expectedTopics: [
        'descriptive statistics (centre, spread, shape)',
        'sampling distributions and the standard error',
        'confidence intervals',
        'hypothesis testing, p-values, type I/II error and power',
        'correlation vs causation, linear regression',
        "common traps (Simpson's paradox, regression to the mean, multiple comparisons)",
      ],
    },
  });

  console.log(`Done. Sets written under ${SETS_DIR}`);
}

main().catch((err) => {
  console.error('Failed to build sample sets:', err);
  process.exit(1);
});
