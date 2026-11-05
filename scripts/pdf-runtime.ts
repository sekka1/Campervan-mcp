/**
 * scripts/pdf-runtime.ts
 *
 * One place that opens PDFs for the ingestion scripts.
 *
 * Why: the PDF.js build bundled inside `unpdf` is a serverless build with the JPEG 2000 (JPX) and
 * JBIG2 image decoders stubbed out. Any page whose diagrams are stored with those codecs fails to
 * decode ("OpenJPEG failed to initialize"), `extractImages` then returns nothing for that page and
 * the page silently gets no schematic. Whether a manual hits this depends on how its publisher
 * encoded the images, not on its content, so it hit one edition of a manual and not its siblings.
 * These scripts run in Node, so we point unpdf at the full `pdfjs-dist` build (a dev dependency
 * pinned to the version unpdf bundles) and give it the directory holding the wasm decoders.
 *
 * Only the Node-side scripts use this; the Worker never parses PDFs.
 */

import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { definePDFJSModule, getDocumentProxy } from "unpdf";

type PdfDocument = Awaited<ReturnType<typeof getDocumentProxy>>;

let initialised: Promise<string> | null = null;

/** Loads the full pdfjs-dist build once and resolves to the file URL of its wasm decoder directory. */
function initPdfRuntime(): Promise<string> {
  initialised ??= (async () => {
    const require = createRequire(import.meta.url);
    const root = dirname(require.resolve("pdfjs-dist/package.json"));
    await definePDFJSModule(() => import("pdfjs-dist/legacy/build/pdf.mjs") as never);
    return pathToFileURL(join(root, "wasm") + "/").href;
  })();
  return initialised;
}

/** Opens a PDF with the full PDF.js build so JPEG 2000 / JBIG2 images decode. */
export async function openPdf(bytes: Uint8Array, options: { verbosity?: number } = {}): Promise<PdfDocument> {
  const wasmUrl = await initPdfRuntime();
  return getDocumentProxy(bytes, { verbosity: options.verbosity ?? 0, wasmUrl });
}
