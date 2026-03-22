# Toppa Agent

> AI agent for digital goods and utility payments across 170+ countries, powered by Celo.

**Use it:** [t.me/toppa402bot](https://t.me/toppa402bot) | WhatsApp (self-hosted — see setup below) | **See it:** [toppa.cc](https://toppa.cc) | **Verify it:** [8004scan](https://www.8004scan.io/agents/celo/1870) · [Agentscan](https://agentscan.info/agents/e42ebcb1-fd03-4fe8-ac1a-3cf1c24d80df) · [Karma](https://www.karmahq.xyz/project/toppa) · [Self Agent ID](https://app.ai.self.xyz)

## What Toppa Does

Toppa is an autonomous AI agent that lets anyone buy digital goods using cUSD on Celo — no bank account, no KYC, no fiat offramp complexity. Just tell it what you need in plain language or send a voice note.

**Services:**
- **Airtime** — Mobile top-ups across 170+ countries, 800+ operators. Auto-detects operator from phone number.
- **Data Plans** — Mobile data bundles (1GB, 5GB, 10GB, etc.) across 170+ countries with plan descriptions.
- **Utility Bills** — Electricity, water, TV (DStv, GOtv, Startimes), internet.
- **Gift Cards** — 300+ brands, 14,000+ products. Amazon, Steam, Netflix, Spotify, PlayStation, Xbox, Uber, Airbnb, Apple, Google Play, prepaid Visa/Mastercard, and more.

**Key capability — Multi-intent resolution:**
> "Get my brother 500 naira airtime in Nigeria, pay mom's DStv bill in Lagos, and buy me a $25 Steam gift card"

Toppa parses this into three parallel operations and executes them all.

## Platforms

### Telegram Bot
- Personal wallets with deposit/withdraw
- Voice note transcription (Deepgram)
- @mention filtering in groups (responds only when tagged)
- Group wallets with democratic poll-based governance
- Inline buttons for order confirmation
- Scheduled payments via heartbeat engine

### WhatsApp Bot
- Same personal wallet system (Baileys)
- Multi-currency deposits (cUSD, CELO, USDC, USDT, cEUR) with `/swap`
- @mention filtering in groups
- Group wallets and polls (native WhatsApp polls)
- Voice note transcription
- QR code pairing for self-hosted setup

## Features

### Group Wallets
Groups (Telegram or WhatsApp) can enable a shared wallet. One admin, democratic spending via polls.

- `/group enable` — Create a group wallet (first user becomes admin)
- `/group` — View group balance, address, members, recent activity
- `/contribute <amount>` — Transfer cUSD from personal wallet to group
- `/group_withdraw <address> <amount>` — Admin withdraws from group wallet
- `/threshold <0-100>` — Set poll approval percentage (default 70%)

All group spending goes through a poll — members vote, and the action executes when the threshold is reached (or is rejected if impossible to reach).

### Identity Verification (Self Protocol)
ZK proof-of-humanity for tiered access — no KYC, no personal data disclosed:
- **Unverified users:** $20/day spending limit
- **Self-verified users:** $200/day spending limit
- `/verify` — Opens Self Protocol verification flow
- Sybil-resistant: one passport = one identity (nullifier-based)
- Self Agent ID: #48 on Celo Sepolia

**Verification Flow:**
1. User types `/verify` in Telegram or WhatsApp
2. Bot creates a verification session and sends a Self universal deep link
3. User taps link → Self app opens → scans passport via NFC (~30 seconds)
4. Self Protocol sends ZK proof to `POST /api/verify` callback
5. Server verifies proof using `SelfBackendVerifier` from `@selfxyz/core`
6. On success, user's spending limit upgrades from $20 → $200/day
7. Bot sends confirmation message to the user

**Endpoints:**
- `GET /verify?token=...` — Verification landing page with Self link
- `POST /api/verify` — Self Protocol ZK proof callback
- `GET /api/verify/status?userId=...` — Check verification status

### Multi-Currency Deposits
Deposit any supported Celo token and auto-swap to cUSD:
- **Supported:** cUSD, CELO, USDC, USDT, cEUR
- `/swap` — Convert all non-cUSD tokens to cUSD via Uniswap Trading API (with direct contract fallback)

### Expenditure Reports
Generate PDF or Excel statements of your transaction history:
- Personal statements or group statements
- Filter by date range
- Delivered as a document right in chat

### Voice Notes
Send a voice message on Telegram or WhatsApp — Toppa transcribes it via Deepgram and processes the request. Supports English, French, Yoruba, Swahili, and more.

### Smart Memory
Toppa remembers contacts, preferences, and transaction history across sessions (MongoDB-backed, 24h TTL).

### Scheduled Payments
Set up recurring payments — the heartbeat engine checks every 15 minutes:
- "Send mom airtime every Friday"
- "Pay my DStv on the 15th of every month"

## Architecture

```
                     ┌─────────────────┐       ┌─────────────────┐
                     │  Desktop (MCP)  │       │  Other AI Agents │
                     └────────┬────────┘       └────────┬────────┘
                              │ STDIO (Local)           │ x402 payment (cUSD)
                              ▼                         ▼
┌───────────────────────────────────────────────────────────────────────┐
│                           Toppa Agent                                 │
│                                                                       │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌───────────────────────┐  │
│  │ HTTP API │  │ Telegram │  │   MCP    │  │   LangGraph Agent     │  │
│  │ (x402)   │  │ WhatsApp │  │  Server  │  │   (StateGraph loop)   │  │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘  └───────────┬───────────┘  │
│       └─────────────┼─────────────┘                    │              │
│                     │                                  │              │
│  ┌──────────┐  ┌────┴───────┐  ┌────────────┐          │              │
│  │ ERC-8004 │  │  Reloadly  │  │    Self    │          │              │
│  │ Identity │  │ 170+ ctry  │  │  Protocol  │          │              │
│  └──────────┘  └────────────┘  └────────────┘          │              │
│                                                        │              │
│  ┌──────────┐  ┌────────────┐  ┌────────────┐          │              │
│  │  Wallet  │  │   Group    │  │  Reports   │          │              │
│  │ Manager  │  │  Wallets   │  │  (PDF/XLS) │          │              │
│  └──────────┘  └────────────┘  └────────────┘          │              │
└────────────────────────────────────────────────────────┼──────────────┘
                       │                                 │
              ┌────────┴─────────────────────────────────┴┐
              │           Celo Network + MongoDB           │
              └───────────────────────────────────────────┘
```

## Tech Stack

| Layer | Technology | Purpose |
|-------|-----------|---------|
| **Agent** | LangGraph (StateGraph) | Agent ↔ tools loop with conditional edges, payment short-circuit, fidelity checks |
| **LLM** | Gemini 2.0 Flash (via OpenRouter) | Fast, reliable, with automatic fallback to Llama 3.3 70B |
| **Identity** | ERC-8004 | On-chain agent identity and reputation (Agent #1870 on Celo) |
| **Payments** | x402 | HTTP 402 Payment Required for agent micropayments |
| **Verification** | Self Protocol | ZK proof of humanity — tiered spending limits ($20 unverified → $200 verified) |
| **Digital Goods** | Reloadly | Airtime, data, bills, gift cards across 170+ countries |
| **Blockchain** | Celo + viem | Low-cost L2, cUSD stablecoin, feeCurrency gas abstraction |
| **Swaps** | Uniswap Trading API + V3 | Optimized routing via Trading API with direct contract fallback |
| **Wallets** | AES-256-GCM encrypted | MongoDB-backed wallet store with encrypted private keys |
| **Bot** | Telegram (raw API) + WhatsApp (Baileys) | Chat interfaces with in-app wallets, rate limiting, input sanitization |
| **Groups** | MongoDB | Group wallets, polls, contributions, transaction history |
| **Reports** | pdfkit + exceljs | PDF and Excel expenditure statements |
| **Voice** | Deepgram | Speech-to-text for voice note transcription |
| **API** | Express | HTTP API with x402, MCP, and A2A protocol support |
| **Storage** | MongoDB | Wallets, conversations, groups, receipts, user activity |

## Project Structure

```
src/
├── agent/                     # AI Agent (LangGraph)
│   ├── graph.ts               # LangGraph StateGraph — agent ↔ tools loop
│   ├── state.ts               # Agent state annotation
│   ├── tools.ts               # 36 tools (32 free + 4 paid)
│   ├── memory.ts              # Conversation history (MongoDB)
│   ├── heartbeat.ts           # Proactive check-ins and alerts
│   ├── scheduler.ts           # Scheduled/recurring payments
│   ├── goals.ts               # User goals and contact storage
│   └── user-activity.ts       # Activity tracking for heartbeat
│
├── api/                       # HTTP API Server
│   └── server.ts              # Express (x402, MCP, A2A, admin routes)
│
├── apis/                      # External Service Clients
│   ├── reloadly.ts            # Reloadly API (airtime, data, bills, gift cards)
│   ├── prestmit.ts            # Prestmit API (gift card sell — coming soon)
│   └── selfclaw.ts            # Self Protocol ZK verification
│
├── blockchain/                # On-Chain Interactions
│   ├── x402.ts                # x402 payment verification
│   ├── erc8004.ts             # ERC-8004 agent identity
│   ├── reputation.ts          # On-chain reputation tracking
│   ├── service-receipts.ts    # Payment → service binding receipts
│   ├── swap.ts                # Uniswap V3 direct contract swaps (fallback)
│   ├── uniswap-api.ts         # Uniswap Trading API integration (primary)
│   ├── self-verification.ts   # Self Protocol ZK identity + tiered limits
│   ├── relay-bridge.ts        # Cross-chain bridge (coming soon)
│   └── replay-guard.ts        # Transaction replay prevention
│
├── bot/                       # Chat Interfaces
│   ├── telegram/              # Telegram-specific
│   │   ├── bot.ts             # Telegram bot (raw API, long polling/webhook)
│   │   ├── client.ts          # Minimal Telegram Bot API client
│   │   ├── handlers.ts        # Telegram callback handler (payments, orders, gifts)
│   │   └── webhook.ts         # Prestmit webhook handler (paused)
│   ├── whatsapp/              # WhatsApp-specific
│   │   └── bot.ts             # WhatsApp bot (Baileys)
│   ├── service-executor.ts    # Shared service execution + result formatting
│   ├── groups.ts              # Group wallet infrastructure (MongoDB)
│   ├── group-context.ts       # Group @mention tracking, rate limiting
│   ├── pending-orders.ts      # Order confirmation flow
│   ├── user-settings.ts       # Per-user settings (timezone, etc.)
│   ├── sell-orders.ts         # Sell order tracking (paused)
│   └── sell-order-poller.ts   # Sell order status poller (paused)
│
├── wallet/                    # Wallet Management
│   ├── manager.ts             # WalletManager — create, balance, withdraw, swap
│   ├── crypto.ts              # AES-256-GCM encryption for private keys
│   ├── mongo-store.ts         # MongoDB wallet store
│   └── store.ts               # Wallet store interface + in-memory fallback
│
├── reports/                   # Expenditure Reports
│   └── generator.ts           # PDF and Excel statement generation
│
├── mcp/                       # Model Context Protocol
│   ├── server.ts              # MCP Streamable HTTP server
│   └── tools.ts               # 13 MCP tools
│
├── a2a/                       # Agent-to-Agent Protocol
│   ├── handler.ts             # A2A JSON-RPC handler
│   └── agent-card.ts          # A2A Agent Card generator
│
├── shared/                    # Shared Utilities
│   ├── constants.ts           # Chain IDs, token addresses, config
│   ├── sanitize.ts            # Input sanitization (phones, amounts, injection)
│   ├── refund.ts              # Auto-refund on service failure
│   ├── api-cache.ts           # TTL cache for API responses
│   ├── balance-cache.ts       # Wallet balance cache
│   └── reputation-meta.ts    # Reputation metadata helpers
│
└── index.ts                   # Entry point — starts API, Telegram, WhatsApp
```

## API Endpoints

### Public (free)
| Method | Path | Description |
|--------|------|-------------|
| GET | `/` | Agent info + protocol details |
| GET | `/health` | Health check |
| GET | `/countries` | All supported countries |
| GET | `/countries/:cc/services` | Service availability for a country |
| GET | `/operators/:country` | Mobile operators by country |
| GET | `/data-plans/:country` | Data plan operators with bundle descriptions |
| GET | `/billers/:country` | Utility billers by country (supports `?type=ELECTRICITY_BILL_PAYMENT`) |
| GET | `/gift-cards/:country` | Gift card brands by country |
| GET | `/gift-cards/search?q=Steam` | Search gift cards by brand |
| GET | `/promotions/:country` | Active promotions by country |
| GET | `/convert?amount=10&from=USD&country=NG` | Currency conversion |
| GET | `/transaction/:type/:id` | Check transaction status |
| GET | `/identity` | Agent ERC-8004 on-chain identity |
| GET | `/reputation` | Agent reputation score |
| GET | `/verify?token=...` | Self Protocol verification landing page |
| POST | `/api/verify` | Self Protocol ZK proof callback |
| GET | `/api/verify/status?userId=...` | Check user verification status |

### Paid (x402 — product cost + 1.5% service fee)
| Method | Path | Description |
|--------|------|-------------|
| POST | `/send-airtime` | Send airtime top-up |
| POST | `/send-data` | Send data plan top-up |
| POST | `/pay-bill` | Pay utility bill |
| POST | `/buy-gift-card` | Buy a gift card |

### Admin (API key required)
| Method | Path | Description |
|--------|------|-------------|
| GET | `/admin/receipts/stats` | Receipt statistics |
| GET | `/admin/receipts/failed` | Failed receipts for review |
| GET | `/admin/receipts/payer/:payer` | Receipts by payer |
| GET | `/admin/receipts/tx/:txHash` | Receipt by payment tx hash |
| GET | `/gift-card-code/:id` | Gift card redeem codes |

### x402 Payment Flow
```bash
# 1. Call without payment — get 402 with payment requirements
curl -X POST https://api.toppa.cc/send-airtime

# 2. Send cUSD to agent wallet on Celo, then call with tx hash
curl -X POST https://api.toppa.cc/send-airtime \
  -H "X-PAYMENT: 0xYOUR_CUSD_TX_HASH" \
  -H "Content-Type: application/json" \
  -d '{"phone": "08147658721", "countryCode": "NG", "amount": 5}'
```

## Quick Start

```bash
# Install dependencies
npm install

# Copy env template
cp .env.example .env

# Edit .env with your credentials:
# - LLM_API_KEY (OpenRouter API key)
# - CELO_PRIVATE_KEY (agent wallet)
# - RELOADLY_CLIENT_ID + SECRET (from reloadly.com)
# - MONGODB_URI (MongoDB connection string)
# - TELEGRAM_BOT_TOKEN (from @BotFather)
# - ENABLE_WHATSAPP=true (optional — prints QR code for WhatsApp)
# - DEEPGRAM_API_KEY (optional — for voice note transcription)
# - WALLET_ENCRYPTION_KEY (32-byte hex — for encrypting wallet private keys)

# Generate a wallet (if needed)
npm run generate-wallet

# Register agent on ERC-8004 (needs CELO for gas)
npm run register

# Start the agent
npm run dev
```

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `LLM_API_KEY` | Yes | OpenRouter API key |
| `CELO_PRIVATE_KEY` | Yes | Agent wallet private key |
| `RELOADLY_CLIENT_ID` | Yes | Reloadly API credentials |
| `RELOADLY_CLIENT_SECRET` | Yes | Reloadly API credentials |
| `MONGODB_URI` | Yes | MongoDB connection string |
| `TELEGRAM_BOT_TOKEN` | Yes | From @BotFather |
| `WALLET_ENCRYPTION_KEY` | Yes | 32-byte hex key for AES-256-GCM wallet encryption |
| `DEEPGRAM_API_KEY` | Recommended | Voice note transcription |
| `ENABLE_WHATSAPP` | Optional | Set `true` to enable WhatsApp bot |
| `ADMIN_API_KEY` | Optional | Admin endpoint authentication |
| `UNISWAP_API_KEY` | Optional | Uniswap Trading API key (from developers.uniswap.org) |
| `SELF_SCOPE` | Optional | Self Protocol verification scope (default: `toppa-verify`) |
| `API_BASE_URL` | Optional | Public API URL for Self callback (default: `https://api.toppa.cc`) |

## Integrations

### ERC-8004 — On-Chain Agent Identity
On-chain identity and reputation on Celo's ERC-8004 registries. Toppa registers as an NFT-based agent identity and builds reputation through on-chain transaction feedback.

- Identity Registry: `0x8004BAa17C55a88189AE136b182e5fdA19dE9b63` (Celo Mainnet)
- Reputation Registry: `0x8004B663056A597Dffe9eCcC1965A193B7388713` (Celo Mainnet)
- **Toppa Agent ID: #1870** — [View on 8004scan](https://www.8004scan.io/agents/celo/1870)

### x402 — Payment Protocol
Implements the x402 standard (HTTP 402 Payment Required). Other AI agents pay cUSD per API call. Payments verified on-chain by checking cUSD Transfer events on Celo.

### Self Protocol — ZK Verification
ZK proof of humanity via passport NFC scanning. Users verify once in the Self app — no personal data disclosed. Sybil-resistant without KYC.

- **Self Agent ID: #48** (Celo Sepolia) — Address: `0x9480a88916074D9B2f62c6954a41Ea4B9B40b64c`
- **SDK:** `@selfxyz/core` — `SelfBackendVerifier` for proof verification, `getUniversalLink` for deep links
- **Callback:** `POST /api/verify` receives ZK proof from Self Protocol after passport scan
- **Sybil Resistance:** Nullifier-based — one passport = one identity across all accounts
- **Spending Tiers:** $20/day (unverified) → $200/day (verified) — enforced in both Telegram and WhatsApp bots
- **Docs:** [docs.self.xyz](https://docs.self.xyz) | [app.ai.self.xyz](https://app.ai.self.xyz)

### Multi-Protocol Agent Access
- **REST + x402** — Pay-per-call HTTP API for any agent
- **MCP** — 13 tools for Claude Desktop, Cursor, and other MCP clients
- **A2A (Agent-to-Agent)** — Google's protocol for agent interoperability

## License

MIT
