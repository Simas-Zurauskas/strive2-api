import Papa from 'papaparse';
import {
  ExtractionError,
  ExtractionInput,
  ExtractionOptions,
  ExtractionResult,
} from './types';

/**
 * CSV → papaparse → ONE atomic `table` block (markdown pipe table).
 * Row preview is capped: assessment/digest only need the table's shape
 * and a representative sample, and an unbounded million-row dump would
 * blow the corpus token cap for zero pedagogical value. Truncation is
 * surfaced both as a warning and inline in the block.
 */

export const CSV_PREVIEW_ROWS = 200;
const MAX_CELL_CHARS = 200;
const MAX_COLUMNS = 64;

const escapeCell = (value: string): string => {
  const cleaned = value.replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim();
  return cleaned.length > MAX_CELL_CHARS ? `${cleaned.slice(0, MAX_CELL_CHARS)}…` : cleaned;
};

export const extractCsv = async (
  input: ExtractionInput,
  _opts: ExtractionOptions,
): Promise<ExtractionResult> => {
  const text = input.buffer.toString('utf-8');
  const parsed = Papa.parse<string[]>(text, { skipEmptyLines: 'greedy' });
  const rows = parsed.data.filter((row) => Array.isArray(row) && row.some((cell) => String(cell).trim() !== ''));

  if (rows.length === 0) {
    throw new ExtractionError('csv_parse_failed', 'no parseable rows');
  }

  const warnings: string[] = [];
  const totalRows = rows.length;
  const columnCount = Math.min(Math.max(...rows.map((r) => r.length)), MAX_COLUMNS);
  if (Math.max(...rows.map((r) => r.length)) > MAX_COLUMNS) {
    warnings.push(`csv: table truncated to the first ${MAX_COLUMNS} columns`);
  }

  const preview = rows.slice(0, CSV_PREVIEW_ROWS + 1); // header + capped data rows
  const truncated = totalRows > preview.length;

  const normalizeRow = (row: string[]): string[] => {
    const cells = row.slice(0, columnCount).map((c) => escapeCell(String(c ?? '')));
    while (cells.length < columnCount) cells.push('');
    return cells;
  };

  const [header, ...dataRows] = preview.map(normalizeRow);
  const lines = [
    `| ${header.join(' | ')} |`,
    `| ${header.map(() => '---').join(' | ')} |`,
    ...dataRows.map((cells) => `| ${cells.join(' | ')} |`),
  ];
  if (truncated) {
    warnings.push(
      `csv: preview truncated to the first ${CSV_PREVIEW_ROWS} of ${totalRows - 1} data rows`,
    );
  }

  const markdown = lines.join('\n');
  return {
    markdown,
    blocks: [{ type: 'table', markdown, headingPath: [] }],
    warnings,
  };
};
