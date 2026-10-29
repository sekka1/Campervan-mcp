/**
 * ABYC E-11 Compliant DC Wire Gauge and Overcurrent Protection (Fuse) Calculator
 * Implements deterministic electrical calculations and returns mandatory safety invariants
 * and negative constraints to prevent LLMs from hallucinating hazardous electrical recommendations.
 */

import {
  calculateDCWireAndFuse,
  WireCalculationParams,
  WireCalculationResult,
  ABYC_AWG_TABLE,
} from "../utils/formulas";

export type { WireCalculationParams, WireCalculationResult };
export { ABYC_AWG_TABLE };

export const calculateDcWireAndFuse = calculateDCWireAndFuse;
export { calculateDCWireAndFuse };
