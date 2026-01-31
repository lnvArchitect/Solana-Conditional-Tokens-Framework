# Gnosis CTF on Solana: Technical Implementation Guide

## Overview

This implementation replicates the Gnosis Conditional Tokens Framework (CTF) on Solana using Anchor. The core innovation of CTF is the ability to create **combinatorial prediction markets** through "deep splits" - splitting conditional tokens into further conditional tokens.

## Core Invariants

### 1. The Fundamental Equation

```
1 Collateral = Σ(All Outcome Tokens)
```

When you split 1 USDC into a binary market (YES/NO), you receive:
- 1 YES token
- 1 NO token

This means: `1 USDC = 1 YES + 1 NO`

### 2. The Merge Invariant (Inverse)

```
Σ(All Outcome Tokens) → 1 Collateral
```

If you hold 1 YES + 1 NO, you can merge them back to get 1 USDC at any time before resolution. This is the **"No Loss" property** that makes CTF powerful for market makers.

## Architecture Differences: EVM vs Solana

### Gnosis (EVM) Approach

```solidity
// ERC-1155 multi-token standard
contract ConditionalTokens is ERC1155 {
    // Single contract manages all positions
    mapping(uint256 => uint256) internal _balances;
    
    // Position ID = hash(collateralToken, collectionId)
    // Collection ID = hash(conditionId, indexSet)
}
```

**Key Features:**
- Single contract holds all collateral
- Uses bitmasks to represent outcome sets
- Position IDs are deterministically derived hashes

### Solana Approach (Our Implementation)

```rust
// Separate SPL Token Mints for each outcome
pub struct Condition {
    pub oracle: Pubkey,
    pub condition_id: [u8; 32],
    pub outcome_slot_count: u8,
    // ...
}

// Each outcome is a distinct Mint
// YES_Mint, NO_Mint, etc.
```

**Key Features:**
- Vault PDA holds collateral per condition
- Each outcome is a separate SPL Token with its own Mint
- Program acts as Mint Authority for outcome tokens
- Uses PDA (Program Derived Addresses) for deterministic addresses

## Deep Splits: Combinatorial Markets

### Example: Nested Conditional Markets

**Scenario:**
1. **Primary Market**: "Will Trump win the 2024 election?"
   - Collateral: USDC
   - Outcomes: YES, NO

2. **Secondary Market** (conditional on YES): "If Trump wins, will he fire the Fed Chair?"
   - Collateral: **YES tokens from Market 1**
   - Outcomes: FIRES_CHAIR, KEEPS_CHAIR

### Implementation Flow

```typescript
// Step 1: Create primary condition
const primaryCondition = await program.methods
  .prepareCondition(questionId1, 2)
  .accounts({
    condition: primaryConditionPda,
    oracle: oracleKeypair.publicKey,
    // ...
  })
  .rpc();

// Step 2: Split USDC into YES/NO
await program.methods
  .splitPosition(new BN(1_000_000), [0b01, 0b10])
  .accounts({
    collateralMint: usdcMint, // USDC
    // ...
  })
  .rpc();

// Step 3: Create secondary condition
const secondaryCondition = await program.methods
  .prepareCondition(questionId2, 2)
  .accounts({
    condition: secondaryConditionPda,
    oracle: oracleKeypair.publicKey,
    // ...
  })
  .rpc();

// Step 4: Split YES tokens into FIRES_CHAIR/KEEPS_CHAIR
await program.methods
  .splitPosition(new BN(500_000), [0b01, 0b10])
  .accounts({
    collateralMint: yesMint, // YES tokens as collateral!
    // ...
  })
  .rpc();
```

### Result: Token Hierarchy

```
USDC (Base Collateral)
├── YES (Primary Market)
│   ├── FIRES_CHAIR (Secondary Market)
│   └── KEEPS_CHAIR (Secondary Market)
└── NO (Primary Market)
```

### Mathematical Properties

If you hold:
- 1 FIRES_CHAIR token
- 1 KEEPS_CHAIR token

You can merge them to get: **1 YES token**

Then, if you also hold 1 NO token, you can merge to get: **1 USDC**

This creates a **dependency chain**:
```
USDC → YES → FIRES_CHAIR
```

## Collection IDs and Position IDs

### Gnosis Approach (EVM)

```solidity
// Collection ID encodes outcome set
bytes32 collectionId = keccak256(
    abi.encodePacked(
        parentCollectionId,
        conditionId,
        indexSet  // Bitmask: 0b01, 0b10, 0b11, etc.
    )
);

// Position ID combines collateral + collection
uint256 positionId = uint256(keccak256(
    abi.encodePacked(
        collateralToken,
        collectionId
    )
));
```

**Bitmask Semantics:**
- `0b01` = Outcome 0 only
- `0b10` = Outcome 1 only  
- `0b11` = Outcomes 0 AND 1 (compound position)

### Solana Approach

On Solana, we use **distinct Mint accounts** instead of a single ID space:

```rust
// Each outcome has its own Mint
let yes_mint = create_mint(
    connection,
    payer,
    mint_authority_pda, // Program controls minting
    None,
    6 // decimals
);

let no_mint = create_mint(
    connection,
    payer,
    mint_authority_pda,
    None,
    6
);
```

**PDA Seeds for Determinism:**
```rust
// Vault PDA (holds collateral)
let (vault_pda, _) = Pubkey::find_program_address(
    &[
        b"vault",
        condition_pubkey.as_ref(),
        collateral_mint.as_ref(),
    ],
    program_id
);

// Mint Authority PDA
let (mint_authority_pda, _) = Pubkey::find_program_address(
    &[
        b"mint-authority",
        condition_pubkey.as_ref(),
    ],
    program_id
);
```

## Partition Validation

A **partition** divides outcome slots into disjoint sets that cover all possibilities.

### Valid Partitions (Binary Market)

```rust
// Full index set for 2 outcomes: 0b11
[0b01, 0b10]  // ✓ Valid: {0} ∪ {1} = {0,1}, no overlap
```

### Invalid Partitions

```rust
[0b11]         // ✗ Trivial: all outcomes in one set
[0b01, 0b01]   // ✗ Duplicate sets
[0b11, 0b01]   // ✗ Overlapping: {0,1} ∩ {0} ≠ ∅
[0b01]         // ✗ Incomplete: missing outcome 1
[]             // ✗ Empty
```

### Validation Algorithm

```rust
fn validate_partition(partition: &[u8], outcome_slot_count: u8) -> bool {
    if partition.is_empty() || partition.len() == 1 {
        return false; // Trivial
    }

    let full_index_set = (1u64 << outcome_slot_count) - 1;
    let mut union = 0u64;

    for &index_set in partition {
        let index_set_u64 = index_set as u64;
        
        // Check overlap
        if (union & index_set_u64) != 0 {
            return false;
        }
        
        // Check validity
        if index_set_u64 > full_index_set {
            return false;
        }
        
        union |= index_set_u64;
    }

    // Check completeness
    union == full_index_set
}
```

## Resolution and Redemption

### Oracle Resolution

Only the designated oracle can resolve a condition:

```rust
pub fn report_payout(
    ctx: Context<ReportPayout>,
    payout_numerators: Vec<u64>,
) -> Result<()> {
    require!(
        ctx.accounts.oracle.key() == condition.oracle,
        ErrorCode::UnauthorizedOracle
    );
    
    condition.payout_numerators = payout_numerators;
    condition.is_resolved = true;
    
    Ok(())
}
```

### Payout Calculation

For a binary market with YES winning:
```
payout_numerators = [0, 1]  // NO=0%, YES=100%
payout_denominator = 0 + 1 = 1

If you hold 100 YES tokens:
payout = (100 * 1) / 1 = 100 USDC
```

For a partial resolution (50/50 split):
```
payout_numerators = [1, 1]  // Both get 50%
payout_denominator = 1 + 1 = 2

If you hold 100 YES tokens:
payout = (100 * 1) / 2 = 50 USDC
```

### Redemption Implementation

```rust
pub fn redeem_positions(
    ctx: Context<RedeemPositions>,
    index_sets: Vec<u8>,
    amount: u64,
) -> Result<()> {
    require!(condition.is_resolved, ErrorCode::ConditionNotResolved);
    
    let payout_denominator: u64 = condition.payout_numerators.iter().sum();
    let mut total_payout = 0u64;

    for (i, &index_set) in index_sets.iter().enumerate() {
        // Calculate payout for this index set
        let payout_numerator = calculate_payout_numerator(
            &condition.payout_numerators,
            index_set
        );
        
        let payout = (amount as u128)
            .checked_mul(payout_numerator as u128)
            .unwrap()
            .checked_div(payout_denominator as u128)
            .unwrap() as u64;
        
        total_payout += payout;
        
        // Burn outcome tokens
        token::burn(/* ... */)?;
    }
    
    // Transfer collateral payout to user
    token::transfer(/* ... */, total_payout)?;
    
    Ok(())
}
```

## Oracle Integration

The program is **oracle-agnostic**. The resolution authority can be:

### 1. Switchboard Function
```typescript
const oracleKeypair = switchboardFunction.getAuthority();
```

### 2. Pyth Price Feed
```typescript
const oracleKeypair = pythAggregator.getAuthority();
```

### 3. Multisig DAO
```typescript
const oracleKeypair = squadsMultisig.getAuthority();
```

### 4. Human Oracle
```typescript
const oracleKeypair = realityEthBridge.getAuthority();
```

## Gas Optimization

### Batch Operations

Instead of calling `split_position` multiple times, use Solana's transaction parallelization:

```typescript
const tx = new Transaction();

// Add multiple split instructions
for (const condition of conditions) {
  tx.add(
    await program.methods
      .splitPosition(amount, partition)
      .accounts({ /* ... */ })
      .instruction()
  );
}

await provider.sendAndConfirm(tx);
```

### Account Reuse

Reuse token accounts across multiple conditions:

```typescript
const userYesAccount = await getOrCreateAssociatedTokenAccount(
  connection,
  payer,
  yesMint,
  user.publicKey
);

// Reuse this account for all YES token operations
```

## Security Considerations

### 1. Mint Authority Protection

The program must be the **sole mint authority** for outcome tokens:

```rust
#[account(
    seeds = [b"mint-authority", condition.key().as_ref()],
    bump
)]
pub mint_authority: AccountInfo<'info>,
```

Never transfer mint authority to users or external programs.

### 2. Vault Isolation

Each condition + collateral pair has its own vault:

```rust
#[account(
    seeds = [
        b"vault",
        condition.key().as_ref(),
        collateral_mint.key().as_ref()
    ],
    bump
)]
pub vault: Account<'info, TokenAccount>,
```

This prevents cross-contamination between markets.

### 3. Integer Overflow Protection

Always use checked arithmetic:

```rust
let payout = (amount as u128)
    .checked_mul(payout_numerator as u128)
    .unwrap()
    .checked_div(payout_denominator as u128)
    .unwrap() as u64;
```

### 4. Reentrancy Prevention

Anchor's account constraints prevent reentrancy by default, but be cautious with CPI calls:

```rust
// Burn BEFORE transferring
token::burn(ctx, amount)?;
token::transfer(ctx, amount)?; // Safe: already burned
```

## Testing Strategy

### Unit Tests
- Partition validation logic
- Payout calculation accuracy
- Integer overflow edge cases

### Integration Tests
- Full split → merge → redeem flow
- Multi-condition deep splits
- Oracle resolution scenarios

### Fuzz Tests
- Random partition generation
- Large number combinations
- Extreme payout ratios

## Deployment Checklist

- [ ] Deploy program to devnet
- [ ] Initialize collateral mints (USDC, etc.)
- [ ] Create outcome mints for each market
- [ ] Set up oracle accounts
- [ ] Test split/merge with real tokens
- [ ] Verify vault balances match invariants
- [ ] Test resolution and redemption
- [ ] Security audit
- [ ] Deploy to mainnet

## Future Enhancements

### 1. Composite Positions

Support trading compound positions (multiple outcomes):

```rust
// Trade a position that wins if EITHER outcome 0 OR 1 happens
index_set = 0b11  // Represents {0, 1}
```

### 2. Liquidity Pools

Integrate with AMMs (Orca, Raydium) to provide automated market making:

```typescript
// Create a constant product AMM for YES/NO tokens
const pool = await createPool(yesMint, noMint, feeRate);
```

### 3. Cross-Chain Markets

Use Wormhole to enable cross-chain conditional tokens:

```typescript
// Bridge YES tokens from Solana to Ethereum
const bridgedYes = await wormhole.bridge(yesMint, targetChain);
```

## References

- [Gnosis CTF Contracts](https://github.com/gnosis/conditional-tokens-contracts)
- [Gnosis CTF Documentation](https://docs.gnosis.io/conditionaltokens/)
- [Anchor Framework](https://www.anchor-lang.com/)
- [Solana Token Program](https://www.solana-program.com/docs/token)
- [ERC-1155 Standard](https://eips.ethereum.org/EIPS/eip-1155)

## Contact & Support

For questions or contributions:
- GitHub Issues: [Your Repo]
- Discord: [Your Server]
- Twitter: [@YourHandle]
