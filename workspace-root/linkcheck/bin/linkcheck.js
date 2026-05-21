#!/usr/bin/env node

const { checkLinks } = require('../src/index.js');
const path = require('path');
const process = require('process');

// ANSI escape codes for colors
const colors = {
  reset: '\x1b[0m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
};

function colorText(text, color) {
  return colors[color] + text + colors.reset;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.error(colorText('Error: No target directory specified.', 'red'));
    process.exit(1);
  }

  const targetDir = path.resolve(args[0]);

  try {
    const results = await checkLinks(targetDir);
    let hasBroken = false;

    for (const [file, linkResults] of Object.entries(results)) {
      console.log(colorText(`File: ${file}`, 'blue'));
      for (const { link, ok } of linkResults) {
        if (ok) {
          console.log(`  ${colorText('\u2714', 'green')} ${link}`);
        } else {
          hasBroken = true;
          console.log(`  ${colorText('\u2716', 'red')} ${link}`);
        }
      }
      console.log('');
    }

    if (hasBroken) {
      console.error(colorText('Some links are broken.', 'red'));
      process.exit(1);
    } else {
      console.log(colorText('All links are valid.', 'green'));
      process.exit(0);
    }
  } catch (err) {
    console.error(colorText('Error during link check: ' + err.message, 'red'));
    process.exit(1);
  }
}

main();
