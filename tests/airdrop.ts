import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Keypair, PublicKey } from "@solana/web3.js";
import { expect } from "chai";
import { buildMerkleTree, normalizeClaim } from "../shared/merkle";
import {
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  getOrCreateAssociatedTokenAccount,
  transfer,
} from "@solana/spl-token";
import dotenv from "dotenv";
import bs58 from "bs58";

dotenv.config();

const mintAddress = process.env.MINT_ADDRESS;
const adminPrivateKey = process.env.ADMIN_PRIVATE_KEY;
const claimerPrivateKey = process.env.CLAIMER_PRIVATE_KEY;

if (!mintAddress) {
  throw new Error("MINT_ADDRESS must be provided in the environment (.env file).");
}
if (!adminPrivateKey) {
  throw new Error("ADMIN_PRIVATE_KEY must be provided in the environment (.env file).");
}
if (!claimerPrivateKey) {
  throw new Error("CLAIMER_PRIVATE_KEY must be provided in the environment (.env file).");
}

const adminKeypair = Keypair.fromSecretKey(bs58.decode(adminPrivateKey));
const claimerKeypair = Keypair.fromSecretKey(bs58.decode(claimerPrivateKey));
const baseProvider = anchor.AnchorProvider.env();
const provider = new anchor.AnchorProvider(
  baseProvider.connection,
  new anchor.Wallet(adminKeypair),
  baseProvider.opts
);
anchor.setProvider(provider);

type AirdropProgram = Program<any>;
const program = anchor.workspace.Airdrop as AirdropProgram;

const adminPublicKey = adminKeypair.publicKey;
const mintPubkey = new PublicKey(mintAddress);
const adminTokenAccount = getAssociatedTokenAddressSync(mintPubkey, adminPublicKey);

function deriveStatePda(): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("airdrop_state")],
    program.programId
  );
}

function deriveVaultAuthorityPda(): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("airdrop_vault_authority")],
    program.programId
  );
}

const [statePda] = deriveStatePda();
const [vaultAuthority] = deriveVaultAuthorityPda();
const vaultAta = getAssociatedTokenAddressSync(mintPubkey, vaultAuthority, true);

const claimAllocations = [
  normalizeClaim(0, claimerKeypair.publicKey.toBase58(), 500_000_000n),
];
const merkleTree = buildMerkleTree(claimAllocations);
// const merkleRootBuffer = Buffer.from(merkleTree.root, "hex");
const merkleRootBuffer = Buffer.from("0xaeb98c42372c18e3a3441b4ebfa41d93bc52fbd7e06b0878f71bb24c8ad614c5", "hex");
const getProofForIndex = (idx: number) =>
  merkleTree.entries[idx].proof.map((node) => Array.from(Buffer.from(node, "hex").values()));
const claimAllocation = claimAllocations[0];
const claimProof = getProofForIndex(0);

// Claim window timestamps: November 22, 2025 9:00 UTC - November 24, 2025 9:00 UTC
const CLAIM_OPEN_AT = Math.floor(new Date("2025-11-22T09:00:00Z").getTime() / 1000);
const CLAIM_CLOSE_AT = Math.floor(new Date("2025-11-24T09:00:00Z").getTime() / 1000);

describe("airdrop program", () => {
  it("initializes state and vault accounts", async () => {
    const adminAtaInfo = await provider.connection.getAccountInfo(adminTokenAccount);
    if (!adminAtaInfo) {
      throw new Error(
        `Admin token account ${adminTokenAccount.toBase58()} does not exist. Please create and fund it before running tests.`
      );
    }

    const stateAccountInfo = await provider.connection.getAccountInfo(statePda);
    if (!stateAccountInfo) {
      const zeroRoot = Buffer.alloc(32);
      // Set claim window: November 22, 2025 9:00 UTC - November 24, 2025 9:00 UTC
      const claimOpenAt = new anchor.BN(CLAIM_OPEN_AT);
      const claimCloseAt = new anchor.BN(CLAIM_CLOSE_AT);
      
      try {
        const sig = await program.methods
          .initialize(16, Array.from(zeroRoot.values()), claimOpenAt, claimCloseAt)
          .accounts({
            admin: adminPublicKey,
            mint: mintPubkey,
            state: statePda,
            vaultAuthority,
            vault: vaultAta,
            systemProgram: anchor.web3.SystemProgram.programId,
            tokenProgram: TOKEN_PROGRAM_ID,
            associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
            rent: anchor.web3.SYSVAR_RENT_PUBKEY,
          })
          .signers([adminKeypair])
          .rpc();
        console.log("initialize tx:", sig);
        const state = await program.account.airdropState.fetch(statePda);
        expect(state.admin.equals(adminPublicKey)).to.be.true;
        expect(state.mint.equals(mintPubkey)).to.be.true;
        expect(state.claimedBitmap.length).to.equal(Math.ceil(state.maxClaims / 8));
        expect(state.claimOpenAt.toNumber()).to.equal(claimOpenAt.toNumber());
        expect(state.claimCloseAt.toNumber()).to.equal(claimCloseAt.toNumber());

      } catch (error) {
        console.error("initialize failed:", error);
        throw error;
      }
    } else {
      console.log("initialize skipped: state account already exists");
    }
  });

  it("rejects reinitialization", async () => {
    const stateAccountInfo = await provider.connection.getAccountInfo(statePda);
    if (!stateAccountInfo) {
      throw new Error(
        "State account must exist for reinitialization test. Run initialization test first."
      );
    }

    const zeroRoot = Buffer.alloc(32);
    // Set claim window: November 22, 2025 9:00 UTC - November 24, 2025 9:00 UTC
    const claimOpenAt = new anchor.BN(CLAIM_OPEN_AT);
    const claimCloseAt = new anchor.BN(CLAIM_CLOSE_AT);

    let reinitializationRejected = false;
    try {
      await program.methods
        .initialize(16, Array.from(zeroRoot.values()), claimOpenAt, claimCloseAt)
        .accounts({
          admin: adminPublicKey,
          mint: mintPubkey,
          state: statePda,
          vaultAuthority,
          vault: vaultAta,
          systemProgram: anchor.web3.SystemProgram.programId,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          rent: anchor.web3.SYSVAR_RENT_PUBKEY,
        })
        .signers([adminKeypair])
        .rpc();
      console.error("unexpected reinitialization succeeded");
    } catch (error: any) {
      console.log("reinitialization rejected as expected:", error.message);
      // Reinitialization should fail either due to Anchor's init constraint
      // or our custom AlreadyInitialized error check
      reinitializationRejected = true;
    }
    expect(reinitializationRejected).to.be.true;
  });

  it("posts a new merkle root", async () => {
    try {
      const sig = await program.methods
        .postMerkleRoot(Array.from(merkleRootBuffer.values()))
        .accounts({
          state: statePda,
          admin: adminPublicKey,
        })
        .signers([adminKeypair])
        .rpc();
      console.log("post_merkle_root tx:", sig);
    } catch (error) {
      console.error("post_merkle_root failed:", error);
      throw error;
    }

    try {
      const state = await program.account.airdropState.fetch(statePda);
      expect(Buffer.from(state.merkleRoot)).to.deep.equal(merkleRootBuffer);
    } catch (error) {
      console.error("merkle root comparison failed:", error);
      throw error;
    }
  });

  it("funds the vault with SPL tokens (admin can fund)", async () => {
    const deposit = claimAllocation.amount + 100_000_000n;
    const adminBalanceBefore = await provider.connection.getTokenAccountBalance(adminTokenAccount);
    expect(BigInt(adminBalanceBefore.value.amount) > deposit).to.be.true;

    const vaultBefore = await provider.connection.getTokenAccountBalance(vaultAta);

    try {
      const sig = await program.methods
        .fundVault(new anchor.BN(deposit.toString()))
        .accounts({
          state: statePda,
          funder: adminPublicKey,
          funderTokenAccount: adminTokenAccount,
          vaultAuthority,
          vault: vaultAta,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        })
        .signers([adminKeypair])
        .rpc();
      console.log("fund_vault tx:", sig);
    } catch (error) {
      console.error("fund_vault failed:", error);
      throw error;
    }

    const vaultAfter = await provider.connection.getTokenAccountBalance(vaultAta);
    try {
      expect(BigInt(vaultAfter.value.amount)).to.equal(
        BigInt(vaultBefore.value.amount) + deposit
      );
    } catch (error) {
      console.error("vault balance comparison failed:", error);
      throw error;
    }
  });

  it("allows anyone with tokens to fund the vault", async () => {
    // Create a random funder (non-admin)
    const randomFunder = Keypair.generate();
    
    // Airdrop SOL to the random funder for transaction fees
    const airdropSig = await provider.connection.requestAirdrop(
      randomFunder.publicKey,
      1 * anchor.web3.LAMPORTS_PER_SOL
    );
    await provider.connection.confirmTransaction(airdropSig);

    // Create token account for the random funder
    const funderTokenAccount = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      randomFunder,
      mintPubkey,
      randomFunder.publicKey
    );

    // Transfer some tokens from admin to the random funder so they can fund
    // First check if admin has enough tokens
    const adminBalance = await provider.connection.getTokenAccountBalance(adminTokenAccount);
    const testDepositAmount = 1_000_000n; // Small test amount
    
    if (BigInt(adminBalance.value.amount) < testDepositAmount) {
      console.log("Skipping test: admin doesn't have enough tokens to transfer to funder");
      return;
    }

    // Transfer tokens from admin to random funder using SPL token transfer
    try {
      await transfer(
        provider.connection,
        adminKeypair, // payer (for fees)
        adminTokenAccount, // source
        funderTokenAccount.address, // destination
        adminKeypair, // owner (signer)
        Number(testDepositAmount) // amount
      );
    } catch (error) {
      console.error("Failed to transfer tokens to funder:", error);
      throw error;
    }
    
    const vaultBefore = await provider.connection.getTokenAccountBalance(vaultAta);
    const funderBalanceBefore = await provider.connection.getTokenAccountBalance(funderTokenAccount.address);

    // Verify funder received tokens
    expect(BigInt(funderBalanceBefore.value.amount)).to.equal(testDepositAmount);

    const depositAmount = BigInt(funderBalanceBefore.value.amount) / 2n; // Use half of funder's balance
    const depositBN = new anchor.BN(depositAmount.toString());

    try {
      const sig = await program.methods
        .fundVault(depositBN)
        .accounts({
          state: statePda,
          funder: randomFunder.publicKey,
          funderTokenAccount: funderTokenAccount.address,
          vaultAuthority,
          vault: vaultAta,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        })
        .signers([randomFunder])
        .rpc();
      console.log("fund_vault (non-admin) tx:", sig);
    } catch (error) {
      console.error("fund_vault (non-admin) failed:", error);
      throw error;
    }

    const vaultAfter = await provider.connection.getTokenAccountBalance(vaultAta);
    const funderBalanceAfter = await provider.connection.getTokenAccountBalance(funderTokenAccount.address);
    
    try {
      // Verify vault received the tokens
      expect(BigInt(vaultAfter.value.amount)).to.equal(
        BigInt(vaultBefore.value.amount) + depositAmount
      );
      // Verify funder's balance decreased
      expect(BigInt(funderBalanceAfter.value.amount)).to.equal(
        BigInt(funderBalanceBefore.value.amount) - depositAmount
      );
    } catch (error) {
      console.error("vault/funder balance comparison failed:", error);
      throw error;
    }
  });

  it("rejects claim with wrong amount", async () => {
    const claimer = claimerKeypair;

    const claimerAta = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      adminKeypair,
      mintPubkey,
      claimer.publicKey
    );

    let wrongAmountRejected = false;
    try {
      await program.methods
        .claim(new anchor.BN((claimAllocation.amount + 1n).toString()), claimAllocation.index, getProofForIndex(0))
        .accounts({
          claimer: claimer.publicKey,
          state: statePda,
          mint: mintPubkey,
          vaultAuthority,
          vault: vaultAta,
          claimerTokenAccount: claimerAta.address,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: anchor.web3.SystemProgram.programId,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        })
        .signers([claimer])
        .rpc();
      console.error("unexpected wrong-amount claim succeeded");
    } catch (error) {
      console.log("wrong amount claim rejected as expected:", error.message);
      wrongAmountRejected = true;
    }
    expect(wrongAmountRejected).to.be.true;
  });

  it("rejects claim with wrong address", async () => {
    const wrongClaimer = Keypair.generate();
    const wrongClaimerAta = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      adminKeypair,
      mintPubkey,
      wrongClaimer.publicKey
    );

    let wrongAddressRejected = false;
    try {
      await program.methods
        .claim(
          new anchor.BN(claimAllocation.amount.toString()),
          claimAllocation.index,
          getProofForIndex(0)
        )
        .accounts({
          claimer: wrongClaimer.publicKey,
          state: statePda,
          mint: mintPubkey,
          vaultAuthority,
          vault: vaultAta,
          claimerTokenAccount: wrongClaimerAta.address,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: anchor.web3.SystemProgram.programId,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        })
        .signers([wrongClaimer])
        .rpc();
      console.error("unexpected wrong-address claim succeeded");
    } catch (error) {
      console.log("wrong address claim rejected as expected:", error.message);
      wrongAddressRejected = true;
    }
    expect(wrongAddressRejected).to.be.true;
  });

  it("processes a valid claim", async () => {
    const claimer = claimerKeypair;

    const claimerAta = getAssociatedTokenAddressSync(
      mintPubkey,
      claimer.publicKey
    );

    const claimerBalanceBefore = await provider.connection.getTokenAccountBalance(claimerAta);
    const vaultBalanceBefore = await provider.connection.getTokenAccountBalance(vaultAta);
    expect(BigInt(vaultBalanceBefore.value.amount) >= claimAllocation.amount).to.be.true;

    try {
      const sig = await program.methods
        .claim(
          new anchor.BN(claimAllocation.amount.toString()),
          claimAllocation.index,
          claimProof
        )
        .accounts({
          claimer: claimer.publicKey,
          state: statePda,
          mint: mintPubkey,
          vaultAuthority,
          vault: vaultAta,
          claimerTokenAccount: claimerAta,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: anchor.web3.SystemProgram.programId,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        })
        .signers([claimer])
        .rpc();
      console.log("claim tx:", sig);
    } catch (error) {
      console.error("claim failed:", error);
      throw error;
    }

    const claimerBalanceAfter = await provider.connection.getTokenAccountBalance(claimerAta);
    expect(
      BigInt(claimerBalanceAfter.value.amount) - BigInt(claimerBalanceBefore.value.amount)
    ).to.equal(claimAllocation.amount);
  });

  it("rejects a double claim", async () => {
    const claimer = claimerKeypair;

    const claimerAta = getAssociatedTokenAddressSync(
      mintPubkey,
      claimer.publicKey
    );

    let doubleClaimFailed = false;
    try {
      await program.methods
        .claim(
          new anchor.BN(claimAllocation.amount.toString()),
          claimAllocation.index,
          claimProof
        )
        .accounts({
          claimer: claimer.publicKey,
          state: statePda,
          mint: mintPubkey,
          vaultAuthority,
          vault: vaultAta,
          claimerTokenAccount: claimerAta,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: anchor.web3.SystemProgram.programId,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        })
        .signers([claimer])
        .rpc();
      console.error("unexpected double claim succeeded");
    } catch (error) {
      console.log("double claim rejected as expected:", error.message);
      doubleClaimFailed = true;
    }
    expect(doubleClaimFailed).to.be.true;
  });

  it("rejects sweep_lux when airdrop is still open", async () => {
    const state = await program.account.airdropState.fetch(statePda);
    const currentTime = Math.floor(Date.now() / 1000);
    
    // Only test if airdrop is still open (hasn't closed yet)
    if (currentTime > state.claimCloseAt.toNumber()) {
      console.log("sweep_lux rejected test skipped: airdrop is already closed");
      return;
    }

    let sweepRejected = false;
    try {
      await program.methods
        .sweepLux()
        .accounts({
          state: statePda,
          admin: adminPublicKey,
          adminTokenAccount,
          vaultAuthority,
          vault: vaultAta,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([adminKeypair])
        .rpc();
      console.error("unexpected sweep succeeded while airdrop is open");
    } catch (error: any) {
      console.log("sweep rejected as expected when airdrop is open:", error.message);
      // Check if error is AirdropNotClosed
      if (error.message && error.message.includes("Airdrop must be closed")) {
        sweepRejected = true;
      }
    }
    expect(sweepRejected).to.be.true;
  });

  it("sweeps remaining tokens from vault to admin after airdrop closes", async () => {
    const state = await program.account.airdropState.fetch(statePda);
    const currentTime = Math.floor(Date.now() / 1000);
    
    // Only test if airdrop is closed
    if (currentTime <= state.claimCloseAt.toNumber()) {
      console.log("sweep_lux skipped: airdrop is still open (closes at:", state.claimCloseAt.toNumber(), ", current:", currentTime, ")");
      return;
    }

    const adminBalanceBefore = await provider.connection.getTokenAccountBalance(adminTokenAccount);
    const vaultBalanceBefore = await provider.connection.getTokenAccountBalance(vaultAta);
    
    // Only test if there are tokens in the vault
    if (BigInt(vaultBalanceBefore.value.amount) === 0n) {
      console.log("sweep_lux skipped: vault is empty");
      return;
    }

    try {
      const sig = await program.methods
        .sweepLux()
        .accounts({
          state: statePda,
          admin: adminPublicKey,
          adminTokenAccount,
          vaultAuthority,
          vault: vaultAta,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([adminKeypair])
        .rpc();
      console.log("sweep_lux tx:", sig);
    } catch (error) {
      console.error("sweep_lux failed:", error);
      throw error;
    }

    const adminBalanceAfter = await provider.connection.getTokenAccountBalance(adminTokenAccount);
    const vaultBalanceAfter = await provider.connection.getTokenAccountBalance(vaultAta);

    try {
      // Verify all tokens were transferred
      expect(BigInt(vaultBalanceAfter.value.amount)).to.equal(0n);
      expect(
        BigInt(adminBalanceAfter.value.amount) - BigInt(adminBalanceBefore.value.amount)
      ).to.equal(BigInt(vaultBalanceBefore.value.amount));
    } catch (error) {
      console.error("sweep balance comparison failed:", error);
      throw error;
    }
  });

  it("rejects sweep_lux from non-admin", async () => {
    const nonAdmin = Keypair.generate();
    const nonAdminAta = getAssociatedTokenAddressSync(mintPubkey, nonAdmin.publicKey);

    let unauthorizedSweepRejected = false;
    try {
      await program.methods
        .sweepLux()
        .accounts({
          state: statePda,
          admin: nonAdmin.publicKey,
          adminTokenAccount: nonAdminAta,
          vaultAuthority,
          vault: vaultAta,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([nonAdmin])
        .rpc();
      console.error("unexpected unauthorized sweep succeeded");
    } catch (error) {
      console.log("unauthorized sweep rejected as expected:", error.message);
      unauthorizedSweepRejected = true;
    }
    expect(unauthorizedSweepRejected).to.be.true;
  });
});