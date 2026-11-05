/**
 * Context disambiguation ("don't assume, ask").
 *
 * The same question can have different answers for different manufacturers, models, model years or markets
 * (a vehicle platform, a heater, a battery system, a plumbing kit, ...). The server must never silently pick one
 * (for example "the newest year" or "the US market"). Instead, when the best results come from several documents
 * that differ in a facet the caller did NOT specify, it returns a clarification: which facets are missing and which
 * options exist in the indexed documents, so the LLM can ask the user a short follow-up question.
 *
 * Fully generic: it knows nothing about any vehicle or component. Facet values come from the indexed documents.
 */

export type VariantFacet = "manufacturer" | "model" | "model_year" | "market";

/** Minimal shape of a ranked search result needed to detect variants. */
export interface AmbiguityCandidate {
  id: string;
  document_title?: string | undefined;
  manufacturer?: string | undefined;
  model?: string | undefined;
  market?: string | undefined;
  model_year?: number | undefined;
  metadata_json?: string | undefined;
}

/** Context the caller already supplied (explicit filters). A specified facet is never asked about. */
export interface SpecifiedContext {
  manufacturer?: string | undefined;
  model?: string | undefined;
  chassis?: string | undefined;
  market?: string | undefined;
  model_year?: number | undefined;
  /** A specific manual was requested; nothing is ambiguous. */
  source?: string | undefined;
}

export interface VariantOption {
  document_title: string;
  manufacturer?: string;
  model?: string;
  model_year?: string;
  market?: string;
  matching_chunks: number;
}

export interface Clarification {
  needs_clarification: true;
  reason: string;
  /** Facets whose values differ among the best results and were not specified by the caller. */
  missing_context: VariantFacet[];
  /** Distinct values found per missing facet, for building the follow-up question. */
  choices: Partial<Record<VariantFacet, string[]>>;
  options: VariantOption[];
  suggested_question: string;
  instruction: string;
}

/** A document counts as a real competing variant if it has at least this many top results... */
export const MIN_CHUNKS_FOR_VARIANT = 2;
/** ...or if one of its results is ranked within this many top positions. */
export const TOP_RANKS_FOR_VARIANT = 3;

const FACET_LABEL: Record<VariantFacet, string> = {
  manufacturer: "manufacturer",
  model: "model",
  model_year: "model year",
  market: "market/region",
};

function documentKey(id: string): string {
  const m = id.match(/^(.+)#chunk_\d+$/);
  return m ? m[1]! : id;
}

function yearLabel(c: AmbiguityCandidate): string | undefined {
  if (c.model_year === undefined || !Number.isFinite(c.model_year)) return undefined;
  let end: number | undefined;
  if (c.metadata_json) {
    try {
      const meta = JSON.parse(c.metadata_json) as { year_end?: unknown };
      if (meta.year_end !== null && meta.year_end !== undefined && Number.isFinite(Number(meta.year_end))) {
        end = Number(meta.year_end);
      }
    } catch {
      /* ignore malformed metadata */
    }
  }
  return end !== undefined && end !== c.model_year ? `${c.model_year}-${end}` : String(c.model_year);
}

function facetValue(c: AmbiguityCandidate, facet: VariantFacet): string | undefined {
  switch (facet) {
    case "manufacturer":
      return c.manufacturer && c.manufacturer.toLowerCase() !== "unknown" ? c.manufacturer.toLowerCase() : undefined;
    case "model":
      return c.model ? c.model.toLowerCase() : undefined;
    case "market":
      return c.market ? c.market.toLowerCase() : undefined;
    case "model_year":
      return yearLabel(c);
  }
}

function isSpecified(facet: VariantFacet, s: SpecifiedContext): boolean {
  switch (facet) {
    case "manufacturer":
      return Boolean(s.manufacturer);
    case "model":
      return Boolean(s.model || s.chassis);
    case "market":
      return Boolean(s.market);
    case "model_year":
      return s.model_year !== undefined;
  }
}

/**
 * Returns a clarification when the best results come from several documents that differ in a facet the caller
 * did not specify; otherwise undefined. `results` must be in final relevance order (best first).
 */
export function assessAmbiguity(
  results: ReadonlyArray<AmbiguityCandidate>,
  specified: SpecifiedContext
): Clarification | undefined {
  if (specified.source || results.length === 0) return undefined;

  type Group = { key: string; first: AmbiguityCandidate; count: number; bestRank: number };
  const groups = new Map<string, Group>();
  results.forEach((r, rank) => {
    const key = documentKey(r.id);
    const g = groups.get(key);
    if (g) g.count++;
    else groups.set(key, { key, first: r, count: 1, bestRank: rank });
  });

  const variants = Array.from(groups.values()).filter(
    (g) => g.count >= MIN_CHUNKS_FOR_VARIANT || g.bestRank < TOP_RANKS_FOR_VARIANT
  );
  if (variants.length < 2) return undefined;

  const facets: VariantFacet[] = ["manufacturer", "model", "model_year", "market"];
  const missing: VariantFacet[] = [];
  const choices: Partial<Record<VariantFacet, string[]>> = {};
  for (const facet of facets) {
    if (isSpecified(facet, specified)) continue;
    const values = Array.from(
      new Set(variants.map((g) => facetValue(g.first, facet)).filter((v): v is string => Boolean(v)))
    ).sort();
    if (values.length >= 2) {
      missing.push(facet);
      choices[facet] = values;
    }
  }
  if (missing.length === 0) return undefined;

  const options: VariantOption[] = variants
    .sort((a, b) => a.bestRank - b.bestRank)
    .map((g) => {
      const f = g.first;
      return {
        document_title: f.document_title ?? g.key,
        ...(facetValue(f, "manufacturer") ? { manufacturer: facetValue(f, "manufacturer")! } : {}),
        ...(facetValue(f, "model") ? { model: facetValue(f, "model")! } : {}),
        ...(facetValue(f, "model_year") ? { model_year: facetValue(f, "model_year")! } : {}),
        ...(facetValue(f, "market") ? { market: facetValue(f, "market")! } : {}),
        matching_chunks: g.count,
      };
    });

  const missingLabels = missing.map((m) => FACET_LABEL[m]);
  const joined =
    missingLabels.length > 1
      ? `${missingLabels.slice(0, -1).join(", ")} and ${missingLabels[missingLabels.length - 1]}`
      : missingLabels[0]!;
  const optionList = options.map((o) => `"${o.document_title}"`).join(", ");

  return {
    needs_clarification: true,
    reason: `The best matches come from ${variants.length} different documents that differ in ${joined}, and no ${joined} was specified. The answer may differ between them, so none was assumed.`,
    missing_context: missing,
    choices,
    options,
    suggested_question: `Which ${joined} do you mean? Indexed options: ${optionList}.`,
    instruction:
      "Do NOT answer yet and do NOT pick an option yourself. If the user already stated the missing detail earlier in the conversation, call the tool again with it as a filter. Otherwise ask the user the suggested question (you may rephrase it), then call the tool again with the answer as filters. If the user wants every variant, call again with include_all_variants=true and label each part of your answer with its document title and year.",
  };
}
