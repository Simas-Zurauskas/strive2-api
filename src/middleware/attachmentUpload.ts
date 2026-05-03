import { type Request, type Response, type NextFunction } from 'express';
import multer, { type FileFilterCallback } from 'multer';
import path from 'node:path';

/**
 * Multer middleware for mentor-attachment uploads.
 *
 * Configuration is owned by this module so route files don't need to
 * know about multer details. Tuned conservatively:
 *
 *   - 10 MB raw cap. Mentor attachments are excerpts the learner pastes
 *     to discuss, not whole textbooks. The downstream extractor caps
 *     post-extraction at 50K tokens, so a 10 MB binary that distils to
 *     200K tokens still gets rejected — but the multer cap protects
 *     memory long before then.
 *   - Memory storage. Files never touch disk; the extractor wants a
 *     Buffer and we forget the file once we've persisted the extracted
 *     text on the chat doc.
 *   - Single file per request. Per-turn cap of 1 attachment is enforced
 *     here AND in the chat zod schema (defence in depth).
 *
 * MIME allowlist + extension fallback because most code editors upload
 * `.ts`/`.go`/`.rs` etc. with `application/octet-stream`. We don't want
 * to whitelist octet-stream wholesale — that opens the door to binaries
 * masquerading as text — so the extension list is the narrower gate
 * for those cases.
 */

const MAX_FILE_BYTES = 10 * 1024 * 1024;

const ALLOWED_MIME_TYPES = new Set<string>([
  'application/pdf',
  'application/json',
  'text/plain',
  'text/markdown',
  'text/x-markdown',
  'text/html',
  'text/css',
  'text/javascript',
  'application/javascript',
  'application/typescript',
  'application/xml',
  'text/xml',
]);

const ALLOWED_EXTENSIONS = new Set<string>([
  '.txt', '.md', '.markdown',
  '.json', '.yml', '.yaml', '.toml', '.xml', '.csv',
  '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx',
  '.py', '.go', '.rs', '.rb', '.php', '.swift', '.kt',
  '.java', '.scala', '.cs',
  '.c', '.h', '.cc', '.cpp', '.hpp',
  '.html', '.htm', '.css', '.scss',
  '.sh', '.bash', '.zsh', '.fish',
  '.sql',
  '.pdf',
]);

const fileFilter = (
  _req: Request,
  file: { mimetype: string; originalname: string },
  cb: FileFilterCallback,
): void => {
  const ext = path.extname(file.originalname).toLowerCase();
  if (ALLOWED_MIME_TYPES.has(file.mimetype) || ALLOWED_EXTENSIONS.has(ext)) {
    cb(null, true);
    return;
  }
  cb(new Error(`Unsupported file type: ${file.mimetype || ext || 'unknown'}`));
};

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_BYTES, files: 1 },
  fileFilter,
});

/** Single-file middleware (`file` form field). */
export const attachmentUpload = upload.single('file');

/**
 * Translate multer's thrown errors into clean JSON responses. Multer's
 * `LIMIT_FILE_SIZE` and our custom fileFilter rejections would otherwise
 * surface as generic 500s through the express error handler.
 *
 * Mounted as 4-arg error middleware AFTER the multer middleware on the
 * route. Express only invokes 4-arg middleware on `next(err)`, so on
 * the success path control flows straight from multer to the controller.
 */
export const handleAttachmentUploadErrors = (
  err: unknown,
  _req: Request,
  res: Response,
  next: NextFunction,
): void => {
  if (!err) {
    next();
    return;
  }
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      res.status(413).json({ message: `File too large. Max ${MAX_FILE_BYTES / 1024 / 1024} MB.` });
      return;
    }
    res.status(400).json({ message: err.message });
    return;
  }
  if (err instanceof Error) {
    res.status(400).json({ message: err.message });
    return;
  }
  next(err);
};
