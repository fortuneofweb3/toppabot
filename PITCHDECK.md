# Toppa — Pitch Deck (10 Slides)
Copy each slide into Gamma.app, Canva, or Google Slides.
Orange brand: #FFA533 / Dark: #E8901A / Background: white or #0F172A (dark slides)

---

## SLIDE 1 — Title

**Toppa**
The AI Agent That Buys Real Things With Crypto

Airtime. Data. Bills. Gift Cards.
170+ countries. One conversation. Powered by Celo.

> toppa.cc | @toppa402Bot | Agent #1870

---

## SLIDE 2 — The Problem

**2.4 billion people buy airtime and data every day.**
**Zero AI agents can do it for them.**

- Walk to a kiosk. USSD menus. Mobile money timeouts.
- Sending airtime across borders? Forget it.
- The agentic economy can book flights and trade crypto — but can't top up a phone number in Lagos

The most basic digital transaction billions make daily — completely invisible to AI.

---

## SLIDE 3 — The Solution

**Toppa: One message. Any service. Any country.**

Talk to Toppa in plain language on Telegram or WhatsApp — type or send a voice note.

- Airtime top-ups — 800+ operators, 170+ countries
- Data bundles — any size, auto-detect operator
- Utility bills — electricity, water, TV (DStv, GOtv), internet
- Gift cards — 300+ brands, 14,000+ products (Amazon, Steam, Netflix, PlayStation, Apple, Google Play, Visa, and more)

No bank account. No KYC. Just cUSD on Celo.

---

## SLIDE 4 — How It Works

**One message. Three operations. Zero questions.**

User says:
> "Get my brother 500 naira airtime, pay mom's DStv bill, and buy me a $25 Steam gift card"

Toppa:
1. Parses 3 separate intents
2. Auto-detects operator from phone number
3. Resolves the DStv biller + finds the right Steam card
4. Executes all 3 — in parallel

This isn't a chatbot. This is an agent.

---

## SLIDE 5 — Autonomous Intelligence

**It thinks about you when you're not talking to it.**

SCHEDULED PAYMENTS
- "Pay my DStv on the 1st of every month"
- Background scheduler every 60s, atomic task claiming, no double payments

STANDING INSTRUCTIONS
- Remembers contacts, operators, preferences
- "Send him airtime" — already knows who, what network, what country

HEARTBEAT ENGINE
- Wakes every 15 minutes, reviews user context
- Proactive alerts: upcoming bills, low balance, promotions

---

## SLIDE 6 — Group Wallets

**Pool money. Vote to spend. Full transparency.**

1. Admin types `/group enable` — shared wallet created
2. Members `/contribute 5` — funds move from personal to group
3. Someone requests a purchase — native Telegram/WhatsApp poll goes out
4. 70% approval (configurable) — purchase auto-executes
5. Full PDF/Excel reports for every transaction

Offices pooling for internet. Friends sharing Netflix. Families paying utilities. Configurable thresholds, admin bypass, key export.

---

## SLIDE 7 — Agent-to-Agent Commerce

**The wild part: other AI agents can pay Toppa.**

```
POST /send-airtime → 402 Payment Required (pay 3.50 cUSD)
POST /send-airtime + X-PAYMENT: 0xabc... → 200 OK ✓
```

- x402 protocol — no API keys, no OAuth, just crypto
- Product cost + 1.5% service fee
- Replay guard + auto-refund on failure
- Also speaks MCP (13 tools) and Google A2A protocol

A support agent sending airtime as compensation. A rewards agent distributing gift cards. They all just pay Toppa.

---

## SLIDE 8 — Trust & Architecture

**On-chain identity. Verifiable reputation.**

- ERC-8004 Agent #1870 on Celo Mainnet
- Self Protocol ZK verification — passport scan, no data stored
- Tiered limits: $20/day → $200/day verified

**LangGraph StateGraph — 34 tools**

- 4 paid execution + 30 free discovery tools
- Multi-currency via Uniswap V3 (CELO, USDC, USDT, cEUR → cUSD)
- Voice transcription (Deepgram), wallets encrypted AES-256-GCM
- 5 interfaces: Telegram, WhatsApp, x402 API, MCP, A2A

---

## SLIDE 9 — Roadmap & Vision

**Built. Shipping. Next.**

SHIPPED:
- Telegram + WhatsApp bots with full feature parity
- Airtime, data, bills, gift cards across 170+ countries
- Group wallets with poll governance
- x402, MCP, A2A protocols
- ERC-8004 identity + Self Protocol ZK verification
- Scheduled payments, smart memory, voice notes

IN PROGRESS:
- Gift card sell pipeline (sell unused cards for cUSD)
- Cross-chain bridge (Ethereum, Base, Arbitrum → Celo)

NEXT:
- MiniPay deep integration
- Developer SDK (npm package)
- Merchant tools & bulk distribution
- Fiat on/off ramps (M-Pesa, MTN MoMo)
- P2P transfers by name or phone number

---

## SLIDE 10 — Try It Now

**Toppa is live. Not a demo. Not testnet. Real transactions on Celo Mainnet.**

170+ countries | 800+ operators | 300+ brands | 14,000+ products | 34 tools | Open source (MIT)

USE IT: t.me/toppa402Bot
SEE IT: toppa.cc
BUILD ON IT: toppa.cc/docs
VERIFY IT: 8004scan.io/agents/celo/1870
GITHUB: github.com/fortuneofweb3/toppabot

Built on Celo. Agents doing real things for real people.
