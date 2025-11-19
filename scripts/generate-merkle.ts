import fs from "fs";
import path from "path";
import { parse } from "csv-parse/sync";
import { PublicKey } from "@solana/web3.js";
import { buildMerkleTree, normalizeClaim } from "../shared/merkle";

interface CsvRow {
  address: string;
  amount: string;
}

function usage(): never {
  console.error("Usage: npm run generate:merkle -- <input.csv> <output.json>");
  process.exit(1);
}

function ensureU64(value: bigint, address: string) {
  if (value < 0n) {
    throw new Error(`Negative allocation for ${address}`);
  }
  const max = (1n << 64n) - 1n;
  if (value > max) {
    throw new Error(`Amount exceeds u64 for ${address}: ${value.toString()}`);
  }
}

function readCsv(inputPath: string): CsvRow[] {
  const data = fs.readFileSync(inputPath, "utf-8");
  return parse(data, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
  }) as CsvRow[];
}

function main() {
  const [, , inputArg, outputArg] = process.argv;

  if (!inputArg || !outputArg) {
    usage();
  }

  const inputPath = path.resolve(process.cwd(), inputArg);
  const outputPath = path.resolve(process.cwd(), outputArg);

  if (!fs.existsSync(inputPath)) {
    console.error(`Input file does not exist: ${inputPath}`);
    process.exit(1);
  }

  const rows = readCsv(inputPath);
  if (rows.length === 0) {
    throw new Error("CSV contains no rows");
  }

  const claims = rows.map((row, idx) => {
    if (!row.address || !row.amount) {
      throw new Error(`Row ${idx + 1} missing address or amount`);
    }

    const address = new PublicKey(row.address).toBase58();
    const amount = BigInt(row.amount);
    ensureU64(amount, address);

    return normalizeClaim(idx, address, amount);
  });

  const result = buildMerkleTree(claims);

  const outputDir = path.dirname(outputPath);
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  const payload = {
    root: result.root,
    total: claims.length,
    entries: result.entries.map((entry) => ({
      index: entry.index,
      address: entry.account,
      amount: entry.amount.toString(),
      proof: entry.proof,
    })),
  };

  fs.writeFileSync(outputPath, JSON.stringify(payload, null, 2), "utf-8");
  console.log(`Merkle root: ${result.root}`);
  console.log(`Wrote ${payload.entries.length} entries to ${outputPath}`);
}

main();

