export interface Claim { type: "spec" | "section" | "page" | "part" | "standard"; value: string; claim: string }
export function parseProviderOutput(output: string): { answer: string; evidence: string; pages: Set<number> };
export function extractClaims(answer: string): Claim[];
export function findUngroundedClaims(input: { answer: string; evidence: string; pages?: Set<number>; question?: string }): Claim[];
export function groundingAssertion(
  output: string,
  context?: { vars?: Record<string, unknown> }
): { pass: boolean; score: number; reason: string };
