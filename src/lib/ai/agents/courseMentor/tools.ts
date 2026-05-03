/**
 * Tool registry for the course-scoped mentor.
 *
 * v1 reuses the three tools that already work in the lesson mentor —
 * web_search, get_user_progress, search_lesson_content. Importing
 * directly from the sibling agent (rather than refactoring into a
 * shared module) keeps this PR small. v2 introduces `emit_handoff`
 * which DOES live in a shared module since it's used by both agents.
 *
 * What is intentionally NOT here:
 *   - `fetch_url` — discussing pasted URLs is rare at course scope. If
 *     the learner wants to discuss a paper or article, the lesson
 *     mentor (which already has fetch_url + attachments) is the right
 *     surface.
 *   - File attachments — same reasoning.
 */

import {
  webSearch,
  getUserProgress,
  searchLessonContentTool,
} from '../lessonMentor/tools';
import { emitHandoffTool } from '../shared/emitHandoffTool';

export const TOOLS = [webSearch, getUserProgress, searchLessonContentTool, emitHandoffTool];
