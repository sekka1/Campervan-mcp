/**
 * scripts/schematics.ts
 *
 * Pure helpers for Phase 3 (schematic images): PDF image filtering, PNG encoding,
 * deterministic IDs / R2 keys, captions, and section-title detection.
 */

import { deflateSync } from "node:zlib";

/** Images smaller than this (in either dimension) are icons/bullets/rules, not schematics. */
export const MIN_SCHEMATIC_DIMENSION = 100;

/** Maximum schematic images kept per page (largest first). */
export const MAX_IMAGES_PER_PAGE = 3;

/** Maximum length of a derived section title. */
export const MAX_SECTION_TITLE_LENGTH = 120;

export interface RawPdfImage {
  data: Uint8ClampedArray;
  width: number;
  height: number;
  channels: 1 | 3 | 4;
}

export interface SchematicImage {
  id: string;
  documentId: string;
  pageNumber: number;
  caption: string;
  r2Key: string;
  mimeType: string;
  width: number;
  height: number;
}

export interface EncodedSchematic {
  image: SchematicImage;
  bytes: Uint8Array;
}

/** True when the image is large enough to plausibly be a schematic/diagram. */
export function isSchematicCandidate(image: Pick<RawPdfImage, "width" | "height">): boolean {
  return image.width >= MIN_SCHEMATIC_DIMENSION && image.height >= MIN_SCHEMATIC_DIMENSION;
}

/** Deterministic schematic ID, so re-ingesting a document rewrites the same rows. */
export function buildSchematicImageId(documentId: string, pageNumber: number, imageIndex: number): string {
  return `${documentId}_p${pageNumber}_img${imageIndex}`;
}

/** R2 object key for a schematic PNG. */
export function buildSchematicR2Key(documentId: string, pageNumber: number, imageIndex: number): string {
  return `schematics/${documentId}/p${pageNumber}-${imageIndex}.png`;
}

export function buildSchematicCaption(title: string, pageNumber: number, sectionTitle?: string | null): string {
  return sectionTitle ? `${title} - page ${pageNumber}: ${sectionTitle}` : `${title} - page ${pageNumber}`;
}

let crcTable: Uint32Array | undefined;

function crc32(bytes: Uint8Array): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Uint8Array): Buffer {
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const out = Buffer.alloc(body.length + 8);
  out.writeUInt32BE(data.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE(crc32(body), body.length + 4);
  return out;
}

/** Encodes raw 8-bit grayscale / RGB / RGBA pixel data as a PNG (no native deps). */
export function encodePng(image: RawPdfImage): Uint8Array {
  const { width, height, channels, data } = image;
  if (data.length < width * height * channels) {
    throw new Error("Image data is shorter than width * height * channels");
  }
  const colorType = channels === 1 ? 0 : channels === 3 ? 2 : 6;
  const stride = width * channels;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    Buffer.from(data.buffer, data.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = colorType;
  return new Uint8Array(
    Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      pngChunk("IHDR", ihdr),
      pngChunk("IDAT", deflateSync(raw)),
      pngChunk("IEND", new Uint8Array(0)),
    ])
  );
}

/**
 * Filters a page's raw images down to schematic candidates (largest first, capped per page)
 * and encodes them as PNGs with deterministic IDs and R2 keys.
 */
export function prepareSchematics(
  documentId: string,
  title: string,
  pageNumber: number,
  rawImages: RawPdfImage[],
  sectionTitle?: string | null
): EncodedSchematic[] {
  return rawImages
    .filter(isSchematicCandidate)
    .sort((a, b) => b.width * b.height - a.width * a.height)
    .slice(0, MAX_IMAGES_PER_PAGE)
    .map((raw, index) => ({
      image: {
        id: buildSchematicImageId(documentId, pageNumber, index),
        documentId,
        pageNumber,
        caption: buildSchematicCaption(title, pageNumber, sectionTitle),
        r2Key: buildSchematicR2Key(documentId, pageNumber, index),
        mimeType: "image/png",
        width: raw.width,
        height: raw.height,
      },
      bytes: encodePng(raw),
    }));
}

const NUMBERED_HEADING_RE = /^(?:section\s+|chapter\s+)?\d+(?:\.\d+)*[.)]?\s+[A-Za-z]/i;

/**
 * Picks a section title from a page's text: the first short line that looks like a heading
 * (numbered, or ALL CAPS). Returns null when no line qualifies.
 */
export function deriveSectionTitle(pageText: string): string | null {
  for (const rawLine of pageText.split(/\r?\n/)) {
    const line = rawLine.replace(/\s+/g, " ").trim();
    if (line.length < 4 || line.length > MAX_SECTION_TITLE_LENGTH) continue;
    if (line.split(" ").length > 12) continue;
    const letters = line.replace(/[^A-Za-z]/g, "");
    const isAllCaps = letters.length >= 4 && letters === letters.toUpperCase();
    if (NUMBERED_HEADING_RE.test(line) || isAllCaps) return line;
  }
  return null;
}
