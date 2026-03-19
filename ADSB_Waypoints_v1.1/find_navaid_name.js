const fs = require('fs');
const fflateCode = fs.readFileSync('fflate.js', 'utf8');
const script = `const module={exports:{}};const exports=module.exports;${fflateCode};return module.exports;`;
const fflate = new Function(script)();

const buf = fs.readFileSync('cifp.zip');
const files = fflate.unzipSync(new Uint8Array(buf));
const cifpName = Object.keys(files).find(k => /FAACIFP/i.test(k) && !/\.(pdf|txt|xlsx|doc)$/i.test(k));
const text = new TextDecoder('utf-8').decode(files[cifpName]);
const lines = text.split(/\r?\n/);

let output = "";
for (const line of lines) {
  if (!line.startsWith("SUSAD") && !line.startsWith("SPACD")) continue;
  
  const ident = line.substring(13, 18).trim();
  if (ident === 'GLH' || ident === 'JFK' || ident === 'LAX') {
    output += `Ident: ${ident}\n`;
    output += `Line length: ${line.length}\n`;
    if (line.length > 93) {
      // In ARINC 424, Navaid name is columns 94-123 (0-indexed: 93 to 123)
      output += `Name (93-123): "${line.substring(93, 123)}"\n`;
    }
    output += `\n`;
  }
}
fs.writeFileSync('navaid_names.txt', output);
