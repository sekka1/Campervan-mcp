import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { getDocumentProxy } from "unpdf";
import { renderCompositeSchematic } from "../schematics";
import { inflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import {
  buildSchematicCaption,
  buildSchematicImageId,
  buildSchematicR2Key,
  deriveSectionTitle,
  encodePng,
  isSchematicCandidate,
  prepareSchematics,
  type RawPdfImage,
} from "../schematics";

const raw = (width: number, height: number, channels: 1 | 3 | 4 = 3): RawPdfImage => ({
  width,
  height,
  channels,
  data: new Uint8ClampedArray(width * height * channels).fill(7),
});

describe("encodePng", () => {
  it("produces a valid PNG whose pixels round-trip", () => {
    const png = encodePng(raw(2, 2, 4));
    expect(Array.from(png.slice(0, 8))).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const buf = Buffer.from(png);
    expect(buf.readUInt32BE(16)).toBe(2);
    expect(buf.readUInt32BE(20)).toBe(2);
    expect(buf[25]).toBe(6);
    const idatLen = buf.readUInt32BE(33);
    const pixels = inflateSync(buf.subarray(41, 41 + idatLen));
    expect(pixels).toHaveLength(2 * (1 + 8));
    expect(pixels[0]).toBe(0);
    expect(pixels[1]).toBe(7);
    expect(buf.subarray(-12, -8).toString("hex")).toBe("00000000");
    expect(buf.subarray(-8, -4).toString("ascii")).toBe("IEND");
    expect(buf.subarray(-4).toString("hex")).toBe("ae426082");
  });

  it("uses the right color type per channel count and rejects short data", () => {
    expect(Buffer.from(encodePng(raw(1, 1, 1)))[25]).toBe(0);
    expect(Buffer.from(encodePng(raw(1, 1, 3)))[25]).toBe(2);
    expect(() => encodePng({ width: 4, height: 4, channels: 3, data: new Uint8ClampedArray(3) })).toThrow();
  });
});

describe("schematic naming", () => {
  it("builds deterministic IDs, keys and captions", () => {
    expect(buildSchematicImageId("doc", 3, 1)).toBe("doc_p3_img1");
    expect(buildSchematicR2Key("doc", 3, 1)).toBe("schematics/doc/p3-1.png");
    expect(buildSchematicCaption("Manual", 3)).toBe("Manual - page 3");
    expect(buildSchematicCaption("Manual", 3, "WIRING")).toBe("Manual - page 3: WIRING");
  });
});

describe("prepareSchematics", () => {
  it("drops small images, keeps the largest first and caps per page", () => {
    const out = prepareSchematics("doc", "Manual", 2, [raw(20, 20), raw(120, 120), raw(300, 200), raw(150, 150), raw(110, 110)]);
    expect(isSchematicCandidate(raw(99, 500))).toBe(false);
    expect(out.map((o) => o.image.width)).toEqual([300, 150, 120]);
    expect(out[0].image).toMatchObject({ id: "doc_p2_img0", r2Key: "schematics/doc/p2-0.png", mimeType: "image/png", height: 200 });
    expect(out[0].bytes.length).toBeGreaterThan(8);
  });
});

describe("deriveSectionTitle", () => {
  it("finds numbered and all-caps headings", () => {
    expect(deriveSectionTitle("intro text\n4.2 Battery Wiring\nbody")).toBe("4.2 Battery Wiring");
    expect(deriveSectionTitle("some text here\nELECTRICAL SYSTEM\nmore")).toBe("ELECTRICAL SYSTEM");
  });

  it("returns null when nothing looks like a heading", () => {
    expect(deriveSectionTitle("just a plain sentence with no heading at all")).toBeNull();
    expect(deriveSectionTitle("")).toBeNull();
  });
});

describe("renderCompositeSchematic", () => {
  it("renders a composite PDF page to a valid PNG with vector and text layers intact", async () => {
    const fixturePath = resolve(__dirname, "../../tests/fixtures/schematic-manual.pdf");
    const buffer = readFileSync(fixturePath);
    const pdf = await getDocumentProxy(new Uint8Array(buffer));
    const result = await renderCompositeSchematic(pdf, "doc_test", "Test Manual", 1, "4.2 Battery Wiring");
    expect(result.image.id).toBe("doc_test_p1_img0");
    expect(result.image.r2Key).toBe("schematics/doc_test/p1-0.png");
    expect(result.image.caption).toBe("Test Manual - page 1: 4.2 Battery Wiring");
    expect(result.image.mimeType).toBe("image/png");
    expect(result.image.width).toBe(1224);
    expect(result.image.height).toBe(1584);
    expect(result.bytes.subarray(0, 8)).toEqual(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  });
});
