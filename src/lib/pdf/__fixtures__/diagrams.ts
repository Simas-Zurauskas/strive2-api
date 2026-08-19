/**
 * Diagram fixtures — every `PROD_*` entry is copied VERBATIM out of a
 * production `LessonContent.blocks[].content` row. Not paraphrased, not
 * shortened. An earlier draft of this file abbreviated them and the
 * abbreviation hid two label-corruption bugs, so: if you touch these,
 * re-read them off the database, don't edit them by hand.
 *
 * Census of `production.LessonContent` at 2026-08-19 (112 lessons, 112
 * mermaid blocks — exactly one per lesson):
 *   flowchart 102 | mindmap 7 | sequenceDiagram 3
 * `classDiagram`, `stateDiagram-v2` and `erDiagram` are permitted by the
 * generator (`lib/ai/agents/lessonGeneration/prompts.ts:18`) but unused so
 * far; they are covered by the SYNTHETIC_* entries.
 */

// ── flowchart (102 of 112 production diagrams) ──────────────

/** Decision node, edge labels, and a cycle back to an earlier node. */
export const PROD_FLOWCHART_TD = `flowchart TD
  A["Define Product + Platform Context"] --> B["Name the Knowledge Gap"]
  B --> C["State the Decision Being Informed"]
  C --> D["Specify Output Format + Constraints"]
  D --> E["Run Prompt in Claude"]
  E --> F{"Output Usable?"}
  F -->|"Yes — minor edits needed"| G["Refine Artifact Manually"]
  F -->|"No — too generic"| H["Add Missing Layer to Prompt"]
  H --> E
  G --> I["Use in Research Plan"]`;

/** Subgraph containers, `<br/>` line breaks, and a chained edge. */
export const PROD_FLOWCHART_LR_SUBGRAPH = `flowchart LR
  subgraph IaaS["IaaS — e.g. EC2"]
    A1["You manage: OS, Runtime,<br/>App, Data"]
    A2["AWS manages: Virtualization,<br/>Servers, Networking, Storage"]
  end
  subgraph PaaS["PaaS — e.g. Elastic Beanstalk"]
    B1["You manage: App, Data"]
    B2["AWS manages: OS, Runtime,<br/>Virtualization, Hardware"]
  end
  subgraph SaaS["SaaS — e.g. WorkMail"]
    C1["You manage: Data, Access"]
    C2["AWS manages: Everything else"]
  end
  IaaS --> PaaS --> SaaS`;

/** Unicode minus, `>` in a label, and a fan-in. */
export const PROD_FLOWCHART_SCORING = `flowchart TD
  A["150 Questions Available"] --> B["Attempt Decision per Question"]
  B --> C{"Confidence > 60%?"}
  C -->|"Yes — Attempt"| D["Correct: +3 marks"]
  C -->|"Yes — Attempt"| E["Wrong: −1 mark"]
  C -->|"No — Skip"| F["0 marks, no penalty"]
  D --> G["Net contribution: +3"]
  E --> H["Net contribution: −1"]
  F --> I["Net contribution: 0"]
  G --> J["Score accumulates toward 300"]
  H --> K["Score bleeds away from 300"]
  I --> J`;

export const PROD_FLOWCHARTS = [
  PROD_FLOWCHART_TD,
  PROD_FLOWCHART_LR_SUBGRAPH,
  PROD_FLOWCHART_SCORING,
] as const;

// ── sequenceDiagram (3 of 112) ─────────────────────────────

/** `participant … as` aliases, sync + async arrows, and a self-message. */
export const PROD_SEQUENCE = `sequenceDiagram
  participant C as Interrogator
  participant H as Human Respondent
  participant M as Machine
  C->>H: "Are you human?"
  H-->>C: "Yes, I am — I feel nervous right now!"
  C->>M: "Are you human?"
  M-->>C: "Yes, I am — I feel nervous right now!"
  C->>C: "Which one is the machine?"`;

// ── mindmap (7 of 112) — ALL of them, verbatim ─────────────

export const PROD_MINDMAP_DESIGN_PATTERN = `mindmap
  root("Design Pattern Anatomy")
    Name
      "Memorable label"
      "Domain-grounded"
    Problem
      "Recurring challenge"
      "Cross-dyad scope"
    Context
      "When/where it arises"
      "Transition type"
    Forces
      "Competing pressures"
      "Grounded in rationales"
    Solution
      "Principle of resolution"
      "Prescriptive not over-specified"
    Rationale
      "Evidence linkage"
      "Why it resolves forces"
    Consequences
      "Trade-offs"
      "Links to related patterns"`;

export const PROD_MINDMAP_STUDY_AGENT = `mindmap
  root("AI Study Agent")
    AI Brain
      ChatGPT
      Gemini
      Understands questions
      Generates answers
    Voice Layer
      Speech-to-Text
      Text-to-Speech
      ElevenLabs
      Hindi + English
    Avatar Face
      Ready Player Me
      HeyGen
      Lip-sync video
      Custom name
    Knowledge Base
      NCERT PDFs
      Grade-level folders
      Voiceflow KB
      Accurate answers`;

export const PROD_MINDMAP_CAREER_COACH = `mindmap
  root("Your Career Coach Brand")
    "Job Seekers"
      "CV & Interview Tactics"
      "Recruiter Insider Tips"
      "ATS & LinkedIn Hacks"
    "Career Changers"
      "Transferable Skills"
      "Pivot Roadmaps"
      "Imposter Syndrome"
    "Redundancy Survivors"
      "First 72 Hours Guide"
      "Financial Survival Tips"
      "Rebuilding Confidence"
    "Money & Wealth Layer"
      "Emergency Fund Basics"
      "Upskilling on a Budget"
      "Income Diversification"`;

/** Lithuanian — diacritics, en-dash, and `→` arrows inside labels. */
export const PROD_MINDMAP_SKAICIAI = `mindmap
  root("Skaičiai 11–20")
    "Dešimtukas = 10"
      "Visada kairėje"
      "Pilnas rėmelis"
    "Vienetai"
      "11 → +1"
      "12 → +2"
      "13 → +3"
      "14 → +4"
      "15 → +5"
      "16 → +6"
      "17 → +7"
      "18 → +8"
      "19 → +9"
    "20 = 10 + 10"
      "Du dešimtukai"`;

export const PROD_MINDMAP_DAILY_LIFE = `mindmap
  root("AI in Daily Life")
    Entertainment
      "Netflix recommendations"
      "Spotify Daily Mix"
      "YouTube autoplay"
    Communication
      "Gmail spam filter"
      "Autocomplete / predictive text"
      "Voice assistants"
    Navigation
      "Google Maps traffic"
      "Ride-share routing"
    Security
      "Face unlock"
      "Fraud detection"`;

/** Bare labels throughout, including one with commas the prompt says to quote. */
export const PROD_MINDMAP_NEWTONIAN = `mindmap
  root("Classical Newtonian Picture")
    Absolute Space
      Fixed universal grid
      Same for all observers
    Absolute Time
      Universal flowing river
      Simultaneity is objective
    Simple Velocity Addition
      Velocities add like numbers
      v_total equals v1 plus v2
    Works perfectly for
      Everyday speeds
      Trains, cars, thrown balls
      Centuries of confirmed predictions`;

export const PROD_MINDMAP_SESIMA = `mindmap
  root("Skaičiaus 8 šeima")
    "1 + 7"
    "2 + 6"
    "3 + 5"
    "4 + 4"
    "5 + 3"
    "6 + 2"
    "7 + 1"`;

/** All seven, with their true node counts read off the source. */
export const PROD_MINDMAPS: readonly { name: string; source: string; nodes: number }[] = [
  { name: 'Design Pattern Anatomy', source: PROD_MINDMAP_DESIGN_PATTERN, nodes: 22 },
  { name: 'AI Study Agent', source: PROD_MINDMAP_STUDY_AGENT, nodes: 21 },
  { name: 'Your Career Coach Brand', source: PROD_MINDMAP_CAREER_COACH, nodes: 17 },
  { name: 'Skaičiai 11–20', source: PROD_MINDMAP_SKAICIAI, nodes: 16 },
  { name: 'AI in Daily Life', source: PROD_MINDMAP_DAILY_LIFE, nodes: 15 },
  { name: 'Classical Newtonian Picture', source: PROD_MINDMAP_NEWTONIAN, nodes: 14 },
  { name: 'Skaičiaus 8 šeima', source: PROD_MINDMAP_SESIMA, nodes: 8 },
] as const;

// ── permitted by the generator, unused in production so far ──

export const SYNTHETIC_CLASS_DIAGRAM = `classDiagram
  class Animal {
    +String name
    +int age
    +makeSound()
  }
  class Dog {
    +fetch()
  }
  Animal <|-- Dog`;

export const SYNTHETIC_STATE_DIAGRAM = `stateDiagram-v2
  [*] --> Idle
  Idle --> Running: start
  Running --> Paused: pause
  Paused --> Running: resume
  Running --> [*]: finish`;

export const SYNTHETIC_ER_DIAGRAM = `erDiagram
  COURSE ||--o{ MODULE : contains
  MODULE ||--o{ LESSON : contains
  LESSON ||--o| NARRATION : has`;

// ── degenerate sources the renderer must refuse ────────────

/** Renders without throwing — the library never throws — but is meaningless. */
export const DEGENERATE_MALFORMED = `flowchart TD
  A[ --> ]]] {{{ broken`;

export const DEGENERATE_EMPTY_BODY = `flowchart TD`;

export const DEGENERATE_PROSE = `flowchart TD
  this is not really a diagram at all`;

/** The smallest thing that must still be accepted — the negative control. */
export const MINIMAL_VALID_FLOWCHART = `flowchart TD
  A["Start"] --> B["End"]`;
