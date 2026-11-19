/**
 * Dump exact code slices needed for audit fixes (read-only, no side effects).
 * Usage on PC (run from "D:\Adion Browse"): node "tool scan\dump-actions.js"
 */
'use strict';
const fs = require('fs');

function lines(file, from, to) {
  const all = fs.readFileSync(file, 'utf8').split('\n');
  return all.slice(from - 1, to).map((l, i) => (from + i) + ':' + l).join('\n');
}
function grep(file, re, ctx) {
  const all = fs.readFileSync(file, 'utf8').split('\n');
  const out = [];
  all.forEach((l, i) => {
    if (re.test(l)) {
      out.push('--- ' + file + ':' + (i + 1));
      for (let j = Math.max(0, i - (ctx || 0)); j <= Math.min(all.length - 1, i + (ctx || 0)); j++) out.push((j + 1) + ':' + all[j]);
    }
  });
  return out.join('\n');
}

console.log('===== press+scroll impl (desktopActions 200-240) =====');
console.log(lines('src/pc/desktopActions.js', 200, 240));
console.log('===== plan rules (index.js match lines +3) =====');
console.log(grep('src/pc/index.js', /text\.match/, 4));
console.log('===== input.ps1 key table hints =====');
console.log(grep('src/pc/input.ps1', /F12|F24|valid|keys/i, 1).slice(0, 3000));
