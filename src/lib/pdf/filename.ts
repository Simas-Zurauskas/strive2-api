/**
 * Download filenames.
 *
 * These are built from LLM-generated course and lesson names and end up in
 * a `Content-Disposition` response header — and, for the narration MP3, in
 * a signed S3 `ResponseContentDisposition`. A raw CR/LF or `"` there is a
 * header-injection vector, so nothing untrusted reaches the header
 * unfiltered.
 *
 * `generateSlug` (`lib/slugify.ts`) already does the hard part — lowercase,
 * NFD-decompose, strip diacritics, collapse to `[a-z0-9-]`, trim, cap at 80
 * — and reusing it keeps a downloaded file's name recognisably related to
 * the course's URL slug. Its one gap is that a title with no ASCII
 * alphanumerics at all slugs to the empty string, which would produce a
 * file called `.pdf`; that is what `fallback` is for.
 */

import { generateSlug } from '@lib/slugify';

/** Characters that may appear in the quoted filename. Nothing else can. */
const SAFE = /[^A-Za-z0-9._-]/g;

export const downloadFilename = ({
  parts,
  extension,
  fallback,
}: {
  /** Name fragments, most significant first. Empty ones are dropped. */
  parts: string[];
  /** Without the dot, e.g. `pdf`. */
  extension: string;
  /** Used when every part slugs away to nothing. */
  fallback: string;
}): string => {
  const slugged = parts.map((p) => generateSlug(p ?? '')).filter(Boolean);
  const base = (slugged.length > 0 ? slugged.join('-') : fallback)
    .replace(SAFE, '')
    .replace(/-{2,}/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 120);
  return `${base || fallback}.${extension}`;
};

/**
 * A `Content-Disposition` value carrying both the ASCII form and the
 * RFC 5987 `filename*` form. Both are derived from the already-sanitised
 * name, so the encoding is belt-and-braces rather than the only defence.
 */
export const contentDisposition = (filename: string): string =>
  `attachment; filename="${filename}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
