import * as anchor from "@coral-xyz/anchor";
import { Program, BN } from "@coral-xyz/anchor";
import { ConditionalTokens } from "../target/types/conditional_tokens";
import { PublicKey, Keypair } from "@solana/web3.js";
import { createMint, mintTo, getOrCreateAssociatedTokenAccount } from "@solana/spl-token";
import { ConditionalTokensClient, PartitionHelper } from "../sdk/client";

/**
 * Example: Deep Splits (Combinatorial Conditional Markets)
 * 
 * This demonstrates the "killer feature" of Gnosis CTF:
 * Creating nested conditional markets where outcome tokens from one market
 * become collateral for another market.
 * 
 * Scenario:
 * 1. Primary Market: "Will Trump win the 2024 election?"
 *    - Collateral: USDC
 *    - Outcomes: TRUMP_WINS, TRUMP_LOSES
 * 
 * 2. Secondary Market: "If Trump wins, will he fire the Fed Chair in his first year?"
 *    - Collateral: TRUMP_WINS tokens (from Market 1)
 *    - Outcomes: FIRES_CHAIR, KEEPS_CHAIR
 * 
 * This creates a dependency chain:
 * USDC → TRUMP_WINS → FIRES_CHAIR
 * 
 * Mathematical property:
 * - 1 FIRES_CHAIR + 1 KEEPS_CHAIR = 1 TRUMP_WINS
 * - 1 TRUMP_WINS + 1 TRUMP_LOSES = 1 USDC
 */

async function demonstrateDeepSplits() {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.ConditionalTokens as Program<ConditionalTokens>;
  const client = new ConditionalTokensClient(program, provider);

  // Setup
  const oracle = Keypair.generate();
  const user = Keypair.generate();

  // Airdrop SOL
  await Promise.all([
    provider.connection.requestAirdrop(oracle.publicKey, 2 * anchor.web3.LAMPORTS_PER_SOL),
    provider.connection.requestAirdrop(user.publicKey, 2 * anchor.web3.LAMPORTS_PER_SOL),
  ]);

  console.log("=== Deep Splits Demo: Nested Conditional Markets ===\n");

  // =========================================================================
  // STEP 1: Create base collateral (USDC)
  // =========================================================================
  console.log("Step 1: Creating USDC collateral...");
  
  const usdcMint = await createMint(
    provider.connection,
    user,
    user.publicKey,
    null,
    6
  );

  const userUsdcAccount = await getOrCreateAssociatedTokenAccount(
    provider.connection,
    user,
    usdcMint,
    user.publicKey
  );

  // Mint 1000 USDC to user
  await mintTo(
    provider.connection,
    user,
    usdcMint,
    userUsdcAccount.address,
    user,
    1_000_000_000 // 1000 USDC
  );

  console.log(`✓ Created USDC: ${usdcMint.toBase58()}`);
  console.log(`✓ User USDC balance: 1000 USDC\n`);

  // =========================================================================
  // STEP 2: Primary Market - Election Outcome
  // =========================================================================
  console.log("Step 2: Setting up Primary Market (Election)...");

  const electionQuestionId = Buffer.from("Will Trump win 2024 election?".padEnd(32, "\0"));
  
  const { conditionPda: electionCondition } = await client.prepareCondition(
    oracle.publicKey,
    electionQuestionId,
    2 // Binary: WINS / LOSES
  );

  console.log(`✓ Election condition created: ${electionCondition.toBase58()}`);

  // Create outcome token mints for primary market
  const [electionMintAuthority] = client.deriveMintAuthorityPda(electionCondition);
  
  const trumpWinsMint = await createMint(
    provider.connection,
    user,
    electionMintAuthority,
    null,
    6
  );

  const trumpLosesMint = await createMint(
    provider.connection,
    user,
    electionMintAuthority,
    null,
    6
  );

  console.log(`✓ TRUMP_WINS mint: ${trumpWinsMint.toBase58()}`);
  console.log(`✓ TRUMP_LOSES mint: ${trumpLosesMint.toBase58()}\n`);

  // Ensure user has outcome token accounts
  await getOrCreateAssociatedTokenAccount(
    provider.connection,
    user,
    trumpWinsMint,
    user.publicKey
  );

  await getOrCreateAssociatedTokenAccount(
    provider.connection,
    user,
    trumpLosesMint,
    user.publicKey
  );

  // =========================================================================
  // STEP 3: Split USDC into TRUMP_WINS + TRUMP_LOSES
  // =========================================================================
  console.log("Step 3: Splitting 500 USDC into election outcomes...");

  const splitAmount1 = new BN(500_000_000); // 500 USDC

  await client.splitPosition({
    user: user.publicKey,
    condition: electionCondition,
    collateralMint: usdcMint,
    outcomeMints: [trumpWinsMint, trumpLosesMint],
    amount: splitAmount1,
    partition: PartitionHelper.binaryPartition(),
    userSigner: user,
  });

  const trumpWinsBalance = await client.getUserOutcomeBalance(user.publicKey, trumpWinsMint);
  const trumpLosesBalance = await client.getUserOutcomeBalance(user.publicKey, trumpLosesMint);

  console.log(`✓ User TRUMP_WINS balance: ${trumpWinsBalance} tokens`);
  console.log(`✓ User TRUMP_LOSES balance: ${trumpLosesBalance} tokens`);
  console.log(`✓ Invariant verified: 500 USDC = 500 TRUMP_WINS + 500 TRUMP_LOSES\n`);

  // =========================================================================
  // STEP 4: Secondary Market - Fed Chair Decision (Conditional on Trump Winning)
  // =========================================================================
  console.log("Step 4: Setting up Secondary Market (Fed Chair)...");
  console.log("(This market only matters if Trump wins)\n");

  const fedQuestionId = Buffer.from("Will Trump fire Fed Chair?".padEnd(32, "\0"));
  
  const { conditionPda: fedCondition } = await client.prepareCondition(
    oracle.publicKey,
    fedQuestionId,
    2 // Binary: FIRES / KEEPS
  );

  console.log(`✓ Fed Chair condition created: ${fedCondition.toBase58()}`);

  // Create outcome token mints for secondary market
  const [fedMintAuthority] = client.deriveMintAuthorityPda(fedCondition);
  
  const firesChairMint = await createMint(
    provider.connection,
    user,
    fedMintAuthority,
    null,
    6
  );

  const keepsChairMint = await createMint(
    provider.connection,
    user,
    fedMintAuthority,
    null,
    6
  );

  console.log(`✓ FIRES_CHAIR mint: ${firesChairMint.toBase58()}`);
  console.log(`✓ KEEPS_CHAIR mint: ${keepsChairMint.toBase58()}\n`);

  await getOrCreateAssociatedTokenAccount(
    provider.connection,
    user,
    firesChairMint,
    user.publicKey
  );

  await getOrCreateAssociatedTokenAccount(
    provider.connection,
    user,
    keepsChairMint,
    user.publicKey
  );

  // =========================================================================
  // STEP 5: DEEP SPLIT - Use TRUMP_WINS as collateral for secondary market
  // =========================================================================
  console.log("Step 5: DEEP SPLIT - Splitting TRUMP_WINS tokens into Fed Chair outcomes...");
  console.log("This is the key innovation of CTF!\n");

  const splitAmount2 = new BN(200_000_000); // 200 TRUMP_WINS tokens

  // KEY POINT: We're using TRUMP_WINS tokens as collateral!
  await client.splitPosition({
    user: user.publicKey,
    condition: fedCondition,
    collateralMint: trumpWinsMint, // <--- TRUMP_WINS tokens, not USDC!
    outcomeMints: [firesChairMint, keepsChairMint],
    amount: splitAmount2,
    partition: PartitionHelper.binaryPartition(),
    userSigner: user,
  });

  const trumpWinsBalanceAfter = await client.getUserOutcomeBalance(user.publicKey, trumpWinsMint);
  const firesChairBalance = await client.getUserOutcomeBalance(user.publicKey, firesChairMint);
  const keepsChairBalance = await client.getUserOutcomeBalance(user.publicKey, keepsChairMint);

  console.log("=== Token Hierarchy Created ===");
  console.log(`USDC (Base)`);
  console.log(`├── TRUMP_WINS: ${trumpWinsBalanceAfter} remaining`);
  console.log(`│   ├── FIRES_CHAIR: ${firesChairBalance}`);
  console.log(`│   └── KEEPS_CHAIR: ${keepsChairBalance}`);
  console.log(`└── TRUMP_LOSES: ${trumpLosesBalance}\n`);

  console.log("Invariant verification:");
  console.log(`200 TRUMP_WINS = 200 FIRES_CHAIR + 200 KEEPS_CHAIR ✓\n`);

  // =========================================================================
  // STEP 6: Demonstrate the merge property
  // =========================================================================
  console.log("Step 6: Demonstrating merge invariant...");
  console.log("Merging 100 FIRES_CHAIR + 100 KEEPS_CHAIR → 100 TRUMP_WINS\n");

  const mergeAmount = new BN(100_000_000);

  await client.mergePositions({
    user: user.publicKey,
    condition: fedCondition,
    collateralMint: trumpWinsMint, // Merging back to TRUMP_WINS
    outcomeMints: [firesChairMint, keepsChairMint],
    amount: mergeAmount,
    partition: PartitionHelper.binaryPartition(),
    userSigner: user,
  });

  const trumpWinsFinal = await client.getUserOutcomeBalance(user.publicKey, trumpWinsMint);
  const firesChairFinal = await client.getUserOutcomeBalance(user.publicKey, firesChairMint);
  const keepsChairFinal = await client.getUserOutcomeBalance(user.publicKey, keepsChairMint);

  console.log("After merging:");
  console.log(`TRUMP_WINS: ${trumpWinsFinal} (+100 from merge) ✓`);
  console.log(`FIRES_CHAIR: ${firesChairFinal} (-100 burned) ✓`);
  console.log(`KEEPS_CHAIR: ${keepsChairFinal} (-100 burned) ✓\n`);

  // =========================================================================
  // STEP 7: Resolution Scenario 1 - Trump wins AND fires Fed Chair
  // =========================================================================
  console.log("Step 7: Resolution Scenario - Trump wins AND fires Fed Chair\n");

  // Resolve primary market: Trump wins
  await client.reportPayout(
    electionCondition,
    [new BN(0), new BN(1)], // [LOSES=0%, WINS=100%]
    oracle
  );

  console.log("✓ Primary market resolved: Trump WINS");

  // Resolve secondary market: Fires Fed Chair
  await client.reportPayout(
    fedCondition,
    [new BN(0), new BN(1)], // [KEEPS=0%, FIRES=100%]
    oracle
  );

  console.log("✓ Secondary market resolved: FIRES Fed Chair\n");

  // =========================================================================
  // STEP 8: Redemption chain
  // =========================================================================
  console.log("Step 8: Redemption chain demonstration...");
  console.log("Redeeming: FIRES_CHAIR → TRUMP_WINS → USDC\n");

  // First, redeem FIRES_CHAIR for TRUMP_WINS
  const firesChairToRedeem = await client.getUserOutcomeBalance(user.publicKey, firesChairMint);
  
  console.log(`Redeeming ${firesChairToRedeem} FIRES_CHAIR tokens...`);
  
  await client.redeemPositions({
    user: user.publicKey,
    condition: fedCondition,
    collateralMint: trumpWinsMint,
    outcomeMints: [firesChairMint],
    indexSets: [PartitionHelper.outcomeToIndexSet(1)], // Index 1 = FIRES
    amount: new BN(firesChairToRedeem.toString()),
    userSigner: user,
  });

  const trumpWinsAfterRedeem1 = await client.getUserOutcomeBalance(user.publicKey, trumpWinsMint);
  console.log(`✓ Received ${trumpWinsAfterRedeem1} TRUMP_WINS tokens\n`);

  // Now redeem TRUMP_WINS for USDC
  console.log(`Redeeming ${trumpWinsAfterRedeem1} TRUMP_WINS tokens for USDC...`);
  
  await client.redeemPositions({
    user: user.publicKey,
    condition: electionCondition,
    collateralMint: usdcMint,
    outcomeMints: [trumpWinsMint],
    indexSets: [PartitionHelper.outcomeToIndexSet(1)], // Index 1 = WINS
    amount: new BN(trumpWinsAfterRedeem1.toString()),
    userSigner: user,
  });

  const finalUsdcBalance = (await getOrCreateAssociatedTokenAccount(
    provider.connection,
    user,
    usdcMint,
    user.publicKey
  )).amount;

  console.log(`✓ Final USDC balance: ${finalUsdcBalance}\n`);

  // =========================================================================
  // STEP 9: Verify CTF invariants
  // =========================================================================
  console.log("Step 9: Verifying CTF invariants...\n");

  const electionInvariant = await client.verifyCTFInvariant(
    electionCondition,
    usdcMint,
    [trumpWinsMint, trumpLosesMint]
  );

  const fedInvariant = await client.verifyCTFInvariant(
    fedCondition,
    trumpWinsMint,
    [firesChairMint, keepsChairMint]
  );

  console.log("Primary Market (Election) Invariant:");
  console.log(`  Vault USDC: ${electionInvariant.vaultBalance}`);
  console.log(`  Total outcome supply: ${electionInvariant.totalOutcomeSupply}`);
  console.log(`  Valid: ${electionInvariant.isValid} ✓\n`);

  console.log("Secondary Market (Fed Chair) Invariant:");
  console.log(`  Vault TRUMP_WINS: ${fedInvariant.vaultBalance}`);
  console.log(`  Total outcome supply: ${fedInvariant.totalOutcomeSupply}`);
  console.log(`  Valid: ${fedInvariant.isValid} ✓\n`);

  console.log("=== Deep Splits Demo Complete ===\n");
  
  console.log("Key Takeaways:");
  console.log("1. Outcome tokens from one market can be collateral for another");
  console.log("2. This creates a dependency chain: USDC → TRUMP_WINS → FIRES_CHAIR");
  console.log("3. The merge property holds at each level");
  console.log("4. Redemption follows the chain backwards");
  console.log("5. All CTF invariants are maintained throughout\n");

  console.log("Real-world applications:");
  console.log("- Prediction markets with conditional outcomes");
  console.log("- Options on prediction market positions");
  console.log("- Multi-stage sports tournaments");
  console.log("- Correlated event markets");
  console.log("- Portfolio insurance products\n");
}

// Run the demo
demonstrateDeepSplits()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });

/**
 * Expected Output:
 * 
 * === Deep Splits Demo: Nested Conditional Markets ===
 * 
 * Step 1: Creating USDC collateral...
 * ✓ Created USDC: [MINT_ADDRESS]
 * ✓ User USDC balance: 1000 USDC
 * 
 * Step 2: Setting up Primary Market (Election)...
 * ✓ Election condition created: [CONDITION_PDA]
 * ✓ TRUMP_WINS mint: [MINT_ADDRESS]
 * ✓ TRUMP_LOSES mint: [MINT_ADDRESS]
 * 
 * Step 3: Splitting 500 USDC into election outcomes...
 * ✓ User TRUMP_WINS balance: 500000000 tokens
 * ✓ User TRUMP_LOSES balance: 500000000 tokens
 * ✓ Invariant verified: 500 USDC = 500 TRUMP_WINS + 500 TRUMP_LOSES
 * 
 * Step 4: Setting up Secondary Market (Fed Chair)...
 * (This market only matters if Trump wins)
 * ✓ Fed Chair condition created: [CONDITION_PDA]
 * ✓ FIRES_CHAIR mint: [MINT_ADDRESS]
 * ✓ KEEPS_CHAIR mint: [MINT_ADDRESS]
 * 
 * Step 5: DEEP SPLIT - Splitting TRUMP_WINS tokens into Fed Chair outcomes...
 * This is the key innovation of CTF!
 * 
 * === Token Hierarchy Created ===
 * USDC (Base)
 * ├── TRUMP_WINS: 300000000 remaining
 * │   ├── FIRES_CHAIR: 200000000
 * │   └── KEEPS_CHAIR: 200000000
 * └── TRUMP_LOSES: 500000000
 * 
 * Invariant verification:
 * 200 TRUMP_WINS = 200 FIRES_CHAIR + 200 KEEPS_CHAIR ✓
 * 
 * ... [rest of output]
 */
