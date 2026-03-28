// One-off script: remove risky stop word patterns from Stop Word Regex.xlsx
// Run with: node scripts/fixStopWords.js

const XLSX = require('xlsx');
const path = require('path');

const file      = path.join(__dirname, '..', 'regex', 'Stop Word Regex.xlsx');
const sheetName = 'SNOMED_Stop_Regex';

const wb   = XLSX.readFile(file);
const ws   = wb.Sheets[sheetName];
const rows = XLSX.utils.sheet_to_json(ws, { defval: null });

console.log('Rows before:', rows.length);
rows.forEach((r, i) => console.log(`  row ${i + 2}: ${r.REGEX}`));

// Patterns to REMOVE (exact string values as stored in the cell):
const REMOVE = new Set([
  '\\ba\\b',         // "a"          — strips Type A, Hepatitis A, Influenza A, Vitamin A
  '\\bIntentional\\b', // "Intentional" — strips intentional self-harm/overdose distinction
  '\\bwithout\\b',   // "without"    — collapses "X without Y" SNOMED concepts into "X"
  '\\bwith\\b',      // "with" (×2)  — collapses comorbidity concepts e.g. "Diabetes with nephropathy"
]);

const filtered = rows.filter(r => {
  if (REMOVE.has(r.REGEX)) {
    console.log(`\nREMOVING: ${r.REGEX}`);
    return false;
  }
  return true;
});

console.log('\nRows after:', filtered.length);

const newWs = XLSX.utils.json_to_sheet(filtered, {
  header: ['REGEX', 'REPLACE_WITH', '__EMPTY', 'LENGTH'],
});
wb.Sheets[sheetName] = newWs;
XLSX.writeFile(wb, file);
console.log('Saved to', file);
