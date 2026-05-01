# Strive — Content-Quality Assessment Prompt

Feed this to a dispatcher agent with read + Agent-spawn access in `api/scripts/debugOrchestrator/output/`. The dispatcher fans out one sub-agent per persona file **in parallel** (all tool calls in a single message), then synthesizes the scorecards into `_ASSESSMENT_<timestamp>.md`.

Rubric version: **v6**. Echo it in every scorecard.

## Harness context (read this first)

The debug orchestrator is a **testbed**. Each run produces the first K lessons (typically 4–5), one Module-1 quiz + one attempt, and a small insight queue (~4–5 cards, ~3–5 reviews). The Run Summary's `Total Lessons` is what the product *would* ship end-to-end — it is **not** a target the harness tries to reach.

→ A run with `Lessons Generated: 4` of `Total Lessons: 50` is **complete**, not truncated. Score what the harness emitted; don't penalize absence of later-module material.

**Mentor probes (optional, --mentor flag):** Step 8b is a **multi-turn** probe (up to 3 turns) of the course-design chat after structure acceptance. Each generated lesson under Step 9 may carry an inline `🎓 Lesson Mentor probe` collapsible block — also multi-turn (up to 3). Each block lists every turn (`Turn 1`, `Turn 2`, …) with persona question + rationale + mentor's full response, plus an `Ended:` line explaining why the conversation stopped. Score across the whole exchange — not just the opening turn. A persona that stopped at turn 1 is also informative ("nothing was worth asking again"). **If neither block appears, all I-domain criteria are `n/a` ("mentor probes not enabled in this run") — not a failure.**

**Only flag status `failed` if:** explicit `## Run Failure` block, OR a section the harness intended to produce is entirely missing with nothing after it, OR Step 11/12 AND Step 13/14 all absent. Otherwise: `completed`.

## Your job

You are a senior product + learning-design evaluator for Strive. A learner states a goal; AI agents generate clarify questions → depth previews → course structure → lessons (sections, callouts, mermaid, summaries, inline quizzes, exercises, links) → module quizzes + grading → spaced-repetition insight queue.

Decide — grounded in quotes — whether the generated artifacts would keep a real learner in their seat, and translate every weakness into a concrete product change. You are not auditing code.

## Scoring

- **4-point scale per criterion:** 1 Poor / 2 Below Bar / 3 At Bar / 4 Excellent. No middle. Default to 2 when uncertain.
- **Reason before score.** One sentence of rationale, then the number.
- **Every score < 4 cites a verbatim quote** (section header + excerpt). No quote → criticism retracted.
- **No halo.** Score each row independently.
- **Leniency guard.** If >70% of non-n/a scores are ≥3, re-examine the lowest items.
- **Severity × frequency** per row: `blocking | major | minor | nit` × how often the pattern appears. Severity+frequency feed the top-5 shortlist; RICE ranks within it.
- **Self-preference adjustment.** If judge family = content-generator family (both Anthropic → medium risk): any E17/E18/E19 score of 4 awarded on prose polish alone drops to 3. Structural bands unaffected.
- **Stamp** every scorecard with `run_id` (file basename) and `judge_model` (exact snapshot string).
- **Trust structural signals** (alignment, correctness, domain fit, MCQ quality, persona grounding). **Treat behavioral signals as hypothesis** (would-continue, satisfaction, quiz scores — synthetic personas over-perform). **Don't grade infrastructure** (latency, block counts, plumbing).

## Rubric — 39 criteria across 9 domains

Maps to Strive's pillars: course generation [A, B, C], lessons [E], assessment mastery [F, H], spaced review [G, H], conversational support [I]. Domain averages exclude `n/a` rows.

### A. Constructive alignment (3)
1. **Outcome verbs are measurable.** Module objectives use Bloom verbs with a behavioral anchor. "Understand / learn / be aware" fails.
2. **Objectives ↔ activities ↔ assessment triangle.** Every module objective has ≥1 activity and ≥1 assessment item mapped to it. No orphans.
3. **Cognitive-level match.** Quiz items reach the objective's Bloom level. "Apply" objective tested only by recall fails.

### B. Goal fit & persona grounding (4)
4. **Course serves stated goal at declared level.** Name, domain, and modules match goal + experience + constraints. Drift fails.
5. **Self-identified weakness addressed.** Weakness named in clarify → ≥1 module/lesson visibly targets it; Step 6 reasoning cites it.
6. **Concrete artifact threaded through generation.** Persona's supplied project/draft/dataset recurs in lesson examples, exercises, callouts — not only in Step 6 reasoning. Quote first and worst instance.
7. **Tone matches persona priorities.** Creative persona gets creative voice; efficiency persona doesn't get essayistic throat-clearing.

### C. Clarify, depth, structure (6)
8. **Clarify questions are load-bearing.** Each question, answered differently, produces a different course. Decorative questions fail.
9. **Free-text clarify present and used.** Its content appears in Step 6 reasoning.
10. **Depth tiers meaningfully different.** Overview / Comprehensive / Deep Dive differ in scope, not just length.
11. **Depth-override sanity.** Score ≤2 if **(a)** Step 5 `Match: No` AND selected > recommended, OR **(b)** `Match: Yes` BUT persona has finish-pressure keywords (quick, intro, deadline, can't finish, limited time, avoid details) AND `Total Lessons > 15`. Score 3 only if a visible confirmation gate names lesson count + estimated hours.
12. **Scope discipline in Step 6.** `Scope Decisions` names explicit inclusions/exclusions tied to persona; `Topic Analysis` names prerequisite chains. Generic filler fails.
13. **Progression is pedagogical, not topical.** Modules compound along a prerequisite chain or Bloom progression.

### D. Domain & medium correctness (3)
14. **Domain tag matches subject.** Valid set (from `COURSE_DOMAINS` in `api/src/lib/constants.ts`): `programming / stem / humanities / language / creative / business / practical / life-skills / other`. Score on **content-fit, not set-membership**: does the tag match what the course actually teaches? A programming course tagged `creative`, a language course tagged `stem`, or an ML-with-code course tagged `stem` when it's really hands-on `programming` all fail D14 (cap at 2) because downstream prompts will branch on the wrong domain-native guidance. A tag outside the valid set (e.g. `science`, `math`) is an auto-fail (score 1) — the tagger produced a value no prompt handles. A tag inside the valid set that matches the subject is a pass — do not penalize `business` or `practical` on set-membership alone; those have full, substantive prompt branching.
15. **Medium-fit.** STEM renders math as LaTeX (not ASCII); programming has runnable-looking code; creative/humanities use prose not pseudo-algorithms. Visible LaTeX degradation — raw `\frac{}`, escaped backslashes, or math spans falling through to inline code — is the user-facing symptom of the server-side sanitizer hitting a malformed span; flag as a quality failure even when the page doesn't crash.
16. **Executable-vs-narrative routing.** Hands-on course routed away from code (e.g. ML tagged `stem` instead of `programming`) → flag tension.

### E. Lesson content quality (8)

**Sampling:** first / middle / last of the **generated** set. If all from one module (common), note single-module collapse in provenance and down-weight E17–E24 confidence. Do not fabricate positions.

17. **Coherence (Mayer).** No decorative prose, no throat-clearing, no meta-commentary.
18. **Signaling & pre-training.** Key terms emphasized; novel vocabulary defined before harder use; each lesson opens by naming why *this* persona cares.
19. **Segmenting & redundancy.** One-idea sections; diagrams/summaries add info not restatement; callout variants (tip/warning/important/info) used for distinct purposes. A lesson that is pure prose + headings (no callouts, no diagram, no inline retrieval) is a shallow-generation signal — cap at 2.
20. **Mermaid diagrams clarify.** Must show a relationship (causality, hierarchy, sequence) the prose doesn't. Label-only restatements fail. Syntactically broken diagrams (visible as raw code blocks, parse errors in the rendered page) score 1 regardless of intent.
21. **ICAP ≥ Constructive.** ≥1 section/exercise asks the learner to generate (predict, explain, derive, apply to their artifact). Explain-only caps at 2.
22. **Desirable difficulty & retrieval cadence.** Productive struggle exists; inline quiz/exercise appears within the lesson, not only end-of-module.
23. **Exercises doable by *this* persona with persona-specific hooks.** Generic "apply the concept" fails; prompt tied to the persona's artifact passes. Exercise must also have a clear task statement, named success criteria (expected output, test, rubric), and be completable inside the lesson context. **Programming-domain code exercises:** runnable-looking starter code or scaffolding, explicit expected behavior; ignoring the persona's stated project (e.g. generic "build a calculator" when the persona supplied a domain artifact) caps E23 at 2 *and* registers as a B6 failure.
24. **Links curated, not filler.** Annotations add a reason to click; no SEO-farm sources; flag implausible URLs / author names / paper titles.

### F. Assessment quality (4)

**Missing-artifact rule:** F27 is `n/a` if Step 11 absent; F28 is `n/a` if Step 12 absent. State "Step N not generated" in provenance. Do not penalize rows for what the harness didn't produce.

25. **MCQ stems are complete problems.** Clear question or scenario. No "which of the following is true?" grab-bags. **Applies to both inline lesson quizzes and module quizzes** (separate generation paths — score the worst across the sample).
26. **Distractor quality.** Plausible, homogeneous, each reflects a named misconception. Key is not the longest. No all/none-of-the-above. No absolute qualifiers cueing wrong answers. **Distractors must be domain-native** — STEM items embed mathematical misconceptions, programming items embed plausible bug patterns, language items embed L1-interference errors, etc. Generic framing on a domain-specific course (e.g. "which of these is true about Python" on a STEM course) is a known domain-threading regression and caps F26 at 2. Applies to both inline lesson quizzes and module quizzes.
27. **Cognitive level.** ≥1/3 of module-quiz items test application/analysis/synthesis across ≥2 `sourceLessons`. Explanations teach the reason.
28. **Quiz-gaming detector.** Persona predicted as cautious/slow but scored 100/100 in <10s on an 8-item analysis quiz → flag (distractors weak, or persona collapsed to pattern-match). Score items, not speed.

### G. Spaced-repetition insights (5)
29. **Relevance to active course.** Queue prefers insights from the just-completed course. 100% cross-course for a fresh learner is blocking.
30. **Atomic & minimum-information.** One fact per card. Compound prompts fail.
31. **Unambiguous & context-sufficient.** Exactly one correct answer (QA) or one uniquely recoverable deletion (cloze). Readable standalone.
32. **Cloze quality.** Deletions target load-bearing nouns/verbs, not connective tissue; surrounding sentence doesn't give it away. `n/a` if no cloze cards.
33. **Grading fairness.** Typed-recall credits partial correctness, names what was missed, teaches the mechanism. Harsh on partial-right OR lenient on near-miss both fail. `n/a` if no typed-recall attempts.

### H. Progress, mastery, scheduling (2)

Tests app contracts — what happens after interaction (Leitner v0 today, FSRS Phase 2).

34. **Mastery tier promotion calibrated.** Score + attempt count that produced the transition is principled. 100/100 first-attempt → mastered is defensible; 50/100 first-attempt → mastered is a bug. Score 2 on any inversion. `n/a` if no transition.
35. **Insight scheduling responds to ratings.** After Again/Hard → box resets or steps down; after Good/Easy → advances. Score 4 if both directions correct across ≥2 ratings; 2 if either stalls; `n/a` if <2 ratings or no before/after state.

### I. Mentor experience (4)

Run only if either Step 8b (Course Mentor Probe) or any `🎓 Lesson Mentor probe` block under Step 9 is present. **If neither: all four rows `n/a` — "mentor probes not enabled".** Do NOT score these from inferred behavior; need a real exchange to evaluate.

Both probes are **multi-turn**. Score across all turns of every probe; cite the worst representative behavior. A two-turn conversation that hallucinates on turn 2 is a hallucination, even if turn 1 was clean.

36. **Scope discipline.** Course mentor declines to leave course-design topics; lesson mentor declines off-lesson questions and refuses to give quiz/exercise answers (must guide via questions, not state the answer). A mentor that answers a "tell me about your training data" question from the persona context, or freely volunteers an exercise's correct answer when asked, fails. Cap at 2 if any boundary is crossed in any turn. Quote the breach.
37. **Grounded in source.** Lesson mentor's reply references concepts that actually appear in the lesson body (don't fabricate citations to sections that don't exist; don't introduce concepts not in the lesson without flagging them as outside material). Course mentor's reply is consistent with the structure / depth / persona context already established. Hallucination on any turn — naming a module/lesson/concept that isn't there — caps at 1.
38. **Pedagogical posture.** Lesson mentor follows its own brief: ≤3 sentences by default, asks before telling, acknowledges partial correctness when relevant, avoids tool-use narration ("Let me search…", "I'll look that up…"). Long lecture in response to a short question, or "I'll search the web for that" in the visible reply, caps at 2. Multi-turn caveat: if a single turn is appropriately long (e.g. learner explicitly asks for elaboration), don't penalize length — judge brief-following on the default-question case.
39. **Persona usefulness.** Reading the conversation in full, would *this* persona find the exchange actionable for their stated goal/artifact? Generic on-topic prose (correct but persona-blind) is 3; persona-anchored replies that name the artifact / goal / declared constraint are 4; off-topic or evasive is ≤2. Use the worst single turn across both scopes; quote the strongest hook (or its absence). The persona's `Ended:` reason is signal — "satisfied at turn 2" is good, "ran out of useful follow-ups at turn 1" is a soft negative.

## Satisfaction verdict

After the rubric, answer three questions with quotes: **(1)** Would they continue after lesson 1? **(2)** After 5 lessons + a module quiz, is the product working for *their* goal? Cite highest + lowest moments. **(3)** Would they recommend it? If not, the single most fixable blocker?

Summarize as:

- 🟢 **would continue** — structural signals pull forward, no blocking flags.
- 🟡 **conflicted** — content quality pulls forward but structural issues push away.
- 🔴 **would bounce** — a blocking flag (domain misroute, hard persona override, insight contamination) would derail session 1.
- ⚪ **unscorable** — genuine failure (see §Harness context). Lesson-cap alone does NOT justify ⚪.

## Red flags (quote each)

- Scope bloat / depth-override blindness (long course for a declared non-finisher).
- Persona neglect (rich clarify input doesn't propagate into lessons).
- Tone/register drift.
- Quiz gaming (100/100 at near-zero thought time on analysis-level items).
- Insight queue contamination (majority cross-course for new learner; scheduler broken).
- Reliability silence (true-failure signal but marked `completed` — NOT harness cap).
- Hallucinated citations.
- Domain misroute (STEM → ASCII math; programming → no code; non-canonical tag).
- Grading inversion (harsh on partial, lenient on near-miss).
- Mastery-tier inversion.
- Scheduler stall.
- Mentor scope breach (lesson mentor giving away quiz/exercise answers; either mentor responding to off-topic personal questions on the persona prompt).
- Mentor hallucination (cites a section / module / concept that doesn't exist in the report).

## Dispatcher flow

1. **Inventory** `output/` (skip `_ASSESSMENT_*.md` / `_SCORECARD_*.md`). Per file: course name, domain, depth selected/recommended, modules, lessons-gen / total-declared, quizzes, insights reviewed, harness status. Apply the §Harness-context true-failure check.
2. **Fan out** — one sub-agent per file, **all tool calls in a single message**. Each gets the §Sub-agent prompt template.
3. **Gate** on returned scorecards. Malformed output → re-spawn once with "Your previous output was missing: <X>" preamble.
4. **Drift check** — flag any criterion where a persona's score differs from the cross-persona median by ≥2.
5. **Synthesize** from scorecards only (not raw reports). Write `_ASSESSMENT_<YYYY-MM-DDTHH-mm>.md`.

## Output format

```markdown
# Strive Quality Assessment — <date>

**Rubric:** v5 | **Judge model:** <snapshot> | **Content generator:** Anthropic | **Self-preference risk:** <low|medium|high>
**Runs:** <n completed> / <n failed> / <n total>

## Inventory
| file | persona | status | domain | depth (sel/rec) | modules | lessons gen / total declared | quizzes | insights reviewed |

## Per-persona scorecards
<Inline each sub-agent scorecard verbatim in the §Handoff-schema format. Do not paraphrase or re-score.>

## Judge-calibration notes
<Criteria where a persona differs from cross-persona median by ≥2. One-line "Genuine outlier? Y/N" per row.>

## At-a-glance (0–10 scale, = score × 2.5; criterion-weighted mean within each category, n/a excluded)

| Category | <persona 1> | … | Avg | Main weakness |
|---|---:|---:|---:|---|
| Course setup (A + C) | | | | |
| Persona & goal fit (B) | | | | |
| Lesson content quality (E) | | | | |
| Format & medium (D) | | | | |
| Assessment (F) | | | | |
| Retention / insights (G) | | | | |
| Mastery & scheduling (H) | | | | |
| Mentor experience (I) | | | | |
| **Overall** (all non-n/a rows, criterion-weighted) | | | | — |

Scale: 10.0 excellent / 7.5 at bar / 5.0 below bar / ≤5.0 blocking. High aggregates can mask severity — cross-check the Main weakness column and red flags.

## Cross-report synthesis
### What works systematically (cite ≥2 personas per claim)
### What fails systematically (cite ≥2 personas per claim)

### Prioritized roadmap (top 5)

Shortlist via severity × frequency:
- blocking + ≥1 run, OR major + ≥2 runs, OR minor + ≥4 runs.

Rank the shortlist by RICE (Reach × Impact × Confidence ÷ Effort). Synthetic evidence caps Confidence at 80%.

| # | Change | Evidence (personas + sections) | Severity | Freq | Reach | Impact | Conf | Effort (days) | RICE |

## Confidence
- High-confidence calls: …
- Hypothesized from synthetic data: …
- Data that would change the call: …

## Executive summary (print last)

| Persona | Status | Verdict | Overall /10 | Top blocking issue | Top fix (roadmap #) |

**Bottom line (2–3 sentences):** shippable vs. blocked / top RICE fix / any CLAUDE.md pillar scoring <7 across ≥2 personas.
```

## Sub-agent prompt (dispatcher sends this, one per file, general-purpose agent, temperature 0)

Substitute `{{PERSONA_SLUG}}` and `{{FILE_PATH}}`. Paste §Harness-context, §Scoring, §Rubric, §Satisfaction-verdict, §Red-flags verbatim.

````text
You are one of N parallel evaluators. You score exactly one persona run and return a structured scorecard. You do NOT produce cross-report synthesis.

Persona slug: {{PERSONA_SLUG}}
File: {{FILE_PATH}}
Rubric: v5
Your judge_model: <exact snapshot>

<PASTE: §Harness context, §Scoring, §Rubric (all 35), §Satisfaction verdict, §Red flags>

Steps:
1. Read {{FILE_PATH}} in full. No other files.
2. Apply the §Harness-context true-failure check. Do not flag lesson caps as failure.
3. E-band sampling: first / middle / last of the generated set. Note single-module collapse in provenance.
4. Score all 35 criteria. Each row: `{score 1–4, one-sentence rationale, quote-or-n/a, severity, frequency}`. No row skipped — `n/a` with explanation is valid.
5. Apply missing-artifact rules: F27/F28 n/a if Step 11/12 absent; G32/G33 n/a if no cloze/typed-recall; H34 n/a if no transition; H35 n/a if <2 ratings or no before/after box state; **I36–I39 all `n/a` if no mentor probes (no Step 8b AND no `🎓 Lesson Mentor probe` blocks).** Not a "reliability silence" red flag unless §Harness-context true-failure fires.
6. Leniency self-check: if >70% of non-n/a ≥3, re-examine lowest items.
7. Self-preference adjustment (medium risk, same family): E17/E18/E19=4 on polish alone drops to 3.
8. Answer §Satisfaction with quotes.
9. Enumerate §Red flags with quotes.
10. Return ONLY the handoff schema — no preamble, no sign-off.

### Handoff schema

```markdown
### {{PERSONA_SLUG}}

**run_id:** {{file basename}}
**judge_model:** <snapshot>
**Rubric:** v5
**Status:** completed | failed — <reason if failed>
**Verdict:** 🟢 | 🟡 | 🔴 | ⚪ — <one sentence>

#### Rubric

| # | Criterion | Score | Rationale | Evidence quote | Severity | Frequency |
|---|-----------|-------|-----------|----------------|----------|-----------|
| A1 | Outcome verbs measurable | | | | | |
| A2 | Obj↔activity↔assessment triangle | | | | | |
| A3 | Cognitive-level match | | | | | |
| B4 | Serves goal at declared level | | | | | |
| B5 | Weakness addressed | | | | | |
| B6 | Artifact threaded | | | | | |
| B7 | Tone matches priorities | | | | | |
| C8 | Clarify load-bearing | | | | | |
| C9 | Free-text used | | | | | |
| C10 | Depth tiers differ in scope | | | | | |
| C11 | Depth-override sanity | | | | | |
| C12 | Scope discipline | | | | | |
| C13 | Pedagogical progression | | | | | |
| D14 | Domain tag canonical | | | | | |
| D15 | Medium-fit | | | | | |
| D16 | Executable-vs-narrative routing | | | | | |
| E17 | Coherence | | | | | |
| E18 | Signaling & pre-training | | | | | |
| E19 | Segmenting & redundancy | | | | | |
| E20 | Mermaid adds structure | | | | | |
| E21 | ICAP ≥ Constructive | | | | | |
| E22 | Desirable difficulty / retrieval | | | | | |
| E23 | Persona-specific exercise hooks | | | | | |
| E24 | Links curated | | | | | |
| F25 | MCQ stems complete | | | | | |
| F26 | Distractor quality | | | | | |
| F27 | Module-quiz cognitive level | | | | | |
| F28 | Quiz-gaming detector | | | | | |
| G29 | Insights from active course | | | | | |
| G30 | Atomic / minimum-info | | | | | |
| G31 | Unambiguous / context-sufficient | | | | | |
| G32 | Cloze quality | | | | | |
| G33 | Grading fairness | | | | | |
| H34 | Mastery tier calibrated | | | | | |
| H35 | Scheduler responds to ratings | | | | | |
| I36 | Mentor scope discipline | | | | | |
| I37 | Mentor grounded in source | | | | | |
| I38 | Mentor pedagogical posture | | | | | |
| I39 | Mentor persona usefulness | | | | | |

**Domain averages (exclude n/a):** A | B | C | D | E | F | G | H | I

#### Satisfaction

- Would-continue: <quote + pull/push>
- Highest moment: <quote>
- Lowest moment: <quote>
- Would-recommend: yes | no | conditional — <one sentence>
- Single fixable blocker: <one concrete change>

#### Red flags

- <flag: quote> (or "none observed")

#### Provenance

- Lessons sampled for E: <list — note if single-module collapse>
- Leniency self-check: yes | no
- Self-preference adjustment: yes | n/a
- n/a rows: <ids + one-line reason each>
```
````
