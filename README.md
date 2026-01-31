# Solana Conditional Tokens (CTF) Framework

A faithful implementation of the Gnosis Conditional Tokens Framework (CTF) on Solana, enabling combinatorial prediction markets through "deep splits."

## 🎯 What is CTF?

The Conditional Tokens Framework enables the creation of **nested conditional markets** where outcome tokens from one prediction market can serve as collateral for another. This allows for sophisticated market structures like:

- "If Trump wins, will he fire the Fed Chair?"
- "If ETH hits $10k, will BTC also be above $100k?"
- "If team A wins the tournament, who will be MVP?"

## 🔑 Core Features

### 1. Split/Merge Invariant

**The Fundamental Rule:**
```
1 Collateral = Σ(All Outcome Tokens)
```

When you split 1 USDC in a YES/NO market:
- You receive 1 YES token + 1 NO token
- You can merge 1 YES + 1 NO back into 1 USDC anytime

### 2. Deep Splits (Combinatorial Markets)

Outcome tokens can become collateral for new markets:

```
USDC
├── TRUMP_WINS
│   ├── FIRES_CHAIR
│   └── KEEPS_CHAIR
└── TRUMP_LOSES
```

### 3. Oracle-Agnostic Resolution

Works with any oracle system:
- Switchboard Functions
- Pyth Price Feeds
- Multisig DAOs
- Reality.eth Bridge

### 4. Mathematically Sound

All operations preserve the CTF invariants:
- No loss property for liquidity providers
- Deterministic position IDs
- Atomic split/merge operations

## 🏗️ Architecture

### Solana vs EVM Differences

| Feature | Gnosis (EVM) | This Implementation (Solana) |
|---------|--------------|------------------------------|
| Token Standard | ERC-1155 (multi-token) | SPL Token (separate mints) |
| Collateral Storage | Single contract | PDA vault per condition |
| Position IDs | Hash-based uint256 | Separate Mint accounts |
| Mint Authority | N/A | Program-controlled PDA |
| Account Model | Storage slots | Account-based |

### Key Components

#### 1. Condition Account
```rust
pub struct Condition {
    pub oracle: Pubkey,              // Authorized resolver
    pub question_id: [u8; 32],       // Unique question identifier
    pub outcome_slot_count: u8,      // Number of outcomes (2-256)
    pub is_resolved: bool,           // Resolution status
    pub payout_numerators: Vec<u64>, // Payout distribution
    pub condition_id: [u8; 32],      // Deterministic ID
}
```

#### 2. Vault PDA
Holds collateral for each condition:
```
Seeds: [b"vault", condition, collateral_mint]
```

#### 3. Mint Authority PDA
Controls minting of outcome tokens:
```
Seeds: [b"mint-authority", condition]
```

## 🚀 Quick Start

### Installation

```bash
# Clone the repository
git clone <your-repo-url>
cd conditional-tokens-solana

# Install dependencies
yarn install

# Build the program
anchor build

# Run tests
anchor test
```

### Basic Usage

```typescript
import { ConditionalTokensClient, PartitionHelper } from "./sdk/client";
import * as anchor from "@coral-xyz/anchor";

const provider = anchor.AnchorProvider.env();
const program = anchor.workspace.ConditionalTokens;
const client = new ConditionalTokensClient(program, provider);

// 1. Prepare a condition
const { conditionPda } = await client.prepareCondition(
  oracleKeypair.publicKey,
  Buffer.from("Will ETH hit $10k in 2025?".padEnd(32, "\0")),
  2 // Binary market
);

// 2. Split USDC into YES/NO tokens
await client.splitPosition({
  user: user.publicKey,
  condition: conditionPda,
  collateralMint: usdcMint,
  outcomeMints: [yesMint, noMint],
  amount: new BN(1_000_000), // 1 USDC
  partition: PartitionHelper.binaryPartition(),
  userSigner: userKeypair,
});

// 3. Merge back to collateral
await client.mergePositions({
  user: user.publicKey,
  condition: conditionPda,
  collateralMint: usdcMint,
  outcomeMints: [yesMint, noMint],
  amount: new BN(500_000), // 0.5 USDC worth
  partition: PartitionHelper.binaryPartition(),
  userSigner: userKeypair,
});

// 4. Oracle resolves the market
await client.reportPayout(
  conditionPda,
  [new BN(0), new BN(1)], // YES wins 100%
  oracleKeypair
);

// 5. Redeem winning positions
await client.redeemPositions({
  user: user.publicKey,
  condition: conditionPda,
  collateralMint: usdcMint,
  outcomeMints: [yesMint],
  indexSets: [PartitionHelper.outcomeToIndexSet(1)], // YES = index 1
  amount: new BN(1_000_000),
  userSigner: userKeypair,
});
```

## 📚 Documentation

- **[Implementation Guide](./IMPLEMENTATION_GUIDE.md)** - Deep dive into CTF mechanics, deep splits, and architecture
- **[API Reference](./docs/api.md)** - Complete SDK documentation
- **[Examples](./examples/)** - Working examples including deep splits

## 🧪 Examples

### Binary Market (YES/NO)

See [tests/conditional-tokens.ts](./tests/conditional-tokens.ts) for a complete example.

### Deep Splits (Nested Markets)

See [examples/deep_splits.ts](./examples/deep_splits.ts) for a demonstration of combinatorial markets.

Run it:
```bash
ts-node examples/deep_splits.ts
```

### Partition Helpers

```typescript
import { PartitionHelper } from "./sdk/client";

// Binary partition
const binary = PartitionHelper.binaryPartition(); // [0b01, 0b10]

// N-outcome partition
const ternary = PartitionHelper.fullPartition(3); // [0b001, 0b010, 0b100]

// Validate partition
const isValid = PartitionHelper.validatePartition([0b01, 0b10], 2); // true

// Convert between formats
const indexSet = PartitionHelper.outcomeToIndexSet(0); // 0b01
const outcomes = PartitionHelper.indexSetToOutcomes(0b101); // [0, 2]
```

## 🔒 Security

### Audits

- [ ] Pending security audit
- [ ] Fuzzing tests in progress
- [ ] Formal verification planned

### Key Security Features

1. **Mint Authority Protection**: Program-controlled PDAs prevent unauthorized minting
2. **Vault Isolation**: Each condition has separate vault to prevent cross-contamination
3. **Integer Overflow Protection**: All arithmetic uses checked operations
4. **Reentrancy Prevention**: Anchor's account constraints + burn-before-transfer pattern

### Known Limitations

- Maximum 256 outcomes per condition (bitmask limit)
- No built-in AMM (integrate with Orca/Raydium separately)
- Resolution is final (no dispute mechanism)

## 🎯 Use Cases

### Prediction Markets
- Binary (YES/NO) questions
- Multiple choice questions
- Continuous variable ranges

### Conditional Markets
- Tournament brackets
- Sequential events
- Correlated outcomes

### Financial Instruments
- Options on prediction positions
- Portfolio insurance
- Structured products

### DeFi Composability
- Use outcome tokens as collateral in lending protocols
- Create liquidity pools for outcome tokens
- Synthetic assets based on predictions

## 🛠️ Development

### Project Structure

```
conditional-tokens-solana/
├── programs/
│   └── conditional-tokens/
│       ├── src/
│       │   └── lib.rs          # Main program
│       └── Cargo.toml
├── tests/
│   └── conditional-tokens.ts    # Integration tests
├── sdk/
│   └── client.ts                # TypeScript SDK
├── examples/
│   └── deep_splits.ts           # Deep splits demo
├── IMPLEMENTATION_GUIDE.md      # Technical documentation
└── README.md
```

### Running Tests

```bash
# Run all tests
anchor test

# Run specific test
anchor test --skip-build -- --grep "splits collateral"

# Run with logs
anchor test -- --show-logs
```

### Building

```bash
# Build program
anchor build

# Deploy to devnet
anchor deploy --provider.cluster devnet

# Upgrade program
anchor upgrade target/deploy/conditional_tokens.so --program-id <PROGRAM_ID>
```

## 📊 Performance

### Transaction Costs (Devnet)

| Operation | Compute Units | Approx. SOL Cost |
|-----------|---------------|------------------|
| Prepare Condition | ~20,000 | 0.0001 SOL |
| Split Position | ~50,000 | 0.00025 SOL |
| Merge Positions | ~45,000 | 0.000225 SOL |
| Report Payout | ~15,000 | 0.000075 SOL |
| Redeem Positions | ~40,000 | 0.0002 SOL |

*Note: Actual costs vary based on network congestion and number of outcomes*

## 🤝 Contributing

Contributions are welcome! Please:

1. Fork the repository
2. Create a feature branch
3. Add tests for new functionality
4. Ensure all tests pass
5. Submit a pull request

## 📜 License

This project is licensed under Apache License 2.0.

## 🙏 Acknowledgments

- [Gnosis](https://gnosis.io/) for the original Conditional Tokens Framework
- [Solana Foundation](https://solana.org/) for Anchor and tooling

## 📞 Support

- GitHub Issues: [Create an issue](https://github.com/DSB-117/Solana-Conditional-Tokens-Framework/issues)

## 🗺️ Roadmap

- [x] Core CTF mechanics (split/merge)
- [x] Deep splits support
- [x] Oracle-agnostic resolution
- [x] TypeScript SDK
- [ ] Security audit
- [ ] AMM integration examples
- [ ] Liquidation mechanism
- [ ] Cross-chain bridges (Wormhole)
- [ ] UI/UX dashboard
- [ ] Mainnet deployment

---

**Built with ❤️ on Solana**
