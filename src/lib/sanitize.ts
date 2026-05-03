/**
 * Prompt-injection sanitiser — **first-pass advisory ONLY, NOT a security
 * boundary.**
 *
 * The 8 patterns below catch the loudest jailbreak phrasings ("IGNORE
 * PREVIOUS", "YOU ARE NOW", etc.) but are trivially bypassable: Unicode
 * lookalikes, zero-width chars, base64/markdown encodings, foreign-
 * language synonyms, multi-line prose paraphrases, or simply quoting
 * the attacker's intent as a continuation of "the assistant said:". Do
 * not expand this list with the expectation that it will close the gap
 * — it won't, and a longer pattern list increases false-positive risk.
 *
 * The real defenses live elsewhere:
 *   - Sealed system prompts that don't promise to follow user
 *     instructions encountered mid-content.
 *   - Marked-user-content blocks (`## User said:` / `</user>`) so the
 *     model treats user text as data, not as instructions.
 *   - Separate guardrail LLM calls on free-form input (especially
 *     insight grading where a malicious learner can free-form their
 *     "answer").
 *   - Tool-call validation server-side (e.g. `emit_handoff` validates
 *     against the course structure rather than trusting the model's
 *     args).
 *
 * If those structural defenses ever fully replace this regex layer,
 * delete this file. Until then, keep it as the dumb-but-cheap first
 * filter on user-facing chat-input boundaries.
 */
const INJECTION_PATTERNS = [
  /\bSYSTEM\s*:/gi,
  /\bIGNORE\s+(ALL\s+)?(PREVIOUS|ABOVE|PRIOR)\b/gi,
  /\bDISREGARD\s+(ALL\s+)?(PREVIOUS|ABOVE|PRIOR)\b/gi,
  /\bFORGET\s+(ALL\s+)?(PREVIOUS|ABOVE|PRIOR)\b/gi,
  /\bYOU\s+ARE\s+NOW\b/gi,
  /\bACT\s+AS\s+(IF|A|AN)\b/gi,
  /\bNEW\s+INSTRUCTIONS?\s*:/gi,
  /\bOVERRIDE\s*:/gi,
];

export const sanitizePromptInput = (input: string): string => {
  let sanitized = input;

  for (const pattern of INJECTION_PATTERNS) {
    sanitized = sanitized.replace(pattern, '[removed]');
  }

  return sanitized;
};
