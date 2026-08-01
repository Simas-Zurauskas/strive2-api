import zlib from 'node:zlib';

/**
 * Programmatic fixture builders for documentExtraction tests. Everything
 * is generated at test time from these ~pure functions — no opaque binary
 * blobs checked in, every byte reviewable.
 */

// ── Zip writer (store-only) ────────────────────────────────

export interface ZipInput {
  name: string;
  data: Buffer | string;
  /** Compress with raw deflate (method 8) instead of store (method 0). */
  deflate?: boolean;
}

/**
 * Minimal zip writer (store + raw-deflate) — enough for docx/pptx/epub
 * fixtures. CRC32 via node:zlib (Node ≥22.2).
 */
export const buildZip = (files: ZipInput[]): Buffer => {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;

  for (const file of files) {
    const nameBuf = Buffer.from(file.name, 'utf-8');
    const data = Buffer.isBuffer(file.data) ? file.data : Buffer.from(file.data, 'utf-8');
    const crc = zlib.crc32(data);
    const method = file.deflate ? 8 : 0;
    const stored = file.deflate ? zlib.deflateRawSync(data) : data;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0, 6); // flags
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10); // mod time
    local.writeUInt16LE(0, 12); // mod date
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(stored.length, 18); // compressed
    local.writeUInt32LE(data.length, 22); // uncompressed
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28); // extra length

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(0, 8); // flags
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(0, 12); // time
    central.writeUInt16LE(0, 14); // date
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(stored.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30); // extra
    central.writeUInt16LE(0, 32); // comment
    central.writeUInt16LE(0, 34); // disk
    central.writeUInt16LE(0, 36); // internal attrs
    central.writeUInt32LE(0, 38); // external attrs
    central.writeUInt32LE(offset, 42); // local header offset

    localParts.push(local, nameBuf, stored);
    centralParts.push(central, nameBuf);
    offset += 30 + nameBuf.length + stored.length;
  }

  const centralOffset = offset;
  const centralBuf = Buffer.concat(centralParts);

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4); // disk
  eocd.writeUInt16LE(0, 6); // central dir disk
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(centralOffset, 16);
  eocd.writeUInt16LE(0, 20); // comment length

  return Buffer.concat([...localParts, centralBuf, eocd]);
};

/**
 * A structurally valid zip whose CENTRAL DIRECTORY declares a huge
 * uncompressed size (the classic bomb shape: tiny file, giant claim).
 */
export const buildZipBomb = ({ declaredBytesPerEntry = 1024 * 1024 * 1024, entries = 1 } = {}): Buffer => {
  const zip = buildZip(
    Array.from({ length: entries }, (_, i) => ({ name: `f${i}.bin`, data: 'x' })),
  );
  // Patch every central-directory uncompressedSize (offset +24 from sig).
  let idx = 0;
  while ((idx = zip.indexOf('PK\x01\x02', idx)) !== -1) {
    zip.writeUInt32LE(declaredBytesPerEntry >>> 0, idx + 24);
    idx += 4;
  }
  return zip;
};

/** A zip declaring more entries than the cap (5001 one-byte stored files). */
export const buildManyEntriesZip = (count: number): Buffer =>
  buildZip(Array.from({ length: count }, (_, i) => ({ name: `e${i}`, data: '' })));

// ── PDF builder ────────────────────────────────────────────

const escapePdfText = (text: string): string =>
  text.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');

/**
 * Minimal valid PDF, one page per input string (empty string = blank
 * page → "scanned" to the detector). Uncompressed content streams,
 * correct xref offsets — pdf.js parses it happily.
 */
export const buildPdf = (pages: string[]): Buffer => {
  const objects: string[] = [];
  const pageCount = pages.length;
  // Object layout: 1 Catalog, 2 Pages, 3 Font, then per page: Page + Contents.
  const pageObjNums = pages.map((_, i) => 4 + i * 2);
  const kids = pageObjNums.map((n) => `${n} 0 R`).join(' ');

  objects.push(`1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n`);
  objects.push(`2 0 obj\n<< /Type /Pages /Kids [${kids}] /Count ${pageCount} >>\nendobj\n`);
  objects.push(`3 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n`);

  pages.forEach((text, i) => {
    const pageNum = 4 + i * 2;
    const contentNum = pageNum + 1;
    objects.push(
      `${pageNum} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${contentNum} 0 R >>\nendobj\n`,
    );
    // Break the text into 60-char Tj lines so long fixtures stay valid.
    const lines = text.length
      ? (text.match(/.{1,60}/gs) ?? []).map(
          (chunk, li) => `BT /F1 12 Tf 50 ${720 - li * 14} Td (${escapePdfText(chunk)}) Tj ET`,
        )
      : [];
    const stream = lines.join('\n');
    objects.push(
      `${contentNum} 0 obj\n<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream\nendobj\n`,
    );
  });

  let body = '%PDF-1.4\n';
  const offsets: number[] = [];
  for (const obj of objects) {
    offsets.push(Buffer.byteLength(body));
    body += obj;
  }
  const xrefOffset = Buffer.byteLength(body);
  const xrefEntries = offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('');
  body +=
    `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${xrefEntries}` +
    `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(body, 'latin1');
};

/**
 * PDF with a standard-security-handler /Encrypt dictionary whose O/U
 * strings do not verify against the empty password — pdf.js raises
 * PasswordException (NEED_PASSWORD) on open.
 */
export const buildEncryptedPdf = (): Buffer => {
  const base = buildPdf(['locked']).toString('latin1');
  const junk32 = '<' + '00112233445566778899aabbccddeeff'.repeat(2) + '>';
  const encryptObj = `9000 0 obj\n<< /Filter /Standard /V 1 /R 2 /O ${junk32} /U ${junk32} /P -44 >>\nendobj\n`;
  const startxrefIdx = base.lastIndexOf('startxref');
  const trailerIdx = base.lastIndexOf('trailer');
  const oldXrefOffset = Number(base.slice(startxrefIdx).match(/startxref\n(\d+)/)?.[1] ?? 0);

  // Insert the object before the xref, rebuild trailer with /Encrypt + /ID.
  const beforeXref = base.slice(0, oldXrefOffset);
  const xrefSection = base.slice(oldXrefOffset, trailerIdx);
  const encryptOffset = Buffer.byteLength(beforeXref, 'latin1');
  const newXrefOffset = encryptOffset + Buffer.byteLength(encryptObj, 'latin1');
  const trailerMatch = base.slice(trailerIdx).match(/trailer\n<<(.*?)>>/s);
  const trailerInner = trailerMatch?.[1] ?? ' /Size 10 /Root 1 0 R ';
  const id = '<0123456789abcdef0123456789abcdef>';
  const rebuilt =
    beforeXref +
    encryptObj +
    xrefSection.replace(/^xref\n0 (\d+)\n/, (_m, count) => `xref\n0 ${count}\n`) +
    // Append the encrypt object as its own xref subsection.
    `9000 1\n${String(encryptOffset).padStart(10, '0')} 00000 n \n` +
    `trailer\n<<${trailerInner} /Encrypt 9000 0 R /ID [${id} ${id}] >>\nstartxref\n${newXrefOffset}\n%%EOF\n`;
  return Buffer.from(rebuilt, 'latin1');
};

// ── DOCX / PPTX ────────────────────────────────────────────

export const buildDocx = ({
  withTable = false,
  withImage = false,
}: { withTable?: boolean; withImage?: boolean } = {}): Buffer => {
  const tableXml = withTable
    ? `<w:tbl>
        <w:tr><w:tc><w:p><w:r><w:t>Metric</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Value</w:t></w:r></w:p></w:tc></w:tr>
        <w:tr><w:tc><w:p><w:r><w:t>Speed</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>42</w:t></w:r></w:p></w:tc></w:tr>
      </w:tbl>`
    : '';
  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Fixture Heading</w:t></w:r></w:p>
    <w:p><w:r><w:t>This is the first paragraph of the docx fixture with enough words to be meaningful.</w:t></w:r></w:p>
    ${tableXml}
    <w:p><w:r><w:t>Closing paragraph after the table.</w:t></w:r></w:p>
  </w:body>
</w:document>`;
  return buildZip([
    {
      name: '[Content_Types].xml',
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`,
    },
    {
      name: '_rels/.rels',
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`,
    },
    { name: 'word/document.xml', data: documentXml },
    // Embedded-media fixture (Phase 3 moderation): a tiny PNG in the
    // standard OOXML media directory so `enumerateEmbeddedImages` has a
    // reviewable, byte-generated target.
    ...(withImage ? [{ name: 'word/media/image1.png', data: tinyPng() }] : []),
  ]);
};

export const buildPptx = (
  slides: string[],
  { withImage = false }: { withImage?: boolean } = {},
): Buffer => {
  const slideXml = (text: string) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <p:cSld><p:spTree>
    <p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
    <p:grpSpPr/>
    <p:sp>
      <p:nvSpPr><p:cNvPr id="2" name="Content"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>
      <p:spPr/>
      <p:txBody><a:bodyPr/><a:p><a:r><a:t>${text}</a:t></a:r></a:p></p:txBody>
    </p:sp>
  </p:spTree></p:cSld>
</p:sld>`;
  const slideEntries = slides.map((text, i) => ({
    name: `ppt/slides/slide${i + 1}.xml`,
    data: slideXml(text),
  }));
  const slideOverrides = slides
    .map(
      (_, i) =>
        `<Override PartName="/ppt/slides/slide${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`,
    )
    .join('\n');
  const slideRels = slides
    .map(
      (_, i) =>
        `<Relationship Id="rSlide${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${i + 1}.xml"/>`,
    )
    .join('\n');
  const slideIds = slides
    .map((_, i) => `<p:sldId id="${256 + i}" r:id="rSlide${i + 1}"/>`)
    .join('\n');
  return buildZip([
    {
      name: '[Content_Types].xml',
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>
  ${slideOverrides}
</Types>`,
    },
    {
      name: '_rels/.rels',
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/>
</Relationships>`,
    },
    {
      name: 'ppt/presentation.xml',
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <p:sldIdLst>${slideIds}</p:sldIdLst>
</p:presentation>`,
    },
    {
      name: 'ppt/_rels/presentation.xml.rels',
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
${slideRels}
</Relationships>`,
    },
    ...slideEntries,
    // Embedded-media fixture (Phase 3 moderation) — PPTX media directory.
    ...(withImage ? [{ name: 'ppt/media/image1.png', data: tinyPng() }] : []),
  ]);
};

// ── EPUB ───────────────────────────────────────────────────

export const buildEpub = (
  chapters: Array<{ title: string; body: string }>,
  { withImage = false }: { withImage?: boolean } = {},
): Buffer => {
  const manifest = chapters
    .map((_, i) => `<item id="ch${i + 1}" href="ch${i + 1}.xhtml" media-type="application/xhtml+xml"/>`)
    .join('\n');
  const spine = chapters.map((_, i) => `<itemref idref="ch${i + 1}"/>`).join('\n');
  const chapterEntries = chapters.map((ch, i) => ({
    name: `OEBPS/ch${i + 1}.xhtml`,
    data: `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><head><title>${ch.title}</title></head>
<body><h1>${ch.title}</h1><p>${ch.body}</p></body></html>`,
  }));
  return buildZip([
    { name: 'mimetype', data: 'application/epub+zip' },
    {
      name: 'META-INF/container.xml',
      data: `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`,
    },
    {
      name: 'OEBPS/content.opf',
      data: `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Fixture Book</dc:title><dc:identifier id="uid">fixture</dc:identifier></metadata>
  <manifest>${manifest}</manifest>
  <spine>${spine}</spine>
</package>`,
    },
    ...chapterEntries,
    // Embedded-media fixture (Phase 3 moderation) — EPUB image entry.
    ...(withImage ? [{ name: 'OEBPS/images/cover.png', data: tinyPng() }] : []),
  ]);
};

// ── WAV ────────────────────────────────────────────────────

/**
 * Canonical 44-byte-header PCM WAV of silence. Low sample rate keeps
 * multi-minute fixtures small (1 kHz, 16-bit mono → 2 KB/s).
 */
export const buildWav = ({
  seconds,
  sampleRate = 1000,
  channels = 1,
  bitsPerSample = 16,
}: {
  seconds: number;
  sampleRate?: number;
  channels?: number;
  bitsPerSample?: number;
}): Buffer => {
  const byteRate = (sampleRate * channels * bitsPerSample) / 8;
  const dataLength = Math.round(byteRate * seconds);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + dataLength, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16); // fmt chunk size
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE((channels * bitsPerSample) / 8, 32); // block align
  header.writeUInt16LE(bitsPerSample, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(dataLength, 40);
  return Buffer.concat([header, Buffer.alloc(dataLength)]);
};

// ── PNG ────────────────────────────────────────────────────

/** 1×1 transparent PNG. */
export const tinyPng = (): Buffer =>
  Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
    'base64',
  );

// ── HTML ───────────────────────────────────────────────────

/** Long-enough article body so Readability keeps it. */
export const htmlArticle = ({ withHostileBits = false }: { withHostileBits?: boolean } = {}): string => {
  const hostile = withHostileBits
    ? `<script>globalThis.__extraction_pwned = true;</script>
       <img src="http://169.254.169.254/latest/meta-data/" alt="ssrf probe">`
    : '';
  const paragraph =
    'Spaced repetition is a learning technique that schedules reviews at increasing intervals. ' +
    'Each successful recall pushes the next review further out, exploiting the spacing effect. ';
  return `<!doctype html><html><head><title>Fixture Article</title></head><body>
  ${hostile}
  <article>
    <h1>Understanding Spaced Repetition</h1>
    <p>${paragraph.repeat(6)}</p>
    <h2>The Leitner System</h2>
    <p>${paragraph.repeat(6)}</p>
    <table><tr><th>Box</th><th>Interval</th></tr><tr><td>1</td><td>1 day</td></tr><tr><td>2</td><td>3 days</td></tr></table>
    <p>${paragraph.repeat(4)}</p>
  </article>
</body></html>`;
};
