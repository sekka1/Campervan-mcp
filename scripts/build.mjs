import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.resolve(__dirname, "../dist");

if (!fs.existsSync(distDir)) {
  fs.mkdirSync(distDir, { recursive: true });
}

// Copy index.html or generate standalone bundle for workbench UI
const htmlContent = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Campervan MCP Server & Electrical Workbench</title>
  <script src="https://cdn.tailwindcss.com"></script>
</head>
<body class="bg-slate-950 text-slate-100 min-h-screen font-sans p-6">
  <div class="max-w-4xl mx-auto space-y-6">
    <header class="border-b border-slate-800 pb-4">
      <div class="flex items-center space-x-3">
        <span class="text-3xl">🚐</span>
        <div>
          <h1 class="text-2xl font-bold text-amber-400">Campervan MCP Server Workbench</h1>
          <p class="text-sm text-slate-400">ABYC E-11 Electrical Formulas & Verified Manual Retrieval</p>
        </div>
      </div>
    </header>

    <div class="grid grid-cols-1 md:grid-cols-2 gap-6">
      <section class="bg-slate-900 border border-slate-800 rounded-xl p-5 space-y-4">
        <h2 class="text-lg font-semibold text-emerald-400 flex items-center space-x-2">
          <span>⚡</span><span>DC Wire & Fuse Sizing</span>
        </h2>
        <p class="text-sm text-slate-400">Deterministic ABYC E-11 calculations and safety invariants.</p>
      </section>

      <section class="bg-slate-900 border border-slate-800 rounded-xl p-5 space-y-4">
        <h2 class="text-lg font-semibold text-sky-400 flex items-center space-x-2">
          <span>📖</span><span>Manuals & Grounding Retrieval</span>
        </h2>
        <p class="text-sm text-slate-400">RAG grounding contracts with ICE-first prioritization.</p>
      </section>
    </div>
  </div>
</body>
</html>`;

fs.writeFileSync(path.join(distDir, "index.html"), htmlContent, "utf8");
console.log("Built dist/index.html successfully.");
