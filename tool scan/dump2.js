/** Read-only slice dump, part 2. Run from "D:\Adion Browse": node "tool scan\dump2.js" */
'use strict';
const fs = require('fs');
function lines(file, from, to) {
  const all = fs.readFileSync(file, 'utf8').split('\n');
  return all.slice(from - 1, to).map((l, i) => (from + i) + ':' + l).join('\n');
}
console.log('===== desktopActions 200-236 =====');
console.log(lines('src/pc/desktopActions.js', 200, 236));
console.log('===== input.ps1 95-160 =====');
console.log(lines('src/pc/input.ps1', 95, 160));
