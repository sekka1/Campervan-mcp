/**
 * scripts/grounding-check.mjs
 *
 * Generic, deterministic "is this answer grounded?" checker. It has NO knowledge of any vehicle,
 * component or manual: it extracts checkable claims from an LLM answer and verifies that each one
 * appears in the evidence the MCP tools actually returned (plus the user's own question).
 *
 * Checked claim types:
 *   spec      numeric value + unit (torque, current, voltage, gauge, length, pressure, ...)
 *   section   "Section 4.5.2" style references
 *   page      "p. 62", "pages 61-62" references
 *   part      alphanumeric part / figure numbers (e.g. "14K024", "E185976")
 *   standard  named external standards (ABYC, NEC, ISO, SAE, ...)
 *
 * Anything that is not in the evidence is reported as ungrounded. That catches the whole class of
 * "model invented a number / rule / citation" failures on every platform and system, without
 * per-case rules. Values computed by calculate_dc_wire_and_fuse count as evidence because the tool
 * result is part of the trace.
 *
 * Provider output format (scripts/promptfoo-mcp-provider.mjs):
 *   "MCP Tool Result (<tool>): <json>" lines, then a blank line, then the synthesized answer.
 */

const TRACE_PREFIX = /^MCP Tool Result \(([^)]+)\): (.*)$/;

/** Splits promptfoo-provider output into the final answer and the evidence the tools returned. */
export function parseProviderOutput(output) {
  const lines = String(output ?? "").split("\n");
  const traceLines = [];
  let lastTraceIdx = -1;
  lines.forEach((l, i) => {
    if (TRACE_PREFIX.test(l)) {
      traceLines.push(l);
      lastTraceIdx = i;
    }
  });
  const answer = lines.slice(lastTraceIdx + 1).join("\n").trim();

  const evidence = [];
  const pages = new Set();
  for (const line of traceLines) {
    const m = line.match(TRACE_PREFIX);
    let content;
    try {
      content = JSON.parse(m[2]);
    } catch {
      evidence.push(m[2]);
      continue;
    }
    for (const item of Array.isArray(content) ? content : [content]) {
      const text = typeof item?.text === "string" ? item.text : JSON.stringify(item);
      let obj;
      try {
        obj = JSON.parse(text);
      } catch {
        evidence.push(text);
        continue;
      }
      if (Array.isArray(obj?.results)) {
        // Search result: use ONLY retrieved content. The retrieval_contract is instructions to the
        // model, not evidence (it names standards/examples that must not count as support).
        for (const r of obj.results) {
          evidence.push(
            [r.text, r.chunk_text, r.section, r.document_title, r.schematic_caption, r.schematic_url]
              .filter(Boolean)
              .join(" ")
          );
          if (Number.isFinite(Number(r.page))) pages.add(Number(r.page));
        }
      } else {
        evidence.push(JSON.stringify(obj)); // e.g. calculator output
      }
    }
  }
  return { answer, evidence: evidence.join("\n"), pages };
}

const normalize = (s) => s.toLowerCase().replace(/[\s·\-–—_]/g, "");
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Multi-letter units may be separated from the number by a space; ambiguous single letters may not.
const WORD_UNITS =
  "ft[\\s·.\\-]*lbs?|in[\\s·.\\-]*lbs?|n[\\s·.\\-]*m|nm|awg|amps?|volts?|vdc|vac|mm|cm|inch(?:es)?|feet|ft|psi|kpa|bar|gal|liters?|litres?|kw|kwh|ah|btu|rpm|hz|°c|°f";
const SPEC_RE = new RegExp(
  `(?<![\\w.])(\\d+(?:\\.\\d+)?(?:\\s*[-–]\\s*\\d+(?:\\.\\d+)?)?)(?:\\s*(${WORD_UNITS})(?![A-Za-z])|(A|V|W|L)(?![A-Za-z]))`,
  "gi"
);
const SECTION_RE = /\b(?:section|sec\.|§)\s*(\d+(?:\.\d+)+)/gi;
const PAGE_RE = /\b(?:pp?\.|pages?)\s*(\d+)(?:\s*[-–]\s*(\d+))?/gi;
const PART_RE = /(?<![A-Za-z0-9-])(?=[A-Z0-9-]*\d)(?=[A-Z0-9-]*[A-Z])[A-Z0-9][A-Z0-9-]{3,}(?![A-Za-z0-9])/g;
const STANDARD_RE = /\b(ABYC|NEC|NFPA|ISO|SAE|IEC|DIN|FMVSS|ECE)\b/g;

function stripNoise(answer) {
  return answer
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ") // markdown images (URLs contain page/part-like text)
    .replace(/\]\([^)]*\)/g, "]"); // markdown link targets
}

/** Extracts checkable claims from an answer. */
export function extractClaims(answer) {
  const text = stripNoise(answer);
  const claims = [];
  const seen = new Set();
  const add = (type, value, display) => {
    const key = `${type}:${value}`;
    if (seen.has(key)) return;
    seen.add(key);
    claims.push({ type, value, claim: display });
  };

  for (const m of text.matchAll(SPEC_RE)) {
    add("spec", normalize(m[0]), m[0].trim());
  }
  for (const m of text.matchAll(SECTION_RE)) add("section", m[1], `Section ${m[1]}`);
  for (const m of text.matchAll(PAGE_RE)) {
    const from = Number(m[1]);
    const to = m[2] ? Number(m[2]) : from;
    // Ranges ("pp. 150-153") are checked by their endpoints only.
    add("page", String(from), `page ${from}`);
    if (to !== from) add("page", String(to), `page ${to}`);
  }
  for (const m of text.matchAll(PART_RE)) {
    const tok = m[0];
    if (/^\d+[A-Z]{1,3}$/.test(tok)) continue; // 120V, 2000W ...
    if (/^[A-Z]-?\d{1,2}$/.test(tok) || /^[A-Z]{1,3}\d{1,2}$/.test(tok)) continue; // M6, A4, E-11 ...
    add("part", tok, tok);
  }
  for (const m of text.matchAll(STANDARD_RE)) add("standard", m[1].toLowerCase(), m[1]);
  return claims;
}

/** Returns the claims in `answer` that are not supported by `evidence` (and the user's question). */
export function findUngroundedClaims({ answer, evidence, pages = new Set(), question = "" }) {
  const haystack = `${evidence}\n${question}`;
  const normHay = normalize(haystack);
  const lowerHay = haystack.toLowerCase();

  // Page numbers also count when the chunk text or a continuation label mentions them (e.g. "p153", "page 150").
  const pageSet = new Set(pages);
  for (const m of haystack.matchAll(/\b(?:p|pp|page|pages)\.?\s*(\d{1,4})\b/gi)) pageSet.add(Number(m[1]));
  for (const m of haystack.matchAll(/(?:^|[/_-])p(\d{1,4})-\d+\.(?:png|jpe?g)/gi)) pageSet.add(Number(m[1]));

  // PDF text extraction often leaves stray spaces around hyphens ("KK2V- 14301-K"); match part numbers ignoring them.
  const tightHay = haystack.replace(/\s*[-–]\s*/g, "-");

  return extractClaims(answer).filter((c) => {
    switch (c.type) {
      case "spec":
        return !new RegExp(`(?<![\\d.])${escapeRe(c.value)}`).test(normHay);
      case "section":
        return !new RegExp(`(?<![\\d.])${escapeRe(c.value)}(?!\\d)`).test(haystack);
      case "page":
        return !pageSet.has(Number(c.value));
      case "part":
        return !new RegExp(`(?<![A-Za-z0-9-])${escapeRe(c.value)}(?![A-Za-z0-9])`, "i").test(tightHay);
      case "standard":
        return !lowerHay.includes(c.value);
      default:
        return false;
    }
  });
}

/**
 * Promptfoo `javascript` assertion: fails when the answer contains claims that no tool returned.
 * Usage in promptfooconfig.yaml:
 *   - type: javascript
 *     value: file://scripts/grounding-check.mjs:groundingAssertion
 */
export function groundingAssertion(output, context) {
  const { answer, evidence, pages } = parseProviderOutput(output);
  if (!evidence) return { pass: true, score: 1, reason: "No tool evidence in output; grounding check skipped." };
  const question = context?.vars?.question ?? "";
  const ungrounded = findUngroundedClaims({ answer, evidence, pages, question });
  if (ungrounded.length === 0) return { pass: true, score: 1, reason: "All specs, sections, pages, part numbers and standards are in the retrieved evidence." };
  const list = ungrounded.map((c) => `${c.type}: ${c.claim}`).join("; ");
  return { pass: false, score: 0, reason: `Ungrounded claims (not in any tool result): ${list}` };
}
