const xlsx = require('xlsx');
const fs = require('fs');
const path = require('path');

const inputFile = path.join(__dirname, '../device_management_CSV/Fingerprint_Device_Inventory_Master_EN.xlsx');
const rawCsvFile = path.join(__dirname, '../device_management_CSV/raw_inventory.csv');

const boxLabels = {
  W: 'Fully Working',
  D1: 'Display Fault Group 1',
  D2: 'Display Fault Group 2',
  D3: 'Display Fault Group 3',
  D4: 'Display Fault Group 4',
  S1: 'Sensor Fault',
  K1: 'Keypad Fault',
  P1: 'Power Fault',
  U1: 'Unclassified'
};

const boxCosts = {
  W: 15000.00,
  D1: 6000.00,
  D2: 6000.00,
  D3: 6000.00,
  D4: 6000.00,
  S1: 5000.00,
  K1: 5500.00,
  P1: 4500.00,
  U1: 3000.00,
  Unassigned: 2000.00
};

try {
  console.log(`Loading workbook: ${inputFile}`);
  const workbook = xlsx.readFile(inputFile);
  
  // We will collect devices from All Devices (Master) sheet
  const sheetName = 'All Devices (Master)';
  const ws = workbook.Sheets[sheetName];
  if (!ws) {
    throw new Error(`Sheet "${sheetName}" not found in workbook.`);
  }

  // The headers are in the second row (index 1), so range: 1 skips the title row
  const rows = xlsx.utils.sheet_to_json(ws, { range: 1 });
  console.log(`Read ${rows.length} records from "${sheetName}"`);

  const inventoryGroups = {};

  rows.forEach((row, index) => {
    // Find keys matching columns (newlines might be parsed as \n)
    const keys = Object.keys(row);
    const modelKey = keys.find(k => k.toLowerCase().includes('model') && k.toLowerCase().includes('standardized'));
    const boxKey = keys.find(k => k.toLowerCase().includes('assigned') && k.toLowerCase().includes('box'));
    const serialKey = keys.find(k => k.toLowerCase().includes('serial'));

    let model = (modelKey && row[modelKey] ? String(row[modelKey]) : '').trim();
    let box = (boxKey && row[boxKey] ? String(row[boxKey]) : '').trim();
    const serial = (serialKey && row[serialKey] ? String(row[serialKey]) : '').trim();

    // Default fallbacks if empty
    if (!model || model === 'Unknown') {
      model = 'GenericFP';
    }
    if (!box) {
      box = 'Unassigned';
    }

    const groupKey = `${model}|${box}`;
    if (!inventoryGroups[groupKey]) {
      inventoryGroups[groupKey] = {
        model: model,
        box: box,
        count: 0
      };
    }
    inventoryGroups[groupKey].count += 1;
  });

  // Now create the raw inventory list in the format expected by import_inventory_csv.js:
  // Headers: sku, name, category, quantity_on_hand, reorder_level, unit_cost
  const csvRows = [['sku', 'name', 'category', 'quantity_on_hand', 'reorder_level', 'unit_cost']];

  Object.values(inventoryGroups).forEach(group => {
    const safeModel = group.model.replace(/[^a-zA-Z0-9]/g, '');
    const sku = `FP-${safeModel}-${group.box}`;
    const boxName = boxLabels[group.box] || group.box;
    const name = `Fingerprint Device ${group.model} (${boxName})`;
    const category = 'Fingerprint Device';
    const qty = group.count;
    const reorder = 5;
    const cost = boxCosts[group.box] || 2500.00;

    csvRows.push([sku, name, category, qty, reorder, cost]);
  });

  // Write out raw CSV
  const csvContent = csvRows.map(r => r.map(val => {
    const text = String(val ?? '');
    if (/[",\n\r]/.test(text)) {
      return `"${text.replace(/"/g, '""')}"`;
    }
    return text;
  }).join(',')).join('\n');

  fs.writeFileSync(rawCsvFile, csvContent, 'utf8');
  console.log(`Raw inventory CSV successfully prepared at: ${rawCsvFile}`);
  console.log(`Generated ${csvRows.length - 1} inventory groups.`);

} catch (error) {
  console.error('Error preparing inventory:', error);
  process.exit(1);
}
