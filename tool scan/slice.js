/** Usage: node slice.js <file> <fromLine> <toLine> (1-based, inclusive). */
'use strict';
const fs = require('fs');
const [file, from, to] = [process.argv[2], +process.argv[3], +process.argv[4]];
const all = fs.readFileSync(file, 'utf8').split('\n');
console.log(all.slice(from - 1, to).map((l, i) => (from + i) + ':' + l).join('\n'));
