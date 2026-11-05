import { describe, it, expect } from "vitest";
import {
  buildD1UpsertStatements,
  classifyChunkPowertrain,
  classifyPowertrainText,
  findBevOnlyPages,
  stripPageBoilerplate,
} from "../../scripts/ingest-manuals";
import { computePatchedChunkMetadata } from "../../scripts/patch-powertrain-metadata";
import { extractChunkFuelType } from "../../src/utils/db";
import { isBevOnlyFallback } from "../../src/tools/manuals";

const HEADER =
  "Abc = BEV Only Abc = ICE Only Date of Publication: 04/2024 FORD TRANSIT & E-TRANSIT1534 Electrical 153 ";

describe("page boilerplate stripping", () => {
  it("removes the BEV/ICE legend and model banner", () => {
    const out = stripPageBoilerplate(HEADER);
    expect(out).not.toMatch(/bev/i);
    expect(out).not.toMatch(/e-transit/i);
  });
});

describe("classifyPowertrainText", () => {
  it("does not tag an ICE-only table as BEV because of the page legend", () => {
    const text = `${HEADER}49 Engine Bay Side Inner Exhaust Gas Gauge Van/Wagon, CCB/CW ICE 9K499 53 Front Floor ICE 14401`;
    expect(classifyPowertrainText(text)).toBe("ice");
  });

  it("tags a BEV-only table as bev", () => {
    const text = `${HEADER}1 Front Floor Van/Wagon BEV 14401 9 Front End Cradle HV Megabrace Case BEV 14301`;
    expect(classifyPowertrainText(text)).toBe("bev");
  });

  it("tags mixed content as all", () => {
    const text = `${HEADER}ICE Van, Wagon and Common Ground Points E185976 rev1 BEV ground points`;
    expect(classifyPowertrainText(text)).toBe("all");
  });

  it("returns undefined for a neutral chunk with only boilerplate", () => {
    expect(classifyPowertrainText(`${HEADER}Tighten to 25 Nm.`)).toBeUndefined();
  });
});

describe("extractChunkFuelType (query time)", () => {
  it("ignores legend boilerplate in untagged chunks", () => {
    expect(
      extractChunkFuelType({ chunk_text: `${HEADER}49 Exhaust Gas Gauge ICE 9K499` })
    ).toBe("ice");
  });

  it("treats mixed text as neutral", () => {
    expect(
      extractChunkFuelType({ chunk_text: "ICE ground points and BEV ground points" })
    ).toBeUndefined();
  });

  it("treats metadata fuel 'all' as neutral even if text mentions BEV", () => {
    expect(
      extractChunkFuelType({
        metadata_json: JSON.stringify({ fuel: "all" }),
        chunk_text: "E-Transit BEV note",
      })
    ).toBeUndefined();
  });
});

describe("isBevOnlyFallback", () => {
  it("flags non-BEV queries whose results are all BEV", () => {
    expect(isBevOnlyFallback("ground points 2024 transit", [{ fuel_type: "bev" }])).toBe(true);
  });
  it("does not flag explicit BEV queries", () => {
    expect(isBevOnlyFallback("e-transit ground points", [{ fuel_type: "bev" }])).toBe(false);
  });
  it("does not flag mixed or empty results", () => {
    expect(isBevOnlyFallback("ground points", [{ fuel_type: "bev" }, {}])).toBe(false);
    expect(isBevOnlyFallback("ground points", [])).toBe(false);
  });
});

describe("shared chunk classification (ingest and patch script use one implementation)", () => {
  it("classifies from text, defaults by chassis, and lets a BEV-tagged document force BEV", () => {
    expect(classifyChunkPowertrain({ text: `${HEADER}Tighten to 25 Nm.`, applicableChassis: "van" })).toBe("ice");
    expect(classifyChunkPowertrain({ text: `${HEADER}Tighten to 25 Nm.`, applicableChassis: "universal" })).toBe("all");
    expect(classifyChunkPowertrain({ text: "HV battery traction cable routing" })).toBe("bev");
    expect(classifyChunkPowertrain({ text: "Tighten to 25 Nm.", applicableChassis: "van", docFuel: "bev" })).toBe("bev");
  });

  it("finds only BEV-only pages (mixed pages and legend-only pages do not count)", () => {
    const pages = findBevOnlyPages([
      { page: 1, text: `${HEADER}1 Front Floor BEV 14401` },
      { page: 2, text: `${HEADER}ICE Van ground points E185976 BEV ground points` },
      { page: 3, text: `${HEADER}Tighten to 25 Nm.` },
      { page: 4, text: "HV battery traction cable" },
      { page: 4, text: "1 Front Floor ICE 14401" },
    ]);
    expect(Array.from(pages)).toEqual([1]);
  });

  it("ingestion and the patch script always agree on the tag for the same chunk", () => {
    const samples = [
      `${HEADER}49 Engine Bay Side Inner Exhaust Gas Gauge ICE 9K499`,
      `${HEADER}1 Front Floor Van/Wagon BEV 14401 9 Front End Cradle HV Megabrace Case BEV 14301`,
      `${HEADER}ICE Van, Wagon and Common Ground Points E185976 rev1 BEV ground points`,
      `${HEADER}Tighten to 25 Nm.`,
    ];
    const doc = {
      id: "doc", title: "Doc", category: "chassis", manufacturer: "acme", applicableChassis: "van", rawR2Path: "x.pdf",
      metadata_json: JSON.stringify({ year_start: 2024 }),
    };
    const stmts = buildD1UpsertStatements(
      doc,
      samples.map((text, i) => ({ id: `doc#chunk_${i}`, pageNumber: i + 1, sectionTitle: null, text }))
    );
    const written = stmts
      .filter((s) => s.sql.includes("INSERT INTO document_chunks"))
      .map((s) => JSON.parse(String(s.params[s.params.length - 1])).powertrain);
    const patched = samples.map(
      (text) => computePatchedChunkMetadata({ chunk_text: text, applicable_chassis: "van" }).powertrain
    );
    expect(patched).toEqual(written);
    expect(written).toEqual(["ice", "bev", "all", "ice"]);
  });
});

