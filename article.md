# I Built an AI Agent That Other AI Agents Can Pay to Buy Anything, Anywhere

**[INSERT HERO IMAGE: Vector illustration — shocked robot with dense chaos behind]**
![Toppa Final 5:2 Hero Image](/Users/fortune/.gemini/antigravity/brain/ebc2b9f4-cb3e-4f7f-81ef-13c733612007/article_hero_final_5_2.png)

It started with a simple question: what if an AI agent could walk into any store in any country and buy something for you?

Not a theoretical something. Not a token swap or a DeFi yield. Something real — airtime for your brother in Lagos, a DStv subscription for your mom in Nairobi, a Steam gift card for yourself, a data bundle for your cousin in Accra. All from one conversation.

That's Toppa. And the part that gets interesting? It's not just for humans. Other AI agents can pay it to do the same thing.

---

## The Problem Nobody's Solving

There are over 2.4 billion people in emerging markets who buy airtime, data bundles, and utility top-ups regularly. The process hasn't changed in years — walk to a kiosk, wrestle with USSD menus, or hope your mobile money app doesn't time out.

Meanwhile, we're building the "agentic economy." Agents that book flights, write code, trade crypto, generate art. But ask any of them to top up a phone number in Lagos? Nothing. Ask one to pay an electricity bill in Nairobi? Silence.

The most basic digital transaction that billions of people make every day — and no agent can do it.

**[INSERT SCREENSHOT: Telegram conversation showing a user asking Toppa to send airtime and Toppa executing it]**

---

## What Toppa Actually Does

Toppa is an autonomous AI agent running on @Celo. You talk to it in plain language — type or send a voice note in English, French, Yoruba, or Swahili on Telegram, WhatsApp, or call its API — and it handles the rest.

**What it sells:**
- Airtime top-ups across 170+ countries, 800+ mobile operators
- Data bundles — 1GB, 5GB, 10GB, you name it
- Utility bills — electricity, water, TV (DStv, GOtv, Startimes), internet
- Gift cards — 2,000+ products discovery depth. Amazon, Steam, Netflix, Binance, Spotify, PlayStation, Xbox, Uber, Airbnb, Apple, Google Play, prepaid Visa/Mastercard, and more

No bank account. No KYC. No fiat offramp. Just cUSD on @Celo.

But here's where it gets real.

---

## One Message, Three Countries, Zero Questions

Most "AI agents" are really just chatbots with an API key. You say something, they ask five clarifying questions, then call one endpoint. That's not an agent — that's a form with extra steps.

Toppa does something different. Say this:

> "Get my brother 500 naira airtime in Nigeria, pay mom's DStv bill in Lagos, and buy me a $25 Steam gift card"

Toppa parses that into three separate operations. It auto-detects the mobile operator from the phone number. It resolves the DStv biller. It finds the right Steam card denomination. Then it executes all three — in parallel.

This is where AI genuinely matters. Not as a wrapper, but as the thing that turns a messy human sentence — typed or spoken via voice note — into structured, parallel operations across different services and countries.

**[INSERT SCREENSHOT: Real Telegram conversation showing a multi-intent request being parsed and executed]**

---

## It Thinks About You When You're Not Talking To It

Here's what separates Toppa from every other agent I've seen at hackathons: it doesn't just respond. It acts on its own.

**Scheduled Tasks** — You can tell Toppa things like:
- "Send 500 naira airtime to +234... at 5pm"
- "Pay my DStv bill every month on the 1st"
- "Buy me a 2GB data bundle tomorrow morning"

It stores the task, and a background scheduler checks every 60 seconds for due tasks. When the time comes, it handles the payment and execution automatically — and notifies you when it's done.

But here's the part most agent wallets get wrong: **state transitions**. Toppa uses atomic task claiming — a MongoDB `updateOne` with a status filter that ensures only one process can claim a task. No double-execution. No double-payments. If the server crashes mid-execution, stuck tasks are auto-detected and recovered within 10 minutes on restart.

Recurring payments get their own failure tracking. Each consecutive failure increments a counter. After 3 consecutive failures (configurable), the recurring task auto-disables — no infinite retry loops draining a user's wallet. A single success resets the counter.

**Standing Instructions** — Toppa remembers your preferences persistently:
- "Always top up my brother +234... on the 1st of every month with 1000 NGN"
- "My mom's DStv account is 1234567890 — never let it expire"
- "I prefer MTN for all Nigerian numbers"
- "My default country is Nigeria"

These are loaded before every single interaction. When you say "send him airtime," Toppa already knows who "him" is, what network they're on, and what country they're in.

**Heartbeat Engine** — Every 15 minutes, Toppa wakes up. It reviews every active user's context — their goals, their conversation history, available promotions in their country. If there's something genuinely useful and actionable, it sends a proactive message. A bill coming due? A relevant airtime promo? A follow-up on yesterday's conversation?

Anti-spam safeguards keep it from being annoying — max one proactive message per user every 4 hours, and suspicious content is automatically blocked.

This isn't request-response. This is an agent that thinks about its users even when they're asleep.

**[INSERT ILLUSTRATION: Simple diagram showing the autonomous loop — Scheduler (every 60s) > Heartbeat (every 15min) > User Goals > Proactive Messages]**

---

## Group Wallets — Pool Money, Spend With a Vote

Add Toppa to any Telegram or WhatsApp group and enable a shared wallet. Members contribute cUSD from their personal wallets into the group pool. Want to spend? A democratic poll goes out.

Here's how it works:

1. **Enable** — Any admin types `/group enable` to create a shared group wallet
2. **Contribute** — Members send `/contribute 5` to add 5 cUSD from their personal balance. They get a private DM confirming the deduction
3. **Spend** — Someone asks Toppa to buy something. A native poll goes out to the group (Telegram poll or WhatsApp poll — not a custom button, a real platform poll)
4. **Vote** — When the approval threshold is met (default 70%, configurable), the purchase executes automatically from the group balance
5. **Track** — Full transparency. Every contribution, withdrawal, and spend is logged. Generate PDF or Excel reports for the whole group

Admins get extra controls: bypass polls for urgent purchases, configure the approval threshold, set poll expiry time (minimum 1 hour), export the group wallet's private key, and withdraw funds.

This solves a real problem. Offices pooling money for internet bills. Friend groups sharing a Netflix subscription. Families collectively paying utilities. The infrastructure for transparent, governed group spending didn't exist in messaging apps — now it does.

**[INSERT SCREENSHOT: Group chat showing a poll vote and automatic purchase after approval]**

---

## Multi-Currency — Deposit Anything, Spend cUSD

Not everyone holds cUSD. That's fine. Toppa accepts deposits in CELO, USDC, USDT, or cEUR and auto-swaps everything to cUSD via Uniswap V3.

Type `/swap`, and Toppa routes through the Uniswap Trading API for the best rate. If the API rejects the quote, it falls back to direct SwapRouter02 on-chain. You see a before/after breakdown of all your balances.

One wallet, multiple tokens in, one stablecoin out.

---

## Reports — Every Transaction, Documented

Tell Toppa "give me my statement" and it drops a PDF or Excel file right in the chat. Every airtime purchase, data bundle, bill payment, gift card order, swap, and group contribution — all listed with dates, amounts, and statuses.

Works for personal wallets and group wallets. Filter by date range. Cached for 5 minutes so repeated requests don't regenerate.

For groups, this is accountability. Every member can see exactly where the money went.

---

## Identity Verification — Higher Limits, Zero Data Stored

By default, Toppa gives every user a $20/day spending limit. Want more? Verify your identity.

Type `/verify`, tap the link, scan your passport or ID with the Self app. 30 seconds. Done. Your limit jumps to $200/day.

Here's the key: Toppa uses Self Protocol's zero-knowledge proofs. It verifies that you're a real person with a valid document — without ever seeing or storing your personal data. No name, no passport number, no photo. Just a cryptographic proof that you passed verification.

**[INSERT SCREENSHOT: The /verify flow — tap link, scan passport, limit upgraded]**

---

## Now Here's the Wild Part: Agent-to-Agent Commerce

Everything I just described? It's not just for humans.

Any AI agent on the internet can call Toppa's API, pay the product cost + a 1.5% service fee, and Toppa will execute the operation. No API keys. No OAuth. No business development partnership. Just crypto.

This is the x402 protocol — HTTP 402 Payment Required. When an agent calls Toppa's endpoint without payment, it gets back a 402 response with payment instructions. The agent sends cUSD to Toppa's wallet on @Celo, includes the transaction hash in the header, and Toppa verifies the payment on-chain before executing.

```
# 1. Agent calls without payment — gets 402
POST https://api.toppa.cc/send-airtime → 402 Payment Required

# 2. Agent pays product cost + 1.5% fee on Celo, calls again with proof
POST https://api.toppa.cc/send-airtime
X-PAYMENT: 0xYOUR_CUSD_TX_HASH
{"phone": "08147658721", "countryCode": "NG", "amount": 5}
→ 200 OK — airtime sent
```

Every payment goes through a replay guard — MongoDB-backed atomic deduplication ensures no transaction hash can be used twice. If the service fails after payment, Toppa auto-refunds the cUSD to the payer. Full receipt tracking links every payment to its service result.

Think about what this enables. A personal assistant agent that manages your family's phone bills. A customer support agent that sends airtime as compensation. A rewards agent that distributes gift cards. None of them need to integrate with telecom APIs — they just pay Toppa.

Agents paying agents. The agentic economy doing something useful.

**[INSERT SCREENSHOT: The x402 payment flow — showing a 402 response then a successful request with payment header]**

---

## Every Protocol, Every Interface

Toppa doesn't lock you into one way of accessing it. It speaks every major agent and user protocol:

**For Humans:**
- **Telegram Bot** — Full-featured chat interface with in-app cUSD wallets, inline confirmations, order tracking, group wallets, and voice note input — just record what you need and Toppa transcribes and acts on it
- **WhatsApp Bot** — Same capabilities, full feature parity. Reaching the 2+ billion users who live on WhatsApp

**For AI Agents:**
- **REST + x402** — Pay-per-call HTTP API. Any agent, any language, any framework. Replay-guarded with auto-refund on failure
- **MCP (Model Context Protocol)** — 14 tools that plug directly into Claude Desktop, Cursor, and any MCP-compatible client. Free discovery tools + paid execution via x402
- **A2A (Agent-to-Agent)** — Google's protocol for agent interoperability. Full v1.0 spec — agents can discover Toppa via `agent-card.json`, send tasks via JSON-RPC, and track task status with persistent history

**[INSERT SCREENSHOT: Architecture diagram showing all protocol entry points — Telegram, WhatsApp, MCP, x402 API, A2A]**

---

## On-Chain Identity and Reputation

Toppa isn't anonymous. It's registered as **Agent #1870** on @Celo's ERC-8004 Identity Registry — an NFT-based on-chain identity that anyone can verify before interacting.

And it has skin in the game. The ERC-8004 Reputation Registry tracks every transaction with on-chain feedback. Every successful airtime delivery, every gift card that redeemed correctly, every bill that got paid — it all contributes to a verifiable reputation score that any agent or user can query.

This is what trust looks like in the agentic economy. Not a logo on a website. Not a "verified" badge from a centralized platform. An immutable, on-chain track record.

**[INSERT SCREENSHOT: 8004scan.io/agents/celo/1870 page showing agent profile, reputation score, and review history]**

---

## The Architecture

For the builders reading this — here's how it all fits together:

```
              ┌─────────────┐  ┌─────────────┐  ┌──────────────┐
              │  Telegram    │  │  WhatsApp   │  │  Desktop     │
              │  Bot         │  │  Bot        │  │  (MCP)       │
              └──────┬───────┘  └──────┬──────┘  └──────┬───────┘
                     │                 │                 │ Streamable HTTP
                     ▼                 ▼                 ▼
┌────────────────────────────────────────────────────────────────────────┐
│                           Toppa Agent Core                             │
│                                                                        │
│  ┌───────────────┐  ┌──────────────────────────────────────────────┐   │
│  │  HTTP API     │  │  LangGraph StateGraph                       │   │
│  │  (x402 + A2A) │  │                                             │   │
│  └───────┬───────┘  │  Agent Node ←──→ Tools Node (34 tools)      │   │
│          │          │      │                                       │   │
│          │          │  payment_required? → short-circuit response  │   │
│          │          └──────────────────────────────────────────────┘   │
│          │                                                             │
│  ┌───────┴─────────┐  ┌──────────────┐  ┌──────────────────────────┐  │
│  │ x402 Payment    │  │  Scheduler   │  │  Standing Instructions   │  │
│  │ Verify + Refund │  │  60s poll    │  │  Loaded per interaction  │  │
│  │ Replay Guard    │  │  + Heartbeat │  │  Contacts, prefs, rules  │  │
│  └─────────────────┘  │  + Recurring │  └──────────────────────────┘  │
│                       │  + Recovery  │                                 │
│  ┌─────────────────┐  └──────────────┘  ┌──────────────────────────┐  │
│  │ ERC-8004        │                    │  Group Wallets            │  │
│  │ Identity +      │                    │  Polls + Contributions    │  │
│  │ Reputation      │                    │  Admin controls           │  │
│  └─────────────────┘                    └──────────────────────────┘  │
│                                                                        │
│  ┌─────────────┐  ┌──────────────┐  ┌──────────────┐                  │
│  │ Uniswap V3  │  │  Deepgram    │  │  Self Proto  │                  │
│  │ Multi-swap  │  │  Voice STT   │  │  ZK Identity │                  │
│  └─────────────┘  └──────────────┘  └──────────────┘                  │
└───────────────────────────────────────┬────────────────────────────────┘
                                        │
              ┌─────────────────────────┴────────────────────────┐
              │              Celo Network + MongoDB              │
              │  cUSD payments · Wallet encryption (AES-256-GCM) │
              │  Conversation memory (24h TTL) · Task store      │
              └─────────────────────────────────────────────────┘
```

The agent core is a **LangGraph StateGraph** with two nodes: Agent (LLM call) and Tools (execute tool calls). The agent node decides whether to call tools or return a final response. When a paid tool returns a `payment_required` payload, the loop short-circuits immediately — no extra LLM call needed.

**35 tools** total — 4 paid execution tools (send airtime, send data, pay bill, buy gift card) and 31 free tools covering operator detection, biller search, gift card discovery, currency conversion, multi-token balances, Uniswap swaps, scheduling, recurring tasks, standing instructions, group wallet operations, and report generation.

Conversation memory is MongoDB-backed with a 24-hour TTL — so users can pick up where they left off the next day. Wallets are encrypted at rest with AES-256-GCM. Every user input is sanitized against prompt injection. Every proactive message is filtered for suspicious patterns.

---

## Why Digital Goods?

I get asked this a lot. "Why airtime and gift cards? Why not something more... DeFi?"

Four reasons:

**1. Zero regulatory risk.** Gift cards and airtime are digital merchandise — not money transmission. No banking licenses needed. No compliance departments. No country-by-country regulatory approvals. You're selling products, not moving money.

**2. 170+ countries from day one.** A single API integration covers the globe. No per-country onboarding, no local partnerships, no hardware. It just works.

**3. Real demand.** This isn't hypothetical. Billions of people buy airtime and data every single day. It's one of the largest transaction categories in emerging markets. The demand already exists — the delivery mechanism is what's broken.

**4. AI is genuinely necessary.** Multi-intent parsing, operator detection from phone numbers, plan matching, scheduling, proactive reminders, group governance — these are problems that need an LLM. You can't solve "send my brother airtime and pay mom's bills" with a REST API and a dropdown menu.

**[INSERT INFOGRAPHIC: The numbers — 170+ countries, 800+ operators, 2,000+ products, 35 tools]**

---

## Try It

Toppa is live right now. Not a demo, not a testnet, not a "coming soon." Live, on @Celo mainnet, processing real transactions.

- **Use it:** https://t.me/toppa402bot
- **See it:** https://toppa.cc
- **Build on it:** https://toppa.cc/docs
- **Verify it:** https://www.8004scan.io/agents/celo/1870, https://agentscan.info/agents/e42ebcb1-fd03-4fe8-ac1a-3cf1c24d80df
- **Karma:** https://www.karmahq.xyz/project/toppa
- **GitHub:** https://github.com/fortuneofweb3/toppabot

Built for the @Celo @CeloDevs @CeloPG "Build Agents for the Real World V2" hackathon. Because agents should do real things for real people.

**[INSERT FOOTER BANNER: Toppa logo + Telegram/Website/Docs links + Agent #1870 badge]**
