/**
 * ABYC E-11 Compliant DC Wire Gauge and Overcurrent Protection (Fuse) Calculator
 * Implements deterministic electrical calculations and returns mandatory safety invariants
 * and negative constraints to prevent LLM hallucinations.
 */

export interface WireCalculationParams {
  system_voltage: 12 | 24 | 48;
  amperage: number;
  one_way_distance_feet: number;
  allowable_drop_percent: 3 | 10;
  is_engine_compartment?: boolean;
}

export interface WireCalculationResult {
  recommended_awg: string;
  recommended_fuse_amps: number;
  exact_voltage_drop_volts: number;
  exact_voltage_drop_percent: number;
  fuse_type: string;
  wire_ampacity_amps: number;
  round_trip_feet: number;
  safety_invariants: {
    fuse_placement: string;
    prohibited_practices: string[];
    upsize_path: string;
  };
  installation_notes: string[];
}

export interface AWGSpec {
  awg: string;
  circular_mils: number;
  resistance_per_1000ft_ohms: number;
  ampacity_outside_engine_105c: number;
  ampacity_inside_engine_105c: number;
}

export const ABYC_AWG_TABLE: AWGSpec[] = [
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
 * Deterministically computes DC wire gauge (AWG), fuse ampacity, and voltage drop per ABYC E-11.
 * Emits mandatory safety invariants and negative constraints to protect LLMs from hallucinating
 * hazardous electrical recommendations.
 */
export function calculateDcWireAndFuse(params: WireCalculationParams): WireCalculationResult {
  const round_trip_feet = params.one_way_distance_feet * 2;
  const allowable_v_drop = params.system_voltage * (params.allowable_drop_percent / 100);
  const K = 10.75; // Specific resistance of tinned copper at 75°C per ABYC E-11

  // 1. Calculate Minimum Required Circular Mils
  const required_circular_mils = (K * params.amperage * round_trip_feet) / allowable_v_drop;

  // 2. Match wire gauge meeting BOTH Circular Mils and Ampacity derating
  const isEngine = Boolean(params.is_engine_compartment);
  const matched_spec = ABYC_AWG_TABLE.find((spec) => {
    const meets_drop = spec.circular_mils >= required_circular_mils;
    const max_ampacity = isEngine
      ? spec.ampacity_inside_engine_105c
      : spec.ampacity_outside_engine_105c;
    const meets_ampacity = max_ampacity >= params.amperage;
    return meets_drop && meets_ampacity;
  });

  if (!matched_spec) {
    throw new Error(
      `Exceeds 4/0 AWG limits for continuous load of ${params.amperage}A over ${round_trip_feet}ft round trip. Upgrade system voltage to 24V or 48V to reduce amperage.`
    );
  }

  // 3. Exact electrical computations
  const loop_resistance = (matched_spec.resistance_per_1000ft_ohms / 1000) * round_trip_feet;
  const actual_v_drop = params.amperage * loop_resistance;
  const actual_percent_drop = (actual_v_drop / params.system_voltage) * 100;

  const wire_ampacity = isEngine
    ? matched_spec.ampacity_inside_engine_105c
    : matched_spec.ampacity_outside_engine_105c;

  // 4. Overcurrent Protection Sizing:
  // Recommended fuse is 125% of load per ABYC, capped by wire ampacity rating
  let recommended_fuse = Math.round(params.amperage * 1.25);
  if (recommended_fuse > wire_ampacity) {
    recommended_fuse = wire_ampacity;
  }

  // Select appropriate fuse form factor based on amperage & AIC ratings
  let fuse_type = "ATC/ATO Blade";
  if (recommended_fuse > 30 && recommended_fuse <= 100) {
    fuse_type = "MIDI / AMI Fuse";
  } else if (recommended_fuse > 100 && recommended_fuse <= 300) {
    fuse_type = "MRBF (Marine Rated Battery Fuse) or MEGA";
  } else if (recommended_fuse > 300) {
    fuse_type = "Class T Fuse (Essential for LiFePO4 high AIC ratings)";
  }

  // Determine appropriate upsize path based on recommended AWG
  let upsize_path = "For heavy inductive or continuous surge loads, upsize to 1/0 AWG with a 250A fuse.";
  if (matched_spec.awg === "1/0" || matched_spec.awg === "2/0") {
    upsize_path = "For heavy inductive or continuous surge loads, upsize to 4/0 AWG with a 350A Class T fuse.";
  } else if (matched_spec.awg === "4/0") {
    upsize_path = "Already at maximum 4/0 AWG single-conductor rating. Upgrade to parallel runs or 24V/48V system topology for higher inductive loads.";
  } else if (matched_spec.awg === "2" || matched_spec.awg === "4" || matched_spec.awg === "6") {
    upsize_path = "For heavy inductive or continuous surge loads, upsize to 1/0 AWG with a 250A fuse.";
  }

  return {
    recommended_awg: matched_spec.awg,
    recommended_fuse_amps: recommended_fuse,
    exact_voltage_drop_volts: parseFloat(actual_v_drop.toFixed(2)),
    exact_voltage_drop_percent: parseFloat(actual_percent_drop.toFixed(2)),
    fuse_type,
    wire_ampacity_amps: wire_ampacity,
    round_trip_feet,
    safety_invariants: {
      fuse_placement:
        "CRITICAL SAFETY: Overcurrent protection (fuse) MUST be installed at the POWER SOURCE (battery positive terminal) within 7 inches (ABYC E-11). NEVER install primary overcurrent protection at the load/inverter end.",
      prohibited_practices: [
        "DO NOT install the primary circuit fuse at the inverter terminal. This leaves the entire positive run unprotected against dead-short chassis fires.",
        "DO NOT treat higher AWG numbers (e.g., 4 AWG) as 'upsizes' from lower numbers (e.g., 2 AWG). AWG is an inverse gauge: 1/0, 2/0, and 4/0 are larger; 4, 6, and 8 are smaller and create an undersized fire hazard.",
        'DO NOT recommend 15–20 ft-lbs torque on DC terminal studs. Standard M8 / 5/16" battery and inverter terminal studs strip or shear above 8–10 N·m (6–7.5 ft-lbs).'
      ],
      upsize_path
    },
    installation_notes: [
      `Calculation based on ${round_trip_feet}ft total circuit path (positive run + negative return).`,
      "Wire must be stranded, tinned copper rated for 105°C minimum (UL 1426 / SAE J1127).",
      "Overcurrent protection must be installed within 7 inches of the power source terminal.",
      "Terminal lugs should be closed-end tinned copper with dual-wall adhesive-lined heat shrink."
    ]
  };
}

// Alias for backwards compatibility with PascalCase naming convention
export const calculateDCWireAndFuse = calculateDcWireAndFuse;
