use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer, MintTo, Burn};

declare_id!("CTFxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx");

#[program]
pub mod conditional_tokens {
    use super::*;

    /// Prepare a condition with a specific oracle, question ID, and outcome count
    /// This is the Gnosis CTF's prepareCondition equivalent
    pub fn prepare_condition(
        ctx: Context<PrepareCondition>,
        question_id: [u8; 32],
        outcome_slot_count: u8,
    ) -> Result<()> {
        require!(outcome_slot_count >= 2 && outcome_slot_count <= 256, ErrorCode::InvalidOutcomeCount);
        
        let condition = &mut ctx.accounts.condition;
        condition.oracle = ctx.accounts.oracle.key();
        condition.question_id = question_id;
        condition.outcome_slot_count = outcome_slot_count;
        condition.is_resolved = false;
        condition.payout_numerators = vec![];
        condition.bump = ctx.bumps.condition;

        // Derive condition_id: keccak256(oracle || question_id || outcome_slot_count)
        let mut data = Vec::new();
        data.extend_from_slice(&ctx.accounts.oracle.key().to_bytes());
        data.extend_from_slice(&question_id);
        data.push(outcome_slot_count);
        condition.condition_id = solana_program::keccak::hash(&data).to_bytes();

        emit!(ConditionPrepared {
            condition_id: condition.condition_id,
            oracle: condition.oracle,
            question_id: condition.question_id,
            outcome_slot_count: condition.outcome_slot_count,
        });

        Ok(())
    }

    /// Split collateral into conditional tokens
    /// This implements the core CTF invariant: 1 collateral = sum of all outcome tokens
    pub fn split_position(
        ctx: Context<SplitPosition>,
        amount: u64,
        partition: Vec<u8>, // Bitmask partition (e.g., [0b01, 0b10] for binary split)
    ) -> Result<()> {
        let condition = &ctx.accounts.condition;
        
        // Validate partition
        require!(!partition.is_empty(), ErrorCode::EmptyPartition);
        require!(validate_partition(&partition, condition.outcome_slot_count), ErrorCode::InvalidPartition);

        // Transfer collateral from user to vault
        let cpi_accounts = Transfer {
            from: ctx.accounts.user_collateral.to_account_info(),
            to: ctx.accounts.vault.to_account_info(),
            authority: ctx.accounts.user.to_account_info(),
        };
        let cpi_program = ctx.accounts.token_program.to_account_info();
        let cpi_ctx = CpiContext::new(cpi_program, cpi_accounts);
        token::transfer(cpi_ctx, amount)?;

        // Mint outcome tokens for each partition element
        // This is the critical invariant: amount of collateral = amount of each outcome token
        let condition_key = ctx.accounts.condition.key();
        let seeds = &[
            b"mint-authority",
            condition_key.as_ref(),
            &[ctx.bumps.mint_authority],
        ];
        let signer = &[&seeds[..]];

        for (i, _index_set) in partition.iter().enumerate() {
            // Mint 'amount' of tokens for this outcome
            let mint_to_accounts = MintTo {
                mint: ctx.accounts.outcome_mints[i].to_account_info(),
                to: ctx.accounts.user_outcome_accounts[i].to_account_info(),
                authority: ctx.accounts.mint_authority.to_account_info(),
            };
            let mint_cpi_ctx = CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                mint_to_accounts,
                signer,
            );
            token::mint_to(mint_cpi_ctx, amount)?;
        }

        emit!(PositionSplit {
            user: ctx.accounts.user.key(),
            collateral_token: ctx.accounts.collateral_mint.key(),
            condition_id: condition.condition_id,
            partition: partition.clone(),
            amount,
        });

        Ok(())
    }

    /// Merge conditional tokens back into collateral
    /// Enforces the inverse invariant: burning all outcomes returns collateral
    pub fn merge_positions(
        ctx: Context<MergePositions>,
        amount: u64,
        partition: Vec<u8>,
    ) -> Result<()> {
        let condition = &ctx.accounts.condition;
        
        // Validate partition
        require!(validate_partition(&partition, condition.outcome_slot_count), ErrorCode::InvalidPartition);

        // Burn outcome tokens from each partition element
        for (i, _index_set) in partition.iter().enumerate() {
            let burn_accounts = Burn {
                mint: ctx.accounts.outcome_mints[i].to_account_info(),
                from: ctx.accounts.user_outcome_accounts[i].to_account_info(),
                authority: ctx.accounts.user.to_account_info(),
            };
            let burn_cpi_ctx = CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                burn_accounts,
            );
            token::burn(burn_cpi_ctx, amount)?;
        }

        // Transfer collateral back to user
        let condition_key = ctx.accounts.condition.key();
        let collateral_mint_key = ctx.accounts.collateral_mint.key();
        let seeds = &[
            b"vault",
            condition_key.as_ref(),
            collateral_mint_key.as_ref(),
            &[ctx.bumps.vault],
        ];
        let signer = &[&seeds[..]];

        let cpi_accounts = Transfer {
            from: ctx.accounts.vault.to_account_info(),
            to: ctx.accounts.user_collateral.to_account_info(),
            authority: ctx.accounts.vault.to_account_info(),
        };
        let cpi_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            cpi_accounts,
            signer,
        );
        token::transfer(cpi_ctx, amount)?;

        emit!(PositionsMerged {
            user: ctx.accounts.user.key(),
            collateral_token: ctx.accounts.collateral_mint.key(),
            condition_id: condition.condition_id,
            partition: partition.clone(),
            amount,
        });

        Ok(())
    }

    /// Resolve a condition with payout numerators
    /// Only the designated oracle can call this
    pub fn report_payout(
        ctx: Context<ReportPayout>,
        payout_numerators: Vec<u64>,
    ) -> Result<()> {
        let condition = &mut ctx.accounts.condition;
        
        require!(!condition.is_resolved, ErrorCode::ConditionAlreadyResolved);
        require!(
            payout_numerators.len() == condition.outcome_slot_count as usize,
            ErrorCode::InvalidPayoutNumerators
        );
        require!(ctx.accounts.oracle.key() == condition.oracle, ErrorCode::UnauthorizedOracle);

        // Validate that sum of payout_numerators > 0
        let sum: u64 = payout_numerators.iter().sum();
        require!(sum > 0, ErrorCode::InvalidPayoutSum);

        condition.is_resolved = true;
        condition.payout_numerators = payout_numerators.clone();

        emit!(ConditionResolved {
            condition_id: condition.condition_id,
            oracle: condition.oracle,
            payout_numerators,
        });

        Ok(())
    }

    /// Redeem winning positions for collateral after condition resolution
    pub fn redeem_positions(
        ctx: Context<RedeemPositions>,
        index_sets: Vec<u8>, // The outcome slots being redeemed
        amount: u64,
    ) -> Result<()> {
        let condition = &ctx.accounts.condition;
        
        require!(condition.is_resolved, ErrorCode::ConditionNotResolved);
        require!(!index_sets.is_empty(), ErrorCode::EmptyIndexSets);

        // Calculate payout for each index set
        let mut total_payout = 0u64;
        let payout_denominator: u64 = condition.payout_numerators.iter().sum();

        for (i, index_set) in index_sets.iter().enumerate() {
            // Calculate payout for this index set
            let payout_numerator = calculate_payout_numerator(&condition.payout_numerators, *index_set);
            let payout = (amount as u128)
                .checked_mul(payout_numerator as u128)
                .unwrap()
                .checked_div(payout_denominator as u128)
                .unwrap() as u64;

            total_payout = total_payout.checked_add(payout).unwrap();

            // Burn the outcome tokens
            let burn_accounts = Burn {
                mint: ctx.accounts.outcome_mints[i].to_account_info(),
                from: ctx.accounts.user_outcome_accounts[i].to_account_info(),
                authority: ctx.accounts.user.to_account_info(),
            };
            let burn_cpi_ctx = CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                burn_accounts,
            );
            token::burn(burn_cpi_ctx, amount)?;
        }

        // Transfer payout to user
        let condition_key = ctx.accounts.condition.key();
        let collateral_mint_key = ctx.accounts.collateral_mint.key();
        let seeds = &[
            b"vault",
            condition_key.as_ref(),
            collateral_mint_key.as_ref(),
            &[ctx.bumps.vault],
        ];
        let signer = &[&seeds[..]];

        let cpi_accounts = Transfer {
            from: ctx.accounts.vault.to_account_info(),
            to: ctx.accounts.user_collateral.to_account_info(),
            authority: ctx.accounts.vault.to_account_info(),
        };
        let cpi_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            cpi_accounts,
            signer,
        );
        token::transfer(cpi_ctx, total_payout)?;

        emit!(PositionsRedeemed {
            user: ctx.accounts.user.key(),
            collateral_token: ctx.accounts.collateral_mint.key(),
            condition_id: condition.condition_id,
            index_sets: index_sets.clone(),
            payout: total_payout,
        });

        Ok(())
    }
}

// ============================================================================
// Account Structures
// ============================================================================

#[derive(Accounts)]
#[instruction(question_id: [u8; 32], outcome_slot_count: u8)]
pub struct PrepareCondition<'info> {
    #[account(
        init,
        payer = payer,
        space = 8 + Condition::INIT_SPACE,
        seeds = [b"condition", oracle.key().as_ref(), question_id.as_ref()],
        bump
    )]
    pub condition: Account<'info, Condition>,
    
    /// CHECK: Oracle address that will resolve this condition
    pub oracle: AccountInfo<'info>,
    
    #[account(mut)]
    pub payer: Signer<'info>,
    
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SplitPosition<'info> {
    #[account(mut)]
    pub user: Signer<'info>,
    
    pub condition: Account<'info, Condition>,
    
    pub collateral_mint: Account<'info, Mint>,
    
    #[account(
        mut,
        associated_token::mint = collateral_mint,
        associated_token::authority = user,
    )]
    pub user_collateral: Account<'info, TokenAccount>,
    
    #[account(
        mut,
        seeds = [b"vault", condition.key().as_ref(), collateral_mint.key().as_ref()],
        bump,
        token::mint = collateral_mint,
        token::authority = vault,
    )]
    pub vault: Account<'info, TokenAccount>,
    
    /// CHECK: PDA that has authority to mint outcome tokens
    #[account(
        seeds = [b"mint-authority", condition.key().as_ref()],
        bump
    )]
    pub mint_authority: AccountInfo<'info>,
    
    // Remaining accounts:
    // - outcome_mints: Vec<Account<'info, Mint>>
    // - user_outcome_accounts: Vec<Account<'info, TokenAccount>>
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct MergePositions<'info> {
    #[account(mut)]
    pub user: Signer<'info>,
    
    pub condition: Account<'info, Condition>,
    
    pub collateral_mint: Account<'info, Mint>,
    
    #[account(
        mut,
        associated_token::mint = collateral_mint,
        associated_token::authority = user,
    )]
    pub user_collateral: Account<'info, TokenAccount>,
    
    #[account(
        mut,
        seeds = [b"vault", condition.key().as_ref(), collateral_mint.key().as_ref()],
        bump,
        token::mint = collateral_mint,
        token::authority = vault,
    )]
    pub vault: Account<'info, TokenAccount>,
    
    // Remaining accounts:
    // - outcome_mints: Vec<Account<'info, Mint>>
    // - user_outcome_accounts: Vec<Account<'info, TokenAccount>>
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct ReportPayout<'info> {
    #[account(mut)]
    pub condition: Account<'info, Condition>,
    
    pub oracle: Signer<'info>,
}

#[derive(Accounts)]
pub struct RedeemPositions<'info> {
    #[account(mut)]
    pub user: Signer<'info>,
    
    pub condition: Account<'info, Condition>,
    
    pub collateral_mint: Account<'info, Mint>,
    
    #[account(
        mut,
        associated_token::mint = collateral_mint,
        associated_token::authority = user,
    )]
    pub user_collateral: Account<'info, TokenAccount>,
    
    #[account(
        mut,
        seeds = [b"vault", condition.key().as_ref(), collateral_mint.key().as_ref()],
        bump,
        token::mint = collateral_mint,
        token::authority = vault,
    )]
    pub vault: Account<'info, TokenAccount>,
    
    // Remaining accounts:
    // - outcome_mints: Vec<Account<'info, Mint>>
    // - user_outcome_accounts: Vec<Account<'info, TokenAccount>>
    pub token_program: Program<'info, Token>,
}

// ============================================================================
// State Accounts
// ============================================================================

#[account]
#[derive(InitSpace)]
pub struct Condition {
    pub oracle: Pubkey,                    // 32 bytes
    pub question_id: [u8; 32],             // 32 bytes
    pub outcome_slot_count: u8,            // 1 byte
    pub is_resolved: bool,                 // 1 byte
    pub condition_id: [u8; 32],            // 32 bytes (keccak hash)
    #[max_len(256)]
    pub payout_numerators: Vec<u64>,       // Max 256 outcomes
    pub bump: u8,                          // 1 byte
}

// ============================================================================
// Events
// ============================================================================

#[event]
pub struct ConditionPrepared {
    pub condition_id: [u8; 32],
    pub oracle: Pubkey,
    pub question_id: [u8; 32],
    pub outcome_slot_count: u8,
}

#[event]
pub struct PositionSplit {
    pub user: Pubkey,
    pub collateral_token: Pubkey,
    pub condition_id: [u8; 32],
    pub partition: Vec<u8>,
    pub amount: u64,
}

#[event]
pub struct PositionsMerged {
    pub user: Pubkey,
    pub collateral_token: Pubkey,
    pub condition_id: [u8; 32],
    pub partition: Vec<u8>,
    pub amount: u64,
}

#[event]
pub struct ConditionResolved {
    pub condition_id: [u8; 32],
    pub oracle: Pubkey,
    pub payout_numerators: Vec<u64>,
}

#[event]
pub struct PositionsRedeemed {
    pub user: Pubkey,
    pub collateral_token: Pubkey,
    pub condition_id: [u8; 32],
    pub index_sets: Vec<u8>,
    pub payout: u64,
}

// ============================================================================
// Helper Functions
// ============================================================================

/// Validates that a partition is non-trivial and covers all outcome slots exactly once
fn validate_partition(partition: &[u8], outcome_slot_count: u8) -> bool {
    if partition.is_empty() || partition.len() == 1 {
        return false; // Trivial partition
    }

    let full_index_set = (1u64 << outcome_slot_count) - 1;
    let mut union = 0u64;

    for &index_set in partition {
        let index_set_u64 = index_set as u64;
        
        // Check for overlap with existing union
        if (union & index_set_u64) != 0 {
            return false; // Overlapping sets
        }
        
        // Check if index_set is within valid range
        if index_set_u64 > full_index_set {
            return false; // Invalid index set
        }
        
        union |= index_set_u64;
    }

    // Check if union covers all outcome slots
    union == full_index_set
}

/// Calculate the payout numerator for a given index set
fn calculate_payout_numerator(payout_numerators: &[u64], index_set: u8) -> u64 {
    let mut payout = 0u64;
    
    for (i, &numerator) in payout_numerators.iter().enumerate() {
        if (index_set & (1 << i)) != 0 {
            payout = payout.checked_add(numerator).unwrap();
        }
    }
    
    payout
}

// ============================================================================
// Errors
// ============================================================================

#[error_code]
pub enum ErrorCode {
    #[msg("Invalid outcome count. Must be between 2 and 256.")]
    InvalidOutcomeCount,
    
    #[msg("Empty partition provided.")]
    EmptyPartition,
    
    #[msg("Invalid partition. Must be non-trivial and cover all outcomes exactly once.")]
    InvalidPartition,
    
    #[msg("Condition already resolved.")]
    ConditionAlreadyResolved,
    
    #[msg("Invalid payout numerators length.")]
    InvalidPayoutNumerators,
    
    #[msg("Unauthorized oracle.")]
    UnauthorizedOracle,
    
    #[msg("Invalid payout sum. Must be greater than zero.")]
    InvalidPayoutSum,
    
    #[msg("Condition not resolved yet.")]
    ConditionNotResolved,
    
    #[msg("Empty index sets.")]
    EmptyIndexSets,
}
