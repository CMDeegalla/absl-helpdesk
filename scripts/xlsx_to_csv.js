const xlsx = require('xlsx');
const fs = require('fs');
const path = require('path');

const inputFile = path.join(__dirname, '../device_management_CSV/Fingerprint_Device_Inventory_Master_EN.xlsx');
const outputFile = path.join(__dirname, '../device_management_CSV/Fingerprint_Device_Inventory_Master_EN.csv');

try {
  console.log(`Loading Excel file: ${inputFile}`);
  const workbook = xlsx.readFile(inputFile);
  const firstSheetName = workbook.SheetNames[0];
  const worksheet = workbook.Sheets[firstSheetName];
  
  console.log(`Converting sheet "${firstSheetName}" to CSV...`);
  const csvData = xlsx.utils.sheet_to_csv(worksheet);
  
  fs.writeFileSync(outputFile, csvData, 'utf8');
  console.log(`Saved CSV file to: ${outputFile}`);
} catch (error) {
  console.error('Error converting XLSX to CSV:', error);
  process.exit(1);
}
