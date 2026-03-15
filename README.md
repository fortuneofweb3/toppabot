# Toppa Agent

> AI agent for digital goods and utility payments across 170+ countries, powered by Celo.

Built for the Celo **"Build Agents for the Real World V2"** hackathon.

## What Toppa Does

Toppa is an autonomous AI agent that lets anyone buy digital goods using cUSD on Celo — no bank account, no KYC, no fiat offramp complexity. Just tell it what you need in plain language.

**Services:**
- **Airtime & Data** — Mobile top-ups across 170+ countries, 800+ operators. Auto-detects operator from phone number.
- **Utility Bills** — Electricity, water, TV (DStv, GOtv, Startimes), internet.
- **Gift Cards** — 300+ brands, 14,000+ products. Amazon, Steam, Netflix, Spotify, PlayStation, Xbox, Uber, Airbnb, Apple, Google Play, prepaid Visa/Mastercard, and more.

**Key capability — Multi-intent resolution:**
> "Get my brother 500 naira airtime in Nigeria, pay mom's DStv bill in Lagos, and buy me a $25 Steam gift card"

Toppa parses this into three parallel operations and executes them all. This is where AI makes a genuine difference — not just a wrapper around an API.

## Architecture

```
                    ┌─────────────────┐
                    │  Other AI Agents │
                    └────────┬────────┘
                             │ x402 payment (cUSD)
                             ▼
┌────────────────────────────────────────────────┐
│                  Toppa Agent                    │
│                                                 │
│  ┌──────────┐  ┌──────────┐  ┌──────────────┐ │
│  │ HTTP API │  │ Telegram │  │  LangGraph   │ │
│  │ (x402)   │  │   Bot    │  │  AI Agent    │ │
│  └────┬─────┘  └────┬─────┘  └──────┬───────┘ │
│       └──────────────┴───────────────┘         │
│                      │                          │
│  ┌──────────┐  ┌─────┴──────┐  ┌────────────┐ │
│  │ ERC-8004 │  │  Reloadly  │  │    Self     │ │
│  │ Identity │  │  170+ ctry │  │  Protocol   │ │
│  └──────────┘  └────────────┘  └────────────┘ │
└────────────────────────────────────────────────┘
                       │
              ┌────────┴────────┐
              │   Celo Network  │
              └─────────────────┘
```

## Tech Stack

| Layer | Technology | Purpose |
|-------|-----------|---------|
| **Agent** | LangGraph | Tool-calling AI agent with multi-intent resolution |
| **LLM** | DeepSeek | OpenAI-compatible, 97% cheaper |
| **Identity** | ERC-8004 | On-chain agent identity and reputation (deployed on Celo) |
| **Payments** | x402 | HTTP 402 Payment Required for agent micropayments |
| **Verification** | Self Protocol | ZK proof of humanity (passport-based, no data disclosed) |
| **Digital Goods** | Reloadly | Airtime, bills, gift cards across 170+ countries |
| **Blockchain** | Celo + viem | Low-cost L2, cUSD stablecoin |
| **Bot** | Telegraf | Telegram bot interface |
| **API** | Express | HTTP API for agent-to-agent interactions |

## API Endpoints

### Public (free)
| Method | Path | Description |
|--------|------|-------------|
| GET | `/` | Agent info + protocol details |
| GET | `/operators/:country` | Mobile operators by country |
| GET | `/billers/:country` | Utility billers by country |
| GET | `/gift-cards/:country` | Gift card brands by country |
| GET | `/gift-cards/search?q=Steam` | Search gift cards by brand |
| GET | `/identity` | Agent ERC-8004 on-chain identity |
| GET | `/reputation` | Agent reputation score |
| POST | `/api/verify` | Self Protocol verification callback |

### Paid (x402 — 0.5 cUSD per request)
| Method | Path | Description |
|--------|------|-------------|
| POST | `/send-airtime` | Send airtime top-up |
| POST | `/pay-bill` | Pay utility bill |
| POST | `/buy-gift-card` | Buy a gift card |
| GET | `/gift-card-code/:id` | Get gift card redeem code |

### x402 Payment Flow
```bash
# 1. Call without payment — get 402 with payment requirements
curl https://toppa.api/send-airtime

# 2. Send cUSD to agent wallet, then call with tx hash
curl -X POST https://toppa.api/send-airtime \
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
# - OPENAI_API_KEY (DeepSeek API key)
# - CELO_PRIVATE_KEY (agent wallet)
# - RELOADLY_CLIENT_ID + SECRET (from reloadly.com)

# Generate a wallet (if needed)
npm run generate-wallet

# Register agent on ERC-8004 (needs CELO for gas)
npm run register

# Start the agent
npm run dev
```

## Hackathon Integrations

### ERC-8004 — Trustless Agents
On-chain identity and reputation on Celo's official ERC-8004 singleton registries. Toppa registers as an NFT-based agent identity and builds reputation through transaction feedback.

- Identity Registry: `0x8004A818BFB912233c491871b3d84c89A494BD9e` (Alfajores)
- Reputation Registry: `0x8004B663056A597Dffe9eCcC1965A193B7388713` (Alfajores)

### x402 — Payment Protocol
Implements Coinbase's x402 standard (HTTP 402 Payment Required). Other agents pay cUSD per API call. Payments verified on-chain by checking cUSD Transfer events.

### Self Protocol — ZK Verification
ZK proof of humanity via passport NFC scanning. Users verify once in the Self app — no personal data disclosed. Sybil-resistant without KYC.

## Why Digital Goods?

1. **Zero regulatory risk** — Gift cards and airtime are digital merchandise, not money transmission. No banking licenses needed.
2. **170+ countries** — Single integration (Reloadly) covers the globe.
3. **AI is genuinely necessary** — Multi-intent parsing of natural language into parallel API calls across services and countries.
4. **Real demand** — This is how billions of people in emerging markets access digital services.

## License

MIT
