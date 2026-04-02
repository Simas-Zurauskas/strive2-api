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
