import { writeFile, mkdir } from 'fs/promises';
import path from 'path';
import type { Persona, StepResult, CourseData, ClarifyQuestion, DepthPreviews, CourseStructure } from './types';

export class MarkdownRecorder {
  private sections: string[] = [];
  private persona: Persona | null = null;
  private courseId: string = '';
  private runStart: Date = new Date();

  setPersona(persona: Persona): void {
    this.persona = persona;
    this.runStart = new Date();
  }

  setCourseId(courseId: string): void {
    this.courseId = courseId;
  }

  addHeader(): void {
    const p = this.persona!;
    this.sections.push(`# Debug Orchestrator Report: ${p.name}
Generated: ${new Date().toISOString()}

## Persona Profile
- **Name:** ${p.name}
- **Background:** ${p.background}
- **Goal:** "${p.goal}"
- **Personality:** ${p.personality}
- **Priorities:** ${p.priorities}

### Predicted Wizard Behavior
- **Survey style:** ${p.wizardBehavior.surveyStyle}
- **Depth choice:** ${p.wizardBehavior.depthChoice}
- **Structure review:** ${p.wizardBehavior.structureReview}
`);
  }

  addStep1_CreateCourse(result: StepResult, courseId: string): void {
    this.sections.push(`---

## Step 1: Create Course (${fmtDuration(result.durationMs)})
**Course ID:** \`${courseId}\`
**Goal submitted:** "${this.persona!.goal}"
`);
  }

  addStep2_Clarify(result: StepResult, questions: ClarifyQuestion[], pollDuration: number): void {
    let questionsTable = '| # | Question | Type | Options |\n|---|----------|------|---------|';
    for (const q of questions) {
      const opts = q.options ? q.options.join(', ') : '_free text_';
      questionsTable += `\n| ${q.id} | ${q.question} | ${q.type} | ${opts} |`;
    }

    this.sections.push(`---

## Step 2: Clarify Questions (${fmtDuration(result.durationMs)})
**Job poll duration:** ${fmtDuration(pollDuration)}
**Questions generated:** ${questions.length}

${questionsTable}
`);
  }

  addStep3_Answers(result: StepResult, answers: Record<string, unknown>, questions: ClarifyQuestion[], aiReasoning: string): void {
    let answersTable = '| Question | Answer |\n|----------|--------|';
    for (const q of questions) {
      const answer = answers[q.id];
      const display = Array.isArray(answer) ? answer.join(', ') : String(answer);
      answersTable += `\n| ${q.question} | ${display} |`;
    }

    this.sections.push(`---

## Step 3: Answer Questions (${fmtDuration(result.durationMs)})
**AI Reasoning:** ${aiReasoning}

${answersTable}
`);
  }

  addStep4_DepthPreviews(result: StepResult, previews: DepthPreviews, pollDuration: number): void {
    const fmtPreview = (label: string, p: { summary: string; bullets: string[] }, isRec: boolean) => {
      const badge = isRec ? ' **(Recommended)**' : '';
      return `### ${label}${badge}
${p.summary}
${p.bullets.map((b) => `- ${b}`).join('\n')}`;
    };

    this.sections.push(`---

## Step 4: Depth Previews (${fmtDuration(result.durationMs)})
**Job poll duration:** ${fmtDuration(pollDuration)}
**Recommendation reason:** ${previews.recommendationReason}

${fmtPreview('Overview', previews.overview, previews.recommended === 'overview')}

${fmtPreview('Comprehensive', previews.comprehensive, previews.recommended === 'comprehensive')}

${fmtPreview('Deep Dive', previews.deep_dive, previews.recommended === 'deep_dive')}
`);
  }

  addStep5_DepthSelection(result: StepResult, selected: string, recommended: string, aiReasoning: string): void {
    this.sections.push(`---

## Step 5: Depth Selection (${fmtDuration(result.durationMs)})
**Selected:** ${selected}
**Recommended:** ${recommended}
**Match:** ${selected === recommended ? 'Yes' : 'No'}
**AI Reasoning:** ${aiReasoning}
`);
  }

  addStep6_Structure(result: StepResult, structure: CourseStructure, pollDuration: number): void {
    let modulesList = '';
    let totalLessons = 0;
    for (let i = 0; i < structure.modules.length; i++) {
      const mod = structure.modules[i];
      modulesList += `\n${i + 1}. **${mod.name}** — ${mod.description}`;
      for (const lesson of mod.lessons) {
        modulesList += `\n   - ${lesson.name}: ${lesson.description}`;
        totalLessons++;
      }
    }

    this.sections.push(`---

## Step 6: Generate Structure (${fmtDuration(result.durationMs)})
**Job poll duration:** ${fmtDuration(pollDuration)}
**Modules:** ${structure.modules.length}
**Total lessons:** ${totalLessons}

### Reasoning
- **Learner Profile:** ${structure.reasoning.learnerProfile}
- **Topic Analysis:** ${structure.reasoning.topicAnalysis}
- **Scope Decisions:** ${structure.reasoning.scopeDecisions}
- **Progression Strategy:** ${structure.reasoning.progressionStrategy}

### Modules & Lessons
${modulesList}
`);
  }

  addStep7_Review(result: StepResult, feedback: string | null, aiResponse: string | null, structureChanged: boolean): void {
    if (!feedback) {
      this.sections.push(`---

## Step 7: Structure Review (${fmtDuration(result.durationMs)})
**Chat used:** No — persona accepted the structure as-is.
`);
    } else {
      this.sections.push(`---

## Step 7: Structure Review (${fmtDuration(result.durationMs)})
**Chat used:** Yes
**Structure modified:** ${structureChanged ? 'Yes' : 'No'}

**Persona Feedback:**
> ${feedback}

**AI Response:**
> ${(aiResponse ?? '').replace(/\n/g, '\n> ')}
`);
    }
  }

  addStep8_Accept(result: StepResult): void {
    this.sections.push(`---

## Step 8: Accept Course (${fmtDuration(result.durationMs)})
**Final Status:** ready
`);
  }

  addSummary(totalDurationMs: number, course: CourseData, status: 'completed' | 'failed', error?: string): void {
    const totalLessons = course.structure?.modules.reduce((sum, m) => sum + m.lessons.length, 0) ?? 0;

    // Insert summary right after header
    const summary = `## Run Summary
| Metric | Value |
|--------|-------|
| Course ID | \`${this.courseId}\` |
| Total Duration | ${fmtDuration(totalDurationMs)} |
| Status | ${status} |
| Course Name | ${course.name} |
| Depth Selected | ${course.depth ?? 'N/A'} |
| Modules | ${course.structure?.modules.length ?? 'N/A'} |
| Total Lessons | ${totalLessons || 'N/A'} |
${error ? `| Error | ${error} |` : ''}
`;

    // Insert after the header (index 0)
    this.sections.splice(1, 0, summary);
  }

  async writeToFile(outputDir: string): Promise<string> {
    await mkdir(outputDir, { recursive: true });

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const slug = (this.persona?.name ?? 'unknown')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/(^-|-$)/g, '')
      .slice(0, 50);

    const filename = `${timestamp}_${slug}.md`;
    const filepath = path.join(outputDir, filename);

    await writeFile(filepath, this.sections.join('\n'), 'utf-8');
    return filepath;
  }
}

function fmtDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}
