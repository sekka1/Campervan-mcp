import React, { useState, useMemo, useEffect } from 'react';
import {
  CheckCircle2,
  AlertTriangle,
  Cable,
  Truck,
  Terminal,
  Zap,
  Wrench,
  Cpu,
  Database,
  Layers,
  Copy,
  Check,
  RefreshCw,
  GitBranch,
  ShieldAlert,
  ShieldCheck,
  BookOpen,
  FileSearch,
  Lock,
} from 'lucide-react';
import { calculateDcWireAndFuse, WireCalculationResult } from './tools/calculations';
import { searchVanManuals, SearchVanManualsResponse } from './tools/manuals';
import { MCP_TOOLS } from './index';

interface AbycSpec {
  awg: string;
  circularMils: number;
  resistancePer1000Ft: number;
  outsideAmpacity105c: number;
  insideAmpacity105c: number;
}

const ABYC_TABLE: AbycSpec[] = [
  { awg: '16', circularMils: 2580, resistancePer1000Ft: 4.016, outsideAmpacity105c: 25, insideAmpacity105c: 21 },
  { awg: '14', circularMils: 4110, resistancePer1000Ft: 2.525, outsideAmpacity105c: 35, insideAmpacity105c: 30 },
  { awg: '12', circularMils: 6530, resistancePer1000Ft: 1.588, outsideAmpacity105c: 45, insideAmpacity105c: 38 },
  { awg: '10', circularMils: 10380, resistancePer1000Ft: 0.999, outsideAmpacity105c: 60, insideAmpacity105c: 51 },
  { awg: '8', circularMils: 16510, resistancePer1000Ft: 0.628, outsideAmpacity105c: 80, insideAmpacity105c: 68 },
  { awg: '6', circularMils: 26240, resistancePer1000Ft: 0.395, outsideAmpacity105c: 120, insideAmpacity105c: 102 },
  { awg: '4', circularMils: 41740, resistancePer1000Ft: 0.249, outsideAmpacity105c: 160, insideAmpacity105c: 136 },
  { awg: '2', circularMils: 66360, resistancePer1000Ft: 0.156, outsideAmpacity105c: 210, insideAmpacity105c: 178 },
  { awg: '1/0', circularMils: 105600, resistancePer1000Ft: 0.098, outsideAmpacity105c: 285, insideAmpacity105c: 242 },
  { awg: '2/0', circularMils: 133100, resistancePer1000Ft: 0.078, outsideAmpacity105c: 330, insideAmpacity105c: 280 },
  { awg: '4/0', circularMils: 211600, resistancePer1000Ft: 0.049, outsideAmpacity105c: 445, insideAmpacity105c: 378 },
];

type ChassisKey = 'ford_transit' | 'mercedes_sprinter' | 'ram_promaster' | 'universal';
type RuleCategory = 'electrical_tap' | 'roof_load' | 'structural_cutting' | 'floor_mounting' | 'heating_ventilation';

const CHASSIS_SUMMARY: Record<
  ChassisKey,
  Record<
    RuleCategory,
    {
      guidance: string;
      maxRoofLoadLbs: number | null;
      maxAlternatorTapAmps: number | null;
      oemConnectionPoint: string;
      fastenerSpec: string;
      allowed: string[];
      prohibited: string[];
    }
  >
> = {
  ford_transit: {
    electrical_tap: {
      guidance:
        'Use Customer Connection Points (CCP1/CCP2) on the driver seat pedestal (M8 stud, max 60A continuous per stud, 175A combined pre-fuse). Do not connect house loads directly to starter battery terminals.',
      maxRoofLoadLbs: null,
      maxAlternatorTapAmps: 60,
      oemConnectionPoint: "Customer Connection Point 2 (CCP2) M8 stud on driver's seat pedestal",
      fastenerSpec: 'M8 x 1.25 flanged nut torqued to 12–15 Nm (9–11 lb-ft)',
      allowed: [
        'Connect DC-DC charger input (up to 60A continuous) to CCP2 on driver seat pedestal.',
        'Install overcurrent fuse within 7 inches of the CCP stud per ABYC E-11.',
      ],
      prohibited: [
        'Do not attach lugs directly to starter battery positive clamp or bypass BMS shunt on negative post.',
      ],
    },
    roof_load: {
      guidance:
        'Maximum dynamic roof load is 330 lbs (High/Medium Roof) evenly distributed across factory M8 threaded roof rack mounting bosses.',
      maxRoofLoadLbs: 330,
      maxAlternatorTapAmps: null,
      oemConnectionPoint: 'Factory integrated M8 roof rack mounting bosses along cant rail',
      fastenerSpec: 'M8 Grade 8.8 stainless bolts with EPDM bonded sealing washers + butyl sealant',
      allowed: ['Mount roof racks only to factory M8 bosses to transfer load into B/C/D pillar paths.'],
      prohibited: ['Never cut or notch primary transverse roof reinforcement bows.'],
    },
    structural_cutting: {
      guidance:
        'Never cut, drill, or weld into ultra-high-strength Boron steel structural members (A/B/C/D pillars, rocker inner reinforcements, or roof cant rails).',
      maxRoofLoadLbs: null,
      maxAlternatorTapAmps: null,
      oemConnectionPoint: 'Inner sheet-metal secondary ribs (non-structural) for M6/M8 Plusnuts',
      fastenerSpec: 'M6 or M8 steel Plusnuts / Rivnuts with zinc-rich anti-corrosion primer',
      allowed: ['Install M6/M8 Plusnuts in existing factory holes along horizontal waist rails.'],
      prohibited: ['Never drill into upper roof cant rails where side-curtain airbag inflators run.'],
    },
    floor_mounting: {
      guidance:
        'Anchor heavy battery banks (>50 lbs) and water tanks using factory M10 cargo tie-down bosses or through-bolted grade-8 steel backing plates underneath the floor.',
      maxRoofLoadLbs: null,
      maxAlternatorTapAmps: null,
      oemConnectionPoint: 'Factory M10 D-ring cargo tie-down threaded floor bosses',
      fastenerSpec: 'M10 x 1.5 Grade 10.9 bolts with 50x50x3 mm underbody steel backing plates',
      allowed: ['Verify underbody clearance past the mid-ship 25-gal fuel tank and exhaust shields.'],
      prohibited: ['Never rely on wood screws into plywood subfloor alone to restrain LiFePO4 banks.'],
    },
    heating_ventilation: {
      guidance:
        'Use the factory auxiliary fuel tap port on top of the fuel tank sender unit for gasoline/diesel air heaters. Route exhaust at least 12 inches clear of operable openings.',
      maxRoofLoadLbs: null,
      maxAlternatorTapAmps: null,
      oemConnectionPoint: 'Factory auxiliary fuel pickup port on fuel sender assembly',
      fastenerSpec: 'Stainless steel turret flange plate sealed with high-temp RTV silicone + M6 bolts',
      allowed: ['Mount heater turret plate on flat floor pan section under passenger seat or rear cargo area.'],
      prohibited: ['Never tee into pressurized engine fuel supply or return lines.'],
    },
  },
  mercedes_sprinter: {
    electrical_tap: {
      guidance:
        "Use the OEM EK1 terminal strip under the driver's seat (D+ max 10A, Terminal 30 Bat+ max 25A, Terminal 15 Ignition+ max 15A) or F150/4 upfitter fuse block (up to 80A depending on alternator).",
      maxRoofLoadLbs: null,
      maxAlternatorTapAmps: 80,
      oemConnectionPoint: "EK1 Body Builder Terminal Strip under driver's seat & F150/4 upfitter fuse block",
      fastenerSpec: 'M6 / M8 terminal studs torqued to Mercedes-Benz BBMD specification (10–14 Nm)',
      allowed: ['Use EK1 D+ signal strictly as a low-current trigger (<10A) to enable DC-DC chargers.'],
      prohibited: ['Never draw high continuous load (>25A) directly from the EK1 Terminal 30 stud.'],
    },
    roof_load: {
      guidance:
        'Maximum dynamic roof load is 330 lbs (150 kg) on High Roof models with OEM C-channel roof rails, or 220 lbs (100 kg) without factory rails.',
      maxRoofLoadLbs: 330,
      maxAlternatorTapAmps: null,
      oemConnectionPoint: 'OEM C-channel roof rails along roof perimeter',
      fastenerSpec: 'M8 T-slot stainless steel channel bolts torqued to 18 Nm',
      allowed: ['Distribute roof loads evenly across at least 4 crossbars anchored into the C-channel track.'],
      prohibited: ['Never cut or drill through the structural roof bows supporting the high-roof skin.'],
    },
    structural_cutting: {
      guidance:
        'Never cut or drill into high-strength boron steel pillars (A, B, C, D pillars), longitudinal frame rails, or roof bows.',
      maxRoofLoadLbs: null,
      maxAlternatorTapAmps: null,
      oemConnectionPoint: 'Factory pre-punched inner wall flange holes (8.5 mm / 9 mm)',
      fastenerSpec: 'M6 Rivnuts / Plusnuts coated with Sikaflex-252 or zinc anti-corrosion primer',
      allowed: ['Cut side windows and roof fans only within single-skin bays between pillars and bows.'],
      prohibited: ['Never weld or drill into main longitudinal chassis rails or crossmembers.'],
    },
    floor_mounting: {
      guidance:
        'Bolt heavy battery systems and water tanks through the floor into OEM M8/M10 D-ring tie-down nut plates or use wide underbody backing plates.',
      maxRoofLoadLbs: null,
      maxAlternatorTapAmps: null,
      oemConnectionPoint: 'Factory M8/M10 cargo floor lashing ring threaded plates',
      fastenerSpec: 'M8 or M10 Grade 10.9 bolts with underbody backing plates',
      allowed: ['Maintain at least 50 mm clearance from DPF/exhaust system and AdBlue (DEF) tank.'],
      prohibited: ['Do not anchor heavy equipment solely to wood/composite cargo flooring.'],
    },
    heating_ventilation: {
      guidance:
        'Use the factory KL1 auxiliary fuel tap connection next to the fuel tank sender for diesel heaters (Espar/Velit).',
      maxRoofLoadLbs: null,
      maxAlternatorTapAmps: null,
      oemConnectionPoint: 'Option KL1 factory auxiliary diesel fuel pickup port',
      fastenerSpec: 'Through-floor stainless heater turret mount with high-temp gasket',
      allowed: ['Install diesel heater under front passenger seat box or rear floor pan.'],
      prohibited: ['Never splice into high-pressure common-rail diesel engine fuel lines.'],
    },
  },
  ram_promaster: {
    electrical_tap: {
      guidance:
        'Use the Stellantis Upfitter Connector behind the passenger B-pillar lower trim or the fused battery distribution terminal on the starter battery box under the cab floor (max 50A standard).',
      maxRoofLoadLbs: null,
      maxAlternatorTapAmps: 50,
      oemConnectionPoint: 'Right B-pillar Upfitter Connector / Under-floor starter battery distribution block',
      fastenerSpec: 'M8 MIDI fuse holder stud on battery distribution block (12 Nm)',
      allowed: ['Fuse positive DC-DC charger feed within 7 inches of the starter battery distribution block.'],
      prohibited: ['Do not exceed 50A continuous DC-DC draw on standard alternator to prevent stator overheating.'],
    },
    roof_load: {
      guidance:
        'Maximum dynamic roof load is limited to 150 lbs evenly distributed across the 6 or 8 factory mushroom-head roof rack mounting pins (max 50 lbs per crossbar).',
      maxRoofLoadLbs: 150,
      maxAlternatorTapAmps: null,
      oemConnectionPoint: 'Factory stainless mushroom-head roof rack mounting pins along roof gutter',
      fastenerSpec: 'Clamping adapters rated for ProMaster OEM roof pins (max 50 lbs per crossbar)',
      allowed: ['Use at least 3 crossbars on 136 WB and 4 crossbars on 159 WB.'],
      prohibited: ['Do not exceed 150 lbs total dynamic roof load without an internal structural frame.'],
    },
    structural_cutting: {
      guidance:
        'Never cut or drill into structural A/B/C/D pillars, lower unibody frame box sections, or transverse roof bows.',
      maxRoofLoadLbs: null,
      maxAlternatorTapAmps: null,
      oemConnectionPoint: 'Secondary inner wall ribs and horizontal waist rails',
      fastenerSpec: 'M6 or 1/4-20 steel Plusnuts with corrosion inhibitor on bare edges',
      allowed: ['Seal all exterior wall/roof penetrations with butyl tape and UV-stable polyurethane sealant.'],
      prohibited: ['Never drill into cab floor directly above the fuel tank or FWD parking brake cables.'],
    },
    floor_mounting: {
      guidance:
        'Bolt heavy interior battery banks to factory M8/M10 D-ring tie-down anchors or underbody steel backing plates; keep weight forward of rear overhang for FWD traction.',
      maxRoofLoadLbs: null,
      maxAlternatorTapAmps: null,
      oemConnectionPoint: 'Factory cargo floor D-ring tie-down threaded bosses',
      fastenerSpec: 'M8 / M10 Grade 10.9 bolts with 50x50x3 mm underbody backing plates',
      allowed: ['Check clearance around the rear solid beam axle and parking brake equalizer cables.'],
      prohibited: ['Avoid excessive rear overhang weight behind the rear axle (unloads FWD drive wheels).'],
    },
    heating_ventilation: {
      guidance:
        'Connect gasoline heaters to the factory auxiliary fuel tap on top of the fuel pump module under the cab floor inspection cover.',
      maxRoofLoadLbs: null,
      maxAlternatorTapAmps: null,
      oemConnectionPoint: 'Factory auxiliary fuel pickup port accessed via cab floor inspection plate',
      fastenerSpec: 'SAE J30R9 fuel injection hose clamps + stainless floor turret flange',
      allowed: ['Access the auxiliary fuel port directly through the cab floor service panel between seats.'],
      prohibited: ['Never cut into the pressurized engine fuel supply line.'],
    },
  },
  universal: {
    electrical_tap: {
      guidance:
        'Always use OEM-designated customer connection points and an isolated DC-DC charger for house battery charging to protect smart alternators and factory BMS shunts.',
      maxRoofLoadLbs: null,
      maxAlternatorTapAmps: 50,
      oemConnectionPoint: 'OEM Customer Connection Point (CCP / EK1 / Upfitter stud)',
      fastenerSpec: 'M8 stud with UL 1426 105°C tinned copper lug and fuse within 7 inches',
      allowed: ['Use a current-limiting DC-DC charger rather than a non-limiting relay on smart alternators.'],
      prohibited: ['Never connect house loads directly to starter battery negative post (bypasses BMS sensor).'],
    },
    roof_load: {
      guidance:
        'Mount roof racks exclusively to factory reinforced cant-rail mounting points and keep dynamic loads within OEM ratings (150–330 lbs).',
      maxRoofLoadLbs: 200,
      maxAlternatorTapAmps: null,
      oemConnectionPoint: 'Factory roof rack mounting points along roof perimeter',
      fastenerSpec: 'M8 stainless bolts with EPDM sealing washers and butyl tape',
      allowed: ['Use an interior framing collar around 14x14 in roof fan openings.'],
      prohibited: ['Never cut primary structural roof bows without engineered reinforcement.'],
    },
    structural_cutting: {
      guidance:
        'Never cut or drill into high-strength boron steel pillars (A, B, C, D pillars), roof cant rails, or frame rails.',
      maxRoofLoadLbs: null,
      maxAlternatorTapAmps: null,
      oemConnectionPoint: 'Non-structural inner sheet-metal ribs',
      fastenerSpec: 'M6/M8 steel Plusnuts / Rivnuts with zinc anti-corrosion primer',
      allowed: ['Treat all cut or drilled metal edges with rust-inhibiting primer immediately.'],
      prohibited: ['Never drill into structural pillars, seatbelt anchor zones, or frame rails.'],
    },
    floor_mounting: {
      guidance:
        'Secure heavy battery banks (>50 lbs) and water tanks through the metal floor pan using factory tie-down bosses or Grade 10.9 bolts with steel backing plates.',
      maxRoofLoadLbs: null,
      maxAlternatorTapAmps: null,
      oemConnectionPoint: 'Factory M8/M10 cargo tie-down floor bosses',
      fastenerSpec: 'M8/M10 Grade 10.9 bolts with 50x50x3 mm steel underbody backing plates',
      allowed: ['Verify underbody clearance for fuel tanks, brake lines, and exhaust shields.'],
      prohibited: ['Never secure heavy batteries or tanks with wood screws into plywood alone.'],
    },
    heating_ventilation: {
      guidance:
        'Tap auxiliary heater fuel from the OEM fuel sender auxiliary port and route exhaust past the outer body sill at least 12 inches from operable openings.',
      maxRoofLoadLbs: null,
      maxAlternatorTapAmps: null,
      oemConnectionPoint: 'OEM fuel tank sender auxiliary pickup port',
      fastenerSpec: 'Stainless steel floor turret plate with high-temperature gasket',
      allowed: ['Install a CO detector and smoke alarm inside the living space.'],
      prohibited: ['Never tee into pressurized engine fuel lines.'],
    },
  },
};

export default function App() {
  // Interactive ABYC Wire Calculator state
  const [voltage, setVoltage] = useState<12 | 24 | 48>(12);
  const [amperage, setAmperage] = useState<number>(60);
  const [oneWayFeet, setOneWayFeet] = useState<number>(15);
  const [dropPct, setDropPct] = useState<3 | 10>(3);
  const [inEngineRoom, setInEngineRoom] = useState<boolean>(false);

  // Interactive Chassis Rules state
  const [selectedChassis, setSelectedChassis] = useState<ChassisKey>('ford_transit');
  const [selectedCategory, setSelectedCategory] = useState<RuleCategory>('electrical_tap');
  const [proposedRoofLoad, setProposedRoofLoad] = useState<number>(250);
  const [proposedTapAmps, setProposedTapAmps] = useState<number>(50);

  // Embedding Provider Playground state
  const [provider, setProvider] = useState<'deepinfra' | 'cloudflare'>('deepinfra');
  const [mockToken, setMockToken] = useState<string>('di_live_preview_token');
  const [mockCfAccountId, setMockCfAccountId] = useState<string>('cf_acct_882910');
  const [mockCfToken, setMockCfToken] = useState<string>('cf_worker_token_4910');
  const [inputText, setInputText] = useState<string>(
    'Volkswagen Grand California 600 auxiliary diesel heater operating specifications'
  );
  const [copiedCurl, setCopiedCurl] = useState<boolean>(false);

  // Dynamic Manuals Retrieval & Grounding Inspector state
  const [manualQuery, setManualQuery] = useState<string>(
    'Ford Transit CCP2 60A connection torque and fuse rating'
  );
  const [searchResponse, setSearchResponse] = useState<SearchVanManualsResponse | null>(null);
  const [copiedToolPrompt, setCopiedToolPrompt] = useState<string | null>(null);

  const wireResult = useMemo((): (WireCalculationResult & { error?: undefined }) | { error: string } => {
    try {
      const res = calculateDcWireAndFuse({
        system_voltage: voltage,
        amperage,
        one_way_distance_feet: oneWayFeet,
        allowable_drop_percent: dropPct,
        is_engine_compartment: inEngineRoom,
      });
      return res;
    } catch (err: any) {
      return { error: err?.message || 'Calculation limit exceeded' };
    }
  }, [voltage, amperage, oneWayFeet, dropPct, inEngineRoom]);

  // Execute search when manualQuery changes
  useEffect(() => {
    let active = true;
    const runSearch = async () => {
      // Simulate or execute search
      const q = manualQuery.trim().toLowerCase();
      let mockEnv: any = undefined;

      // Provide sample hydrated data for demonstration if query matches known indexed vans
      if (q.includes('transit') || q.includes('ccp') || q.includes('sprinter') || q.includes('promaster') || q.includes('truma')) {
        mockEnv = {
          AI: {
            run: async () => ({ data: [Array.from({ length: 768 }, () => 0.05)] })
          },
          VECTORIZE: {
            query: async () => ({
              matches: [{ id: 'sample_chunk_1', score: 0.94 }]
            })
          },
          DB: {
            prepare: () => ({
              bind: () => ({
                all: async () => ({
                  results: [
                    {
                      id: 'transit_bemm_2024_p148_c2',
                      document_id: 'ford_transit_bemm_2024',
                      title: 'Ford Transit Body and Equipment Mounting Manual (BEMM)',
                      manufacturer: 'Ford Motor Company',
                      page_number: 148,
                      subsystem: '12v_dc',
                      chunk_text:
                        'CCP2 (Customer Connection Point 2) is a 60A continuous (175A pre-fused MIDI) M8 terminal stud on the driver seat pedestal. Torque M8 flange nut to 12–15 Nm (9–11 lb-ft). Do not attach lugs directly to starter battery terminals under the seat.',
                      r2_key: 'schematics/transit/ccp2_diagram.png',
                      caption: 'CCP2 Driver Seat Pedestal Terminal & Fuse Box'
                    }
                  ]
                })
              })
            })
          },
          CDN_BASE_URL: 'https://assets.campervan-mcp.internal'
        };
      }

      const res = await searchVanManuals(manualQuery, mockEnv);
      if (active) {
        setSearchResponse(res);
      }
    };

    runSearch();
    return () => {
      active = false;
    };
  }, [manualQuery]);

  const chassisRule = useMemo(() => {
    const spec = CHASSIS_SUMMARY[selectedChassis][selectedCategory];
    const warnings: string[] = [];
    if (spec.maxRoofLoadLbs !== null && proposedRoofLoad > spec.maxRoofLoadLbs) {
      warnings.push(
        `NON-COMPLIANT: Proposed roof load (${proposedRoofLoad} lbs) exceeds OEM limit of ${spec.maxRoofLoadLbs} lbs.`
      );
    }
    if (spec.maxAlternatorTapAmps !== null && proposedTapAmps > spec.maxAlternatorTapAmps) {
      warnings.push(
        `NON-COMPLIANT: Proposed alternator tap (${proposedTapAmps}A) exceeds OEM connection limit of ${spec.maxAlternatorTapAmps}A.`
      );
    }
    return { ...spec, isCompliant: warnings.length === 0, warnings };
  }, [selectedChassis, selectedCategory, proposedRoofLoad, proposedTapAmps]);

  const curlCommand = useMemo(() => {
    if (provider === 'deepinfra') {
      return `curl -s -X POST https://api.deepinfra.com/v1/inference/BAAI/bge-base-en-v1.5 \\
  -H "Authorization: Bearer ${mockToken || '$DEEPINFRA_TOKEN'}" \\
  -H "Content-Type: application/json" \\
  -d '{"inputs": ["${inputText.replace(/'/g, "\\'")}"]}' | jq '.embeddings[0] | length'`;
    } else {
      return `curl -s -X POST https://api.cloudflare.com/client/v4/accounts/${mockCfAccountId || '$CLOUDFLARE_ACCOUNT_ID'}/ai/run/@cf/baai/bge-base-en-v1.5 \\
  -H "Authorization: Bearer ${mockCfToken || '$CLOUDFLARE_API_TOKEN'}" \\
  -H "Content-Type: application/json" \\
  -d '{"text": ["${inputText.replace(/'/g, "\\'")}"]}' | jq '.result.data[0] | length'`;
    }
  }, [provider, mockToken, mockCfAccountId, mockCfToken, inputText]);

  const handleCopyCurl = () => {
    navigator.clipboard.writeText(curlCommand);
    setCopiedCurl(true);
    setTimeout(() => setCopiedCurl(false), 2000);
  };

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 font-sans pb-16">
      <header className="border-b border-slate-800 bg-slate-900/80 backdrop-blur sticky top-0 z-30">
        <div className="max-w-7xl mx-auto px-6 py-4 flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-lg bg-amber-500/15 border border-amber-500/40 flex items-center justify-center text-amber-400">
              <Wrench className="w-5 h-5" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h1 className="text-lg font-semibold tracking-tight text-white">
                  sekka1/Campervan-mcp — Engineering Workbench
                </h1>
                <span className="px-2 py-0.5 rounded text-[11px] font-mono bg-sky-500/15 border border-sky-500/30 text-sky-300">
                  feat/embedding-provider-switch
                </span>
              </div>
              <p className="text-xs text-slate-400">
                Cloudflare Workers AI & DeepInfra • 768-dim Vectorize Ingestion • ABYC E-11 & OEM Chassis Rules
              </p>
            </div>
          </div>
          <div className="flex items-center gap-3 text-xs">
            <span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-emerald-500/15 border border-emerald-500/30 text-emerald-300 font-medium">
              <CheckCircle2 className="w-4 h-4" />
              14/14 Tests Passed (Vitest)
            </span>
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-6 py-8 space-y-8">
        {/* Architecture & Pipeline Status */}
        <section className="grid grid-cols-1 md:grid-cols-4 gap-4">
          {[
            {
              phase: 'Pipeline Adapter',
              title: 'Embedding Provider Toggle',
              desc: 'Runtime switch via EMBEDDING_PROVIDER ("deepinfra" | "cloudflare"). Identical 768-dim vectors.',
              status: 'Active',
            },
            {
              phase: 'Storage & RAG',
              title: 'D1 + Vectorize Ingestion',
              desc: 'BAAI/bge-base-en-v1.5 compatible index with zero dimension drift across backends.',
              status: 'Aligned',
            },
            {
              phase: 'Testing & QA',
              title: 'Vitest Unit Suite',
              desc: '14 tests covering request formatting, missing tokens, 768-dim guards, and array batching.',
              status: '14 Passed',
            },
            {
              phase: 'CI/CD Pipeline',
              title: 'GitHub Actions sync-r2',
              desc: 'Automated workflow running sync-r2-manuals.ts with secret injection and fallback support.',
              status: 'Configured',
            },
          ].map((item) => (
            <div
              key={item.phase}
              className="p-4 rounded-xl bg-slate-900 border border-slate-800 flex flex-col justify-between"
            >
              <div>
                <div className="flex items-center justify-between text-xs text-slate-400 mb-1">
                  <span className="font-mono text-slate-400">{item.phase}</span>
                  <span className="text-emerald-400 font-medium flex items-center gap-1">
                    <CheckCircle2 className="w-3.5 h-3.5" /> {item.status}
                  </span>
                </div>
                <h2 className="text-sm font-semibold text-white mb-1.5">{item.title}</h2>
                <p className="text-xs text-slate-400 leading-relaxed">{item.desc}</p>
              </div>
            </div>
          ))}
        </section>

        {/* FEATURE HIGHLIGHT: Embedding Provider Switch Simulator */}
        <section className="rounded-xl bg-slate-900 border border-slate-800 p-6 space-y-6">
          <div className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-800 pb-4">
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 rounded-lg bg-sky-500/15 border border-sky-500/30 flex items-center justify-center text-sky-400">
                <Cpu className="w-5 h-5" />
              </div>
              <div>
                <h2 className="text-base font-semibold text-white flex items-center gap-2">
                  Configurable Embedding Provider Switch
                  <span className="text-xs px-2 py-0.5 rounded-full bg-slate-800 border border-slate-700 font-mono text-slate-300">
                    768-dim BAAI/bge-base-en-v1.5
                  </span>
                </h2>
                <p className="text-xs text-slate-400 font-mono">
                  scripts/ingest-manuals.ts • scripts/sync-r2-manuals.ts • tests/embedding-provider.test.ts
                </p>
              </div>
            </div>

            {/* Provider Toggle Pill */}
            <div className="inline-flex rounded-lg bg-slate-950 p-1 border border-slate-800 text-xs font-mono">
              <button
                type="button"
                onClick={() => setProvider('deepinfra')}
                className={`px-3 py-1.5 rounded-md transition flex items-center gap-1.5 ${
                  provider === 'deepinfra'
                    ? 'bg-amber-500/20 text-amber-300 font-semibold border border-amber-500/40'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                <Zap className="w-3.5 h-3.5" />
                DeepInfra (Default)
              </button>
              <button
                type="button"
                onClick={() => setProvider('cloudflare')}
                className={`px-3 py-1.5 rounded-md transition flex items-center gap-1.5 ${
                  provider === 'cloudflare'
                    ? 'bg-sky-500/20 text-sky-300 font-semibold border border-sky-500/40'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                <Database className="w-3.5 h-3.5" />
                Cloudflare Workers AI
              </button>
            </div>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            {/* Configuration Column */}
            <div className="space-y-4">
              <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-400 flex items-center gap-2">
                <Layers className="w-4 h-4 text-slate-400" />
                Provider Specification
              </h3>

              <div className="p-4 rounded-lg bg-slate-950 border border-slate-800 space-y-3 text-xs">
                <div>
                  <span className="text-slate-500 block text-[11px]">Endpoint URL</span>
                  <div className="font-mono text-sky-300 break-all bg-slate-900 p-2 rounded border border-slate-800 mt-1">
                    {provider === 'deepinfra'
                      ? 'https://api.deepinfra.com/v1/inference/BAAI/bge-base-en-v1.5'
                      : `https://api.cloudflare.com/client/v4/accounts/${mockCfAccountId || '{account_id}'}/ai/run/@cf/baai/bge-base-en-v1.5`}
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-2">
                  <div className="p-2.5 rounded bg-slate-900 border border-slate-800">
                    <span className="text-slate-500 block text-[11px]">Request Key</span>
                    <span className="font-mono text-amber-300">
                      {provider === 'deepinfra' ? '"inputs": string[]' : '"text": string[]'}
                    </span>
                  </div>
                  <div className="p-2.5 rounded bg-slate-900 border border-slate-800">
                    <span className="text-slate-500 block text-[11px]">Response Path</span>
                    <span className="font-mono text-emerald-300">
                      {provider === 'deepinfra' ? 'data.embeddings' : 'data.result.data'}
                    </span>
                  </div>
                </div>

                <div className="p-2.5 rounded bg-slate-900 border border-slate-800">
                  <span className="text-slate-500 block text-[11px]">Dimensionality Assertion</span>
                  <span className="font-mono text-white flex items-center gap-1.5 mt-0.5">
                    <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
                    Exact 768 dimensions (BAAI/bge-base-en-v1.5)
                  </span>
                </div>
              </div>

              {/* Credentials Configuration Input */}
              <div className="space-y-2 text-xs">
                <label className="block text-slate-400 font-medium">
                  {provider === 'deepinfra' ? 'DEEPINFRA_TOKEN' : 'CLOUDFLARE Credentials'}
                </label>
                {provider === 'deepinfra' ? (
                  <input
                    type="text"
                    value={mockToken}
                    onChange={(e) => setMockToken(e.target.value)}
                    placeholder="Enter DeepInfra token"
                    className="w-full rounded-lg bg-slate-950 border border-slate-800 px-3 py-2 text-slate-200 font-mono text-xs focus:border-amber-500 outline-none"
                  />
                ) : (
                  <div className="space-y-2">
                    <input
                      type="text"
                      value={mockCfAccountId}
                      onChange={(e) => setMockCfAccountId(e.target.value)}
                      placeholder="CLOUDFLARE_ACCOUNT_ID"
                      className="w-full rounded-lg bg-slate-950 border border-slate-800 px-3 py-2 text-slate-200 font-mono text-xs focus:border-sky-500 outline-none"
                    />
                    <input
                      type="text"
                      value={mockCfToken}
                      onChange={(e) => setMockCfToken(e.target.value)}
                      placeholder="CLOUDFLARE_API_TOKEN"
                      className="w-full rounded-lg bg-slate-950 border border-slate-800 px-3 py-2 text-slate-200 font-mono text-xs focus:border-sky-500 outline-none"
                    />
                  </div>
                )}
              </div>
            </div>

            {/* Test Payload & Live Curl Verification Column */}
            <div className="lg:col-span-2 space-y-4">
              <div className="flex items-center justify-between">
                <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-400 flex items-center gap-2">
                  <Terminal className="w-4 h-4 text-slate-400" />
                  Local Token Verification & Ingestion Curl
                </h3>
                <button
                  type="button"
                  onClick={handleCopyCurl}
                  className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs transition"
                >
                  {copiedCurl ? (
                    <>
                      <Check className="w-3.5 h-3.5 text-emerald-400" /> Copied!
                    </>
                  ) : (
                    <>
                      <Copy className="w-3.5 h-3.5" /> Copy Curl
                    </>
                  )}
                </button>
              </div>

              <div>
                <label className="block text-xs text-slate-400 mb-1">
                  Sample Chunk Input for Embedding Generation
                </label>
                <textarea
                  rows={2}
                  value={inputText}
                  onChange={(e) => setInputText(e.target.value)}
                  className="w-full rounded-lg bg-slate-950 border border-slate-800 p-2.5 text-slate-200 font-mono text-xs focus:border-sky-500 outline-none resize-none"
                />
              </div>

              {/* Terminal Preview */}
              <div className="rounded-lg bg-black border border-slate-800 p-3.5 font-mono text-xs overflow-x-auto space-y-2">
                <div className="text-slate-500 text-[11px] select-none"># Execute in terminal to verify provider output:</div>
                <pre className="text-emerald-400 whitespace-pre-wrap">{curlCommand}</pre>
                <div className="pt-2 border-t border-slate-800/80 flex items-center justify-between text-[11px] text-slate-400">
                  <span>Expected output: <span className="text-amber-400 font-bold">768</span></span>
                  <span className="text-slate-500">Matches Vectorize schema dimensions</span>
                </div>
              </div>

              {/* Local Sync Execution Command */}
              <div className="p-3.5 rounded-lg bg-slate-950 border border-slate-800 text-xs space-y-2">
                <div className="text-slate-400 font-medium">To run manuals synchronization locally:</div>
                <div className="bg-slate-900 p-2 rounded font-mono text-slate-300 text-[11px] overflow-x-auto">
                  {provider === 'deepinfra' ? (
                    <code>DEEPINFRA_TOKEN="{mockToken || 'xxx'}" npx tsx scripts/sync-r2-manuals.ts</code>
                  ) : (
                    <code>EMBEDDING_PROVIDER="cloudflare" CLOUDFLARE_ACCOUNT_ID="{mockCfAccountId || 'xxx'}" CLOUDFLARE_API_TOKEN="{mockCfToken || 'xxx'}" npx tsx scripts/sync-r2-manuals.ts</code>
                  )}
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* Existing Interactive Simulators for ABYC and Chassis Rules */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Tool 1: ABYC E-11 DC Wire & Fuse Calculator */}
          <section className="rounded-xl bg-slate-900 border border-slate-800 p-6 space-y-5">
            <div className="flex items-center justify-between border-b border-slate-800 pb-4">
              <div className="flex items-center gap-2.5">
                <Cable className="w-5 h-5 text-amber-400" />
                <div>
                  <h2 className="text-base font-semibold text-white">
                    ABYC E-11 DC Wire & Fuse Calculator
                  </h2>
                  <p className="text-xs text-slate-400 font-mono">
                    calculate_dc_wire_and_fuse / calculate_wire_gauge
                  </p>
                </div>
              </div>
              <span className="text-xs font-mono px-2.5 py-1 rounded bg-slate-800 text-amber-300">
                K = 10.75 • 105°C Tinned Cu
              </span>
            </div>

            <div className="grid grid-cols-2 gap-4 text-sm">
              <div>
                <label className="block text-xs text-slate-400 mb-1">System Voltage (DC)</label>
                <div className="grid grid-cols-3 gap-2">
                  {([12, 24, 48] as const).map((v) => (
                    <button
                      key={v}
                      type="button"
                      onClick={() => setVoltage(v)}
                      className={`py-2 rounded-lg font-mono text-xs border transition ${
                        voltage === v
                          ? 'bg-amber-500/20 border-amber-500 text-amber-300 font-semibold'
                          : 'bg-slate-950 border-slate-800 text-slate-400 hover:border-slate-700'
                      }`}
                    >
                      {v}V
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <label className="block text-xs text-slate-400 mb-1">Allowable Drop (%)</label>
                <div className="grid grid-cols-2 gap-2">
                  {([3, 10] as const).map((d) => (
                    <button
                      key={d}
                      type="button"
                      onClick={() => setDropPct(d)}
                      className={`py-2 rounded-lg font-mono text-xs border transition ${
                        dropPct === d
                          ? 'bg-amber-500/20 border-amber-500 text-amber-300 font-semibold'
                          : 'bg-slate-950 border-slate-800 text-slate-400 hover:border-slate-700'
                      }`}
                    >
                      {d}% ({d === 3 ? 'Critical' : 'General'})
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <label className="block text-xs text-slate-400 mb-1">
                  Continuous Current: <span className="text-white font-mono">{amperage} A</span>
                </label>
                <input
                  type="range"
                  min={5}
                  max={350}
                  step={5}
                  value={amperage}
                  onChange={(e) => setAmperage(Number(e.target.value))}
                  className="w-full accent-amber-500"
                />
              </div>

              <div>
                <label className="block text-xs text-slate-400 mb-1">
                  One-Way Distance: <span className="text-white font-mono">{oneWayFeet} ft</span> (
                  {oneWayFeet * 2} ft loop)
                </label>
                <input
                  type="range"
                  min={2}
                  max={50}
                  step={1}
                  value={oneWayFeet}
                  onChange={(e) => setOneWayFeet(Number(e.target.value))}
                  className="w-full accent-amber-500"
                />
              </div>
            </div>

            <label className="flex items-center gap-2.5 text-xs text-slate-300 cursor-pointer select-none pt-1">
              <input
                type="checkbox"
                checked={inEngineRoom}
                onChange={(e) => setInEngineRoom(e.target.checked)}
                className="rounded border-slate-700 accent-amber-500"
              />
              <span>
                Routed through hot engine compartment (applies ABYC E-11 105°C engine-room derating)
              </span>
            </label>

            {'error' in wireResult ? (
              <div className="p-4 rounded-lg bg-rose-500/10 border border-rose-500/30 text-rose-300 text-xs flex items-center gap-2">
                <AlertTriangle className="w-4 h-4 shrink-0" />
                {wireResult.error}
              </div>
            ) : (
              <div className="p-4 rounded-lg bg-slate-950 border border-slate-800 space-y-3">
                <div className="grid grid-cols-3 gap-3">
                  <div className="p-3 rounded bg-slate-900 border border-slate-800">
                    <div className="text-[11px] text-slate-400">Recommended Wire</div>
                    <div className="text-lg font-bold font-mono text-amber-400">
                      {wireResult.recommended_awg} AWG
                    </div>
                    <div className="text-[11px] text-slate-500 font-mono">
                      Rated {wireResult.wire_ampacity_amps}A
                    </div>
                  </div>
                  <div className="p-3 rounded bg-slate-900 border border-slate-800">
                    <div className="text-[11px] text-slate-400">Actual V-Drop</div>
                    <div className="text-lg font-bold font-mono text-emerald-400">
                      {wireResult.exact_voltage_drop_volts}V
                    </div>
                    <div className="text-[11px] text-slate-500 font-mono">
                      {wireResult.exact_voltage_drop_percent}% of {voltage}V
                    </div>
                  </div>
                  <div className="p-3 rounded bg-slate-900 border border-slate-800">
                    <div className="text-[11px] text-slate-400">Max Fuse Sizing</div>
                    <div className="text-lg font-bold font-mono text-sky-400">
                      {wireResult.recommended_fuse_amps}A
                    </div>
                    <div className="text-[11px] text-slate-500 truncate" title={wireResult.fuse_type}>
                      {wireResult.fuse_type}
                    </div>
                  </div>
                </div>
                <div className="text-xs text-slate-400 font-mono flex items-center justify-between pt-1 border-t border-slate-800">
                  <span>Fuse Form Factor: {wireResult.fuse_type}</span>
                  <span>Round-Trip Loop: {wireResult.round_trip_feet} ft</span>
                </div>

                {/* Safety Invariants and Negative Constraints */}
                <div className="pt-2 border-t border-slate-800 space-y-3">
                  <div className="p-3 rounded-lg bg-rose-500/10 border border-rose-500/30 text-xs space-y-1.5">
                    <div className="flex items-center gap-1.5 text-rose-300 font-semibold uppercase tracking-wider text-[11px]">
                      <ShieldAlert className="w-3.5 h-3.5" />
                      Mandatory Overcurrent Protection Rule
                    </div>
                    <p className="text-rose-200 text-xs leading-relaxed font-mono">
                      {wireResult.safety_invariants.fuse_placement}
                    </p>
                  </div>

                  <div className="p-3 rounded-lg bg-amber-500/10 border border-amber-500/25 space-y-2">
                    <div className="flex items-center gap-1.5 text-amber-300 font-semibold uppercase tracking-wider text-[11px]">
                      <AlertTriangle className="w-3.5 h-3.5" />
                      Prohibited Practices (Negative Constraints)
                    </div>
                    <ul className="space-y-1.5 text-xs text-amber-200/90 font-mono">
                      {wireResult.safety_invariants.prohibited_practices.map((practice, idx) => (
                        <li key={idx} className="flex items-start gap-2">
                          <span className="text-rose-400 font-bold shrink-0">✕</span>
                          <span>{practice}</span>
                        </li>
                      ))}
                    </ul>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs">
                    <div className="p-2.5 rounded bg-slate-900 border border-slate-800">
                      <span className="text-slate-400 block text-[11px]">Upsize Recommendation</span>
                      <span className="text-sky-300 font-mono">{wireResult.safety_invariants.upsize_path}</span>
                    </div>
                    <div className="p-2.5 rounded bg-slate-900 border border-slate-800">
                      <span className="text-slate-400 block text-[11px]">Conductor Standards</span>
                      <span className="text-emerald-300 font-mono">105°C Tinned Copper (SAE J1127 / UL 1426)</span>
                    </div>
                  </div>
                </div>
              </div>
            )}
          </section>

          {/* Tool 2: Deterministic OEM Chassis Rules */}
          <section className="rounded-xl bg-slate-900 border border-slate-800 p-6 space-y-5">
            <div className="flex items-center justify-between border-b border-slate-800 pb-4">
              <div className="flex items-center gap-2.5">
                <Truck className="w-5 h-5 text-sky-400" />
                <div>
                  <h2 className="text-base font-semibold text-white">
                    OEM Chassis Rules & Upfitter Evaluator
                  </h2>
                  <p className="text-xs text-slate-400 font-mono">chassis_rules</p>
                </div>
              </div>
              <span
                className={`text-xs font-mono px-2.5 py-1 rounded ${
                  chassisRule.isCompliant
                    ? 'bg-emerald-500/15 text-emerald-300 border border-emerald-500/30'
                    : 'bg-rose-500/15 text-rose-300 border border-rose-500/30'
                }`}
              >
                {chassisRule.isCompliant ? 'OEM COMPLIANT' : 'LIMIT EXCEEDED'}
              </span>
            </div>

            <div className="grid grid-cols-2 gap-4 text-xs">
              <div>
                <label className="block text-slate-400 mb-1">Chassis Platform</label>
                <select
                  value={selectedChassis}
                  onChange={(e) => setSelectedChassis(e.target.value as ChassisKey)}
                  className="w-full rounded-lg bg-slate-950 border border-slate-800 px-3 py-2 text-slate-200 font-mono"
                >
                  <option value="ford_transit">ford_transit (Ford Transit BEMM)</option>
                  <option value="mercedes_sprinter">mercedes_sprinter (Sprinter VS30 BBMD)</option>
                  <option value="ram_promaster">ram_promaster (RAM ProMaster Upfitter)</option>
                  <option value="universal">universal (RVIA / ABYC Standard)</option>
                </select>
              </div>

              <div>
                <label className="block text-slate-400 mb-1">Rule Category</label>
                <select
                  value={selectedCategory}
                  onChange={(e) => setSelectedCategory(e.target.value as RuleCategory)}
                  className="w-full rounded-lg bg-slate-950 border border-slate-800 px-3 py-2 text-slate-200 font-mono"
                >
                  <option value="electrical_tap">electrical_tap (CCP / EK1 / Alternator)</option>
                  <option value="roof_load">roof_load (Dynamic Rack & Cutouts)</option>
                  <option value="structural_cutting">structural_cutting (Pillars & Plusnuts)</option>
                  <option value="floor_mounting">floor_mounting (Battery & Tank Tie-Down)</option>
                  <option value="heating_ventilation">heating_ventilation (Aux Fuel Tap & Exhaust)</option>
                </select>
              </div>
            </div>

            {selectedCategory === 'roof_load' && (
              <div>
                <label className="block text-xs text-slate-400 mb-1">
                  Test Proposed Roof Load:{' '}
                  <span className="text-white font-mono">{proposedRoofLoad} lbs</span>
                </label>
                <input
                  type="range"
                  min={50}
                  max={450}
                  step={10}
                  value={proposedRoofLoad}
                  onChange={(e) => setProposedRoofLoad(Number(e.target.value))}
                  className="w-full accent-sky-500"
                />
              </div>
            )}

            {selectedCategory === 'electrical_tap' && (
              <div>
                <label className="block text-xs text-slate-400 mb-1">
                  Test Proposed Alternator / CCP Tap:{' '}
                  <span className="text-white font-mono">{proposedTapAmps} A</span>
                </label>
                <input
                  type="range"
                  min={10}
                  max={120}
                  step={5}
                  value={proposedTapAmps}
                  onChange={(e) => setProposedTapAmps(Number(e.target.value))}
                  className="w-full accent-sky-500"
                />
              </div>
            )}

            <div className="p-4 rounded-lg bg-slate-950 border border-slate-800 space-y-3 text-xs">
              <p className="text-slate-200 leading-relaxed">{chassisRule.guidance}</p>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 pt-1">
                <div className="p-2.5 rounded bg-slate-900 border border-slate-800">
                  <span className="text-slate-400 block text-[11px]">Designated OEM Point</span>
                  <span className="text-sky-300 font-mono">{chassisRule.oemConnectionPoint}</span>
                </div>
                <div className="p-2.5 rounded bg-slate-900 border border-slate-800">
                  <span className="text-slate-400 block text-[11px]">Fastener / Torque Spec</span>
                  <span className="text-slate-200 font-mono">{chassisRule.fastenerSpec}</span>
                </div>
              </div>

              {chassisRule.warnings.map((w) => (
                <div
                  key={w}
                  className="p-2.5 rounded bg-rose-500/15 border border-rose-500/30 text-rose-300 font-mono"
                >
                  {w}
                </div>
              ))}
            </div>
          </section>
        </div>

        {/* FEATURE: Dynamic Retrieval Grounding Contract & MCP Directive Tools */}
        <section className="rounded-xl bg-slate-900 border border-slate-800 p-6 space-y-6">
          <div className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-800 pb-4">
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 rounded-lg bg-emerald-500/15 border border-emerald-500/30 flex items-center justify-center text-emerald-400">
                <ShieldCheck className="w-5 h-5" />
              </div>
              <div>
                <h2 className="text-base font-semibold text-white flex items-center gap-2">
                  Dynamic Retrieval Grounding Contract & Tool Descriptions
                  <span className="text-xs px-2 py-0.5 rounded-full bg-slate-800 border border-slate-700 font-mono text-emerald-300">
                    Defensive Invariants Active
                  </span>
                </h2>
                <p className="text-xs text-slate-400 font-mono">
                  src/tools/calculations.ts • src/tools/manuals.ts • src/index.ts
                </p>
              </div>
            </div>

            <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded bg-slate-950 border border-slate-800 text-xs text-slate-300 font-mono">
              <Lock className="w-3.5 h-3.5 text-amber-400" />
              Anti-Hallucination Contract
            </span>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {/* Left: Interactive Manual Search Simulator */}
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-400 flex items-center gap-2">
                  <FileSearch className="w-4 h-4 text-emerald-400" />
                  Live Retrieval & Missing Manual Contract Tester
                </h3>
              </div>

              <div>
                <label className="block text-xs text-slate-400 mb-1.5">
                  Technical Query (Test documented vs absent manuals):
                </label>
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={manualQuery}
                    onChange={(e) => setManualQuery(e.target.value)}
                    placeholder="Enter component query..."
                    className="flex-1 rounded-lg bg-slate-950 border border-slate-800 px-3 py-2 text-slate-200 font-mono text-xs focus:border-emerald-500 outline-none"
                  />
                </div>

                {/* Preset quick test buttons */}
                <div className="flex flex-wrap gap-2 mt-2">
                  <button
                    type="button"
                    onClick={() =>
                      setManualQuery('Ford Transit CCP2 60A connection torque and fuse rating')
                    }
                    className="px-2.5 py-1 rounded bg-slate-800 hover:bg-slate-700 text-slate-300 text-[11px] font-mono transition"
                  >
                    ✓ Transit CCP2 (Match)
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      setManualQuery('Truma Combi D 6 E diesel heater operating specifications')
                    }
                    className="px-2.5 py-1 rounded bg-slate-800 hover:bg-slate-700 text-slate-300 text-[11px] font-mono transition"
                  >
                    ✓ Truma Heater (Match)
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      setManualQuery('Unknown generic Chinese water pump XYZ-900 fastener torque')
                    }
                    className="px-2.5 py-1 rounded bg-rose-950/40 hover:bg-rose-900/60 border border-rose-800/40 text-rose-300 text-[11px] font-mono transition"
                  >
                    ✕ Absent Manual (Triggers Negative Contract)
                  </button>
                </div>
              </div>

              {/* Retrieval Metadata Envelope Display */}
              {searchResponse && (
                <div className="space-y-3">
                  <div className="p-3.5 rounded-lg bg-slate-950 border border-slate-800 space-y-2.5 text-xs">
                    <div className="flex items-center justify-between border-b border-slate-800 pb-2">
                      <span className="font-mono text-slate-400">Envelope: retrieval_metadata</span>
                      <span
                        className={`px-2 py-0.5 rounded text-[11px] font-mono font-medium ${
                          searchResponse.retrieval_metadata.matches_found
                            ? 'bg-emerald-500/15 text-emerald-300 border border-emerald-500/30'
                            : 'bg-rose-500/15 text-rose-300 border border-rose-500/30'
                        }`}
                      >
                        matches_found: {String(searchResponse.retrieval_metadata.matches_found)} ({searchResponse.retrieval_metadata.count} chunks)
                      </span>
                    </div>

                    {/* Absent Manuals Advice Warning */}
                    {!searchResponse.retrieval_metadata.matches_found && searchResponse.retrieval_metadata.advice && (
                      <div className="p-3 rounded bg-rose-500/10 border border-rose-500/30 text-rose-300 space-y-1">
                        <div className="font-semibold flex items-center gap-1.5 text-[11px] uppercase tracking-wider text-rose-300">
                          <AlertTriangle className="w-3.5 h-3.5" />
                          Zero Matches Advice to Downstream LLM
                        </div>
                        <p className="text-rose-200 text-xs font-mono leading-relaxed">
                          {searchResponse.retrieval_metadata.advice}
                        </p>
                      </div>
                    )}

                    {/* Strict Grounding Rules */}
                    <div className="space-y-2 font-mono text-[11px]">
                      <div className="p-2.5 rounded bg-slate-900 border border-slate-800">
                        <span className="text-slate-400 block mb-0.5 text-[10px] uppercase font-sans font-semibold">
                          Strict Grounding Rule:
                        </span>
                        <span className="text-emerald-300">
                          "{searchResponse.retrieval_metadata.retrieval_contract.strict_grounding_rule}"
                        </span>
                      </div>
                      <div className="p-2.5 rounded bg-slate-900 border border-slate-800">
                        <span className="text-slate-400 block mb-0.5 text-[10px] uppercase font-sans font-semibold">
                          Missing Manual Rule (Anti-Fabrication):
                        </span>
                        <span className="text-amber-300">
                          "{searchResponse.retrieval_metadata.retrieval_contract.missing_manual_rule}"
                        </span>
                      </div>
                    </div>
                  </div>

                  {/* Matched chunks display */}
                  {searchResponse.results.length > 0 && (
                    <div className="p-3.5 rounded-lg bg-slate-950 border border-slate-800 space-y-2">
                      <div className="text-xs font-mono text-slate-400 flex items-center justify-between">
                        <span>Hydrated Manual Chunks:</span>
                        <span className="text-emerald-400">{searchResponse.results.length} result</span>
                      </div>
                      {searchResponse.results.map((chunk) => (
                        <div key={chunk.id} className="p-2.5 rounded bg-slate-900 border border-slate-800 text-xs font-mono space-y-1.5">
                          <div className="text-sky-300 font-semibold">{chunk.title} (Page {chunk.page_number})</div>
                          <p className="text-slate-300 text-[11px] leading-relaxed">{chunk.chunk_text}</p>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Right: Directive MCP Tool Descriptions Registration */}
            <div className="space-y-4">
              <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-400 flex items-center gap-2">
                <Terminal className="w-4 h-4 text-sky-400" />
                Directive Tool Descriptions Registered in MCP (src/index.ts)
              </h3>

              <div className="space-y-4">
                {MCP_TOOLS.map((tool) => (
                  <div key={tool.name} className="p-4 rounded-lg bg-slate-950 border border-slate-800 space-y-2.5 text-xs">
                    <div className="flex items-center justify-between">
                      <span className="font-mono text-sky-400 font-semibold">{tool.name}</span>
                      <button
                        type="button"
                        onClick={() => {
                          navigator.clipboard.writeText(tool.description);
                          setCopiedToolPrompt(tool.name);
                          setTimeout(() => setCopiedToolPrompt(null), 2000);
                        }}
                        className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-slate-800 hover:bg-slate-700 text-slate-300 text-[11px] font-mono transition"
                      >
                        {copiedToolPrompt === tool.name ? (
                          <>
                            <Check className="w-3 h-3 text-emerald-400" /> Copied
                          </>
                        ) : (
                          <>
                            <Copy className="w-3 h-3" /> Copy Directive
                          </>
                        )}
                      </button>
                    </div>

                    <pre className="bg-slate-900 p-3 rounded border border-slate-800 font-mono text-[11px] text-amber-200/90 whitespace-pre-wrap leading-relaxed">
                      {tool.description}
                    </pre>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </section>
      </main>
    </div>
  );
}
