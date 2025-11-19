use anchor_lang::prelude::*;
use anchor_lang::solana_program::keccak::hashv;
use anchor_spl::{
    associated_token::AssociatedToken,
    token::{self, Mint, Token, TokenAccount},
};

declare_id!("DwaC5fxw2UQCxRPcgjb9spXmiZY4LmAt9bxGS9o5MXmE");

#[program]
pub mod airdrop {
    use super::*;

    pub fn initialize(
        ctx: Context<Initialize>,
        max_claims: u32,
        initial_root: [u8; 32],
        claim_open_at: i64,
        claim_close_at: i64,
    ) -> Result<()> {
        require!(max_claims > 0, AirdropError::InvalidMaxClaims);
        require!(claim_open_at > 0, AirdropError::InvalidTimestamp);
        require!(claim_close_at > claim_open_at, AirdropError::InvalidTimestamp);

        let state = &mut ctx.accounts.state;
        
        // Security: Prevent reinitialization by checking if state is already initialized
        // Anchor's `init` constraint should prevent this, but we add explicit check for defense-in-depth
        require!(
            state.admin == Pubkey::default(),
            AirdropError::AlreadyInitialized
        );

        state.admin = ctx.accounts.admin.key();
        state.mint = ctx.accounts.mint.key();
        state.merkle_root = initial_root;
        state.max_claims = max_claims;
        state.total_claimed = 0;
        state.state_bump = ctx.bumps.state;
        state.vault_bump = ctx.bumps.vault_authority;
        state.claim_open_at = claim_open_at;
        state.claim_close_at = claim_close_at;
        let bitmap_len = bitmap_length(max_claims);
        state.claimed_bitmap = vec![0u8; bitmap_len];

        Ok(())
    }

    pub fn post_merkle_root(ctx: Context<PostMerkleRoot>, new_root: [u8; 32]) -> Result<()> {
        let state = &mut ctx.accounts.state;
        state.merkle_root = new_root;
        Ok(())
    }

    pub fn fund_vault(ctx: Context<FundVault>, amount: u64) -> Result<()> {
        require!(amount > 0, AirdropError::InvalidAmount);

        let transfer_accounts = token::Transfer {
            from: ctx.accounts.admin_token_account.to_account_info(),
            to: ctx.accounts.vault.to_account_info(),
            authority: ctx.accounts.admin.to_account_info(),
        };
        let cpi_ctx = CpiContext::new(ctx.accounts.token_program.to_account_info(), transfer_accounts);
        token::transfer(cpi_ctx, amount)?;

        Ok(())
    }

    pub fn claim(
        ctx: Context<Claim>,
        amount: u64,
        index: u32,
        proof: Vec<[u8; 32]>,
    ) -> Result<()> {
        require!(amount > 0, AirdropError::InvalidAmount);
        let vault_bump;
        {
            let state = &mut ctx.accounts.state;

            // Check claim window
            let clock = Clock::get()?;
            let current_timestamp = clock.unix_timestamp;
            require!(
                current_timestamp >= state.claim_open_at,
                AirdropError::ClaimNotOpen
            );
            require!(
                current_timestamp <= state.claim_close_at,
                AirdropError::ClaimClosed
            );

            ensure_not_claimed(state, index)?;

            let leaf = leaf_hash(index, &ctx.accounts.claimer.key(), amount);
            require!(
                verify(proof, leaf, state.merkle_root, index),
                AirdropError::InvalidProof
            );

            mark_claimed(state, index)?;
            state.total_claimed = state
                .total_claimed
                .checked_add(1)
                .ok_or(AirdropError::NumericalOverflow)?;

            vault_bump = state.vault_bump;
        }

        let transfer_accounts = token::Transfer {
            from: ctx.accounts.vault.to_account_info(),
            to: ctx.accounts.claimer_token_account.to_account_info(),
            authority: ctx.accounts.vault_authority.to_account_info(),
        };
        let signer_seeds: &[&[u8]] = &[b"airdrop_vault_authority", &[vault_bump]];
        let signer_seed_slice = [signer_seeds];
        let cpi_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            transfer_accounts,
            &signer_seed_slice,
        );
        token::transfer(cpi_ctx, amount)?;

        Ok(())
    }

    pub fn sweep_lux(ctx: Context<SweepLux>) -> Result<()> {
        let state = &ctx.accounts.state;
        
        // Ensure airdrop is closed before allowing sweep
        let clock = Clock::get()?;
        let current_timestamp = clock.unix_timestamp;
        require!(
            current_timestamp > state.claim_close_at,
            AirdropError::AirdropNotClosed
        );
        
        let vault_bump = state.vault_bump;
        let vault = &ctx.accounts.vault;

        require!(vault.amount > 0, AirdropError::InvalidAmount);

        let transfer_accounts = token::Transfer {
            from: vault.to_account_info(),
            to: ctx.accounts.admin_token_account.to_account_info(),
            authority: ctx.accounts.vault_authority.to_account_info(),
        };
        let signer_seeds: &[&[u8]] = &[b"airdrop_vault_authority", &[vault_bump]];
        let signer_seed_slice = [signer_seeds];
        let cpi_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            transfer_accounts,
            &signer_seed_slice,
        );
        token::transfer(cpi_ctx, vault.amount)?;

        Ok(())
    }
}

#[derive(Accounts)]
#[instruction(max_claims: u32, claim_open_at: i64, claim_close_at: i64)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    pub mint: Account<'info, Mint>,
    #[account(
        init,
        payer = admin,
        seeds = [b"airdrop_state"],
        bump,
        space = AirdropState::space(max_claims)
    )]
    pub state: Account<'info, AirdropState>,
    /// CHECK: PDA authority for vault operations
    #[account(
        seeds = [b"airdrop_vault_authority"],
        bump
    )]
    pub vault_authority: UncheckedAccount<'info>,
    #[account(
        init,
        payer = admin,
        associated_token::mint = mint,
        associated_token::authority = vault_authority
    )]
    pub vault: Account<'info, TokenAccount>,
    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct PostMerkleRoot<'info> {
    #[account(
        mut,
        seeds = [b"airdrop_state"],
        bump
    )]
    pub state: Account<'info, AirdropState>,
    #[account(
        constraint = admin.key() == state.admin @ AirdropError::Unauthorized
    )]
    pub admin: Signer<'info>,
}

#[derive(Accounts)]
pub struct FundVault<'info> {
    #[account(
        mut,
        seeds = [b"airdrop_state"],
        bump
    )]
    pub state: Account<'info, AirdropState>,
    #[account(
        constraint = admin.key() == state.admin @ AirdropError::Unauthorized
    )]
    pub admin: Signer<'info>,
    #[account(
        mut,
        constraint = admin_token_account.owner == admin.key(),
        constraint = admin_token_account.mint == state.mint
    )]
    pub admin_token_account: Account<'info, TokenAccount>,
    /// CHECK: PDA authority for vault operations
    #[account(
        seeds = [b"airdrop_vault_authority"],
        bump
    )]
    pub vault_authority: UncheckedAccount<'info>,
    #[account(
        mut,
        associated_token::mint = state.mint,
        associated_token::authority = vault_authority
    )]
    pub vault: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
}

#[derive(Accounts)]
pub struct Claim<'info> {
    #[account(
        mut,
        seeds = [b"airdrop_state"],
        bump
    )]
    pub state: Account<'info, AirdropState>,
    #[account(mut)]
    pub claimer: Signer<'info>,
    #[account(
        constraint = mint.key() == state.mint @ AirdropError::InvalidMint
    )]
    pub mint: Account<'info, Mint>,
    /// CHECK: PDA authority for vault operations
    #[account(
        seeds = [b"airdrop_vault_authority"],
        bump
    )]
    pub vault_authority: UncheckedAccount<'info>,
    #[account(
        mut,
        associated_token::mint = mint,
        associated_token::authority = vault_authority
    )]
    pub vault: Account<'info, TokenAccount>,
    #[account(
        init_if_needed,
        payer = claimer,
        associated_token::mint = mint,
        associated_token::authority = claimer
    )]
    pub claimer_token_account: Account<'info, TokenAccount>,
    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,

}

#[derive(Accounts)]
pub struct SweepLux<'info> {
    #[account(
        seeds = [b"airdrop_state"],
        bump
    )]
    pub state: Account<'info, AirdropState>,
    #[account(
        constraint = admin.key() == state.admin @ AirdropError::Unauthorized
    )]
    pub admin: Signer<'info>,
    #[account(
        mut,
        constraint = admin_token_account.owner == admin.key(),
        constraint = admin_token_account.mint == state.mint
    )]
    pub admin_token_account: Account<'info, TokenAccount>,
    /// CHECK: PDA authority for vault operations
    #[account(
        seeds = [b"airdrop_vault_authority"],
        bump
    )]
    pub vault_authority: UncheckedAccount<'info>,
    #[account(
        mut,
        associated_token::mint = state.mint,
        associated_token::authority = vault_authority
    )]
    pub vault: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

#[account]
pub struct AirdropState {
    pub admin: Pubkey,
    pub mint: Pubkey,
    pub merkle_root: [u8; 32],
    pub max_claims: u32,
    pub total_claimed: u32,
    pub state_bump: u8,
    pub vault_bump: u8,
    pub claim_open_at: i64,
    pub claim_close_at: i64,
    pub claimed_bitmap: Vec<u8>,
}

impl AirdropState {
    pub fn space(max_claims: u32) -> usize {
        let bitmap_len = bitmap_length(max_claims);
        8  // anchor discriminator
        + 32 // admin
        + 32 // mint
        + 32 // merkle root
        + 4  // max_claims
        + 4  // total_claimed
        + 1  // state_bump
        + 1  // vault_bump
        + 8  // claim_open_at
        + 8  // claim_close_at
        + 4  // vec length
        + bitmap_len // vec bytes
    }
}

#[error_code]
pub enum AirdropError {
    #[msg("The provided Merkle proof is invalid.")]
    InvalidProof,
    #[msg("This allocation has already been claimed.")]
    AlreadyClaimed,
    #[msg("Only the admin can perform this action.")]
    Unauthorized,
    #[msg("The specified amount is invalid.")]
    InvalidAmount,
    #[msg("The specified maximum number of claims is invalid.")]
    InvalidMaxClaims,
    #[msg("Numerical overflow occurred.")]
    NumericalOverflow,
    #[msg("Claim index is out of range for this airdrop.")]
    IndexOutOfBounds,
    #[msg("The provided mint does not match the airdrop mint.")]
    InvalidMint,
    #[msg("The provided timestamp is invalid.")]
    InvalidTimestamp,
    #[msg("Claim window has not opened yet.")]
    ClaimNotOpen,
    #[msg("Claim window has closed.")]
    ClaimClosed,
    #[msg("Airdrop must be closed before sweeping.")]
    AirdropNotClosed,
    #[msg("The airdrop state has already been initialized.")]
    AlreadyInitialized,
}

fn bitmap_length(max_claims: u32) -> usize {
    ((max_claims as usize + 7) / 8) as usize
}

fn ensure_not_claimed(state: &AirdropState, index: u32) -> Result<()> {
    require!(index < state.max_claims, AirdropError::IndexOutOfBounds);
    let byte_index = (index / 8) as usize;
    let bit = 1 << (index % 8);
    if let Some(byte) = state.claimed_bitmap.get(byte_index) {
        require!(byte & bit == 0, AirdropError::AlreadyClaimed);
        Ok(())
    } else {
        err!(AirdropError::IndexOutOfBounds)
    }
}

fn mark_claimed(state: &mut AirdropState, index: u32) -> Result<()> {
    require!(index < state.max_claims, AirdropError::IndexOutOfBounds);
    let byte_index = (index / 8) as usize;
    let bit = 1 << (index % 8);
    let byte = state
        .claimed_bitmap
        .get_mut(byte_index)
        .ok_or(AirdropError::IndexOutOfBounds)?;
    require!(*byte & bit == 0, AirdropError::AlreadyClaimed);
    *byte |= bit;
    Ok(())
}

fn hash_nodes(left: &[u8; 32], right: &[u8; 32]) -> [u8; 32] {
    hashv(&[left, right]).0
}

fn leaf_hash(index: u32, claimer: &Pubkey, amount: u64) -> [u8; 32] {
    hashv(&[
        &index.to_le_bytes(),
        claimer.as_ref(),
        &amount.to_le_bytes(),
    ])
    .0
}

fn verify(proof: Vec<[u8; 32]>, leaf: [u8; 32], root: [u8; 32], index: u32) -> bool {
    let mut computed = leaf;
    let mut idx = index;

    for sibling in proof.iter() {
        if idx & 1 == 1 {
            computed = hash_nodes(sibling, &computed);
        } else {
            computed = hash_nodes(&computed, sibling);
        }
        idx >>= 1;
    }

    computed == root
}