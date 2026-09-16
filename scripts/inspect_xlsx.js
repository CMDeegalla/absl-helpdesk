const xlsx = require('xlsx');
const path = require('path');

const inputFile = path.join(__dirname, '../device_management_CSV/Fingerprint_Device_Inventory_Master_EN.xlsx');

try {
  const workbook = xlsx.readFile(inputFile);
  console.log('Sheet Names:', workbook.SheetNames);
  
  workbook.SheetNames.forEach(name => {
    const ws = workbook.Sheets[name];
    const data = xlsx.utils.sheet_to_json(ws, { header: 1 });
    console.log(`Sheet "${name}" rows count:`, data.length);
    if (data.length > 0) {
      console.log(`Preview of "${name}" first 3 rows:`, data.slice(0, 3));
    }
  });
} catch (error) {
  console.error('Error inspecting workbook:', error);
}
