# Airdrop Program

This repository contains an Anchor-based Solana program that manages a token airdrop backed by a Merkle tree. An administrator initializes the airdrop, funds a program vault, and posts Merkle roots that describe who can claim. Eligible users provide a Merkle proof when claiming and the on-chain program enforces one-claim-per-index logic using a compact bitmap.

## Features
- Initialize an airdrop with a configurable maximum number of claims.
- Post updated Merkle roots as the recipient list evolves.
- Fund an SPL token vault owned by a program-derived address (PDA).
- Verify claims on-chain using Keccak-based Merkle proofs and reject double claims.
- Utility script to generate Merkle roots and proofs from CSV allocation files.
- Integration tests covering the full happy path plus common failure scenarios.

## Project Structure
- `programs/airdrop`: Anchor program (Rust) that tracks state, validates proofs, and moves tokens.
- `shared/merkle.ts`: Shared TypeScript utilities for hashing and tree construction.
- `scripts/generate-merkle.ts`: CLI script that turns a CSV manifest into a Merkle tree JSON artifact.
- `tests/airdrop.ts`: Anchor integration tests driven by environment-configured keypairs and mint accounts.
- `examples/airdrop.csv`: Sample input for generating a Merkle tree.

## Prerequisites
- [Rust](https://www.rust-lang.org/tools/install) and [Anchor CLI](https://www.anchor-lang.com/docs/installation) (v0.30.x) for building the Solana program.
- Solana tool suite (`solana` CLI) configured for your target cluster.
- Node.js 18+ with `npm`.
- A funded admin keypair that holds the SPL tokens you plan to airdrop.

## Install
```bash
npm install
anchor build
```

## Environment
Create a `.env` file at the repository root before running the tests. Required variables:
```
MINT_ADDRESS=<base58 spl token mint>
ADMIN_PRIVATE_KEY=<base58 encoded secret key of admin>
CLAIMER_PRIVATE_KEY=<base58 encoded secret key of test claimer>
```
> The admin secret key must correspond to an account with an associated token account funded for `MINT_ADDRESS`.

## Generate a Merkle Tree
Use the included CSV example or supply your own with `address,amount` headers. The script validates amounts fit in `u64` and outputs a JSON artifact that can be posted on-chain.
```bash
npm run generate:merkle -- examples/airdrop.csv output/airdrop.json
```
The resulting JSON contains the Merkle root and per-index proofs that claimants will supply to the `claim` instruction.

## Local Testing
1. Ensure your validator or target cluster contains the accounts referenced in `.env`.
2. Fund the admin's associated token account with enough SPL tokens to cover all claims.
3. Run the Anchor test suite:
   ```bash
   anchor test
   ```
   The tests will initialize the program (if needed), post a Merkle root, fund the vault, execute positive and negative claim scenarios, and guard against double claims.

## Deployment & Interaction
- Update `Anchor.toml` with the desired cluster RPC URL and program ID if deploying outside localnet.
- Deploy the program:
  ```bash
  anchor deploy
  ```
- Once deployed:
  1. Call `initialize` with the maximum number of claims and an initial (possibly zeroed) Merkle root.
  2. Fund the vault via `fund_vault`.
  3. Post Merkle roots whenever you publish a new allocation snapshot.
  4. Distribute proofs to recipients; they invoke `claim` with `{amount, index, proof}`.

## Troubleshooting
- **Program ID mismatch:** Ensure `declare_id!` in `programs/airdrop/src/lib.rs` matches the deployed program key and the entry in `Anchor.toml`.
- **Missing token accounts:** Create the admin and claimer associated token accounts for the specified mint before running tests (`spl-token create-account <mint>`).
- **RPC errors during tests:** Confirm `.env` points to a reachable cluster and set `ANCHOR_PROVIDER_URL` if you are not using localnet.

## License
MIT © Luxx