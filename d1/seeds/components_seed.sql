-- Seed data: components_seed.sql
-- Populates component_specs with common campervan electrical and mechanical components.
-- Run after applying migrations: npx wrangler d1 execute DB --local --file=d1/seeds/components_seed.sql

-- Inverter/Chargers
INSERT OR IGNORE INTO component_specs (name, category, manufacturer, model_number, max_continuous_amps, idle_power_watts, weight_lbs, terminal_stud_size, dimensions_inches, notes)
VALUES
  ('Victron MultiPlus-II 12/3000/120-50', 'inverter_charger', 'Victron Energy', 'PMP122300100', 250, 11, 26.5, 'M8', '14.2 x 8.7 x 5.5', '3000W continuous, 120A charger, 50A transfer switch. Split-phase AC output.'),
  ('Victron MultiPlus-II 24/3000/70-50', 'inverter_charger', 'Victron Energy', 'PMP243020100', 125, 11, 26.5, 'M8', '14.2 x 8.7 x 5.5', '3000W continuous on 24V system. 70A charger.'),
  ('Victron MultiPlus-II 48/3000/35-50', 'inverter_charger', 'Victron Energy', 'PMP482500500', 63, 11, 26.5, 'M8', '14.2 x 8.7 x 5.5', '3000W continuous on 48V system. 35A charger.'),
  ('Victron Phoenix Inverter 12/1200', 'inverter_charger', 'Victron Energy', 'PIN121201100', 100, 8, 8.4, 'M8', '10.2 x 5.9 x 4.1', '1200W continuous pure sine wave inverter.');

-- Busbars
INSERT OR IGNORE INTO component_specs (name, category, manufacturer, model_number, max_continuous_amps, idle_power_watts, weight_lbs, terminal_stud_size, dimensions_inches, notes)
VALUES
  ('Blue Sea 2000 Series Busbar 250A 6 Circuit', 'busbar', 'Blue Sea Systems', '2128', 250, NULL, 0.4, '3/8"', '6.0 x 1.5 x 1.0', '6 screw terminals, 3/8" stud, 250A rated. Common positive distribution.'),
  ('Blue Sea 2000 Series Busbar 150A 4 Circuit', 'busbar', 'Blue Sea Systems', '2307', 150, NULL, 0.3, '5/16"', '4.5 x 1.5 x 1.0', '4 screw terminals, 150A rated.'),
  ('Blue Sea ST Blade Fuse Block 12 Circuit', 'busbar', 'Blue Sea Systems', '5191', 100, NULL, 0.2, '5/16"', '5.8 x 3.1 x 1.3', '12 circuit blade fuse block with negative bus. 100A max total.');

-- Batteries
INSERT OR IGNORE INTO component_specs (name, category, manufacturer, model_number, max_continuous_amps, idle_power_watts, weight_lbs, terminal_stud_size, dimensions_inches, notes)
VALUES
  ('Battle Born 100Ah 12V LiFePO4', 'battery', 'Battle Born Batteries', 'BB10012', 100, 0, 29, 'M8', '12.7 x 6.9 x 9.0', '100Ah @ 12V, 100A continuous discharge, 50A charge max. BMS included.'),
  ('Battle Born 100Ah 24V LiFePO4', 'battery', 'Battle Born Batteries', 'BB10024', 50, 0, 29, 'M8', '12.7 x 6.9 x 9.0', '100Ah @ 24V (2x12V cells in series). 50A continuous discharge.'),
  ('Victron LiFePO4 200Ah 12.8V', 'battery', 'Victron Energy', 'BAT512120610', 200, 0, 57.3, 'M8', '20.9 x 9.4 x 8.7', '200Ah @ 12.8V, 200A continuous, Smart BMS integration.'),
  ('Renogy 100Ah 12V AGM', 'battery', 'Renogy', 'RNG-BATT-AGM12-100', 100, 0, 62, 'M6', '13.1 x 6.8 x 8.7', '100Ah AGM deep cycle. 100A max discharge. Not suitable for fast charging.');

-- Charge Controllers
INSERT OR IGNORE INTO component_specs (name, category, manufacturer, model_number, max_continuous_amps, idle_power_watts, weight_lbs, terminal_stud_size, dimensions_inches, notes)
VALUES
  ('Victron SmartSolar MPPT 100/50', 'charge_controller', 'Victron Energy', 'SCC110050210', 50, 0.7, 2.2, 'M6', '5.3 x 3.9 x 1.2', 'MPPT, 100V max PV input, 50A output. 12/24V auto-detect. Bluetooth built-in.'),
  ('Victron SmartSolar MPPT 150/100', 'charge_controller', 'Victron Energy', 'SCC115110210', 100, 1.0, 3.5, 'M8', '7.9 x 4.7 x 2.4', 'MPPT, 150V max PV input, 100A output. 12/24/48V. Bluetooth.'),
  ('Renogy Rover 40A MPPT', 'charge_controller', 'Renogy', 'RNG-CTRL-RVR40', 40, 0.4, 1.5, 'M6', '6.2 x 3.7 x 1.3', '40A MPPT, 100V max PV, 12/24V auto-detect.');

-- Heaters
INSERT OR IGNORE INTO component_specs (name, category, manufacturer, model_number, max_continuous_amps, idle_power_watts, weight_lbs, terminal_stud_size, dimensions_inches, notes)
VALUES
  ('Webasto Air Top 2000 STC', 'heater', 'Webasto', 'WT-AT2000STC', 10, 1, 3.3, NULL, '9.5 x 5.9 x 4.3', '2000W diesel/gas air heater. 12V, 0.1–2.0 kW output range. Low fuel consumption.'),
  ('Espar Airtronic D2', 'heater', 'Espar', 'EA-D2', 8, 0.8, 3.1, NULL, '8.5 x 5.5 x 4.3', '2000W diesel air heater. 12V. Altitude compensated.'),
  ('Velit VH2000 Diesel Heater', 'heater', 'Velit', 'VH2000', 10, 0.9, 3.5, NULL, '10.0 x 6.0 x 4.5', '2000W diesel air heater. 12/24V. E1=Glow plug fault, E2=Fuel pump fault, E3=Overheat, E4=Flame sensor fault.');

-- Solar Panels
INSERT OR IGNORE INTO component_specs (name, category, manufacturer, model_number, max_continuous_amps, idle_power_watts, weight_lbs, terminal_stud_size, dimensions_inches, notes)
VALUES
  ('Renogy 200W 12V Mono Solar Panel', 'solar_panel', 'Renogy', 'RNG-200D', 11.8, NULL, 19.8, NULL, '62.2 x 26.8 x 1.4', 'Voc=24.3V, Isc=8.7A, Vmpp=20.5V. Temp coeff Voc=-0.30%/C.'),
  ('Renogy 175W 12V Mono Solar Panel', 'solar_panel', 'Renogy', 'RNG-175D', 10.5, NULL, 18.5, NULL, '58.7 x 26.8 x 1.4', 'Voc=22.5V, Isc=8.3A, Vmpp=19.2V. Temp coeff Voc=-0.30%/C.'),
  ('SunPower 110W Flexible Panel', 'solar_panel', 'SunPower', 'SPR-E-FLEX-110', 6.7, NULL, 4.2, NULL, '46.2 x 25.5 x 0.1', 'Flexible CIGS panel. Voc=25.4V, Isc=5.8A. Ideal for curved roof applications.');
