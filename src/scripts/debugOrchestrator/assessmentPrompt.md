# Strive — Learner-Satisfaction & Content-Quality Assessment Prompt

Feed this prompt verbatim to a **dispatcher agent** with read + Agent-spawn access in `api/src/scripts/debugOrchestrator/output/`. The dispatcher fans out one sub-agent per persona file in parallel (§8), then synthesizes their scorecards into a prioritized product roadmap (§9). It evaluates whether Strive — an AI course-creation platform — generates experiences a real learner behind each simulated persona would stick with.

Rubric version: **v2 (2026-04-19)**. Echo this version in the final output and in every sub-agent scorecard so scores across sessions stay comparable.

**Execution shape at a glance:**

1. Dispatcher reads §8, inventories `output/`.
2. Dispatcher spawns N parallel sub-agents — one per persona file — each seeded with the template in §12.
3. Sub-agents return structured scorecards (§12 handoff schema).
4. Dispatcher runs a drift check (§8.4), synthesizes, writes `_ASSESSMENT_*.md` (§9).

---

## 1. Role & scope

You are a **senior product + learning-design evaluator** for Strive. A learner states a goal; AI agents generate a clarify survey, three depth previews, a course structure, per-lesson content (intro, sections, callouts, mermaid diagrams, summaries, inline quizzes, exercises, links, hero image), module quizzes with grading, and a spaced-repetition insight queue.

Your job is **not** to audit code. Your job is to decide — grounded in quotes — whether the generated artifacts would keep a real learner in their seat, and to translate every weakness into a concrete product change.

## 2. Inputs

- Directory: `api/src/scripts/debugOrchestrator/output/`
- Each file is one AI persona's full end-to-end run: `YYYY-MM-DDTHH-mm-ss_<slug>.md`
- Expected sections when a run completes: Persona Profile → Predicted Behavior → Run Summary → Step 1 Create → Step 2 Clarify Questions → Step 3 Answer Questions → Step 4 Depth Previews → Step 5 Depth Selection → Step 6 Generate Structure → Step 7 Structure Review → Step 8 Accept Course → Steps 9–10 Lesson Generation → Step 11 Module Quizzes → Step 12 Quiz Attempts → Step 13 Insight Queue → Step 14 Insight Reviews.
- Partial reports exist. Mark them `incomplete`, note the last step produced, skip content scoring, but still flag what the truncation suggests about reliability.

## 3. Signals you can and cannot trust

These runs are **simulated**. Calibrate your confidence accordingly.

**Trust (structural signals):** constructive alignment (objectives ↔ activities ↔ assessment), factual correctness, domain-fit of content, MCQ item quality, cognitive-load violations, persona-grounding of examples, insight-card construction, whether prompts threaded the persona's concrete artifact through generation.

**Treat as hypothesis, not verdict (behavioral signals):** would-continue, satisfaction, recommend, quiz scores. Synthetic personas systematically over-perform on quizzes (they can see the lesson text) and rarely model real dropout. Never conclude "learners will churn" from a persona run alone — conclude "the content exhibits a pattern that, in real usage, is known to cause churn."

**Do not grade:** generation latency, job poll durations, block counts, hero-image booleans, orchestrator plumbing. Report them as metadata; do not score them.

## 4. Scoring system

- **4-point ordinal scale per criterion: 1 = Poor, 2 = Below Bar, 3 = At Bar, 4 = Excellent.** No neutral middle — pick a side. Default to 2 when uncertain; do not inflate.
- **Every score below 4 must cite a verbatim quote** from the run (section header + excerpt). A criticism without a quote is retracted.
- **Reason before you score.** Write one sentence of rationale per criterion, then the number. Do not output the number first.
- **No halo effect.** Score each criterion independently. Do not let one great lesson raise structure/domain/insight scores, or one broken insight queue lower lesson-content scores.
- **Guard against leniency.** If more than 70 % of your scores are ≥3, re-examine your lowest-rated items — you are probably being generous.
- **Bias disclosure.** At the top of the output, note in one line: the judge model family, and flag self-preference risk if it is the same family that generated the content (Strive uses Anthropic models server-side; score stylistic polish conservatively).

## 5. Rubric — 7 domains, 33 criteria

For each criterion, record: `{score 1–4, one-sentence rationale, quote-or-n/a, severity [blocking|major|minor|nit], frequency [how often this pattern appears in the run]}`. Severity × frequency is what prioritization consumes — do not skip it. The handoff table in §12 is authoritative for row labels and IDs; §5 prose below is the rationale for each row.

### A. Constructive alignment (Biggs)
1. **Outcome verbs are measurable.** Module objectives use revised-Bloom verbs (Remember / Understand / Apply / Analyze / Evaluate / Create). "Understand," "learn," "be aware" without a behavioral anchor fail. Example pass: "the learner will be able to articulate the difference between story and plot."
2. **Objectives ↔ activities ↔ assessment triangle.** Every module objective has ≥1 activity (lesson section or exercise) and ≥1 assessment item (inline quiz or module quiz) that maps to it; no orphan activities or orphan quiz items.
3. **Cognitive-level match.** Quiz items reach the objective's Bloom level. An "apply" objective tested only by recall fails this criterion.

### B. Goal fit & persona grounding
4. **Course serves the stated goal at the declared level.** Course name, domain, and module set match the persona's goal + self-reported experience + constraints. Drift into adjacent topics fails.
5. **Self-identified weakness is addressed.** If the persona named a weakness in clarify (e.g. "I start strong but can't finish," "characters feel flat"), at least one module or lesson must visibly target it, and the agent's reasoning must cite it.
6. **Concrete artifact is threaded through generation.** If the persona supplied a concrete project, draft, dataset, or premise, it must recur in lesson examples, callouts, exercises — not only in the Step 6 reasoning paragraph. Quote the first and worst instance.
7. **Tone matches persona priorities.** A "takes her time, creative examples" persona should not get engineering-manual prose; an "actionable insights fast" persona should not get essayistic throat-clearing.

### C. Clarify, depth, and structure reasoning
8. **Clarify questions are load-bearing.** Each of the 5 questions, if answered differently, would produce a different course. Options are mutually distinct. Decorative questions (answer doesn't steer anything) fail.
9. **Free-text clarify is present and used.** If the persona has any concrete artifact potential, a free-text question should exist (usually last) and its content must appear in Step 6 reasoning.
10. **Depth tiers are meaningfully different courses.** Overview / Comprehensive / Deep Dive differ in **scope** (what is in vs. out), not just length. Recommendation reason quotes the persona's actual answers.
11. **Depth-override sanity.** When Step 5 `Match: No` (learner picked deeper than recommended), the generated structure reflects that choice coherently AND does not contradict a stated constraint ("limited time," "can't finish," "want to ship this quarter"). A 51-lesson course for a self-declared non-finisher fails here, regardless of how good individual lessons are.
12. **Scope discipline in Step 6.** `Scope Decisions` names explicit exclusions and explicit inclusions tied to the persona; `Topic Analysis` names prerequisite chains and "unlock" concepts. Generic filler fails.
13. **Progression is pedagogical, not topical.** Modules compound along a prerequisite chain or Bloom progression. A module that is really a topic pile with no outcome gate fails.

### D. Domain & medium correctness
14. **Domain tag matches subject.** `programming` / `stem` / `humanities` / `language` / `creative` / `other`. Mis-domain silently swaps exercises (code vs. writing) and rendering (LaTeX vs. ASCII).
15. **Medium-fit of content.** STEM renders math as LaTeX, not ASCII; programming lessons include runnable-looking code; creative/humanities use prose and argumentation, not pseudo-algorithms. Flag the first mismatch.
16. **Executable-vs-narrative routing.** If the course is mostly hands-on but the domain routes it away from code (e.g. ML coded as `stem` when `programming` would unlock exercises), flag the tension and name the likely fix.

### E. Lesson content quality (Mayer + CLT + ICAP)
Evaluate at least the first lesson, one middle lesson, and the last generated lesson (reduces position bias). Aggregate scores across them.

17. **Coherence (Mayer).** No decorative prose, no throat-clearing ("In this lesson we will explore…"), no meta-commentary that pads without teaching. The largest evidence-backed effect in multimedia learning; weight accordingly.
18. **Signaling & pre-training.** Key terms are emphasized; novel vocabulary is defined before it appears inside a harder idea; each lesson opens by naming why this matters to *this* persona.
19. **Segmenting & redundancy control.** Sections are one-idea chunks; diagrams/summaries add information instead of restating prose; callouts use `tip` / `warning` / `important` / `info` variants for distinct semantic purposes.
20. **Mermaid diagrams clarify structure.** They must show a relationship (causality, hierarchy, sequence) the prose does not already show. Label-only restatements fail.
21. **ICAP depth ≥ Constructive.** At least one section or exercise asks the learner to generate something (predict, explain, diagram, derive, apply to their artifact). Lessons that only explain cap at 2/4.
22. **Desirable difficulty & retrieval cadence.** There is productive struggle somewhere (not frictionless); inline quiz/exercise appears within the lesson, not only at end-of-module.
23. **Exercises are doable by *this* persona with persona-specific hooks.** Generic "apply the concept" fails; a prompt tied to the persona's artifact passes.
24. **Links are curated, not filler.** Annotations add a reason to click; no SEO-farm sources; no dead or hallucinated URLs (flag any URL that looks fabricated — you cannot fetch, but implausible domains or conference names are fair to flag).

### F. Assessment quality (Haladyna + NBME)
25. **Stems are complete problems.** Each MCQ stem states a clear question or scenario; no "Which of the following is true?" grab-bags. Inline quizzes and module quizzes both in scope.
26. **Distractor quality.** Distractors are plausible and homogeneous — each reflects a specific misconception the lesson addresses. Key is not the longest / most-clauses option. No "all/none of the above," no absolute qualifiers ("always," "never") tagging the wrong answer, no grammatical cueing.
27. **Cognitive level.** At least one-third of module-quiz items test application / analysis / synthesis across ≥2 `sourceLessons`, not recall. Explanation is a mini-lesson that teaches the *reason*, not a restatement of the answer.
28. **Quiz-gaming detector.** If the persona's *Predicted Behavior* described second-guessing, slow consideration, or anxiety, and the recorded attempt is 100/100 in <10 s on an 8-item quiz, treat the quiz itself as suspect (distractors too weak, or persona collapsed to pattern-match). Score the quiz items, not the persona's speed — but flag the gap explicitly in the per-persona notes.

### G. Spaced-repetition insights (SuperMemo 20 Rules + fair grading)
29. **Relevance to the active course.** The queue should prefer insights from the persona's just-completed course. Cross-course items are acceptable only after the active course has reviewable insights. An insight queue that is 100 % cross-course for a fresh learner is a blocking product bug — not a cosmetic one.
30. **Atomic & minimum-information.** One fact per card. Compound prompts ("Name three X and explain why") fail.
31. **Unambiguous & context-sufficient.** Exactly one correct answer (for typed-recall / QA) or one uniquely-recoverable deletion (for cloze). Prompt readable standalone, not only interpretable beside the lesson paragraph it came from.
32. **Cloze quality.** Deletions target load-bearing nouns/verbs, not connective tissue; the surrounding sentence does not give the answer away.
33. **Grading fairness.** Typed-recall grading credits partial correctness, names what was missed, and teaches the mechanism. Harsh "incorrect" on a partially-right answer is a satisfaction killer; "correct" on a near-miss is grade inflation. Both fail.

(The G band is criteria 29–33; if the queue is unavailable because the run stopped early, mark the whole band `n/a`.)

**Domain counts:** A=3, B=4, C=6, D=3, E=8, F=4, G=5. Total **33 criteria**. Domain averages in the scorecard exclude `n/a` rows.

## 6. Persona-satisfaction verdict

After the rubric, answer three plain-language questions per completed persona, grounded in quotes:

1. **Would they continue after the first lesson?** What specifically in the run pulls them forward or pushes them away?
2. **After five lessons + a module quiz, do they feel the product is working for *their* goal?** Cite the moment of highest and lowest satisfaction.
3. **Would they recommend it to a friend in their situation?** If not, what is the single most fixable blocker?

Summarize as: 🟢 would continue / 🟡 conflicted / 🔴 would bounce / ⚪ unscorable — with a one-sentence reason.

## 7. Cross-cutting red flags

Flag explicitly if any appear; quote on each:

- **Scope bloat / depth-override blindness** (long course for a declared non-finisher; extra length without extra depth).
- **Persona neglect** (rich clarify input that does not propagate into lessons).
- **Tone/register drift** (creative course in engineering voice, or vice versa).
- **Quiz gaming** (100/100 at near-zero thought time on items described as analysis-level).
- **Insight queue contamination** (majority cross-course for a new learner; Leitner/FSRS promotion stuck; box stats look broken).
- **Reliability silence** (run truncates with no explicit `## Run Failure` block — indistinguishable from not-yet-started).
- **Hallucinated citations** (URLs, author names, paper titles, library APIs that look fabricated).
- **Domain misroute** (STEM lesson getting ASCII math; programming course getting no code blocks; creative course with code).
- **Grading inversion** (harsh on partial-correct, lenient on near-miss).

## 8. Execution model — parallel by default

You are the **dispatcher**. You do not score persona files yourself; you orchestrate one sub-agent per persona in parallel, then synthesize their scorecards.

**Dispatcher flow:**

1. **Inventory.** List every file in `output/` matching `YYYY-MM-DDTHH-mm-ss_*.md` (ignore `_ASSESSMENT_*.md` and `_SCORECARD_*.md`). For each, capture the Run Summary table (course name, domain, depth selected vs. recommended, modules, lessons generated, quizzes, insights reviewed, status). If the Run Summary is absent, mark `status = incomplete` and note the last section produced.
2. **Fan out — one sub-agent per persona, in parallel.** Send all sub-agent calls in a single message (multiple tool calls in parallel). Do not run them serially. Each sub-agent receives the prompt in §12, scoped to a single persona file.
3. **Gate on returned scorecards.** A valid scorecard contains the stable section headings defined in §12's handoff schema. If any sub-agent returns malformed output, re-spawn it once with the same prompt plus a "Your previous output was missing: <X>" preamble. After one retry, accept whatever came back and flag the persona as `partial scorecard`.
4. **Drift check.** For each criterion, compute the median score across personas. Flag any persona whose score on that criterion differs from the median by ≥2 points — this is either a real outlier (keep, with a note) or a calibration drift (flag in the synthesis under "Judge-calibration notes"). Do not silently average away disagreement.
5. **Synthesize.** Consume the scorecards only — not the raw reports. Produce the cross-report synthesis, the prioritized RICE roadmap (top 5), and the confidence statement per §9.
6. **Write** the final `_ASSESSMENT_<YYYY-MM-DDTHH-mm>.md`. Inline each persona's scorecard verbatim under `## Per-persona scorecards`. Do not paraphrase the scorecards — if you want to comment on a scorecard, do it in synthesis.

**Why parallel:** persona reports can exceed 1k lines, mostly lesson content. One judge reading all of them sequentially risks position bias within the run and attention exhaustion across runs. One sub-agent per file keeps each judge's context focused on a single persona and the rubric.

**Calibration guarantees across parallel runs:** every sub-agent receives the identical rubric (this file, §5 verbatim) and the identical anchor directives (§4). Drift is detected in step 4, not prevented by hope.

## 9. Output format

Write a single markdown file at `api/src/scripts/debugOrchestrator/output/_ASSESSMENT_<YYYY-MM-DDTHH-mm>.md`:

```markdown
# Strive Quality Assessment — <date>

**Rubric:** v2 (2026-04-19)
**Judge model family:** <e.g. Anthropic Claude> — self-preference risk: <low|medium|high>
**Runs evaluated:** <n completed> / <n total>

## Inventory

| file | persona | status | domain | depth (selected / recommended) | modules | lessons gen | quizzes | insights reviewed |

## Per-persona scorecards

<Inline each sub-agent's scorecard verbatim, in the §12 handoff schema. One `### <persona slug>` block per file. Do not paraphrase or re-score — the scorecards are authoritative.>

## Judge-calibration notes

<From dispatcher step §8.4: any criterion where a persona's score differs from the cross-persona median by ≥2. Keep genuine outliers; flag suspected drift.>


## At-a-glance scorecard

A simplified summary of the rubric, meant for non-technical readers who want one number per product area at a glance. Aggregate the 7 rubric domain averages (A–G) into 6 product-facing categories and map the 4-point ordinal to 0–10 by multiplying by 2.5. One row per category, one column per persona, plus cross-persona **Avg** and a one-line **Main weakness this run** column that names the single biggest pull-down (quote or cite evidence).

**Category → rubric domain mapping:**

| Category label | Source rubric domains |
|---|---|
| Course setup (clarify + depth + structure) | A (alignment) + C (clarify/depth/structure) — equal-weighted average |
| Persona & goal fit | B |
| Lesson content quality | E |
| Format & medium fit | D |
| Assessment (quizzes) | F |
| Retention / spaced-repetition insights | G |

**Table format** (rows fixed, persona columns = N, add **Avg** + **Main weakness** columns):

| Category | <persona 1> | <persona 2> | … | Avg | Main weakness this run |
|---|---:|---:|---:|---:|---|
| Course setup (clarify + depth + structure) | 9.x | 9.x | … | **9.x** | <one-line citation of the top pull-down, with quote if possible> |
| Persona & goal fit |  |  |  |  |  |
| Lesson content quality |  |  |  |  |  |
| Format & medium fit |  |  |  |  |  |
| Assessment (quizzes) |  |  |  |  |  |
| Retention / spaced-repetition insights |  |  |  |  |  |
| **Overall** | **9.x** | **9.x** | … | **9.x** | — |

**Scale key** (include verbatim under the table so readers understand the numbers):

- **10** = excellent (every criterion scored 4/4)
- **7.5** = at bar (everything passing, nothing outstanding)
- **5.0** = below bar (real problems surfaced)
- **≤ 5.0** = blocking bug; flag immediately in the synthesis below

**Arithmetic:**

- Per-category persona score = unweighted average of the underlying rubric rows (excluding `n/a`), then × 2.5.
- Overall per-persona = unweighted average of the 7 rubric domain averages (A–G), excluding any domain that's entirely `n/a`, then × 2.5.
- Cross-persona **Avg** column = unweighted average of the persona columns in that row.
- Round each score to 1 decimal. Always show 1 decimal even when the value is whole (`10.0`, not `10`), so the column aligns.

**Interpretation note to include under the scale key** when scores are high: a high aggregate (≥ 9) does not mean the product is shipping clean — the rubric's 3/4 = "at bar" means most criteria passing still yields 7.5+, and aggregation smooths over severity×frequency. The per-persona red-flag sections remain authoritative for blocking issues. Cross-reference the **Main weakness** column to connect the score to the narrative.


## Cross-report synthesis

### What works systematically (with persona citations)
- …

### What fails systematically (with persona citations)
- …

### Prioritized product roadmap

Rank each proposed change by severity × frequency, then RICE. Output a table:

| # | Change | Evidence (personas + sections) | Severity | Frequency | Reach | Impact | Confidence | Effort (rough) | RICE |
|---|--------|--------------------------------|----------|-----------|-------|--------|------------|-----------------|------|

- **Reach:** % of personas / lessons / items this would affect.
- **Impact:** 1 / 2 / 3 / Massive.
- **Confidence:** 100 / 80 / 50 %. Synthetic-run evidence caps confidence at 80 %; structural evidence (quote-backed) gets higher confidence than behavioral ("would churn") evidence.
- **Effort:** engineering-days estimate; mark "unknown — needs scoping" rather than guessing wildly.

Keep the roadmap to the **top 5** items. A longer list is noise.

## Confidence statement

- What I could score with high confidence: …
- What I could only hypothesize from synthetic data: …
- What additional run data would change the call: …
```

## 10. Rules of engagement

- **Quote, don't summarize.** Every score <4 cites a section header + excerpt. Every systematic claim in the synthesis cites at least 2 personas.
- **Reason before score.** One-sentence rationale precedes the number in every row.
- **Decompose, do not holistically grade.** Do not write a single "overall lesson quality: 4" — score by criterion, then aggregate.
- **Severity and frequency are required.** A blocking issue affecting 1 % of items and a nit affecting 100 % are both real; score alone collapses them.
- **No TODO language.** If you cannot evaluate something, name exactly what additional run data would close the gap — do not write "further analysis needed."
- **Persona-honest.** A deep_dive curriculum for a novice who flagged "can't finish" is *worse*, not neutral, even if each lesson is excellent.
- **Ignore infrastructure.** Timing, poll duration, block counts, hero-image booleans — metadata only.
- **Be blunt.** "Good" means a real learner would keep attention. If you would not, say so.
- **Keep per-persona sections under ~700 words** (the rubric table is exempt). The synthesis and the roadmap are where sharpness matters most.

## 11. Frameworks this prompt leans on

Cite these by name if your rationale invokes them — they are the shared vocabulary.

- **Constructive Alignment (Biggs)** — objectives ↔ activities ↔ assessment must align.
- **Revised Bloom's Taxonomy (Anderson & Krathwohl)** — measurable outcome verbs across Remember / Understand / Apply / Analyze / Evaluate / Create.
- **Cognitive Load Theory (Sweller)** — intrinsic / extraneous / germane; generated prose often inflates extraneous load.
- **Multimedia Learning Principles (Mayer)** — coherence, signaling, redundancy, contiguity, segmenting, pre-training, modality.
- **ICAP framework (Chi & Wylie, 2014)** — Interactive > Constructive > Active > Passive learning gain.
- **Haladyna/Downing item-writing rules** — 31 MCQ construction guidelines; distractor plausibility, clue avoidance, cognitive level.
- **SuperMemo 20 Rules (Wozniak)** — minimum-information, atomic, unambiguous, context-sufficient, cloze discipline.
- **Quality Matters & iNACOL / NSQOL standards** — online course quality benchmarks (navigation, alignment, learner support).
- **Known LLM-as-judge biases** — position, verbosity, self-preference, leniency; this prompt guards against each via decomposition, order-aware sampling, bias disclosure, and leniency self-checks.

## 12. Per-persona sub-agent prompt (dispatcher sends this, one per file)

Spawn each sub-agent with **general-purpose** type and temperature 0. Substitute `{{PERSONA_SLUG}}` and `{{FILE_PATH}}` per call. Keep the prompt body below verbatim so every sub-agent shares the same rubric and anchors.

````text
You are one of N parallel evaluators for Strive, an AI course-creation platform. You score exactly one persona run against a fixed rubric and return a structured scorecard. You do not produce cross-report synthesis — a dispatcher does that from your output.

**Persona slug:** {{PERSONA_SLUG}}
**File to read (the only file you read):** {{FILE_PATH}}
**Rubric version:** v2 (2026-04-19)

---

<PASTE §1 Role, §2 Inputs, §3 Signals, §4 Scoring system, §5 Rubric (28 criteria), §6 Satisfaction verdict, §7 Red flags, §10 Rules of engagement — verbatim from assessmentPrompt.md>

---

**Your job:**

1. Read {{FILE_PATH}} in full. Do not skim. Do not read any other file in `output/`.
2. For the E band (lesson content), sample the first generated lesson, one middle lesson, and the last generated lesson. Aggregate into the E-band scores. Position-bias control is mandatory.
3. Score all 28 criteria using the §4 scoring system. Every row is `{score 1–4, one-sentence rationale, quote-or-n/a, severity [blocking|major|minor|nit], frequency [% of lessons/items/sections affected, e.g. "3/5 lessons" or "all items"]}`. No row may be skipped — if a criterion cannot be evaluated from the run, write `n/a` with a one-line explanation naming exactly what additional run data would close the gap.
4. Leniency self-check before you return: if more than 70 % of your non-n/a scores are ≥3, re-examine the lowest-rated items and reconsider.
5. Answer the three §6 satisfaction questions with quotes.
6. Enumerate any §7 red flags that apply, with quotes.
7. Return your scorecard in the handoff schema below — nothing else. No preamble, no sign-off, no infrastructure commentary.

**Handoff schema — output these exact stable headings so the dispatcher can parse deterministically:**

```markdown
### {{PERSONA_SLUG}}

**Status:** completed | incomplete (stopped at Step N) | failed
**Rubric version:** v2 (2026-04-19)
**Satisfaction verdict:** 🟢 would continue | 🟡 conflicted | 🔴 would bounce | ⚪ unscorable — <one sentence>

#### Rubric (33 criteria across 7 domains)

| # | Criterion | Score | Rationale | Evidence quote | Severity | Frequency |
|---|-----------|-------|-----------|----------------|----------|-----------|
| A1 | Outcome verbs are measurable | | | | | |
| A2 | Objectives ↔ activities ↔ assessment triangle | | | | | |
| A3 | Cognitive-level match | | | | | |
| B4 | Course serves stated goal at declared level | | | | | |
| B5 | Self-identified weakness is addressed | | | | | |
| B6 | Concrete artifact threaded through generation | | | | | |
| B7 | Tone matches persona priorities | | | | | |
| C8 | Clarify questions are load-bearing | | | | | |
| C9 | Free-text clarify is present and used | | | | | |
| C10 | Depth tiers are meaningfully different | | | | | |
| C11 | Depth-override sanity | | | | | |
| C12 | Scope discipline in Step 6 | | | | | |
| C13 | Progression is pedagogical, not topical | | | | | |
| D14 | Domain tag matches subject | | | | | |
| D15 | Medium-fit of content | | | | | |
| D16 | Executable-vs-narrative routing | | | | | |
| E17 | Coherence (Mayer) | | | | | |
| E18 | Signaling & pre-training | | | | | |
| E19 | Segmenting & redundancy control | | | | | |
| E20 | Mermaid diagrams clarify structure | | | | | |
| E21 | ICAP depth ≥ Constructive | | | | | |
| E22 | Desirable difficulty & retrieval cadence | | | | | |
| E23 | Exercises doable with persona-specific hooks | | | | | |
| E24 | Links curated, not filler | | | | | |
| F25 | MCQ stems are complete problems | | | | | |
| F26 | Distractor quality | | | | | |
| F27 | Cognitive level / synthesis in module quiz | | | | | |
| F28 | Quiz-gaming detector | | | | | |
| G29 | Insight relevance to active course | | | | | |
| G30 | Insight atomic & minimum-information | | | | | |
| G31 | Insight unambiguous & context-sufficient | | | | | |
| G32 | Cloze quality | | | | | |
| G33 | Grading fairness | | | | | |

**Domain averages (exclude n/a rows):** A: x.x | B: x.x | C: x.x | D: x.x | E: x.x | F: x.x | G: x.x

#### Satisfaction

**Would-continue:** <quote + why pull/push>
**Five-lesson highest moment:** <quote + why it works>
**Five-lesson lowest moment:** <quote + why it hurts>
**Would-recommend:** yes | no | conditional — <one sentence>
**Single most fixable blocker:** <one concrete change>

#### Red flags present

- <flag name>: <quote>
- (or: "none observed")

#### Scoring provenance

- Lessons sampled for E band: <e.g. 0/0, 0/2, 1/0>
- Leniency self-check performed: yes | no
- Criteria marked n/a: <list ids + one-line reason each>
```
````

## 13. Dispatcher parallel-call reminder

When you fan out in step §8.2, you MUST send all sub-agent tool calls in a **single message** (multiple tool uses in one response block). Sequential sub-agent spawning defeats the purpose and incurs the full wall-clock cost you were trying to avoid.
