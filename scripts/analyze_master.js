const xlsx = require('xlsx');
const path = require('path');

const inputFile = path.join(__dirname, '../device_management_CSV/Fingerprint_Device_Inventory_Master_EN.xlsx');

try {
  const workbook = xlsx.readFile(inputFile);
  const sheet = workbook.Sheets['All Devices (Master)'];
  const rows = xlsx.utils.sheet_to_json(sheet, { range: 1 });
  
  console.log(`Loaded ${rows.length} rows from 'All Devices (Master)'`);
  if (rows.length > 0) {
    console.log('Sample row keys:', Object.keys(rows[0]));
    console.log('Sample row data:', rows[0]);
  }
  
  const modelCounts = {};
  const boxCounts = {};
  const modelBoxCounts = {};
  
  rows.forEach((row, i) => {
    const keys = Object.keys(row);
    const modelKey = keys.find(k => k.includes('Model Name') && k.includes('Standardized')) || keys.find(k => k.includes('Model'));
    const boxKey = keys.find(k => k.includes('Assigned') && k.includes('Box')) || keys.find(k => k.includes('Box'));
    
    const model = (modelKey && row[modelKey] ? String(row[modelKey]) : 'Unknown').trim();
    const box = (boxKey && row[boxKey] ? String(row[boxKey]) : 'Unassigned').trim();
    
    modelCounts[model] = (modelCounts[model] || 0) + 1;
    boxCounts[box] = (boxCounts[box] || 0) + 1;
    
    const key = `${model} [${box}]`;
    modelBoxCounts[key] = (modelBoxCounts[key] || 0) + 1;
  });
  
  console.log('\n--- Standardized Models ---');
  console.log(modelCounts);
  
  console.log('\n--- Assigned Boxes ---');
  console.log(boxCounts);
  
  console.log('\n--- Model + Box counts ---');
  console.log(Object.entries(modelBoxCounts).sort((a, b) => b[1] - a[1]));
  
} catch (error) {
  console.error('Error analyzing master sheet:', error);
}
