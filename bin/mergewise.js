#!/usr/bin/env node

const args = process.argv.slice(2);

if (args.includes("--version") || args.includes("-v")) {
  console.log("mergewise 0.1.0");
  process.exit(0);
}

if (args.includes("--help") || args.includes("-h")) {
  console.log("Mergewise CLI (early access)");
  console.log("");
  console.log("Usage:");
  console.log("  mergewise --help");
  console.log("  mergewise --version");
  console.log("");
  console.log("Docs: https://github.com/JR-G/mergewise");
  process.exit(0);
}

console.log("Mergewise CLI is in early access.");
console.log("Run `mergewise --help` for available commands.");
