# Debug Orchestrator — Course Creation Flow Testing

Generates AI personas with different learning needs, runs each through the full course creation wizard in parallel, and records every input/output to markdown reports.

## Prerequisites

- API dev server running (`yarn dev` in `api/`)
- Valid user account in MongoDB
- `OPENAI_API_KEY` set in `api/.env` (used for persona AI decisions)

## Usage

```bash
cd api

# Basic run — 1 persona, no chat
yarn debug:orchestrator --email user@example.com --password yourpass --concurrency 1 --personas 1

# Include the structure review chat step
yarn debug:orchestrator --email user@example.com --password yourpass --concurrency 3 --personas 5 --chat

# Custom API URL
yarn debug:orchestrator --email user@example.com --password yourpass --concurrency 2 --personas 3 --api-url http://localhost:4000
```

## Options

| Flag            | Type     | Description                                         |
| --------------- | -------- | --------------------------------------------------- |
| `--email`       | required | User email for authentication                       |
| `--password`    | required | User password                                       |
| `--concurrency` | required | Max personas running simultaneously                 |
| `--personas`    | required | Number of personas to generate                      |
| `--api-url`     | optional | API base URL (default: `http://localhost:4000`)     |
| `--chat`        | optional | Include structure review chat step (off by default) |

## What It Does

For each AI-generated persona, the orchestrator runs through the complete course creation flow:

1. **Create Course** — submits the persona's learning goal
2. **Clarify Questions** — triggers AI question generation, polls until complete
3. **Answer Questions** — AI answers as the persona would (GPT-4o)
4. **Depth Previews** — triggers depth preview generation, polls until complete
5. **Select Depth** — AI picks a depth level as the persona (overview/comprehensive/deep_dive)
6. **Generate Structure** — triggers course structure generation, polls until complete
7. **Review Structure** — AI reviews and optionally sends one refinement via chat (SSE)
8. **Accept Course** — sets course status to `ready`

All personas use the same user account — each creates a separate course.

## Output

Reports are written to `api/src/scripts/debugOrchestrator/output/` (gitignored).

Each persona gets a markdown file like:

```
output/2026-04-04T14-30-00_alex-career-switching-data-scientist.md
```

Reports include:

- Persona profile (name, background, goal, personality, priorities)
- Run summary (duration, status, course stats)
- Each step with timing, API responses, AI reasoning
- Questions generated and how the persona answered
- Depth previews and selection reasoning
- Full course structure (modules, lessons, reasoning)
- Chat feedback and AI response (if applicable)

## Concurrency Notes

- Each persona creates a **separate course** — no `activeJobId` conflicts
- Server-side limit: 10 concurrent jobs globally (`jobRunner.ts`)
- Default script concurrency of 3 stays well within this limit
- All 5 personas at concurrency 5 is safe (5 < 10)

## Files

```
debugOrchestrator/
  index.ts              — Entry point, CLI args, auth
  orchestrator.ts       — p-limit concurrency wrapper
  personaGenerator.ts   — GPT-4o persona generation
  courseFlow.ts         — 8-step pipeline + AI-as-persona functions
  apiClient.ts          — HTTP client (fetch, job polling, SSE)
  markdownRecorder.ts   — Per-persona markdown report builder
  types.ts              — Shared TypeScript interfaces
  output/               — Generated reports (gitignored)
```
