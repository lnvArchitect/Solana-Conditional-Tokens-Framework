import * as anchor from "@coral-xyz/anchor";
import { Program, BN } from "@coral-xyz/anchor";
import { ConditionalTokens } from "../target/types/conditional_tokens";
import { 
  PublicKey, 
  Keypair, 
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import { 
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountInstruction,
  getAccount,
} from "@solana/spl-token";

/**
 * Client SDK for interacting with the Conditional Tokens program
 * Provides high-level abstractions over the Anchor program interface
 */
export class ConditionalTokensClient {
  constructor(
    public program: Program<ConditionalTokens>,
    public provider: anchor.AnchorProvider
  ) {}

  /**
   * Derive the PDA for a condition
   */
  deriveConditionPda(
    oracle: PublicKey,
    questionId: Buffer
  ): [PublicKey, number] {
    return PublicKey.findProgramAddressSync(
      [
        Buffer.from("condition"),
        oracle.toBuffer(),
        questionId,
      ],
      this.program.programId
    );
  }

  /**
   * Derive the vault PDA for a condition and collateral
   */
  deriveVaultPda(
    condition: PublicKey,
    collateralMint: PublicKey
  ): [PublicKey, number] {
    return PublicKey.findProgramAddressSync(
      [
        Buffer.from("vault"),
        condition.toBuffer(),
        collateralMint.toBuffer(),
      ],
      this.program.programId
    );
  }

  /**
   * Derive the mint authority PDA for a condition
   */
  deriveMintAuthorityPda(condition: PublicKey): [PublicKey, number] {
    return PublicKey.findProgramAddressSync(
      [
        Buffer.from("mint-authority"),
        condition.toBuffer(),
      ],
      this.program.programId
    );
  }

  /**
   * Prepare a new condition
   */
  async prepareCondition(
    oracle: PublicKey,
    questionId: Buffer,
    outcomeSlotCount: number,
    payer?: PublicKey
  ): Promise<{ signature: string; conditionPda: PublicKey }> {
    const [conditionPda] = this.deriveConditionPda(oracle, questionId);
    
    const signature = await this.program.methods
      .prepareCondition(Array.from(questionId), outcomeSlotCount)
      .accounts({
        condition: conditionPda,
        oracle: oracle,
        payer: payer || this.provider.wallet.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    return { signature, conditionPda };
  }

  /**
   * Split collateral into outcome tokens
   */
  async splitPosition(params: {
    user: PublicKey;
    condition: PublicKey;
    collateralMint: PublicKey;
    outcomeMints: PublicKey[];
    amount: BN;
    partition: number[];
    userSigner?: Keypair;
  }): Promise<string> {
    const [vaultPda] = this.deriveVaultPda(params.condition, params.collateralMint);
    const [mintAuthorityPda] = this.deriveMintAuthorityPda(params.condition);

    // Derive token accounts
    const userCollateral = getAssociatedTokenAddressSync(
      params.collateralMint,
      params.user
    );

    const userOutcomeAccounts = params.outcomeMints.map(mint =>
      getAssociatedTokenAddressSync(mint, params.user)
    );

    // Build remaining accounts
    const remainingAccounts: Array<{
      pubkey: PublicKey;
      isSigner: boolean;
      isWritable: boolean;
    }> = [];

    // Add outcome mints and user accounts
    for (let i = 0; i < params.outcomeMints.length; i++) {
      remainingAccounts.push({
        pubkey: params.outcomeMints[i],
        isSigner: false,
        isWritable: true,
      });
      remainingAccounts.push({
        pubkey: userOutcomeAccounts[i],
        isSigner: false,
        isWritable: true,
      });
    }

    const instruction = await this.program.methods
      .splitPosition(params.amount, params.partition)
      .accounts({
        user: params.user,
        condition: params.condition,
        collateralMint: params.collateralMint,
        userCollateral: userCollateral,
        vault: vaultPda,
        mintAuthority: mintAuthorityPda,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .remainingAccounts(remainingAccounts)
      .instruction();

    const tx = new Transaction().add(instruction);

    if (params.userSigner) {
      return await this.provider.sendAndConfirm(tx, [params.userSigner]);
    } else {
      return await this.provider.sendAndConfirm(tx);
    }
  }

  /**
   * Merge outcome tokens back into collateral
   */
  async mergePositions(params: {
    user: PublicKey;
    condition: PublicKey;
    collateralMint: PublicKey;
    outcomeMints: PublicKey[];
    amount: BN;
    partition: number[];
    userSigner?: Keypair;
  }): Promise<string> {
    const [vaultPda] = this.deriveVaultPda(params.condition, params.collateralMint);

    // Derive token accounts
    const userCollateral = getAssociatedTokenAddressSync(
      params.collateralMint,
      params.user
    );

    const userOutcomeAccounts = params.outcomeMints.map(mint =>
      getAssociatedTokenAddressSync(mint, params.user)
    );

    // Build remaining accounts
    const remainingAccounts: Array<{
      pubkey: PublicKey;
      isSigner: boolean;
      isWritable: boolean;
    }> = [];

    for (let i = 0; i < params.outcomeMints.length; i++) {
      remainingAccounts.push({
        pubkey: params.outcomeMints[i],
        isSigner: false,
        isWritable: true,
      });
      remainingAccounts.push({
        pubkey: userOutcomeAccounts[i],
        isSigner: false,
        isWritable: true,
      });
    }

    const instruction = await this.program.methods
      .mergePositions(params.amount, params.partition)
      .accounts({
        user: params.user,
        condition: params.condition,
        collateralMint: params.collateralMint,
        userCollateral: userCollateral,
        vault: vaultPda,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .remainingAccounts(remainingAccounts)
      .instruction();

    const tx = new Transaction().add(instruction);

    if (params.userSigner) {
      return await this.provider.sendAndConfirm(tx, [params.userSigner]);
    } else {
      return await this.provider.sendAndConfirm(tx);
    }
  }

  /**
   * Oracle reports the outcome of a condition
   */
  async reportPayout(
    condition: PublicKey,
    payoutNumerators: BN[],
    oracle: Keypair
  ): Promise<string> {
    return await this.program.methods
      .reportPayout(payoutNumerators)
      .accounts({
        condition: condition,
        oracle: oracle.publicKey,
      })
      .signers([oracle])
      .rpc();
  }

  /**
   * Redeem winning positions for collateral
   */
  async redeemPositions(params: {
    user: PublicKey;
    condition: PublicKey;
    collateralMint: PublicKey;
    outcomeMints: PublicKey[];
    indexSets: number[];
    amount: BN;
    userSigner?: Keypair;
  }): Promise<string> {
    const [vaultPda] = this.deriveVaultPda(params.condition, params.collateralMint);

    // Derive token accounts
    const userCollateral = getAssociatedTokenAddressSync(
      params.collateralMint,
      params.user
    );

    const userOutcomeAccounts = params.outcomeMints.map(mint =>
      getAssociatedTokenAddressSync(mint, params.user)
    );

    // Build remaining accounts
    const remainingAccounts: Array<{
      pubkey: PublicKey;
      isSigner: boolean;
      isWritable: boolean;
    }> = [];

    for (let i = 0; i < params.outcomeMints.length; i++) {
      remainingAccounts.push({
        pubkey: params.outcomeMints[i],
        isSigner: false,
        isWritable: true,
      });
      remainingAccounts.push({
        pubkey: userOutcomeAccounts[i],
        isSigner: false,
        isWritable: true,
      });
    }

    const instruction = await this.program.methods
      .redeemPositions(params.indexSets, params.amount)
      .accounts({
        user: params.user,
        condition: params.condition,
        collateralMint: params.collateralMint,
        userCollateral: userCollateral,
        vault: vaultPda,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .remainingAccounts(remainingAccounts)
      .instruction();

    const tx = new Transaction().add(instruction);

    if (params.userSigner) {
      return await this.provider.sendAndConfirm(tx, [params.userSigner]);
    } else {
      return await this.provider.sendAndConfirm(tx);
    }
  }

  /**
   * Fetch condition data
   */
  async getCondition(conditionPda: PublicKey) {
    return await this.program.account.condition.fetch(conditionPda);
  }

  /**
   * Get vault balance for a condition
   */
  async getVaultBalance(
    condition: PublicKey,
    collateralMint: PublicKey
  ): Promise<bigint> {
    const [vaultPda] = this.deriveVaultPda(condition, collateralMint);
    const vaultAccount = await getAccount(this.provider.connection, vaultPda);
    return vaultAccount.amount;
  }

  /**
   * Get user's outcome token balance
   */
  async getUserOutcomeBalance(
    user: PublicKey,
    outcomeMint: PublicKey
  ): Promise<bigint> {
    const userAccount = getAssociatedTokenAddressSync(outcomeMint, user);
    try {
      const account = await getAccount(this.provider.connection, userAccount);
      return account.amount;
    } catch {
      return BigInt(0);
    }
  }

  /**
   * Verify the CTF invariant for a condition
   * Returns true if: vault_balance = sum(all_outcome_tokens_supply)
   */
  async verifyCTFInvariant(
    condition: PublicKey,
    collateralMint: PublicKey,
    outcomeMints: PublicKey[]
  ): Promise<{
    isValid: boolean;
    vaultBalance: bigint;
    totalOutcomeSupply: bigint;
  }> {
    const vaultBalance = await this.getVaultBalance(condition, collateralMint);
    
    let totalOutcomeSupply = BigInt(0);
    for (const outcomeMint of outcomeMints) {
      const mintInfo = await this.provider.connection.getParsedAccountInfo(outcomeMint);
      if (mintInfo.value && "parsed" in mintInfo.value.data) {
        const supply = BigInt(mintInfo.value.data.parsed.info.supply);
        totalOutcomeSupply += supply;
      }
    }

    // For binary markets, each outcome should have equal supply
    // So total = vault_balance * num_outcomes
    const expectedTotal = vaultBalance * BigInt(outcomeMints.length);
    const isValid = totalOutcomeSupply === expectedTotal;

    return {
      isValid,
      vaultBalance,
      totalOutcomeSupply,
    };
  }

  /**
   * Create ATAs for outcome tokens if they don't exist
   */
  async ensureOutcomeAccounts(
    user: PublicKey,
    outcomeMints: PublicKey[],
    payer?: PublicKey
  ): Promise<TransactionInstruction[]> {
    const instructions: TransactionInstruction[] = [];
    const payerKey = payer || this.provider.wallet.publicKey;

    for (const mint of outcomeMints) {
      const ata = getAssociatedTokenAddressSync(mint, user);
      
      // Check if account exists
      const accountInfo = await this.provider.connection.getAccountInfo(ata);
      
      if (!accountInfo) {
        instructions.push(
          createAssociatedTokenAccountInstruction(
            payerKey,
            ata,
            user,
            mint
          )
        );
      }
    }

    return instructions;
  }
}

/**
 * Helper functions for working with partitions and index sets
 */
export class PartitionHelper {
  /**
   * Create a binary partition for YES/NO markets
   */
  static binaryPartition(): number[] {
    return [0b01, 0b10]; // [NO, YES]
  }

  /**
   * Create a full partition for N outcomes
   * Returns [2^0, 2^1, 2^2, ..., 2^(n-1)]
   */
  static fullPartition(outcomeCount: number): number[] {
    const partition: number[] = [];
    for (let i = 0; i < outcomeCount; i++) {
      partition.push(1 << i);
    }
    return partition;
  }

  /**
   * Validate a partition
   */
  static validatePartition(partition: number[], outcomeCount: number): boolean {
    if (partition.length === 0 || partition.length === 1) {
      return false; // Trivial
    }

    const fullIndexSet = (1 << outcomeCount) - 1;
    let union = 0;

    for (const indexSet of partition) {
      // Check overlap
      if ((union & indexSet) !== 0) {
        return false;
      }
      
      // Check validity
      if (indexSet > fullIndexSet) {
        return false;
      }
      
      union |= indexSet;
    }

    // Check completeness
    return union === fullIndexSet;
  }

  /**
   * Convert outcome index to index set
   * E.g., outcome 0 -> 0b01, outcome 1 -> 0b10
   */
  static outcomeToIndexSet(outcomeIndex: number): number {
    return 1 << outcomeIndex;
  }

  /**
   * Get all outcome indices from an index set
   * E.g., 0b101 -> [0, 2]
   */
  static indexSetToOutcomes(indexSet: number): number[] {
    const outcomes: number[] = [];
    let bit = 0;
    let remaining = indexSet;
    
    while (remaining > 0) {
      if (remaining & 1) {
        outcomes.push(bit);
      }
      remaining >>= 1;
      bit++;
    }
    
    return outcomes;
  }

  /**
   * Create a compound index set from multiple outcomes
   * E.g., [0, 2] -> 0b101
   */
  static outcomesToIndexSet(outcomeIndices: number[]): number {
    return outcomeIndices.reduce((acc, idx) => acc | (1 << idx), 0);
  }
}

/**
 * Example usage:
 * 
 * ```typescript
 * const client = new ConditionalTokensClient(program, provider);
 * 
 * // Prepare a condition
 * const { conditionPda } = await client.prepareCondition(
 *   oracleKeypair.publicKey,
 *   Buffer.from("Will ETH hit $10k?".padEnd(32, "\0")),
 *   2
 * );
 * 
 * // Split collateral
 * await client.splitPosition({
 *   user: user.publicKey,
 *   condition: conditionPda,
 *   collateralMint: usdcMint,
 *   outcomeMints: [yesMint, noMint],
 *   amount: new BN(1_000_000),
 *   partition: PartitionHelper.binaryPartition(),
 *   userSigner: userKeypair,
 * });
 * 
 * // Verify invariant
 * const { isValid } = await client.verifyCTFInvariant(
 *   conditionPda,
 *   usdcMint,
 *   [yesMint, noMint]
 * );
 * ```
 */
