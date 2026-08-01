import { type Request, type Response, type NextFunction } from 'express';
import multer, { type FileFilterCallback } from 'multer';
import path from 'node:path';
import { AppError } from '@middleware/errorMiddleware';

/**
 * Multer middleware for course source-document uploads (course-from-
 * documents). A separate instance from the mentor `attachmentUpload` on
 * purpose — the two surfaces have different size caps, allowlists and
 * retention (documents persist raw to S3; mentor attachments are
 * extract-and-forget).
 *
 *   - 50 MB raw cap (A9), single `file` field per request. The nginx
 *     `client_max_body_size` on EB is raised to 55M in
 *     `.platform/nginx/conf.d/client_max_body_size.conf` to stay above
 *     this cap (EB's default is 1M).
 *   - Memory storage, matching the attachment precedent: the service
 *     wants a Buffer for sha256 + magic-byte sniffing before the bytes
 *     go to S3. Uploads are serialized per course inside
 *     `sourceDocumentService`, which bounds concurrent RAM held here.
 *   - This filter is the cheap first gate (client-claimed MIME +
 *     extension fallback for `application/octet-stream` uploads). The
 *     authoritative check is the magic-byte sniff / UTF-8 text branch in
 *     `sourceDocumentService.sniffDocumentType` — a lying MIME type gets
 *     through this gate and is rejected there.
 *
 * Errors are translated to typed `AppError`s and forwarded to the shared
 * error formatter (never `res.json` here) so `errorCode` stays inside the
 * registered, compile-checked set.
 */

export const DOCUMENT_MAX_FILE_BYTES = 50 * 1024 * 1024;

// §3.2 launch set: pdf, docx, pptx, xlsx, odt, odp, ods, epub, txt, md,
// html, csv, png, jpg/jpeg, webp, heic, mp3, m4a, wav.
export const ALLOWED_MIME_TYPES = new Set<string>([
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document', // docx
  'application/vnd.openxmlformats-officedocument.presentationml.presentation', // pptx
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', // xlsx
  'application/vnd.oasis.opendocument.text', // odt
  'application/vnd.oasis.opendocument.presentation', // odp
  'application/vnd.oasis.opendocument.spreadsheet', // ods
  'application/epub+zip',
  'text/plain',
  'text/markdown',
  'text/x-markdown',
  'text/csv',
  'application/csv',
  'text/html',
  'image/png',
  'image/jpeg',
  'image/webp',
  // HEIC files are tagged image/heic or image/heif depending on brand.
  'image/heic',
  'image/heif',
  'audio/mpeg',
  'audio/mp3',
  'audio/mp4', // m4a container
  'audio/x-m4a',
  'audio/m4a',
  'audio/wav',
  'audio/x-wav',
  'audio/wave',
  'audio/vnd.wave',
]);

// Fallback for browsers/editors that send `application/octet-stream`.
const ALLOWED_EXTENSIONS = new Set<string>([
  '.pdf', '.docx', '.pptx', '.xlsx', '.odt', '.odp', '.ods', '.epub',
  '.txt', '.md', '.html', '.htm', '.csv',
  '.png', '.jpg', '.jpeg', '.webp', '.heic', '.heif',
  '.mp3', '.m4a', '.wav',
]);

export const documentFileFilter = (
  _req: Request,
  file: { mimetype: string; originalname: string },
  cb: FileFilterCallback,
): void => {
  const ext = path.extname(file.originalname).toLowerCase();
  if (ALLOWED_MIME_TYPES.has(file.mimetype) || ALLOWED_EXTENSIONS.has(ext)) {
    cb(null, true);
    return;
  }
  cb(
    new AppError(`Unsupported file type: ${file.mimetype || ext || 'unknown'}`, {
      errorCode: 'UNSUPPORTED_FILE_TYPE',
      statusCode: 400,
      meta: { mimeType: file.mimetype || null, extension: ext || null },
    }),
  );
};

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: DOCUMENT_MAX_FILE_BYTES, files: 1 },
  fileFilter: documentFileFilter,
});

/** Single-file middleware (`file` form field). */
export const documentUpload = upload.single('file');

/**
 * Translate multer's thrown errors into typed AppErrors and delegate to
 * the shared error formatter. Mounted as 4-arg error middleware AFTER the
 * multer middleware on the route; Express only invokes it on `next(err)`,
 * so the success path flows straight to the controller.
 *
 * Unlike the older mentor `handleAttachmentUploadErrors` (which responds
 * with untyped `res.json`), every path here forwards an AppError with a
 * registered errorCode so clients can branch on code, not message text.
 */
export const handleDocumentUploadErrors = (
  err: unknown,
  _req: Request,
  _res: Response,
  next: NextFunction,
): void => {
  if (!err) {
    next();
    return;
  }
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      next(
        new AppError(
          `File too large. Max ${DOCUMENT_MAX_FILE_BYTES / 1024 / 1024} MB per file.`,
          {
            errorCode: 'DOCUMENT_LIMIT_EXCEEDED',
            statusCode: 413,
            meta: { limitBytes: DOCUMENT_MAX_FILE_BYTES },
          },
        ),
      );
      return;
    }
    next(
      new AppError(err.message, { errorCode: 'CUSTOM_ERROR', statusCode: 400 }),
    );
    return;
  }
  // AppError from the fileFilter (or anything else) — the shared error
  // middleware knows how to format it.
  next(err);
};
