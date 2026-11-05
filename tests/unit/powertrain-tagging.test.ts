import { describe, it, expect } from "vitest";
import {
  classifyPowertrainText,
  stripPageBoilerplate,
} from "../../scripts/ingest-manuals";
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
