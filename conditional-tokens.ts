import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { ConditionalTokens } from "../target/types/conditional_tokens";
import { PublicKey, Keypair, SystemProgram, SYSVAR_RENT_PUBKEY } from "@solana/web3.js";
import { 
  TOKEN_PROGRAM_ID, 
  createMint, 
  getOrCreateAssociatedTokenAccount,
  mintTo,
  getAccount
} from "@solana/spl-token";
import { expect } from "chai";

describe("conditional-tokens", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.ConditionalTokens as Program<ConditionalTokens>;
  
  let collateralMint: PublicKey;
  let oracle: Keypair;
  let user: Keypair;
  let conditionPda: PublicKey;
  let vaultPda: PublicKey;
  let mintAuthorityPda: PublicKey;
  let yesMint: PublicKey;
  let noMint: PublicKey;

  const questionId = Buffer.from("Will ETH reach $10k in 2025?".padEnd(32, "\0"));

  before(async () => {
    // Initialize keypairs
    oracle = Keypair.generate();
    user = Keypair.generate();

    // Airdrop SOL to oracle and user
    const airdropSig1 = await provider.connection.requestAirdrop(
      oracle.publicKey,
      2 * anchor.web3.LAMPORTS_PER_SOL
    );
    await provider.connection.confirmTransaction(airdropSig1);

    const airdropSig2 = await provider.connection.requestAirdrop(
      user.publicKey,
      2 * anchor.web3.LAMPORTS_PER_SOL
    );
    await provider.connection.confirmTransaction(airdropSig2);

    // Create USDC-like collateral token
    collateralMint = await createMint(
      provider.connection,
      user,
      user.publicKey,
      null,
      6 // 6 decimals like USDC
    );

    console.log("Collateral Mint:", collateralMint.toBase58());
  });

  it("Prepares a binary condition", async () => {
    // Derive condition PDA
    [conditionPda] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("condition"),
        oracle.publicKey.toBuffer(),
        questionId,
      ],
      program.programId
    );

    console.log("Condition PDA:", conditionPda.toBase58());

    // Prepare the condition
    const tx = await program.methods
      .prepareCondition(Array.from(questionId), 2) // Binary: YES/NO
      .accounts({
        condition: conditionPda,
        oracle: oracle.publicKey,
        payer: provider.wallet.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    console.log("Prepare Condition TX:", tx);

    // Fetch and verify condition
    const condition = await program.account.condition.fetch(conditionPda);
    expect(condition.oracle.toBase58()).to.equal(oracle.publicKey.toBase58());
    expect(condition.outcomeSlotCount).to.equal(2);
    expect(condition.isResolved).to.be.false;
  });

  it("Initializes outcome token mints (YES/NO)", async () => {
    // Create YES token mint
    yesMint = await createMint(
      provider.connection,
      user,
      mintAuthorityPda = PublicKey.findProgramAddressSync(
        [Buffer.from("mint-authority"), conditionPda.toBuffer()],
        program.programId
      )[0],
      null,
      6
    );

    // Create NO token mint
    noMint = await createMint(
      provider.connection,
      user,
      mintAuthorityPda,
      null,
      6
    );

    console.log("YES Mint:", yesMint.toBase58());
    console.log("NO Mint:", noMint.toBase58());
    console.log("Mint Authority PDA:", mintAuthorityPda.toBase58());
  });

  it("Splits collateral into YES/NO tokens (Core CTF Invariant)", async () => {
    // Derive vault PDA
    [vaultPda] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("vault"),
        conditionPda.toBuffer(),
        collateralMint.toBuffer(),
      ],
      program.programId
    );

    // Create vault token account
    await getOrCreateAssociatedTokenAccount(
      provider.connection,
      user,
      collateralMint,
      vaultPda,
      true // allowOwnerOffCurve for PDA
    );

    // Mint 1000 USDC to user
    const userCollateralAccount = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      user,
      collateralMint,
      user.publicKey
    );

    await mintTo(
      provider.connection,
      user,
      collateralMint,
      userCollateralAccount.address,
      user,
      1_000_000_000 // 1000 USDC (6 decimals)
    );

    // Create user's YES and NO token accounts
    const userYesAccount = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      user,
      yesMint,
      user.publicKey
    );

    const userNoAccount = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      user,
      noMint,
      user.publicKey
    );

    // Split 100 USDC into 100 YES + 100 NO tokens
    const splitAmount = 100_000_000; // 100 USDC

    const partition = [0b01, 0b10]; // Binary partition: outcome 0, outcome 1

    const tx = await program.methods
      .splitPosition(new anchor.BN(splitAmount), partition)
      .accounts({
        user: user.publicKey,
        condition: conditionPda,
        collateralMint: collateralMint,
        userCollateral: userCollateralAccount.address,
        vault: vaultPda,
        mintAuthority: mintAuthorityPda,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .remainingAccounts([
        { pubkey: yesMint, isSigner: false, isWritable: true },
        { pubkey: noMint, isSigner: false, isWritable: true },
        { pubkey: userYesAccount.address, isSigner: false, isWritable: true },
        { pubkey: userNoAccount.address, isSigner: false, isWritable: true },
      ])
      .signers([user])
      .rpc();

    console.log("Split Position TX:", tx);

    // Verify balances - Core CTF Invariant
    const vaultBalance = await getAccount(provider.connection, vaultPda);
    const userYesBalance = await getAccount(provider.connection, userYesAccount.address);
    const userNoBalance = await getAccount(provider.connection, userNoAccount.address);

    console.log("\n=== CTF Invariant Verification ===");
    console.log(`Collateral in Vault: ${vaultBalance.amount} USDC`);
    console.log(`User YES tokens: ${userYesBalance.amount}`);
    console.log(`User NO tokens: ${userNoBalance.amount}`);
    console.log(`Invariant: ${vaultBalance.amount} = ${userYesBalance.amount} + ${userNoBalance.amount} (per outcome)`);

    // Verify the invariant: 1 collateral = 1 YES + 1 NO
    expect(vaultBalance.amount.toString()).to.equal(splitAmount.toString());
    expect(userYesBalance.amount.toString()).to.equal(splitAmount.toString());
    expect(userNoBalance.amount.toString()).to.equal(splitAmount.toString());
  });

  it("Merges YES/NO tokens back into collateral (Inverse Invariant)", async () => {
    const userCollateralAccount = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      user,
      collateralMint,
      user.publicKey
    );

    const userYesAccount = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      user,
      yesMint,
      user.publicKey
    );

    const userNoAccount = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      user,
      noMint,
      user.publicKey
    );

    const beforeCollateral = await getAccount(provider.connection, userCollateralAccount.address);
    const beforeYes = await getAccount(provider.connection, userYesAccount.address);
    const beforeNo = await getAccount(provider.connection, userNoAccount.address);

    console.log("\n=== Before Merge ===");
    console.log(`User Collateral: ${beforeCollateral.amount}`);
    console.log(`User YES: ${beforeYes.amount}`);
    console.log(`User NO: ${beforeNo.amount}`);

    // Merge 50 YES + 50 NO → 50 USDC
    const mergeAmount = 50_000_000; // 50 USDC
    const partition = [0b01, 0b10];

    const tx = await program.methods
      .mergePositions(new anchor.BN(mergeAmount), partition)
      .accounts({
        user: user.publicKey,
        condition: conditionPda,
        collateralMint: collateralMint,
        userCollateral: userCollateralAccount.address,
        vault: vaultPda,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .remainingAccounts([
        { pubkey: yesMint, isSigner: false, isWritable: true },
        { pubkey: noMint, isSigner: false, isWritable: true },
        { pubkey: userYesAccount.address, isSigner: false, isWritable: true },
        { pubkey: userNoAccount.address, isSigner: false, isWritable: true },
      ])
      .signers([user])
      .rpc();

    console.log("Merge Positions TX:", tx);

    const afterCollateral = await getAccount(provider.connection, userCollateralAccount.address);
    const afterYes = await getAccount(provider.connection, userYesAccount.address);
    const afterNo = await getAccount(provider.connection, userNoAccount.address);

    console.log("\n=== After Merge ===");
    console.log(`User Collateral: ${afterCollateral.amount}`);
    console.log(`User YES: ${afterYes.amount}`);
    console.log(`User NO: ${afterNo.amount}`);

    // Verify inverse invariant
    expect(Number(afterCollateral.amount) - Number(beforeCollateral.amount)).to.equal(mergeAmount);
    expect(Number(beforeYes.amount) - Number(afterYes.amount)).to.equal(mergeAmount);
    expect(Number(beforeNo.amount) - Number(afterNo.amount)).to.equal(mergeAmount);
  });

  it("Oracle resolves the condition", async () => {
    // Oracle reports that outcome 1 (YES) wins
    // Payout: [0, 1] means 0% to NO, 100% to YES
    const payoutNumerators = [
      new anchor.BN(0),  // NO gets nothing
      new anchor.BN(1),  // YES gets everything
    ];

    const tx = await program.methods
      .reportPayout(payoutNumerators)
      .accounts({
        condition: conditionPda,
        oracle: oracle.publicKey,
      })
      .signers([oracle])
      .rpc();

    console.log("Report Payout TX:", tx);

    const condition = await program.account.condition.fetch(conditionPda);
    expect(condition.isResolved).to.be.true;
    expect(condition.payoutNumerators.length).to.equal(2);
    expect(condition.payoutNumerators[1].toNumber()).to.equal(1);
  });

  it("Redeems winning positions for collateral", async () => {
    const userCollateralAccount = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      user,
      collateralMint,
      user.publicKey
    );

    const userYesAccount = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      user,
      yesMint,
      user.publicKey
    );

    const beforeCollateral = await getAccount(provider.connection, userCollateralAccount.address);
    const beforeYes = await getAccount(provider.connection, userYesAccount.address);

    console.log("\n=== Before Redemption ===");
    console.log(`User Collateral: ${beforeCollateral.amount}`);
    console.log(`User YES: ${beforeYes.amount}`);

    // Redeem all YES tokens (which won 100%)
    const redeemAmount = Number(beforeYes.amount);
    const indexSets = [0b10]; // Only redeem outcome 1 (YES)

    const tx = await program.methods
      .redeemPositions(indexSets, new anchor.BN(redeemAmount))
      .accounts({
        user: user.publicKey,
        condition: conditionPda,
        collateralMint: collateralMint,
        userCollateral: userCollateralAccount.address,
        vault: vaultPda,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .remainingAccounts([
        { pubkey: yesMint, isSigner: false, isWritable: true },
        { pubkey: userYesAccount.address, isSigner: false, isWritable: true },
      ])
      .signers([user])
      .rpc();

    console.log("Redeem Positions TX:", tx);

    const afterCollateral = await getAccount(provider.connection, userCollateralAccount.address);
    const afterYes = await getAccount(provider.connection, userYesAccount.address);

    console.log("\n=== After Redemption ===");
    console.log(`User Collateral: ${afterCollateral.amount}`);
    console.log(`User YES: ${afterYes.amount}`);

    // Verify: All YES tokens burned, got back equivalent USDC
    expect(afterYes.amount.toString()).to.equal("0");
    expect(Number(afterCollateral.amount) - Number(beforeCollateral.amount)).to.equal(redeemAmount);
  });

  it("Rejects invalid partitions", async () => {
    const userCollateralAccount = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      user,
      collateralMint,
      user.publicKey
    );

    const userYesAccount = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      user,
      yesMint,
      user.publicKey
    );

    const userNoAccount = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      user,
      noMint,
      user.publicKey
    );

    // Test 1: Overlapping partition [0b11, 0b01]
    try {
      await program.methods
        .splitPosition(new anchor.BN(1_000_000), [0b11, 0b01])
        .accounts({
          user: user.publicKey,
          condition: conditionPda,
          collateralMint: collateralMint,
          userCollateral: userCollateralAccount.address,
          vault: vaultPda,
          mintAuthority: mintAuthorityPda,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .remainingAccounts([
          { pubkey: yesMint, isSigner: false, isWritable: true },
          { pubkey: noMint, isSigner: false, isWritable: true },
          { pubkey: userYesAccount.address, isSigner: false, isWritable: true },
          { pubkey: userNoAccount.address, isSigner: false, isWritable: true },
        ])
        .signers([user])
        .rpc();
      
      expect.fail("Should have rejected overlapping partition");
    } catch (err) {
      expect(err.toString()).to.include("InvalidPartition");
    }

    // Test 2: Trivial partition [0b11] (all outcomes in one set)
    try {
      await program.methods
        .splitPosition(new anchor.BN(1_000_000), [0b11])
        .accounts({
          user: user.publicKey,
          condition: conditionPda,
          collateralMint: collateralMint,
          userCollateral: userCollateralAccount.address,
          vault: vaultPda,
          mintAuthority: mintAuthorityPda,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .remainingAccounts([
          { pubkey: yesMint, isSigner: false, isWritable: true },
          { pubkey: userYesAccount.address, isSigner: false, isWritable: true },
        ])
        .signers([user])
        .rpc();
      
      expect.fail("Should have rejected trivial partition");
    } catch (err) {
      expect(err.toString()).to.include("InvalidPartition");
    }
  });
});
