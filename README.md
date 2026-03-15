# Jara Agent

> Autonomous AI agent that converts cUSD on Celo into local currency across 15 countries. Bank transfers, mobile money, bill payments - all via a single x402-payable API.

Built for the Celo **"Build Agents for the Real World V2"** hackathon.

## What Jara Does

Other AI agents (or humans) pay Jara via x402, and it:
- Converts cUSD to local currency via bank transfer or mobile money (15 countries)
- Pays utility bills: electricity, airtime, data, cable TV
- Loads virtual dollar cards
- Finds the best conversion rates
- Builds on-chain reputation via ERC-8004

## Supported Countries

| Country | Currency | Payout Method |
|---------|----------|---------------|
| Nigeria | NGN | Bank transfer |
| Kenya | KES | Bank + Mobile money |
| South Africa | ZAR | Bank transfer |
| Ghana | GHS | Mobile money |
| Uganda | UGX | Mobile money |
| Tanzania | TZS | Mobile money |
| Zambia | ZMW | Mobile money |
| Brazil | BRL | Bank transfer |
| Philippines | PHP | Bank transfer |
| Benin | XOF | Mobile money |
| Cameroon | XAF | Mobile money |
| Senegal | XOF | Mobile money |
| Ivory Coast | XOF | Mobile money |
| Congo | XAF | Mobile money |
| Gabon | XAF | Mobile money |

## Tech Stack

- **Agent Framework:** LangGraph (tool-calling AI agent)
- **Blockchain:** Celo (ERC-8004 identity, x402 payments)
- **Offramp:** Fonbnk (15-country cUSD to local currency)
- **Identity:** SelfProtocol (ZK proof of humanity)
- **Payments:** x402 via Thirdweb (HTTP 402 agent micropayments)
- **LLM:** DeepSeek (OpenAI-compatible)
- **Runtime:** Node.js / TypeScript

## Architecture

```
                    ┌─────────────────┐
                    │  Other AI Agents │
                    └────────┬────────┘
                             │ x402 payment (cUSD)
                             ▼
┌────────────────────────────────────────────────┐
│                  Jara Agent                     │
│                                                 │
│  ┌──────────┐  ┌──────────┐  ┌──────────────┐ │
│  │ HTTP API │  │ Telegram │  │  LangGraph   │ │
│  │ (x402)   │  │   Bot    │  │  AI Agent    │ │
│  └────┬─────┘  └────┬─────┘  └──────┬───────┘ │
│       └──────────────┴───────────────┘         │
│                      │                          │
│  ┌──────────┐  ┌─────┴──────┐  ┌────────────┐ │
│  │ ERC-8004 │  │   Fonbnk   │  │ SelfProtocol│ │
│  │ Identity │  │  Offramp   │  │  ZK Verify  │ │
│  └──────────┘  └────────────┘  └────────────┘ │
└────────────────────────────────────────────────┘
                             │
                    ┌────────┴────────┐
                    │   Celo Network  │
                    └─────────────────┘
```

## API Endpoints

### Public (free)
| Method | Path | Description |
|--------|------|-------------|
| GET | `/` | Agent info + supported countries |
| GET | `/countries` | List all 15 supported countries |
| GET | `/rates?country=NG` | Conversion rates for a country |
| GET | `/rates/:country` | Rate for specific country |
| GET | `/offer?country=KE&type=bank` | Best offer + required fields |
| GET | `/order/:id` | Order status |
| GET | `/reputation` | Agent reputation score |

### Paid (x402 - 0.5 cUSD per request)
| Method | Path | Description |
|--------|------|-------------|
| POST | `/offramp` | Initiate cUSD to local currency conversion |
| POST | `/confirm-order` | Confirm order after sending cUSD |
| POST | `/pay-bill` | Pay utility bills |
| POST | `/load-card` | Load virtual card |

### x402 Payment Flow
```bash
# 1. Call without payment - get 402 response with payment instructions
curl https://jara.api/offramp

# 2. Pay cUSD to agent wallet, then call with tx hash
curl -X POST https://jara.api/offramp \
  -H "x-402-payment: 0xYOUR_TX_HASH" \
  -H "Content-Type: application/json" \
  -d '{"amount": 20, "senderAddress": "0x...", "country": "NG", "bankDetails": {...}}'
```

## Quick Start

```bash
npm install
cp .env.example .env
# Edit .env with your Fonbnk credentials and Celo private key
npm run dev
```

## Hackathon Integration

- **ERC-8004** - On-chain agent identity and reputation scoring
- **x402** - HTTP 402 Payment Required for agent-to-agent commerce
- **SelfProtocol** - ZK proof of humanity verification
- **Celo** - Low-cost L2 for stablecoin payments
- **Fonbnk** - Real offramp infrastructure across 15 countries

## License

MIT
