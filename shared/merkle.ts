import { keccak_256 } from "@noble/hashes/sha3";
import { PublicKey } from "@solana/web3.js";

export interface MerkleClaim {
  index: number;
  account: string;
  amount: bigint;
}

export interface MerkleEntry extends MerkleClaim {
  proof: string[];
}

export interface MerkleTreeResult {
  root: string;
  entries: MerkleEntry[];
}

function toBuffer32(hexOrBuffer: Buffer): Buffer {
  if (hexOrBuffer.length !== 32) {
    throw new Error(`Expected 32 bytes, received ${hexOrBuffer.length}`);
  }
  return hexOrBuffer;
}

function hashNodes(left: Buffer, right: Buffer): Buffer {
  return Buffer.from(keccak_256(Buffer.concat([left, right])));
}

function leafHash({ index, account, amount }: MerkleClaim): Buffer {
  const indexBuf = Buffer.alloc(4);
  indexBuf.writeUInt32LE(index, 0);

  const amountBuf = Buffer.alloc(8);
  amountBuf.writeBigUInt64LE(amount);

  return Buffer.from(keccak_256(Buffer.concat([indexBuf, new PublicKey(account).toBuffer(), amountBuf])));
}

function buildLevels(claims: MerkleClaim[]): Buffer[][] {
  if (claims.length === 0) {
    throw new Error("Cannot build tree with zero leaves");
  }

  const levels: Buffer[][] = [];
  levels.push(claims.map(leafHash));

  while (levels[levels.length - 1].length > 1) {
    const currentLevel = levels[levels.length - 1];
    const nextLevel: Buffer[] = [];

    for (let i = 0; i < currentLevel.length; i += 2) {
      const left = currentLevel[i];
      const right = i + 1 < currentLevel.length ? currentLevel[i + 1] : currentLevel[i];
      nextLevel.push(hashNodes(left, right));
    }

    levels.push(nextLevel);
  }

  return levels;
}

export function buildMerkleTree(claims: MerkleClaim[]): MerkleTreeResult {
  const levels = buildLevels(claims);
  const root = levels[levels.length - 1][0];

  const entries: MerkleEntry[] = claims.map((claim, idx) => {
    const proof: string[] = [];
    let index = idx;

    for (let level = 0; level < levels.length - 1; level++) {
      const levelNodes = levels[level];
      const isRightNode = index % 2 === 1;
      const siblingIndex = isRightNode ? index - 1 : index + 1;
      const sibling = levelNodes[siblingIndex] ?? levelNodes[index];
      proof.push(toBuffer32(sibling).toString("hex"));
      index = Math.floor(index / 2);
    }

    return {
      ...claim,
      proof,
    };
  });

  return {
    root: toBuffer32(root).toString("hex"),
    entries,
  };
}

export function normalizeClaim(index: number, account: string, amount: string | number | bigint): MerkleClaim {
  const normalizedAmount =
    typeof amount === "bigint" ? amount : typeof amount === "number" ? BigInt(amount) : BigInt(amount);

  return {
    index,
    account: new PublicKey(account).toBase58(),
    amount: normalizedAmount,
  };
}

