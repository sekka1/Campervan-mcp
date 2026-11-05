import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("unpdf", () => ({
  getDocumentProxy: vi.fn(async () => ({})),
  definePDFJSModule: vi.fn(async () => undefined),
}));

import { definePDFJSModule, getDocumentProxy } from "unpdf";
import { openPdf } from "../pdf-runtime";

describe("openPdf", () => {
  it("swaps in the full PDF.js build once, so JPEG 2000 / JBIG2 images can decode", async () => {
    await openPdf(new Uint8Array([1]));
    await openPdf(new Uint8Array([2]));
    expect(definePDFJSModule).toHaveBeenCalledTimes(1);
  });

  it("passes the directory that actually contains the wasm image decoders", async () => {
    await openPdf(new Uint8Array([1]), { verbosity: 0 });
    const options = vi.mocked(getDocumentProxy).mock.calls.at(-1)![1] as { wasmUrl: string };
    const dir = fileURLToPath(options.wasmUrl);
    expect(existsSync(join(dir, "openjpeg.wasm"))).toBe(true);
    expect(existsSync(join(dir, "jbig2.wasm"))).toBe(true);
  });
});
