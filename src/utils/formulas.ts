/**
 * Pure mathematical utility functions for campervan electrical and weight calculations.
 * All functions are deterministic and free of side effects.
 */

// ---------------------------------------------------------------------------
// AWG Wire Gauge Table
// Maps AWG gauge number to wire cross-sectional area in circular mils (CM)
// and maximum ampacity for chassis wiring (60 °C rating).
// ---------------------------------------------------------------------------

export interface AwgSpec {
  awg: number;
  circularMils: number;
  maxAmps: number;
}

/**
 * Standard AWG specs used for DC van electrical systems.
 * "Aught" gauges (1/0, 2/0, 3/0, 4/0) are represented as 0, -1, -2, -3.
 * Larger AWG numbers = thinner wire (counterintuitive).
 * Sorted from largest (lowest AWG / most capacity) to smallest.
 */
export const AWG_TABLE: AwgSpec[] = [
  { awg: -3, circularMils: 211_600, maxAmps: 230 }, // 4/0 AWG
  { awg: -2, circularMils: 167_800, maxAmps: 200 }, // 3/0 AWG
  { awg: -1, circularMils: 133_100, maxAmps: 175 }, // 2/0 AWG
  { awg: 0, circularMils: 105_600, maxAmps: 150 },  // 1/0 AWG
  { awg: 1, circularMils: 83_690, maxAmps: 130 },
  { awg: 2, circularMils: 66_360, maxAmps: 115 },
  { awg: 4, circularMils: 41_740, maxAmps: 85 },
  { awg: 6, circularMils: 26_240, maxAmps: 65 },
  { awg: 8, circularMils: 16_510, maxAmps: 50 },
  { awg: 10, circularMils: 10_380, maxAmps: 30 },
  { awg: 12, circularMils: 6_530, maxAmps: 20 },
  { awg: 14, circularMils: 4_107, maxAmps: 15 },
  { awg: 16, circularMils: 2_583, maxAmps: 13 },
  { awg: 18, circularMils: 1_624, maxAmps: 10 },
];

/**
 * Resistivity of copper in ohms per circular mil-foot at 20 °C.
 * Standard constant: 10.371 Ω·CM/ft
 */
const COPPER_RESISTIVITY_CM_FT = 10.371;

// ---------------------------------------------------------------------------
// Voltage Drop Calculation
// ---------------------------------------------------------------------------

export interface VoltageDropResult {
  /** Recommended AWG gauge number (e.g., 10, 8, 4/0 represented as 0 for 1/0) */
  recommended_awg: string;
  /** Actual voltage drop in Volts */
  voltage_drop_volts: number;
  /** Actual voltage drop as a percentage of supply voltage */
  voltage_drop_pct: number;
  /** Recommended fuse size in Amperes (125% of load, next standard size up) */
  fuse_size_amps: number;
  /** Conductor resistance for the selected wire in Ohms */
  conductor_resistance_ohms: number;
  /** Wire temperature derating note */
  notes: string;
}

/**
 * Calculates the optimal AWG wire gauge and voltage drop for a DC circuit.
 *
 * Uses the standard formula:
 *   CM = (K × I × L) / E_drop
 * Where:
 *   K  = 21.4 (constant for copper, round-trip)
 *   I  = current in Amperes
 *   L  = one-way length in feet
 *   E_drop = allowable voltage drop in Volts
 *
 * @param currentAmps    - Circuit current in Amperes
 * @param lengthFeet     - One-way wire run length in feet
 * @param systemVoltage  - DC system voltage (12, 24, or 48)
 * @param allowableDropPct - Maximum allowable voltage drop percentage (1–10)
 */
export function calculateVoltageDrop(
  currentAmps: number,
  lengthFeet: number,
  systemVoltage: number,
  allowableDropPct: number
): VoltageDropResult {
  if (currentAmps <= 0) throw new Error("currentAmps must be positive");
  if (lengthFeet <= 0) throw new Error("lengthFeet must be positive");
  if (systemVoltage <= 0) throw new Error("systemVoltage must be positive");
  if (allowableDropPct <= 0 || allowableDropPct > 100)
    throw new Error("allowableDropPct must be between 0 and 100");

  // Allowable drop in Volts
  const allowableDropVolts = (allowableDropPct / 100) * systemVoltage;

  // Required circular mils using round-trip constant K=21.4 for copper
  const K = 21.4;
  const requiredCM = (K * currentAmps * lengthFeet) / allowableDropVolts;

  // Find smallest AWG gauge that meets or exceeds required CM AND ampacity.
  // AWG_TABLE is ordered from largest gauge (most CM) to smallest, so we must
  // search from the smallest gauge upward to find the *first* (thinnest, most
  // economical) wire that satisfies both constraints, rather than always
  // matching the largest gauge in the table.
  const candidate = [...AWG_TABLE]
    .reverse()
    .find((spec) => spec.circularMils >= requiredCM && spec.maxAmps >= currentAmps);

  // Fall back to largest gauge in table if no candidate found
  const selected = candidate ?? AWG_TABLE[0];

  // Actual resistance = K_resistivity × length (round-trip = 2 × one-way) / CM
  const conductorResistanceOhms =
    (COPPER_RESISTIVITY_CM_FT * 2 * lengthFeet) / selected.circularMils;

  // Actual voltage drop
  const voltageDrop = currentAmps * conductorResistanceOhms;
  const voltageDropPct = (voltageDrop / systemVoltage) * 100;

  // Fuse sizing: NEC recommends 125% of continuous load, rounded to standard sizes
  const rawFuseAmps = currentAmps * 1.25;
  const fuseSize = roundUpToStandardFuseSize(rawFuseAmps);

  // Format AWG string (handle 4/0, 3/0, 2/0, 1/0 special cases)
  const awgLabel = formatAwgLabel(selected.awg);

  return {
    recommended_awg: awgLabel,
    voltage_drop_volts: Math.round(voltageDrop * 1000) / 1000,
    voltage_drop_pct: Math.round(voltageDropPct * 100) / 100,
    fuse_size_amps: fuseSize,
    conductor_resistance_ohms: Math.round(conductorResistanceOhms * 10000) / 10000,
    notes: `Selected ${awgLabel} AWG (${selected.circularMils.toLocaleString()} CM, ${selected.maxAmps}A rated). System: ${systemVoltage}V DC.`,
  };
}

/** Standard automotive/marine fuse sizes in Amperes */
const STANDARD_FUSE_SIZES = [5, 7.5, 10, 15, 20, 25, 30, 35, 40, 50, 60, 70, 80, 100, 125, 150, 175, 200, 225, 250, 300, 350, 400, 450, 500];

function roundUpToStandardFuseSize(amps: number): number {
  const found = STANDARD_FUSE_SIZES.find((s) => s >= amps);
  return found ?? STANDARD_FUSE_SIZES[STANDARD_FUSE_SIZES.length - 1];
}

function formatAwgLabel(awg: number): string {
  if (awg <= 0) {
    const aught = Math.abs(awg) + 1;
    return `${aught}/0`;
  }
  return String(awg);
}

// ---------------------------------------------------------------------------
// Solar Array Validation
// ---------------------------------------------------------------------------

export interface SolarArrayResult {
  /** Whether the configuration is safe for the MPPT controller */
  is_safe: boolean;
  /** Calculated open-circuit voltage at coldest expected temperature */
  cold_weather_voc_volts: number;
  /** Total array power in Watts */
  total_watts: number;
  /** Total short-circuit current in Amperes */
  total_isc_amps: number;
  /** MPPT input voltage range compliance */
  mppt_voltage_ok: boolean;
  /** MPPT input current compliance */
  mppt_current_ok: boolean;
  /** Detailed validation messages */
  messages: string[];
}

export interface SolarPanelSpec {
  /** Panel rated power in Watts (STC) */
  watts: number;
  /** Open-circuit voltage at STC (25 °C) in Volts */
  voc_stc: number;
  /** Short-circuit current in Amperes */
  isc_amps: number;
  /** Temperature coefficient of Voc in %/°C (typically negative, e.g., -0.3) */
  voc_temp_coeff_pct_per_c: number;
}

export interface MpptSpec {
  /** Maximum input voltage (absolute maximum) in Volts */
  max_input_voltage: number;
  /** MPPT operating voltage range minimum */
  mppt_voltage_min: number;
  /** MPPT operating voltage range maximum */
  mppt_voltage_max: number;
  /** Maximum input current in Amperes */
  max_input_current_amps: number;
}

/**
 * Validates a solar panel string configuration against MPPT controller specs.
 *
 * Calculates cold-weather Voc (using -10 °C as worst-case) and checks:
 * - Voc does not exceed MPPT max input voltage
 * - Array current does not exceed MPPT max current
 * - Array voltage falls within MPPT operating range
 *
 * @param panels     - Panel specifications
 * @param seriesCount  - Number of panels in series per string
 * @param parallelStrings - Number of parallel strings
 * @param mppt       - MPPT charge controller specifications
 * @param coldTempC  - Coldest expected temperature in °C (default: -10)
 */
export function validateSolarArray(
  panels: SolarPanelSpec,
  seriesCount: number,
  parallelStrings: number,
  mppt: MpptSpec,
  coldTempC = -10
): SolarArrayResult {
  const messages: string[] = [];

  // Temperature delta from STC (25 °C)
  const tempDelta = coldTempC - 25;

  // Voc rises as temperature drops (negative coefficient)
  const vocIncreasePct = (panels.voc_temp_coeff_pct_per_c / 100) * tempDelta;
  const coldVocPerPanel = panels.voc_stc * (1 + vocIncreasePct);

  // Series string Voc
  const coldStringVoc = coldVocPerPanel * seriesCount;

  // Parallel strings sum current
  const totalIsc = panels.isc_amps * parallelStrings;

  // Total array power (rated at STC)
  const totalWatts = panels.watts * seriesCount * parallelStrings;

  // Check 1: Absolute max voltage
  const mpptVoltageOk = coldStringVoc <= mppt.max_input_voltage;
  if (!mpptVoltageOk) {
    messages.push(
      `DANGER: Cold Voc ${coldStringVoc.toFixed(1)}V exceeds MPPT max input ${mppt.max_input_voltage}V. Reduce series panels.`
    );
  } else {
    messages.push(
      `Voltage OK: Cold Voc ${coldStringVoc.toFixed(1)}V ≤ MPPT max ${mppt.max_input_voltage}V`
    );
  }

  // Check 2: MPPT operating range
  const inMpptRange =
    coldStringVoc >= mppt.mppt_voltage_min && coldStringVoc <= mppt.mppt_voltage_max;
  if (!inMpptRange) {
    messages.push(
      `WARNING: Array voltage ${coldStringVoc.toFixed(1)}V may be outside MPPT range ${mppt.mppt_voltage_min}–${mppt.mppt_voltage_max}V`
    );
  } else {
    messages.push(`MPPT range OK: ${coldStringVoc.toFixed(1)}V within ${mppt.mppt_voltage_min}–${mppt.mppt_voltage_max}V`);
  }

  // Check 3: Current limit
  const mpptCurrentOk = totalIsc <= mppt.max_input_current_amps;
  if (!mpptCurrentOk) {
    messages.push(
      `DANGER: Array Isc ${totalIsc.toFixed(1)}A exceeds MPPT max input ${mppt.max_input_current_amps}A. Reduce parallel strings.`
    );
  } else {
    messages.push(
      `Current OK: Array Isc ${totalIsc.toFixed(1)}A ≤ MPPT max ${mppt.max_input_current_amps}A`
    );
  }

  const isSafe = mpptVoltageOk && mpptCurrentOk;

  return {
    is_safe: isSafe,
    cold_weather_voc_volts: Math.round(coldStringVoc * 100) / 100,
    total_watts: totalWatts,
    total_isc_amps: Math.round(totalIsc * 100) / 100,
    mppt_voltage_ok: mpptVoltageOk,
    mppt_current_ok: mpptCurrentOk,
    messages,
  };
}

// ---------------------------------------------------------------------------
// Van Payload Calculation
// ---------------------------------------------------------------------------

export interface VanSpec {
  gvwr_lbs: number;
  curb_weight_lbs: number;
  front_axle_rating_lbs: number;
  rear_axle_rating_lbs: number;
}

/** Known van base specifications */
export const VAN_SPECS: Record<string, VanSpec> = {
  "sprinter_144": {
    gvwr_lbs: 8_550,
    curb_weight_lbs: 5_200,
    front_axle_rating_lbs: 3_900,
    rear_axle_rating_lbs: 5_060,
  },
  "sprinter_170": {
    gvwr_lbs: 8_550,
    curb_weight_lbs: 5_400,
    front_axle_rating_lbs: 3_900,
    rear_axle_rating_lbs: 5_060,
  },
  "transit_148": {
    gvwr_lbs: 8_600,
    curb_weight_lbs: 5_000,
    front_axle_rating_lbs: 4_000,
    rear_axle_rating_lbs: 5_000,
  },
  "transit_148_ext": {
    gvwr_lbs: 9_000,
    curb_weight_lbs: 5_300,
    front_axle_rating_lbs: 4_000,
    rear_axle_rating_lbs: 5_500,
  },
  "promaster_136": {
    gvwr_lbs: 8_550,
    curb_weight_lbs: 4_900,
    front_axle_rating_lbs: 4_050,
    rear_axle_rating_lbs: 5_330,
  },
  "promaster_159": {
    gvwr_lbs: 8_900,
    curb_weight_lbs: 5_100,
    front_axle_rating_lbs: 4_050,
    rear_axle_rating_lbs: 5_750,
  },
};

export interface PayloadComponent {
  name: string;
  weight_lbs: number;
  /** Position along van length: "front" | "mid" | "rear" */
  position?: "front" | "mid" | "rear";
}

export interface PayloadResult {
  /** Total added weight of all components in lbs */
  total_added_weight_lbs: number;
  /** Remaining payload capacity after components */
  remaining_payload_lbs: number;
  /** Whether total load is within GVWR */
  within_gvwr: boolean;
  /** Estimated weight on front axle */
  estimated_front_axle_lbs: number;
  /** Estimated weight on rear axle */
  estimated_rear_axle_lbs: number;
  /** Whether front axle is within rating */
  front_axle_ok: boolean;
  /** Whether rear axle is within rating */
  rear_axle_ok: boolean;
  /** Component breakdown */
  components: Array<{ name: string; weight_lbs: number; position: string }>;
  /** Van specification used */
  van_model: string;
  notes: string;
}

/**
 * Calculates van payload budget and axle weight distribution.
 *
 * Uses a simplified axle distribution model:
 * - Front position: 70% front / 30% rear
 * - Mid position: 40% front / 60% rear
 * - Rear position: 20% front / 80% rear
 *
 * @param vanModel    - Van model key (e.g., "sprinter_144")
 * @param components  - List of components with weights and positions
 * @param occupantsWeight - Weight of occupants in lbs (default: 0)
 */
export function calculateVanPayload(
  vanModel: string,
  components: PayloadComponent[],
  occupantsWeight = 0
): PayloadResult {
  const spec = VAN_SPECS[vanModel];
  if (!spec) {
    throw new Error(
      `Unknown van model: "${vanModel}". Valid models: ${Object.keys(VAN_SPECS).join(", ")}`
    );
  }

  const maxPayload = spec.gvwr_lbs - spec.curb_weight_lbs;

  let totalAddedWeight = occupantsWeight;
  let frontAxleAdded = 0;
  let rearAxleAdded = 0;

  // Occupants are assumed mid-van
  frontAxleAdded += occupantsWeight * 0.4;
  rearAxleAdded += occupantsWeight * 0.6;

  for (const component of components) {
    totalAddedWeight += component.weight_lbs;

    const pos = component.position ?? "mid";
    if (pos === "front") {
      frontAxleAdded += component.weight_lbs * 0.7;
      rearAxleAdded += component.weight_lbs * 0.3;
    } else if (pos === "rear") {
      frontAxleAdded += component.weight_lbs * 0.2;
      rearAxleAdded += component.weight_lbs * 0.8;
    } else {
      frontAxleAdded += component.weight_lbs * 0.4;
      rearAxleAdded += component.weight_lbs * 0.6;
    }
  }

  // Estimate axle loads: distribute curb weight (assumed 48/52 F/R split)
  const curbFront = spec.curb_weight_lbs * 0.48;
  const curbRear = spec.curb_weight_lbs * 0.52;

  const estimatedFrontAxle = curbFront + frontAxleAdded;
  const estimatedRearAxle = curbRear + rearAxleAdded;

  const remainingPayload = maxPayload - totalAddedWeight;
  const withinGvwr = totalAddedWeight <= maxPayload;
  const frontAxleOk = estimatedFrontAxle <= spec.front_axle_rating_lbs;
  const rearAxleOk = estimatedRearAxle <= spec.rear_axle_rating_lbs;

  const componentBreakdown = components.map((c) => ({
    name: c.name,
    weight_lbs: c.weight_lbs,
    position: c.position ?? "mid",
  }));

  return {
    total_added_weight_lbs: Math.round(totalAddedWeight),
    remaining_payload_lbs: Math.round(remainingPayload),
    within_gvwr: withinGvwr,
    estimated_front_axle_lbs: Math.round(estimatedFrontAxle),
    estimated_rear_axle_lbs: Math.round(estimatedRearAxle),
    front_axle_ok: frontAxleOk,
    rear_axle_ok: rearAxleOk,
    components: componentBreakdown,
    van_model: vanModel,
    notes: `GVWR: ${spec.gvwr_lbs.toLocaleString()} lbs | Curb: ${spec.curb_weight_lbs.toLocaleString()} lbs | Max payload: ${maxPayload.toLocaleString()} lbs`,
  };
}
