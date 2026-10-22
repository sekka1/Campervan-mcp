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

  const largestSpec = AWG_TABLE[0]!;
  const maxAvailableAmpacity = isEngineCompartment
    ? largestSpec.engineCompartmentMaxAmps
    : largestSpec.maxAmps;
  if (currentAmps > maxAvailableAmpacity) {
    throw new Error(
      `Current ${currentAmps}A exceeds maximum 4/0 AWG ampacity limit (${maxAvailableAmpacity}A${isEngineCompartment ? " in engine compartment" : ""}). Consider parallel conductors or upgrading system voltage to 24V/48V.`
    );
  }

  // Fall back to largest gauge in table only when ampacity is safe but long wire run exceeds target voltage drop
  const selected = candidate ?? largestSpec;
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

  // Helper: pick a standard commercial fuse that is > amperage (preferably >= 125% load) and <= wireAmpacity
  const pickStandardFuse = (maxWireAmpacity: number): number | undefined => {
    const target125 = roundUpToStandardFuseSize(params.amperage * 1.25);
    if (target125 <= maxWireAmpacity) {
      return target125;
    }
    const validFuses = STANDARD_FUSE_SIZES.filter(
      (f) => f >= params.amperage && f <= maxWireAmpacity
    );
    return validFuses.length > 0 ? validFuses[validFuses.length - 1] : undefined;
  };

  // 2. Filter AWG Table based on Circular Mils, Ampacity, AND availability of a valid standard fuse <= wire ampacity
  const matchedSpec = ABYC_AWG_TABLE.find((spec) => {
    const meetsDrop = spec.circular_mils >= requiredCircularMils;
    const maxAmpacity = params.is_engine_compartment
      ? spec.ampacity_inside_engine_105c
      : spec.ampacity_outside_engine_105c;
    const meetsAmpacity = maxAmpacity >= params.amperage;
    const hasValidStandardFuse = pickStandardFuse(maxAmpacity) !== undefined;
    return meetsDrop && meetsAmpacity && hasValidStandardFuse;
  });

  if (!matchedSpec) {
    throw new Error("Exceeds 4/0 AWG limits. Consider upgrading system voltage to 24V or 48V.");
  }

  // 3. Exact Calculations
  const loopResistance = (matchedSpec.resistance_per_1000ft_ohms / 1000) * roundTripFeet;
  const actualVDrop = params.amperage * loopResistance;
  const actualPercentDrop = (actualVDrop / params.system_voltage) * 100;

  // 4. Overcurrent Protection Sizing (ABYC: standard fuse rating >= load and <= wire ampacity)
  const wireAmpacity = params.is_engine_compartment
    ? matchedSpec.ampacity_inside_engine_105c
    : matchedSpec.ampacity_outside_engine_105c;

  const recommendedFuse = pickStandardFuse(wireAmpacity)!;

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
