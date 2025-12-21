# Degen Terminal

A binary outcome trading terminal for BTC, ETH, and SOL on Solana.

![License](https://img.shields.io/badge/license-MIT-blue.svg)
![Solana](https://img.shields.io/badge/Solana-Devnet-green.svg)

## Overview

Degen Terminal is a peer-to-peer prediction market where users can trade YES/NO tokens on whether an asset's price will be above or below a strike price at expiry.

```
Will BTC be above $95,000 in 5 minutes?

YES @ $0.52  →  Win $1.00 if price > strike
NO  @ $0.48  →  Win $1.00 if price ≤ strike
```

## Architecture

- **Frontend**: Next.js 14 + TailwindCSS + Solana Wallet Adapter
- **Backend**: Fastify + Supabase + Redis + WebSocket
- **Smart Contract**: Anchor (Rust) on Solana
- **Oracles**: Pyth (live feeds) + Switchboard (settlement)

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for detailed system design.

## Project Structure

```
degen-terminal/
├── apps/
│   ├── web/              # Next.js frontend
│   └── api/              # Fastify backend
├── packages/
│   ├── types/            # Shared TypeScript types
│   └── contracts/        # Anchor program
├── docs/                 # Documentation
│   ├── ARCHITECTURE.md   # System architecture
│   ├── API_SPEC.md       # API specification
│   ├── MARKET_MAKER.md   # MM bot design
│   └── TODO.md           # Project roadmap
└── scripts/              # Development scripts
```

## Quick Start

### Prerequisites

- Node.js 20+
- pnpm 9+ (`npm install -g pnpm`)
- Docker (for local Redis only)
- Supabase account (for database)
- Rust + Anchor CLI (for contract development)
- Solana CLI

### Installation

```bash
# Install pnpm if you don't have it
npm install -g pnpm

# Clone the repo
git clone https://github.com/yourusername/degen-terminal.git
cd degen-terminal

# Install dependencies
pnpm install

# Copy environment variables
cp env.example .env

# Start databases
pnpm db:start

# Run development servers
pnpm dev
```

This starts:
- Frontend: http://localhost:3000
- Backend: http://localhost:4000
- WebSocket: ws://localhost:4000/ws

### Building

```bash
# Build all packages
pnpm build

# Build contracts
cd packages/contracts
anchor build
```

## Development

### Database

Database is hosted on **Supabase**. Only Redis runs locally for orderbook caching.

```bash
# Start Redis (for orderbook cache)
pnpm db:start

# Stop Redis
pnpm db:stop
```

### Testing

```bash
# Run all tests
pnpm test

# Test contracts
cd packages/contracts
anchor test
```

### Linting

```bash
pnpm lint
pnpm format
```

## Documentation

| Document | Description |
|----------|-------------|
| [ARCHITECTURE.md](docs/ARCHITECTURE.md) | System design, data flows, collateral model |
| [API_SPEC.md](docs/API_SPEC.md) | REST & WebSocket API specification |
| [MARKET_MAKER.md](docs/MARKET_MAKER.md) | Market maker bot architecture |
| [MCP_SETUP.md](docs/MCP_SETUP.md) | Supabase MCP configuration for Cursor |
| [TODO.md](docs/TODO.md) | Project roadmap and tasks |

## Key Features

- **Off-chain Orderbook**: Fast matching with on-chain settlement
- **Full Collateralization**: YES + NO = $1.00 always
- **Auto-Settlement**: Winners paid automatically, no claiming
- **Multiple Timeframes**: 5m, 15m, 1h, 4h markets
- **Self-Trade Prevention**: Can't match against yourself

## Fee Structure

| Party | Fee |
|-------|-----|
| Maker | 0.00% |
| Taker | 0.10% |

## Security

- All trades are fully collateralized
- Funds held in program-controlled PDAs
- Emergency pause mechanism
- Oracle price verification

## License

MIT

## Contributing

Contributions welcome! Please read the contributing guidelines first.

---

Built with ☕ for degens everywhere.


