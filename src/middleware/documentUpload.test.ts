/**
 * Unit tests for the course-document upload middleware: the multer
 * fileFilter allowlist (MIME + extension fallback) and the 4-arg error
 * translator that turns multer failures into typed AppErrors routed
 * through the shared error formatter.
 *
 * Run: yarn test documentUpload
 */

import { describe, test, expect, vi } from 'vitest';
import multer from 'multer';
import type { Request, Response, NextFunction } from 'express';
import {
  documentFileFilter,
  handleDocumentUploadErrors,
  DOCUMENT_MAX_FILE_BYTES,
} from './documentUpload';
import { AppError } from './errorMiddleware';

const runFilter = (file: { mimetype: string; originalname: string }) => {
  let result: { error: unknown; accepted: boolean | undefined } = {
    error: undefined,
    accepted: undefined,
  };
  documentFileFilter(
    {} as Request,
    file as Parameters<typeof documentFileFilter>[1],
    ((error: unknown, accepted?: boolean) => {
      result = { error, accepted };
    }) as Parameters<typeof documentFileFilter>[2],
  );
  return result;
};

describe('documentFileFilter', () => {
  test.each([
    ['application/pdf', 'notes.pdf'],
    ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'notes.docx'],
    ['application/vnd.openxmlformats-officedocument.presentationml.presentation', 'deck.pptx'],
    ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'sheet.xlsx'],
    ['application/vnd.oasis.opendocument.text', 'doc.odt'],
    ['application/vnd.oasis.opendocument.presentation', 'deck.odp'],
    ['application/vnd.oasis.opendocument.spreadsheet', 'sheet.ods'],
    ['application/epub+zip', 'book.epub'],
    ['text/plain', 'notes.txt'],
    ['text/markdown', 'notes.md'],
    ['text/html', 'page.html'],
    ['text/csv', 'data.csv'],
    ['image/png', 'scan.png'],
    ['image/jpeg', 'photo.jpg'],
    ['image/webp', 'photo.webp'],
    ['image/heic', 'photo.heic'],
    ['audio/mpeg', 'lecture.mp3'],
    ['audio/x-m4a', 'lecture.m4a'],
    ['audio/wav', 'lecture.wav'],
  ])('accepts %s', (mimetype, originalname) => {
    const { error, accepted } = runFilter({ mimetype, originalname });
    expect(error).toBeNull();
    expect(accepted).toBe(true);
  });

  test.each([
    ['application/octet-stream', 'notes.pdf'],
    ['application/octet-stream', 'photo.heic'],
    ['application/octet-stream', 'lecture.m4a'],
    ['application/octet-stream', 'notes.md'],
  ])('extension fallback accepts %s %s', (mimetype, originalname) => {
    const { error, accepted } = runFilter({ mimetype, originalname });
    expect(error).toBeNull();
    expect(accepted).toBe(true);
  });

  test.each([
    ['application/x-msdownload', 'virus.exe'],
    ['application/zip', 'archive.zip'],
    ['video/mp4', 'movie.mp4'],
    ['image/svg+xml', 'vector.svg'],
    ['application/octet-stream', 'binary.bin'],
    ['application/msword', 'legacy.doc'],
  ])('rejects %s %s with a typed UNSUPPORTED_FILE_TYPE AppError', (mimetype, originalname) => {
    const { error } = runFilter({ mimetype, originalname });
    expect(error).toBeInstanceOf(AppError);
    const appErr = error as AppError;
    expect(appErr.errorCode).toBe('UNSUPPORTED_FILE_TYPE');
    expect(appErr.statusCode).toBe(400);
  });
});

describe('handleDocumentUploadErrors', () => {
  const invoke = (err: unknown) => {
    const next = vi.fn() as unknown as NextFunction;
    handleDocumentUploadErrors(err, {} as Request, {} as Response, next);
    return next as unknown as ReturnType<typeof vi.fn>;
  };

  test('no error → plain next()', () => {
    const next = invoke(undefined);
    expect(next).toHaveBeenCalledWith();
  });

  test('LIMIT_FILE_SIZE → 413 DOCUMENT_LIMIT_EXCEEDED', () => {
    const next = invoke(new multer.MulterError('LIMIT_FILE_SIZE', 'file'));
    const forwarded = next.mock.calls[0][0] as AppError;
    expect(forwarded).toBeInstanceOf(AppError);
    expect(forwarded.statusCode).toBe(413);
    expect(forwarded.errorCode).toBe('DOCUMENT_LIMIT_EXCEEDED');
    expect(forwarded.meta).toMatchObject({ limitBytes: DOCUMENT_MAX_FILE_BYTES });
  });

  test('other MulterError → 400 CUSTOM_ERROR', () => {
    const next = invoke(new multer.MulterError('LIMIT_UNEXPECTED_FILE', 'file'));
    const forwarded = next.mock.calls[0][0] as AppError;
    expect(forwarded).toBeInstanceOf(AppError);
    expect(forwarded.statusCode).toBe(400);
    expect(forwarded.errorCode).toBe('CUSTOM_ERROR');
  });

  test('AppError from the fileFilter passes through untouched', () => {
    const original = new AppError('Unsupported file type', {
      errorCode: 'UNSUPPORTED_FILE_TYPE',
      statusCode: 400,
    });
    const next = invoke(original);
    expect(next.mock.calls[0][0]).toBe(original);
  });

  test('unknown error passes through to the shared handler', () => {
    const original = new Error('boom');
    const next = invoke(original);
    expect(next.mock.calls[0][0]).toBe(original);
  });
});
