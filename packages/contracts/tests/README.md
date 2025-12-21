# Degen Terminal Smart Contract Tests

Comprehensive test suite for the Degen Terminal Solana smart contract.

## Prerequisites

1. **Solana CLI** installed and configured
2. **Anchor CLI** v0.30.1 or later
3. **Node.js** v18 or later
4. **pnpm** or **npm**

## Setup

```bash
# Navigate to contracts directory
cd packages/contracts

# Install dependencies
pnpm install

# Build the program (generates IDL and types)
anchor build
```

## Running Tests

### Local Validator Tests (Recommended)

```bash
# Start local validator and run tests
anchor test
```

### Against Running Validator

```bash
# If you already have a local validator running
anchor test --skip-local-validator
```

### Run Specific Test File

```bash
npx ts-mocha -p ./tsconfig.json -t 1000000 tests/degen-terminal.ts
```

## Test Coverage

The test suite covers all smart contract instructions:

### Admin Instructions
- `initialize_global` - Protocol initialization with fee configuration
- `pause_protocol` - Emergency pause/unpause functionality
- `update_fees` - Fee configuration updates
- `transfer_admin` - Admin authority transfer

### Market Instructions
- `initialize_market` - Market creation with validation
- `resolve_market` - Market resolution using oracle price

### Trading Instructions
- `place_order` - Order validation (price, size, tick size, expiry)
- `execute_match` - Atomic trade execution between maker/taker

### Settlement Instructions
- `settle_positions` - Position settlement and payout

## Test Categories

| Category | Tests | Description |
|----------|-------|-------------|
| Happy Path | ✓ | Successful operations |
| Validation | ✓ | Input validation (price, size, tick) |
| Authorization | ✓ | Admin-only functions |
| State Transitions | ✓ | Market lifecycle |
| Edge Cases | ✓ | Self-trade prevention, overflow checks |

## Test Utilities

The `utils.ts` file provides helper functions:

- **Token Helpers**: `createMockUsdcMint`, `createTokenAccountWithBalance`
- **PDA Derivation**: `deriveGlobalStatePda`, `deriveMarketPda`, `derivePositionPda`
- **Order Creation**: `createOrderArgs`, `generateClientOrderId`
- **Price/Cost Calculation**: `humanToPrice`, `calculateCosts`, `calculateTakerFee`
- **Time Utilities**: `sleep`, `waitForTimestamp`
- **Assertions**: `expectError`

## Environment Variables

Tests use the following configuration:

```env
ANCHOR_PROVIDER_URL=http://localhost:8899
ANCHOR_WALLET=~/.config/solana/id.json
```

## Troubleshooting

### "Account already in use" Error
The global state can only be initialized once. If running tests repeatedly, restart the local validator:
```bash
solana-test-validator --reset
```

### "Insufficient funds" Error
Ensure test accounts have sufficient SOL:
```bash
solana airdrop 10 <pubkey> --url localhost
```

### IDL Not Found
Rebuild the program to regenerate IDL:
```bash
anchor build
```

## Adding New Tests

1. Import utilities from `utils.ts`
2. Follow existing test structure with `describe`/`it` blocks
3. Use `before`/`beforeEach` for setup
4. Test both success and failure cases
5. Verify state changes after operations

## Example Test

```typescript
import { createOrderArgs, expectError } from "./utils";

describe("my_instruction", () => {
  it("succeeds with valid inputs", async () => {
    const args = createOrderArgs("bid", "yes", 0.50, 100);
    await program.methods.myInstruction(args)
      .accounts({ /* ... */ })
      .signers([user])
      .rpc();
    
    // Verify state
    const state = await program.account.myAccount.fetch(pda);
    expect(state.value).to.equal(100);
  });

  it("fails with invalid inputs", async () => {
    await expectError(
      () => program.methods.myInstruction(invalidArgs)
        .accounts({ /* ... */ })
        .signers([user])
        .rpc(),
      "InvalidInput"
    );
  });
});
```













