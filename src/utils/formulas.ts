/**
 * Pure mathematical utility functions for campervan electrical, weight, and OEM chassis calculations.
 * All functions are deterministic and free of side effects.
 */

// ---------------------------------------------------------------------------
// AWG Wire Gauge Table (60 °C Chassis Wiring + Engine Compartment Derating)
// Maps AWG gauge number to wire cross-sectional area in circular mils (CM)
// and maximum ampacity for chassis wiring.
// ---------------------------------------------------------------------------

export interface AwgSpec {
  awg: number;
  circularMils: number;
  maxAmps: number;
  /** Derated ampacity when routed through an engine compartment (~85% of base rating) */
  engineCompartmentMaxAmps: number;
}

/**
 * Standard AWG specs used for DC van electrical systems.
 * "Aught" gauges (1/0, 2/0, 3/0, 4/0) are represented as 0, -1, -2, -3.
 * Larger AWG numbers = thinner wire (counterintuitive).
 * Sorted from largest (lowest AWG / most capacity) to smallest.
 */
export const AWG_TABLE: AwgSpec[] = [
  { awg: -3, circularMils: 211_600, maxAmps: 230, engineCompartmentMaxAmps: 195 }, // 4/0 AWG
  { awg: -2, circularMils: 167_800, maxAmps: 200, engineCompartmentMaxAmps: 170 }, // 3/0 AWG
  { awg: -1, circularMils: 133_100, maxAmps: 175, engineCompartmentMaxAmps: 149 }, // 2/0 AWG
  { awg: 0, circularMils: 105_600, maxAmps: 150, engineCompartmentMaxAmps: 128 },  // 1/0 AWG
  { awg: 1, circularMils: 83_690, maxAmps: 130, engineCompartmentMaxAmps: 110 },
  { awg: 2, circularMils: 66_360, maxAmps: 115, engineCompartmentMaxAmps: 98 },
  { awg: 4, circularMils: 41_740, maxAmps: 85, engineCompartmentMaxAmps: 72 },
  { awg: 6, circularMils: 26_240, maxAmps: 65, engineCompartmentMaxAmps: 55 },
  { awg: 8, circularMils: 16_510, maxAmps: 50, engineCompartmentMaxAmps: 42 },
  { awg: 10, circularMils: 10_380, maxAmps: 30, engineCompartmentMaxAmps: 25 },
  { awg: 12, circularMils: 6_530, maxAmps: 20, engineCompartmentMaxAmps: 17 },
  { awg: 14, circularMils: 4_107, maxAmps: 15, engineCompartmentMaxAmps: 13 },
  { awg: 16, circularMils: 2_583, maxAmps: 13, engineCompartmentMaxAmps: 11 },
  { awg: 18, circularMils: 1_624, maxAmps: 10, engineCompartmentMaxAmps: 8 },
];

// ---------------------------------------------------------------------------
// ABYC E-11 105 °C Marine/RV Stranded Tinned Copper Table (Spec Section 5)
// ---------------------------------------------------------------------------

export interface AbycAwgSpec {
  awg: string;
  circular_mils: number;
  resistance_per_1000ft_ohms: number;
  ampacity_outside_engine_105c: number;
  ampacity_inside_engine_105c: number;
}

export const ABYC_AWG_TABLE: AbycAwgSpec[] = [
  { awg: "16", circular_mils: 2580, resistance_per_1000ft_ohms: 4.016, ampacity_outside_engine_105c: 25, ampacity_inside_engine_105c: 21 },
  { awg: "14", circular_mils: 4110, resistance_per_1000ft_ohms: 2.525, ampacity_outside_engine_105c: 35, ampacity_inside_engine_105c: 30 },
  { awg: "12", circular_mils: 6530, resistance_per_1000ft_ohms: 1.588, ampacity_outside_engine_105c: 45, ampacity_inside_engine_105c: 38 },
  { awg: "10", circular_mils: 10380, resistance_per_1000ft_ohms: 0.999, ampacity_outside_engine_105c: 60, ampacity_inside_engine_105c: 51 },
  { awg: "8",  circular_mils: 16510, resistance_per_1000ft_ohms: 0.628, ampacity_outside_engine_105c: 80, ampacity_inside_engine_105c: 68 },
  { awg: "6",  circular_mils: 26240, resistance_per_1000ft_ohms: 0.395, ampacity_outside_engine_105c: 120, ampacity_inside_engine_105c: 102 },
  { awg: "4",  circular_mils: 41740, resistance_per_1000ft_ohms: 0.249, ampacity_outside_engine_105c: 160, ampacity_inside_engine_105c: 136 },
  { awg: "2",  circular_mils: 66360, resistance_per_1000ft_ohms: 0.156, ampacity_outside_engine_105c: 210, ampacity_inside_engine_105c: 178 },
  { awg: "1/0", circular_mils: 105600, resistance_per_1000ft_ohms: 0.098, ampacity_outside_engine_105c: 285, ampacity_inside_engine_105c: 242 },
  { awg: "2/0", circular_mils: 133100, resistance_per_1000ft_ohms: 0.078, ampacity_outside_engine_105c: 330, ampacity_inside_engine_105c: 280 },
  { awg: "4/0", circular_mils: 211600, resistance_per_1000ft_ohms: 0.049, ampacity_outside_engine_105c: 445, ampacity_inside_engine_105c: 378 },
];

/**
 * Resistivity of copper in ohms per circular mil-foot at 20 °C.
 * Standard constant: 10.371 Ω·CM/ft
 */
const COPPER_RESISTIVITY_CM_FT = 10.371;

/**
 * Selects the recommended fuse form factor based on amperage per ABYC E-11 guidelines.
 */
export function selectFuseFormFactor(fuseAmps: number): string {
  if (fuseAmps <= 30) return "ATC/ATO Blade";
  if (fuseAmps <= 100) return "MIDI / AMI Fuse";
  if (fuseAmps <= 300) return "MRBF (Marine Rated Battery Fuse) or MEGA";
  return "Class T Fuse (Essential for LiFePO4 high AIC ratings)";
}

// ---------------------------------------------------------------------------
// Voltage Drop Calculation
// ---------------------------------------------------------------------------

export interface VoltageDropResult {
  /** Recommended AWG gauge number (e.g., 10, 8, 4/0 represented as "4/0") */
  recommended_awg: string;
  /** Actual voltage drop in Volts */
  voltage_drop_volts: number;
  /** Actual voltage drop as a percentage of supply voltage */
  voltage_drop_pct: number;
  /** Recommended fuse size in Amperes (125% of load, next standard size up) */
  fuse_size_amps: number;
  /** Recommended ABYC fuse form factor based on fuse amperage */
  fuse_type: string;
  /** Total round-trip circuit length in feet (2 × one-way run) */
  round_trip_feet: number;
  /** Whether engine-compartment ampacity derating was applied */
  is_engine_compartment: boolean;
  /** Effective ampacity rating of the selected wire in Amperes */
  wire_ampacity_amps: number;
  /** Conductor resistance for the selected wire in Ohms */
  conductor_resistance_ohms: number;
  /** Wire temperature derating summary note */
  notes: string;
  /** Detailed ABYC E-11 compliance notes */
  abyc_notes: string[];
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
 * @param currentAmps         - Circuit current in Amperes
 * @param lengthFeet          - One-way wire run length in feet
 * @param systemVoltage       - DC system voltage (12, 24, or 48)
 * @param allowableDropPct    - Maximum allowable voltage drop percentage (1–10)
 * @param isEngineCompartment - True if wire runs through an engine compartment (default: false)
 */
export function calculateVoltageDrop(
  currentAmps: number,
  lengthFeet: number,
  systemVoltage: number,
  allowableDropPct: number,
  isEngineCompartment = false
): VoltageDropResult {
  if (currentAmps <= 0) throw new Error("currentAmps must be positive");
  if (lengthFeet <= 0) throw new Error("lengthFeet must be positive");
  if (systemVoltage <= 0) throw new Error("systemVoltage must be positive");
  if (allowableDropPct <= 0 || allowableDropPct > 100)
    throw new Error("allowableDropPct must be between 0 and 100");

  // Allowable drop in Volts
  const allowableDropVolts = (allowableDropPct / 100) * systemVoltage;
  const roundTripFeet = lengthFeet * 2;

  // Required circular mils using round-trip constant K=21.4 for copper
  const K = 21.4;
  const requiredCM = (K * currentAmps * lengthFeet) / allowableDropVolts;

  // Find smallest AWG gauge that meets or exceeds required CM AND ampacity.
  // AWG_TABLE is ordered from largest gauge (most CM) to smallest, so we must
  // search from the smallest gauge upward to find the *first* (thinnest, most
  // economical) wire that satisfies both constraints.
  const candidate = [...AWG_TABLE]
    .reverse()
    .find((spec) => {
      const effectiveAmpacity = isEngineCompartment
        ? spec.engineCompartmentMaxAmps
        : spec.maxAmps;
      return spec.circularMils >= requiredCM && effectiveAmpacity >= currentAmps;
    });

  // Fall back to largest gauge in table if no candidate found
  const selected = candidate ?? AWG_TABLE[0]!;
  const effectiveAmpacity = isEngineCompartment
    ? selected.engineCompartmentMaxAmps
    : selected.maxAmps;

  // Actual resistance = K_resistivity × length (round-trip = 2 × one-way) / CM
  const conductorResistanceOhms =
    (COPPER_RESISTIVITY_CM_FT * roundTripFeet) / selected.circularMils;

  // Actual voltage drop
  const voltageDrop = currentAmps * conductorResistanceOhms;
  const voltageDropPct = (voltageDrop / systemVoltage) * 100;

  // Fuse sizing: NEC/ABYC recommends 125% of continuous load, rounded to standard sizes
  const rawFuseAmps = currentAmps * 1.25;
  const fuseSize = roundUpToStandardFuseSize(rawFuseAmps);
  const fuseType = selectFuseFormFactor(fuseSize);

  // Format AWG string (handle 4/0, 3/0, 2/0, 1/0 special cases)
  const awgLabel = formatAwgLabel(selected.awg);

  return {
    recommended_awg: awgLabel,
    voltage_drop_volts: Math.round(voltageDrop * 1000) / 1000,
    voltage_drop_pct: Math.round(voltageDropPct * 100) / 100,
    fuse_size_amps: fuseSize,
    fuse_type: fuseType,
    round_trip_feet: roundTripFeet,
    is_engine_compartment: isEngineCompartment,
    wire_ampacity_amps: effectiveAmpacity,
    conductor_resistance_ohms: Math.round(conductorResistanceOhms * 10000) / 10000,
    notes: `Selected ${awgLabel} AWG (${selected.circularMils.toLocaleString()} CM, ${effectiveAmpacity}A rated${isEngineCompartment ? " in engine compartment" : ""}). System: ${systemVoltage}V DC.`,
    abyc_notes: [
      `Calculation based on ${roundTripFeet}ft total circuit path (positive + negative return).`,
      "Wire must be stranded, tinned copper rated for 105°C minimum (UL 1426 / SAE J1127).",
      "Overcurrent protection must be installed within 7 inches of the power source terminal.",
    ],
  };
}

// ---------------------------------------------------------------------------
// Strict ABYC E-11 105 °C DC Wire & Fuse Calculator (Spec Section 5)
// ---------------------------------------------------------------------------

export interface WireCalculationParams {
  system_voltage: 12 | 24 | 48;
  amperage: number;
  one_way_distance_feet: number;
  allowable_drop_percent: 3 | 10;
  is_engine_compartment: boolean;
}

export interface WireCalculationResult {
  recommended_awg: string;
  exact_voltage_drop_volts: number;
  exact_voltage_drop_percent: number;
  recommended_fuse_amps: number;
  fuse_type: string;
  round_trip_feet: number;
  wire_ampacity_amps: number;
  notes: string[];
}

/**
 * Performs deterministic ABYC E-11 compliant DC cable gauge (AWG), voltage drop,
 * and overcurrent fuse sizing using the 105 °C tinned copper specification table.
 */
export function calculateDCWireAndFuse(params: WireCalculationParams): WireCalculationResult {
  if (params.amperage <= 0) throw new Error("amperage must be positive");
  if (params.one_way_distance_feet <= 0) throw new Error("one_way_distance_feet must be positive");

  const roundTripFeet = params.one_way_distance_feet * 2;
  const allowableVDrop = params.system_voltage * (params.allowable_drop_percent / 100);
  const K = 10.75; // Specific resistance of tinned copper at 75 °C

  // 1. Calculate Required Circular Mils
  const requiredCircularMils = (K * params.amperage * roundTripFeet) / allowableVDrop;

  // 2. Filter AWG Table based on BOTH Circular Mils AND Ampacity Safety Limits
  const matchedSpec = ABYC_AWG_TABLE.find((spec) => {
    const meetsDrop = spec.circular_mils >= requiredCircularMils;
    const maxAmpacity = params.is_engine_compartment
      ? spec.ampacity_inside_engine_105c
      : spec.ampacity_outside_engine_105c;
    const meetsAmpacity = maxAmpacity >= params.amperage;
    return meetsDrop && meetsAmpacity;
  });

  if (!matchedSpec) {
    throw new Error("Exceeds 4/0 AWG limits. Consider upgrading system voltage to 24V or 48V.");
  }

  // 3. Exact Calculations
  const loopResistance = (matchedSpec.resistance_per_1000ft_ohms / 1000) * roundTripFeet;
  const actualVDrop = params.amperage * loopResistance;
  const actualPercentDrop = (actualVDrop / params.system_voltage) * 100;

  // 4. Overcurrent Protection Sizing (ABYC: Fuse within 7" of battery positive, capped at wire rating)
  const wireAmpacity = params.is_engine_compartment
    ? matchedSpec.ampacity_inside_engine_105c
    : matchedSpec.ampacity_outside_engine_105c;

  let recommendedFuse = Math.round(params.amperage * 1.25);
  if (recommendedFuse > wireAmpacity) {
    recommendedFuse = wireAmpacity;
  }

  const fuseType = selectFuseFormFactor(recommendedFuse);

  return {
    recommended_awg: matchedSpec.awg,
    exact_voltage_drop_volts: parseFloat(actualVDrop.toFixed(2)),
    exact_voltage_drop_percent: parseFloat(actualPercentDrop.toFixed(2)),
    recommended_fuse_amps: recommendedFuse,
    fuse_type: fuseType,
    round_trip_feet: roundTripFeet,
    wire_ampacity_amps: wireAmpacity,
    notes: [
      `Calculation based on ${roundTripFeet}ft total circuit path (positive + negative return).`,
      "Wire must be stranded, tinned copper rated for 105°C minimum (UL 1426 / SAE J1127).",
      "Overcurrent protection must be installed within 7 inches of the power source terminal.",
    ],
  };
}

/** Standard automotive/marine fuse sizes in Amperes */
const STANDARD_FUSE_SIZES = [5, 7.5, 10, 15, 20, 25, 30, 35, 40, 50, 60, 70, 80, 100, 125, 150, 175, 200, 225, 250, 300, 350, 400, 450, 500];

function roundUpToStandardFuseSize(amps: number): number {
  const found = STANDARD_FUSE_SIZES.find((s) => s >= amps);
  return found ?? STANDARD_FUSE_SIZES[STANDARD_FUSE_SIZES.length - 1]!;
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

// ---------------------------------------------------------------------------
// Deterministic OEM Chassis Mounting, Cutting & Electrical Interface Rules
// ---------------------------------------------------------------------------

export type CanonicalChassis =
  | "ford_transit"
  | "mercedes_sprinter"
  | "ram_promaster"
  | "universal";

export type ShortChassisAlias = "transit" | "sprinter" | "promaster" | "universal";

export type ChassisRuleCategory =
  | "electrical_tap"
  | "roof_load"
  | "structural_cutting"
  | "floor_mounting"
  | "heating_ventilation"
  | "general";

export interface ChassisRuleEvaluationOptions {
  /** Optional proposed dynamic roof load in lbs to validate against OEM rating */
  proposed_roof_load_lbs?: number;
  /** Optional proposed continuous DC alternator/upfitter tap current in Amperes */
  proposed_tap_amps?: number;
}

export interface ChassisRuleResult {
  /** Input chassis string as provided by caller */
  chassis: string;
  /** Canonical chassis key */
  canonical_chassis: CanonicalChassis;
  /** Short chassis alias matching D1/Vectorize metadata tags */
  chassis_alias: ShortChassisAlias;
  /** Input rule_type string as provided by caller */
  rule_type: string;
  /** Matched canonical rule category */
  rule_category: ChassisRuleCategory;
  /** Authoritative OEM guidance summary */
  guidance: string;
  /** Maximum dynamic roof load rating in lbs (when applicable) */
  max_roof_load_lbs: number | null;
  /** Maximum continuous OEM customer connection point / alternator tap rating in Amps */
  max_alternator_tap_amps: number | null;
  /** Designated OEM electrical or structural connection point */
  oem_connection_point: string | null;
  /** Recommended fastener / torque specification */
  fastener_spec: string | null;
  /** Permitted upfitter practices */
  allowed_practices: string[];
  /** Prohibited actions that violate OEM BEMM or safety standards */
  prohibited_practices: string[];
  /** Whether any proposed load/current parameters comply with OEM limits */
  is_compliant: boolean;
  /** Specific compliance warnings when proposed values exceed OEM limits */
  compliance_warnings: string[];
  /** Additional engineering notes and manual references */
  notes: string[];
}

interface ChassisCategorySpec {
  guidance: string;
  maxRoofLoadLbs: number | null;
  maxAlternatorTapAmps: number | null;
  oemConnectionPoint: string | null;
  fastenerSpec: string | null;
  allowedPractices: string[];
  prohibitedPractices: string[];
  notes: string[];
}

const CHASSIS_RULES_DB: Record<CanonicalChassis, Record<Exclude<ChassisRuleCategory, "general">, ChassisCategorySpec>> = {
  ford_transit: {
    electrical_tap: {
      guidance:
        "Use the OEM Customer Connection Points (CCP1/CCP2) on the driver seat pedestal (M8 stud, max 60A continuous per stud, 175A combined pre-fuse). Do not connect house loads directly to the starter battery terminals.",
      maxRoofLoadLbs: null,
      maxAlternatorTapAmps: 60,
      oemConnectionPoint: "Customer Connection Point 2 (CCP2) M8 stud on driver's seat pedestal",
      fastenerSpec: "M8 x 1.25 flanged nut torqued to 12–15 Nm (9–11 lb-ft)",
      allowedPractices: [
        "Connect DC-DC charger input (up to 60A continuous) to CCP2 on the driver seat pedestal.",
        "Use OEM ground studs on the driver seat base or B-pillar lower inner panel.",
        "Install overcurrent fuse within 7 inches of the CCP stud per ABYC E-11.",
      ],
      prohibitedPractices: [
        "Do not attach lugs directly to the starter battery positive clamp or bypass the Battery Monitoring Sensor (BMS) shunt on the negative post.",
        "Do not exceed 60A continuous draw from a single CCP stud without dual-alternator upfitter interface.",
      ],
      notes: [
        "Reference: Ford Transit Body and Equipment Mounting Manual (BEMM) Section 4.18 — Customer Connection Points.",
      ],
    },
    roof_load: {
      guidance:
        "Maximum dynamic roof load is 330 lbs (high/medium roof) or 420 lbs (low roof) evenly distributed across the factory M8 threaded roof rack mounting bosses. Reduce allowable cargo load by the weight of roof AC units, solar panels, and rack hardware.",
      maxRoofLoadLbs: 330,
      maxAlternatorTapAmps: null,
      oemConnectionPoint: "Factory integrated M8 roof rack mounting bosses along cant rail",
      fastenerSpec: "M8 Grade 8.8 stainless bolts with EPDM bonded sealing washers + butyl sealant",
      allowedPractices: [
        "Mount roof racks only to factory M8 roof bosses to transfer load into B/C/D pillar load paths.",
        "Place 14x14 in roof vent cutouts exclusively in flat stamped roof bays between transverse roof bows.",
      ],
      prohibitedPractices: [
        "Never cut or notch primary transverse roof reinforcement bows.",
        "Do not exceed 330 lbs total dynamic roof weight on High Roof models (raises center of gravity and voids ESC calibration).",
      ],
      notes: [
        "Reference: Ford Transit BEMM Section 2.11 — Roof Racks and Load Limits.",
      ],
    },
    structural_cutting: {
      guidance:
        "Never cut, drill, or weld into ultra-high-strength Boron steel structural members (A/B/C/D pillars, rocker inner reinforcements, or roof cant rails). Confine window and vent apertures to single-skin outer body panels between structural ribs.",
      maxRoofLoadLbs: null,
      maxAlternatorTapAmps: null,
      oemConnectionPoint: "Inner sheet-metal secondary ribs (non-structural) for M6/M8 Plusnuts",
      fastenerSpec: "M6 or M8 steel Plusnuts / Rivnuts with zinc-rich anti-corrosion primer on bare metal",
      allowedPractices: [
        "Install M6/M8 Plusnuts in existing factory holes along horizontal wall waist rails and inner ceiling ribs.",
        "Prime all raw drilled/cut sheet metal edges immediately with zinc-rich corrosion protection.",
      ],
      prohibitedPractices: [
        "Never drill into upper roof cant rails where side-curtain airbag inflators and pyrotechnic lines are routed.",
        "Never cut B-pillar or D-pillar vertical structural box sections.",
      ],
      notes: [
        "Check BEMM No-Drill Zone diagrams before drilling within 150 mm of seatbelt anchors or airbag harnesses.",
      ],
    },
    floor_mounting: {
      guidance:
        "Anchor heavy battery banks (>50 lbs), water tanks, and cabinetry using the factory M10 cargo tie-down bosses or through-bolted grade-8 steel backing plates underneath the vehicle floor avoiding frame rails, brake lines, and the fuel tank.",
      maxRoofLoadLbs: null,
      maxAlternatorTapAmps: null,
      oemConnectionPoint: "Factory M10 D-ring cargo tie-down threaded floor bosses",
      fastenerSpec: "M10 x 1.5 Grade 10.9 bolts with minimum 50x50x3 mm underbody steel backing plates",
      allowedPractices: [
        "Use existing M10 floor tie-down bosses for battery restraint frames and heavy appliance anchoring.",
        "Verify underbody clearance past the mid-ship 25-gallon fuel tank and exhaust heat shields before through-bolting.",
      ],
      prohibitedPractices: [
        "Never rely on wood screws into a 1/2 in or 3/4 in plywood subfloor to restrain LiFePO4 battery banks or water tanks.",
        "Do not drill through longitudinal frame box rails or crossmembers.",
      ],
      notes: [
        "Battery enclosures must withstand 20G forward / 10G lateral deceleration forces per RVIA / FMVSS guidelines.",
      ],
    },
    heating_ventilation: {
      guidance:
        "Use the factory auxiliary fuel tap port on top of the fuel tank sender unit for gasoline/diesel air heaters (e.g., Webasto, Espar, Velit). Route exhaust tubing outside the body sill at least 12 inches clear of operable doors, windows, and fresh-air intakes.",
      maxRoofLoadLbs: null,
      maxAlternatorTapAmps: null,
      oemConnectionPoint: "Factory auxiliary fuel pickup port on fuel sender assembly",
      fastenerSpec: "Stainless steel turret flange plate sealed with high-temp RTV silicone + M6 fasteners",
      allowedPractices: [
        "Mount heater turret plate on flat floor pan section under passenger seat pedestal or rear cargo floor.",
        "Maintain at least 6 inches of clearance between heater exhaust pipe and plastic fuel lines or wiring harnesses.",
      ],
      prohibitedPractices: [
        "Never tee into pressurized engine fuel supply or return lines.",
        "Do not terminate heater exhaust beneath the sliding door step or within 12 inches of any window opening.",
      ],
      notes: [
        "Ford Transit auxiliary fuel tap automatically stops drawing fuel at ~1/4 tank to prevent stranding the vehicle.",
      ],
    },
  },
  mercedes_sprinter: {
    electrical_tap: {
      guidance:
        "Use the OEM EK1 terminal strip under the driver's seat (D+ max 10A, Terminal 30 Bat+ max 25A, Terminal 15 Ignition+ max 15A) or the upfitter auxiliary battery stud for higher current DC-DC charging (up to 40A–80A depending on alternator option M40/M60).",
      maxRoofLoadLbs: null,
      maxAlternatorTapAmps: 80,
      oemConnectionPoint: "EK1 Body Builder Terminal Strip under driver's seat & F150/4 upfitter fuse block",
      fastenerSpec: "M6 / M8 terminal studs torqued to Mercedes-Benz BBMD specification (10–14 Nm)",
      allowedPractices: [
        "Use EK1 D+ signal strictly as a low-current trigger (<10A) to enable DC-DC chargers when the engine is running.",
        "Connect high-amp DC-DC chargers to the designated F150 fuse block bus under the driver seat pedestal.",
        "Use the factory M8 ground studs inside the driver seat base.",
      ],
      prohibitedPractices: [
        "Never draw high continuous load (>25A) directly from the EK1 Terminal 30 stud.",
        "Never exceed 40A continuous alternator draw on standard 180A alternators, or 80A on 250A/280A (M60) alternators.",
      ],
      notes: [
        "Reference: Mercedes-Benz Sprinter Body & Equipment Mounting Directives (BBMD) — Electrical System & EK1 Interface.",
      ],
    },
    roof_load: {
      guidance:
        "Maximum dynamic roof load is 330 lbs (150 kg) on High Roof models with OEM C-channel roof rails, or 220 lbs (100 kg) without factory rails. Super-High fiberglass roofs are limited to 110 lbs (50 kg).",
      maxRoofLoadLbs: 330,
      maxAlternatorTapAmps: null,
      oemConnectionPoint: "OEM C-channel roof rails along roof perimeter",
      fastenerSpec: "M8 T-slot stainless steel channel bolts torqued to 18 Nm",
      allowedPractices: [
        "Distribute roof loads evenly across at least 4 crossbars anchored into the OEM C-channel track.",
        "Account for center-of-gravity height restrictions per Mercedes-Benz ESP® stability requirements.",
      ],
      prohibitedPractices: [
        "Never cut or drill through the structural roof bows supporting the high-roof skin.",
        "Do not exceed 330 lbs total dynamic load (including rack, solar panels, awning, and rooftop AC).",
      ],
      notes: [
        "Reference: Mercedes-Benz Sprinter BBMD — Roof Loads and Center of Gravity Limits.",
      ],
    },
    structural_cutting: {
      guidance:
        "Never cut or drill into high-strength boron steel pillars (A, B, C, D pillars), longitudinal frame rails, or roof bows. Use existing factory holes with Plusnuts/Rivnuts where possible.",
      maxRoofLoadLbs: null,
      maxAlternatorTapAmps: null,
      oemConnectionPoint: "Factory pre-punched inner wall flange holes (8.5 mm / 9 mm)",
      fastenerSpec: "M6 Rivnuts / Plusnuts coated with Sikaflex-252 or zinc anti-corrosion primer",
      allowedPractices: [
        "Cut side windows and roof fans only within single-skin sheet metal bays between structural pillars and bows.",
        "Reinforce any roof aperture larger than 400x400 mm with a bonded interior steel or aluminum Doubler frame.",
      ],
      prohibitedPractices: [
        "Never weld or drill into the main longitudinal chassis rails or crossmembers.",
        "Never drill into the B-pillar seatbelt pretensioner zone or upper curtain airbag harness track.",
      ],
      notes: [
        "Check BEMM for exact no-drill zones.",
      ],
    },
    floor_mounting: {
      guidance:
        "Bolt heavy battery systems and water tanks through the floor into OEM M8/M10 D-ring tie-down nut plates or use wide underbody backing plates along approved floor ribs.",
      maxRoofLoadLbs: null,
      maxAlternatorTapAmps: null,
      oemConnectionPoint: "Factory M8/M10 cargo floor lashing ring threaded plates",
      fastenerSpec: "M8 or M10 Grade 10.9 bolts with underbody backing plates and Sikaflex underbody sealant",
      allowedPractices: [
        "Maintain at least 50 mm clearance from the DPF/exhaust system and AdBlue (DEF) tank under the floor.",
        "Balance heavy lithium battery banks and water tanks across left/right sides to stay within axle and wheel-load limits.",
      ],
      prohibitedPractices: [
        "Do not anchor heavy equipment solely to the factory wood/composite cargo floor without steel backing into the sheet metal pan.",
      ],
      notes: [
        "Sprinter VS30 requires left-to-right side weight imbalance to remain within 4% of total axle load.",
      ],
    },
    heating_ventilation: {
      guidance:
        "Use the factory KL1 auxiliary fuel tap connection next to the fuel tank sender for diesel heaters (Espar/Velit). Route exhaust out the driver or passenger rocker sill clear of sliding doors and DEF lines.",
      maxRoofLoadLbs: null,
      maxAlternatorTapAmps: null,
      oemConnectionPoint: "Option KL1 factory auxiliary diesel fuel pickup port",
      fastenerSpec: "Through-floor stainless heater turret mount with high-temp gasket",
      allowedPractices: [
        "Install diesel heater under the front passenger seat box or rear floor pan with unobstructed combustion air intake.",
        "Use high-altitude capable heater controller when operating above 5,000 ft.",
      ],
      prohibitedPractices: [
        "Never splice into the high-pressure common-rail diesel engine fuel lines.",
        "Never route heater exhaust near the AdBlue (DEF) tank or plastic brake lines.",
      ],
      notes: [
        "If the Sprinter lacks factory option KL1, install a dedicated standpipe in the fuel sender flange rather than cutting the tank.",
      ],
    },
  },
  ram_promaster: {
    electrical_tap: {
      guidance:
        "Use the Stellantis Upfitter Connector located behind the right (passenger) B-pillar lower trim or the fused battery distribution terminal on the starter battery box under the cab floor. Limit continuous alternator tap to 50A unless equipped with the heavy-duty 220A alternator.",
      maxRoofLoadLbs: null,
      maxAlternatorTapAmps: 50,
      oemConnectionPoint: "Right B-pillar Upfitter Connector / Under-floor starter battery positive distribution block",
      fastenerSpec: "M8 MIDI fuse holder stud on battery distribution block (12 Nm)",
      allowedPractices: [
        "Tap ignition/D+ wake signal from the passenger B-pillar upfitter connector.",
        "Fuse positive DC-DC charger feed within 7 inches of the under-floor starter battery distribution block.",
      ],
      prohibitedPractices: [
        "Do not exceed 50A continuous DC-DC draw on the standard alternator to prevent stator overheating at idle.",
        "Do not route unprotected positive cables across sharp sheet metal edges of the under-floor battery box.",
      ],
      notes: [
        "Reference: RAM ProMaster Body Builder Guide — Upfitter Electrical Interface.",
      ],
    },
    roof_load: {
      guidance:
        "Maximum dynamic roof load is limited to 150 lbs evenly distributed across the 6 or 8 factory external roof rack mounting pins (mushroom studs), with a maximum of 50 lbs per crossbar.",
      maxRoofLoadLbs: 150,
      maxAlternatorTapAmps: null,
      oemConnectionPoint: "Factory stainless mushroom-head roof rack mounting pins along roof gutter",
      fastenerSpec: "Clamping adapters rated for ProMaster OEM roof pins (max 50 lbs per crossbar)",
      allowedPractices: [
        "Use at least 3 crossbars on 136 WB and 4 crossbars on 159 WB to spread roof loads across factory pins.",
        "Keep rooftop solar and fan installations lightweight to stay within the 150 lbs dynamic ceiling.",
      ],
      prohibitedPractices: [
        "Do not exceed 150 lbs total dynamic roof load without an interior structural roll-cage transfer frame.",
        "Never cut the tubular transverse roof bows.",
      ],
      notes: [
        "Reference: RAM ProMaster Upfitter Guide — Roof Rack Mounting & Load Ratings.",
      ],
    },
    structural_cutting: {
      guidance:
        "Never cut or drill into structural A/B/C/D pillars, lower unibody frame Box sections, or transverse roof bows. Use existing factory holes (e.g., Plusnuts/Rivnuts) in secondary ribs where possible.",
      maxRoofLoadLbs: null,
      maxAlternatorTapAmps: null,
      oemConnectionPoint: "Secondary inner wall ribs and horizontal waist rails",
      fastenerSpec: "M6 or 1/4-20 steel Plusnuts with corrosion inhibitor on bare edges",
      allowedPractices: [
        "Take advantage of the ProMaster's wide flat rear axle spacing and straight vertical walls for interior framing.",
        "Seal all exterior wall/roof penetrations with butyl tape and UV-stable polyurethane sealant.",
      ],
      prohibitedPractices: [
        "Never drill into the cab floor Directly above the fuel tank or front-wheel-drive parking brake cable runs.",
        "Check BEMM for exact no-drill zones.",
      ],
      notes: [
        "Because the ProMaster is front-wheel drive (FWD), there is no rear driveshaft under the cargo floor.",
      ],
    },
    floor_mounting: {
      guidance:
        "Take advantage of the flat unibody cargo floor and absence of a rear driveshaft for under-mount grey water tanks, while bolting heavy interior battery banks to factory M8/M10 D-ring tie-down anchors or underbody steel backing plates.",
      maxRoofLoadLbs: null,
      maxAlternatorTapAmps: null,
      oemConnectionPoint: "Factory cargo floor D-ring tie-down threaded bosses",
      fastenerSpec: "M8 / M10 Grade 10.9 bolts with 50x50x3 mm underbody backing plates",
      allowedPractices: [
        "Check clearance around the rear solid beam axle and parking brake equalizer cables before through-bolting.",
        "Place heavy water and battery loads ahead of or directly over the rear axle to avoid unloading the front drive wheels.",
      ],
      prohibitedPractices: [
        "Avoid excessive rear overhang weight behind the rear axle, which reduces front-wheel-drive traction on grades.",
      ],
      notes: [
        "Maintain at least 48% of total vehicle weight on the front drive axle for safe FWD traction.",
      ],
    },
    heating_ventilation: {
      guidance:
        "Connect gasoline heaters (e.g., Webasto Air Top Evo, Velit Gasoline) to the factory auxiliary fuel tap on top of the fuel pump module under the cab floor access cover.",
      maxRoofLoadLbs: null,
      maxAlternatorTapAmps: null,
      oemConnectionPoint: "Factory auxiliary fuel pickup port accessed via cab floor inspection plate",
      fastenerSpec: "SAE J30R9 fuel injection hose clamps + stainless floor turret flange",
      allowedPractices: [
        "Access the auxiliary fuel port directly through the cab floor service panel between the front seats without dropping the tank.",
        "Route heater exhaust past the body pinch weld at least 12 inches from any window or door seal.",
      ],
      prohibitedPractices: [
        "Never cut into the pressurized engine fuel supply line.",
        "Never install diesel-only heaters into a gasoline ProMaster fuel tank without a dedicated separate diesel reservoir.",
      ],
      notes: [
        "ProMaster gas auxiliary fuel pickup tube terminates above the reserve level so the heater cannot drain the tank dry.",
      ],
    },
  },
  universal: {
    electrical_tap: {
      guidance:
        "Always use OEM-designated customer connection points and an isolated DC-DC charger for house battery charging to protect smart variable-voltage Euro 6 / EPA alternators and factory BMS shunts.",
      maxRoofLoadLbs: null,
      maxAlternatorTapAmps: 50,
      oemConnectionPoint: "OEM Customer Connection Point (CCP / EK1 / Upfitter stud)",
      fastenerSpec: "M8 stud with UL 1426 105°C tinned copper lug and fuse within 7 inches",
      allowedPractices: [
        "Use a current-limiting DC-DC charger rather than a dumb combinator/solenoid on modern smart alternators.",
        "Ground the house DC negative bus to a dedicated OEM chassis ground stud with paint removed to bare metal.",
      ],
      prohibitedPractices: [
        "Never connect house loads directly to the starter battery negative post (bypasses OEM BMS current sensor).",
        "Never leave positive battery feeds unfused within 7 inches of the source terminal.",
      ],
      notes: [
        "Refer to the OEM Body and Equipment Mounting Manual (BEMM) for chassis-specific stud ratings.",
      ],
    },
    roof_load: {
      guidance:
        "Mount roof racks exclusively to factory reinforced cant-rail mounting points. Keep dynamic roof loads within OEM limits (typically 150–330 lbs) and place roof vents between structural transverse bows.",
      maxRoofLoadLbs: 200,
      maxAlternatorTapAmps: null,
      oemConnectionPoint: "Factory roof rack mounting points along roof perimeter",
      fastenerSpec: "M8 stainless bolts with EPDM sealing washers and butyl tape",
      allowedPractices: [
        "Deduct the weight of the roof rack, solar panels, awning, and AC unit from the gross dynamic roof rating.",
        "Use an interior wood or aluminum framing collar around 14x14 in roof fan openings.",
      ],
      prohibitedPractices: [
        "Never cut primary structural roof bows without an OEM-engineered reinforcement frame.",
      ],
      notes: [
        "Refer to the OEM Body and Equipment Mounting Manual (BEMM) for exact roof load and center-of-gravity charts.",
      ],
    },
    structural_cutting: {
      guidance:
        "Never cut or drill into high-strength boron steel pillars (A, B, C, D pillars), roof cant rails, or frame rails. Use existing factory holes with Plusnuts/Rivnuts in secondary sheet-metal ribs.",
      maxRoofLoadLbs: null,
      maxAlternatorTapAmps: null,
      oemConnectionPoint: "Non-structural inner sheet-metal ribs",
      fastenerSpec: "M6/M8 steel Plusnuts / Rivnuts with zinc anti-corrosion primer on bare metal",
      allowedPractices: [
        "Inspect behind walls for curtain airbags, wiring looms, and structural pillars before drilling.",
        "Treat all cut or drilled metal edges with rust-inhibiting primer immediately.",
      ],
      prohibitedPractices: [
        "Never drill into structural pillars, seatbelt anchor zones, or underbody frame rails.",
      ],
      notes: [
        "Check BEMM for exact no-drill zones.",
      ],
    },
    floor_mounting: {
      guidance:
        "Secure heavy battery banks (>50 lbs), water tanks, and seating through the metal floor pan using factory tie-down bosses or Grade 8/10.9 bolts with wide underbody steel backing plates.",
      maxRoofLoadLbs: null,
      maxAlternatorTapAmps: null,
      oemConnectionPoint: "Factory M8/M10 cargo tie-down floor bosses",
      fastenerSpec: "M8/M10 Grade 10.9 bolts with 50x50x3 mm steel underbody backing plates",
      allowedPractices: [
        "Verify underbody clearance for fuel tanks, brake lines, parking brake cables, and exhaust shields before drilling.",
      ],
      prohibitedPractices: [
        "Never secure heavy batteries or tanks with wood screws into plywood subflooring alone.",
      ],
      notes: [
        "Refer to the OEM Body and Equipment Mounting Manual (BEMM) for specific underbody clearance zones.",
      ],
    },
    heating_ventilation: {
      guidance:
        "Tap auxiliary heater fuel from the OEM fuel sender auxiliary port (never pressurized engine lines) and route exhaust past the outer body sill at least 12 inches from operable openings.",
      maxRoofLoadLbs: null,
      maxAlternatorTapAmps: null,
      oemConnectionPoint: "OEM fuel tank sender auxiliary pickup port",
      fastenerSpec: "Stainless steel floor turret plate with high-temperature gasket",
      allowedPractices: [
        "Install a CO detector and smoke alarm inside the living space whenever a fuel-burning heater is installed.",
      ],
      prohibitedPractices: [
        "Never tee into pressurized engine fuel lines or terminate exhaust underneath the vehicle floor without exiting past the body skirt.",
      ],
      notes: [
        "Refer to the OEM Body and Equipment Mounting Manual (BEMM) for fuel tap instructions.",
      ],
    },
  },
};

/**
 * Normalizes a chassis identifier (e.g., "transit", "ford_transit", "Mercedes Sprinter")
 * into one of the four canonical chassis keys.
 */
export function normalizeChassisId(chassis: string): {
  canonical: CanonicalChassis;
  alias: ShortChassisAlias;
} {
  const c = chassis.toLowerCase().trim();
  if (c.includes("transit") || c.includes("ford")) {
    return { canonical: "ford_transit", alias: "transit" };
  }
  if (c.includes("sprinter") || c.includes("mercedes")) {
    return { canonical: "mercedes_sprinter", alias: "sprinter" };
  }
  if (c.includes("promaster") || c.includes("ram")) {
    return { canonical: "ram_promaster", alias: "promaster" };
  }
  return { canonical: "universal", alias: "universal" };
}

/**
 * Normalizes a free-form rule_type string into a canonical ChassisRuleCategory.
 */
export function normalizeRuleCategory(ruleType: string): ChassisRuleCategory {
  const r = ruleType.toLowerCase().trim();
  if (
    r.includes("roof") ||
    r.includes("rack") ||
    r.includes("load") ||
    r.includes("solar_mount")
  ) {
    return "roof_load";
  }
  if (
    r.includes("electr") ||
    r.includes("ground") ||
    r.includes("alternator") ||
    r.includes("battery") ||
    r.includes("12v") ||
    r.includes("48v") ||
    r.includes("ccp") ||
    r.includes("ek1") ||
    r.includes("tap")
  ) {
    return "electrical_tap";
  }
  if (
    r.includes("cut") ||
    r.includes("drill") ||
    r.includes("pillar") ||
    r.includes("structural") ||
    r.includes("window") ||
    r.includes("wall")
  ) {
    return "structural_cutting";
  }
  if (
    r.includes("floor") ||
    r.includes("tie") ||
    r.includes("mount") ||
    r.includes("anchor") ||
    r.includes("seat") ||
    r.includes("tank")
  ) {
    return "floor_mounting";
  }
  if (
    r.includes("heat") ||
    r.includes("vent") ||
    r.includes("exhaust") ||
    r.includes("fuel") ||
    r.includes("plumb")
  ) {
    return "heating_ventilation";
  }
  return "general";
}

/**
 * Evaluates deterministic mounting, structural cutting, and electrical interface rules
 * for a given van chassis and rule category, with optional numeric compliance checks.
 */
export function evaluateChassisRules(
  chassis: string,
  ruleType: string,
  options: ChassisRuleEvaluationOptions = {}
): ChassisRuleResult {
  const { canonical, alias } = normalizeChassisId(chassis);
  const category = normalizeRuleCategory(ruleType);

  if (category === "general") {
    return {
      chassis,
      canonical_chassis: canonical,
      chassis_alias: alias,
      rule_type: ruleType,
      rule_category: "general",
      guidance:
        "Refer to the OEM Body and Equipment Mounting Manual (BEMM) for specific guidance. Supported deterministic categories: electrical_tap, roof_load, structural_cutting, floor_mounting, heating_ventilation.",
      max_roof_load_lbs: CHASSIS_RULES_DB[canonical].roof_load.maxRoofLoadLbs,
      max_alternator_tap_amps: CHASSIS_RULES_DB[canonical].electrical_tap.maxAlternatorTapAmps,
      oem_connection_point: CHASSIS_RULES_DB[canonical].electrical_tap.oemConnectionPoint,
      fastener_spec: null,
      allowed_practices: [
        ...CHASSIS_RULES_DB[canonical].electrical_tap.allowedPractices.slice(0, 1),
        ...CHASSIS_RULES_DB[canonical].structural_cutting.allowedPractices.slice(0, 1),
      ],
      prohibited_practices: [
        ...CHASSIS_RULES_DB[canonical].structural_cutting.prohibitedPractices.slice(0, 1),
      ],
      is_compliant: true,
      compliance_warnings: [],
      notes: [
        "Specify rule_type as 'electrical_tap', 'roof_load', 'structural_cutting', 'floor_mounting', or 'heating_ventilation' for targeted OEM specifications.",
      ],
    };
  }

  const spec = CHASSIS_RULES_DB[canonical][category];
  const complianceWarnings: string[] = [];

  if (
    options.proposed_roof_load_lbs !== undefined &&
    spec.maxRoofLoadLbs !== null &&
    options.proposed_roof_load_lbs > spec.maxRoofLoadLbs
  ) {
    complianceWarnings.push(
      `NON-COMPLIANT: Proposed roof load of ${options.proposed_roof_load_lbs} lbs exceeds the ${canonical} OEM dynamic roof limit of ${spec.maxRoofLoadLbs} lbs by ${options.proposed_roof_load_lbs - spec.maxRoofLoadLbs} lbs.`
    );
  }

  if (
    options.proposed_tap_amps !== undefined &&
    spec.maxAlternatorTapAmps !== null &&
    options.proposed_tap_amps > spec.maxAlternatorTapAmps
  ) {
    complianceWarnings.push(
      `NON-COMPLIANT: Proposed continuous tap of ${options.proposed_tap_amps}A exceeds the ${canonical} OEM connection point rating of ${spec.maxAlternatorTapAmps}A.`
    );
  }

  return {
    chassis,
    canonical_chassis: canonical,
    chassis_alias: alias,
    rule_type: ruleType,
    rule_category: category,
    guidance: spec.guidance,
    max_roof_load_lbs: spec.maxRoofLoadLbs,
    max_alternator_tap_amps: spec.maxAlternatorTapAmps,
    oem_connection_point: spec.oemConnectionPoint,
    fastener_spec: spec.fastenerSpec,
    allowed_practices: [...spec.allowedPractices],
    prohibited_practices: [...spec.prohibitedPractices],
    is_compliant: complianceWarnings.length === 0,
    compliance_warnings: complianceWarnings,
    notes: [...spec.notes],
  };
}
