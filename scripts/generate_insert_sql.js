const fs = require('fs');
const path = require('path');

const csvFile = path.join(__dirname, '../device_management_CSV/cleaned_inventory.csv');
const sqlFile = path.join(__dirname, '../device_management_CSV/insert_inventory.sql');

try {
  console.log(`Reading cleaned CSV: ${csvFile}`);
  const csvData = fs.readFileSync(csvFile, 'utf8');
  
  const lines = csvData.split('\n').map(line => line.trim()).filter(line => line.length > 0);
  const headers = lines.shift().split(',');
  
  const sqlLines = [
    '-- SQL Seed script for ABSL Fingerprint Device Inventory',
    '-- Run this in your Supabase SQL Editor to import the cleaned inventory.',
    '',
    'INSERT INTO public.inventory_items (sku, name, category, quantity_on_hand, reorder_level, unit_cost)',
    'VALUES'
  ];
  
  const valueRows = [];
  
  lines.forEach(line => {
    // Simple CSV parser supporting quotes (or simple split since we know our structure)
    // Our CSV generation uses simple fields, but let's parse safely.
    const parts = [];
    let current = '';
    let inQuotes = false;
    
    for (let i = 0; i < line.length; i++) {
      const char = line[i];
      if (char === '"') {
        inQuotes = !inQuotes;
      } else if (char === ',' && !inQuotes) {
        parts.push(current);
        current = '';
      } else {
        current += char;
      }
    }
    parts.push(current);
    
    if (parts.length >= 6) {
      const sku = parts[0].trim();
      const name = parts[1].trim();
      const category = parts[2].trim();
      const qty = parseInt(parts[3].trim(), 10);
      const reorder = parseInt(parts[4].trim(), 10);
      const cost = parseFloat(parts[5].trim());
      
      const safeName = name.replace(/'/g, "''");
      const safeCategory = category.replace(/'/g, "''");
      
      valueRows.push(`  ('${sku}', '${safeName}', '${safeCategory}', ${qty}, ${reorder}, ${cost})`);
    }
  });
  
  sqlLines.push(valueRows.join(',\n') + ';');
  
  fs.writeFileSync(sqlFile, sqlLines.join('\n'), 'utf8');
  console.log(`SQL insert script successfully generated at: ${sqlFile}`);
  
} catch (error) {
  console.error('Error generating SQL script:', error);
  process.exit(1);
}
