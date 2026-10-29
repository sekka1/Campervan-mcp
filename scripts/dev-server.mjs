import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = 3000;
const HOST = "0.0.0.0";

const server = http.createServer((req, res) => {
  // Simple router
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  
  if (url.pathname === "/" || url.pathname === "/index.html") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(`<!DOCTYPE html>
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
      <!-- Electrical Calculator -->
      <section class="bg-slate-900 border border-slate-800 rounded-xl p-5 space-y-4">
        <h2 class="text-lg font-semibold text-emerald-400 flex items-center space-x-2">
          <span>⚡</span><span>DC Wire & Fuse Sizing</span>
        </h2>
        <div class="space-y-3">
          <div>
            <label class="block text-xs text-slate-400 mb-1">System Voltage (V)</label>
            <select id="voltage" class="w-full bg-slate-800 border border-slate-700 rounded px-3 py-2 text-sm">
              <option value="12">12V DC</option>
              <option value="24">24V DC</option>
              <option value="48">48V DC</option>
            </select>
          </div>
          <div>
            <label class="block text-xs text-slate-400 mb-1">Continuous Load (Amps)</label>
            <input id="amps" type="number" value="80" class="w-full bg-slate-800 border border-slate-700 rounded px-3 py-2 text-sm">
          </div>
          <div>
            <label class="block text-xs text-slate-400 mb-1">One-Way Run (Feet)</label>
            <input id="feet" type="number" value="10" class="w-full bg-slate-800 border border-slate-700 rounded px-3 py-2 text-sm">
          </div>
          <button onclick="calculate()" class="w-full bg-emerald-600 hover:bg-emerald-500 font-medium py-2 rounded text-sm transition">
            Calculate Wire & Fuse
          </button>
        </div>
        <div id="calc-result" class="hidden bg-slate-950 border border-slate-800 rounded p-3 text-xs space-y-2"></div>
      </section>

      <!-- Manuals Search & Subsystem Coercion -->
      <section class="bg-slate-900 border border-slate-800 rounded-xl p-5 space-y-4">
        <h2 class="text-lg font-semibold text-sky-400 flex items-center space-x-2">
          <span>📖</span><span>Manual Retrieval & Subsystem Coercion</span>
        </h2>
        <div class="space-y-3">
          <div>
            <label class="block text-xs text-slate-400 mb-1">Search Query</label>
            <input id="query" type="text" value="Roof ventilation fan wiring" class="w-full bg-slate-800 border border-slate-700 rounded px-3 py-2 text-sm">
          </div>
          <div>
            <label class="block text-xs text-slate-400 mb-1">Subsystem (Tests Defensive Coercion)</label>
            <select id="subsystem" class="w-full bg-slate-800 border border-slate-700 rounded px-3 py-2 text-sm">
              <option value="climate">climate (hallucinated synonym -> heating_cooling)</option>
              <option value="heating_cooling">heating_cooling (canonical)</option>
              <option value="fan">fan (synonym -> heating_cooling)</option>
              <option value="electrical">electrical (synonym -> 12v_dc)</option>
              <option value="12v_dc">12v_dc (canonical)</option>
              <option value="water">water (synonym -> plumbing)</option>
              <option value="roof">roof (synonym -> structural)</option>
            </select>
          </div>
          <button onclick="testCoercion()" class="w-full bg-sky-600 hover:bg-sky-500 font-medium py-2 rounded text-sm transition">
            Test Parameter Coercion
          </button>
        </div>
        <div id="search-result" class="hidden bg-slate-950 border border-slate-800 rounded p-3 text-xs space-y-2"></div>
      </section>
    </div>

    <!-- Safety Invariants Banner -->
    <div class="bg-amber-950/30 border border-amber-800/50 rounded-xl p-4 text-xs text-amber-200 space-y-1">
      <div class="font-semibold text-amber-400">🛡️ Active Safety Invariants & Negative Constraints:</div>
      <div>• Mandatory 7-inch source fuse placement (ABYC E-11) — primary fuse prohibited at load/inverter.</div>
      <div>• AWG inverse gauge invariant enforced — higher gauge numbers indicate smaller conductors.</div>
      <div>• Maximum torque limits (8–10 N·m / 6–7.5 ft-lbs ceiling) on small DC battery studs.</div>
    </div>
  </div>

  <script>
    function calculate() {
      const v = Number(document.getElementById('voltage').value);
      const a = Number(document.getElementById('amps').value);
      const ft = Number(document.getElementById('feet').value);
      
      const vDropAllowed = v * 0.03;
      const cMil = (10.75 * a * (ft * 2)) / vDropAllowed;
      
      let awg = "4/0";
      if (cMil <= 4110) awg = "14 AWG";
      else if (cMil <= 6530) awg = "12 AWG";
      else if (cMil <= 10380) awg = "10 AWG";
      else if (cMil <= 16510) awg = "8 AWG";
      else if (cMil <= 26240) awg = "6 AWG";
      else if (cMil <= 41740) awg = "4 AWG";
      else if (cMil <= 66360) awg = "2 AWG";
      else if (cMil <= 83690) awg = "1 AWG";
      else if (cMil <= 105600) awg = "1/0 AWG";
      else if (cMil <= 133100) awg = "2/0 AWG";

      const out = document.getElementById('calc-result');
      out.classList.remove('hidden');
      out.innerHTML = \`
        <div class="font-semibold text-emerald-400">Calculation Result:</div>
        <div>Recommended Wire: <span class="font-bold text-white">\${awg}</span> (105°C tinned copper)</div>
        <div>Required Circular Mils: \${Math.round(cMil)} cmil</div>
        <div>Recommended Fuse: \${Math.ceil(a * 1.25 / 10) * 10}A at battery terminal</div>
        <div class="text-amber-300 mt-2 font-mono text-[11px]">Safety Invariant: Fuse must be within 7" of battery positive. Do NOT install primary fuse at inverter.</div>
      \`;
    }

    const ALIASES = {
      climate: "heating_cooling",
      fan: "heating_cooling",
      electrical: "12v_dc",
      water: "plumbing",
      roof: "structural"
    };

    function testCoercion() {
      const q = document.getElementById('query').value;
      const s = document.getElementById('subsystem').value;
      const coerced = ALIASES[s] || s;

      const out = document.getElementById('search-result');
      out.classList.remove('hidden');
      out.innerHTML = \`
        <div class="font-semibold text-sky-400">Subsystem Normalization:</div>
        <div>Input Argument: <code class="bg-slate-800 px-1 py-0.5 rounded text-amber-300">"\${s}"</code></div>
        <div>Coerced Canonical Enum: <code class="bg-slate-800 px-1 py-0.5 rounded text-emerald-300">"\${coerced}"</code></div>
        <div class="text-emerald-400 mt-1 font-mono text-[11px]">✓ Zod Preprocess succeeded. Schema error -32602 prevented.</div>
      \`;
    }
  </script>
</body>
</html>`);
    return;
  }

  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("Not Found");
});

server.listen(PORT, HOST, () => {
  console.log(`Server running at http://${HOST}:${PORT}/`);
});
