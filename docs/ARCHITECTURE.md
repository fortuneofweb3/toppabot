# Toppa Architecture

**Clean, modular, production-ready architecture for an AI agent on Celo**

---

## System Overview

```
┌─────────────────┐      ┌─────────────────┐      ┌─────────────────┐
│  Telegram Bot   │      │  WhatsApp Bot   │      │  x402 API       │
│  (Human Users)  │      │  (Human Users)  │      │  (Agent-Agent)  │
└────────┬────────┘      └────────┬────────┘      └────────┬────────┘
         │                        │                        │
         │ Free (rate-limited)    │ Free (rate-limited)    │ Paid (cUSD)
         │                        │                        │
         └────────────────┬───────┴────────────────────────┘
                          │
               ┌──────────▼──────────┐
               │   Toppa Agent       │
               │   (LangGraph AI)    │
               └──────────┬──────────┘
                          │
         ┌────────────────┼────────────────┐
         │                │                │
    ┌────▼─────┐   ┌──────▼──────┐  ┌──────▼──────┐
    │ Reloadly │   │    Celo     │  │   MongoDB   │
    │   API    │   │ Blockchain  │  │  (Storage)  │
    └──────────┘   └─────────────┘  └─────────────┘
```

---

## Folder Structure

```
src/
├── agent/                     # AI Agent (LangGraph)
│   ├── graph.ts               # LangGraph StateGraph — agent ↔ tools loop
│   ├── state.ts               # Agent state annotation (Annotation.Root)
│   ├── tools.ts               # 36 tools (32 free + 4 paid)
│   ├── memory.ts              # Conversation history (MongoDB, 24h TTL)
│   ├── heartbeat.ts           # Proactive check-ins and scheduled payment execution
│   ├── scheduler.ts           # Cron-like scheduled payment engine
│   ├── goals.ts               # User goals and saved contacts
│   └── user-activity.ts       # Activity tracking for heartbeat targeting
│
├── api/                       # HTTP API Server
│   └── server.ts              # Express (x402, MCP, A2A, discovery, admin)
│
├── apis/                      # External Service Clients
│   ├── reloadly.ts            # Reloadly API (airtime, data, bills, gift cards)
│   └── prestmit.ts            # Prestmit API (gift card sell — coming soon)
│
├── blockchain/                # On-Chain Interactions
│   ├── x402.ts                # x402 payment verification (cUSD Transfer events)
│   ├── erc8004.ts             # ERC-8004 agent identity & registration
│   ├── reputation.ts          # On-chain reputation tracking & peer reviews
│   ├── service-receipts.ts    # Payment → service binding receipts (MongoDB)
│   ├── swap.ts                # Uniswap V3 token swaps on Celo (multi-currency)
│   ├── relay-bridge.ts        # Cross-chain bridge quotes (coming soon)
│   └── replay-guard.ts        # Transaction replay prevention
│
├── bot/                       # Chat Interfaces
│   ├── telegram/              # Telegram-specific
│   │   ├── bot.ts             # Telegram bot — raw Bot API, long polling/webhook
│   │   ├── client.ts          # Minimal Telegram Bot API fetch wrapper
│   │   ├── handlers.ts        # Telegram callback handler (payments, orders, gifts)
│   │   └── webhook.ts         # Prestmit webhook handler (paused)
│   ├── whatsapp/              # WhatsApp-specific
│   │   └── bot.ts             # WhatsApp bot (Baileys + multi-currency + groups)
│   ├── service-executor.ts    # Shared service execution + result formatting
│   ├── groups.ts              # Group wallet infrastructure (MongoDB)
│   ├── group-context.ts       # Group @mention tracking, rate limiting
│   ├── pending-orders.ts      # Order confirmation flow (inline buttons)
│   ├── user-settings.ts       # Per-user settings (timezone, preferences)
│   ├── sell-orders.ts         # Sell order tracking (paused)
│   └── sell-order-poller.ts   # Sell order poller (paused)
│
├── wallet/                    # Wallet Management
│   ├── manager.ts             # WalletManager — create, balance, withdraw, swap
│   ├── crypto.ts              # AES-256-GCM encryption for private keys
│   ├── mongo-store.ts         # MongoDB wallet store implementation
│   └── store.ts               # Wallet store interface + in-memory fallback
│
├── reports/                   # Expenditure Reports
│   └── generator.ts           # PDF (pdfkit) and Excel (exceljs) generation
│
├── mcp/                       # Model Context Protocol
│   ├── server.ts              # MCP Streamable HTTP server
│   └── tools.ts               # 13 MCP tools for AI clients
│
├── a2a/                       # Agent-to-Agent Protocol
│   ├── handler.ts             # A2A JSON-RPC task handler
│   └── agent-card.ts          # A2A Agent Card generator
│
├── shared/                    # Shared Utilities
│   ├── constants.ts           # Chain IDs, token addresses, CAIP-2 IDs
│   ├── sanitize.ts            # Input sanitization (phones, amounts, injection)
│   ├── refund.ts              # Auto-refund on service failure
│   ├── api-cache.ts           # TTL cache for external API responses
│   ├── balance-cache.ts       # Wallet balance cache
│   └── reputation-meta.ts    # Reputation metadata helpers
│
└── index.ts                   # Entry point — starts API, Telegram, WhatsApp
```

---

## Design Principles

### 1. Separation of Concerns

Each folder has a single, clear responsibility:

| Folder | Responsibility | Depends On |
|--------|---------------|------------|
| `agent/` | AI logic, LangGraph flow, tools | `apis/`, `blockchain/`, `wallet/` |
| `api/` | HTTP endpoints, x402 payment gates | `blockchain/`, `apis/`, `mcp/`, `a2a/` |
| `apis/` | External service clients | Nothing (pure clients) |
| `blockchain/` | On-chain interactions | Nothing (viem only) |
| `bot/` | Telegram + WhatsApp interfaces | `agent/`, `wallet/`, `bot/groups` |
| `wallet/` | Key management, balances, transfers | `blockchain/` |
| `reports/` | PDF/Excel generation | `blockchain/service-receipts` |
| `mcp/` | MCP protocol server | `apis/` |
| `a2a/` | A2A protocol handler | `agent/` |

### 2. Dependency Flow

Clean, acyclic dependency graph:

```
index.ts
  ├─> api/server.ts ──┐
  │                   ├─> blockchain/x402.ts
  │                   ├─> blockchain/erc8004.ts
  │                   ├─> apis/reloadly.ts
  │                   ├─> mcp/server.ts
  │                   └─> a2a/handler.ts
  │
  ├─> bot/telegram/bot.ts
  │     ├─> agent/graph.ts
  │     │     ├─> agent/tools.ts
  │     │     │     ├─> apis/reloadly.ts
  │     │     │     ├─> blockchain/swap.ts
  │     │     │     ├─> wallet/manager.ts
  │     │     │     └─> bot/groups.ts
  │     │     └─> agent/state.ts
  │     ├─> bot/telegram/handlers.ts
  │     ├─> wallet/manager.ts
  │     ├─> bot/groups.ts
  │     └─> reports/generator.ts
  │
  └─> bot/whatsapp/bot.ts
        ├─> agent/graph.ts (same as above)
        ├─> bot/service-executor.ts
        ├─> wallet/manager.ts
        ├─> bot/groups.ts
        └─> reports/generator.ts
```

**No circular dependencies.**

### 3. Single Responsibility

Each file does ONE thing:

- `server.ts` — HTTP endpoints only (no business logic)
- `reloadly.ts` — Reloadly API client only (no auth logic)
- `x402.ts` — x402 payment verification only (no HTTP handling)
- `telegram/bot.ts` — Telegram bot only (delegates to agent for AI)
- `whatsapp/bot.ts` — WhatsApp bot only (delegates to agent for AI)
- `groups.ts` — Group wallet CRUD + polls (no platform logic)
- `manager.ts` — Wallet operations only (no bot logic)
- `graph.ts` — LangGraph orchestration (no direct API calls)

---

## Agent Architecture (LangGraph)

The AI agent uses LangGraph's `StateGraph` with two nodes and conditional edges:

```
┌──────────┐     tool_calls?     ┌──────────┐
│  Agent   │ ────────────────>   │  Tools   │
│  (LLM)   │ <────────────────   │ Execute  │
└──────────┘     results         └──────────┘
     │
     │ no tool_calls (final response)
     ▼
  ┌──────┐
  │ END  │
  └──────┘
```

**Key features:**
- **Conditional routing** — Agent node checks for tool calls; routes to tools node or END
- **Payment short-circuit** — When a paid tool returns `payment_required`, the loop exits immediately with the order confirmation (no extra LLM call)
- **Fidelity check** — Post-response validation catches LLM misreading of tool results (e.g., saying "failed" when the tool returned success)
- **Fallback LLM** — If primary model (Gemini 2.0 Flash) errors, falls back to Llama 3.3 70B for 5 minutes
- **Iteration cap** — Maximum 10 agent↔tools loops to prevent runaway tool calling
- **Streaming** — Optional `onStream` callback for real-time response chunks

### Tool Categories

| Category | Count | Examples |
|----------|-------|---------|
| Free (discovery) | 15 | check_country, get_operators, get_billers, search_gift_cards |
| Free (wallet) | 6 | check_balance, get_deposit_address, withdraw |
| Free (group) | 4 | group_info, group_contribute, group_spend, group_create_poll |
| Free (utility) | 7 | save_contact, set_schedule, generate_statement, check_promotions |
| Paid (services) | 4 | send_airtime, send_data, pay_bill, buy_gift_card |

---

## Bot Architecture

### Telegram (Raw API)

Uses direct `fetch()` calls to the Telegram Bot API — no framework dependencies.

- **telegram/client.ts** — Typed wrapper: `tg('sendMessage', { chat_id, text })`
- **Long polling** by default, auto-switches to webhook when `API_URL` is set
- **@mention filtering** — In groups, free text only processed when bot is @mentioned or replied to. Commands (`/`) always work.
- **Group context** — When mentioned, bot gets last 5 messages + replied-to message for context
- **Voice messages** — In groups, only processed when replying to the bot

### WhatsApp (Baileys)

Uses the `@whiskeysockets/baileys` library for WhatsApp Web multi-device.

- **QR code pairing** — Scan QR in terminal to connect
- **Multi-currency** — Shows all token balances in `/wallet`, `/swap` converts to cUSD
- **@mention filtering** — Same pattern as Telegram (mentionedJid + participant checks)
- **Native polls** — WhatsApp poll messages for group voting
- **Reconnection** — Exponential backoff with 60s cap

### Group Wallets (Shared)

Platform-agnostic group wallet system backed by MongoDB:

- **groups** collection — Group metadata, admin, members, wallet address
- **group_polls** collection — Active/completed polls with vote tracking
- **group_transactions** collection — Contribution/withdrawal/spend history
- Each group gets a unique Celo wallet (keyed as `group_<groupId>`)
- Poll threshold configurable per group (default 70%)
- Polls auto-expire after 24 hours

---

## Wallet Management

### Encryption

Private keys are encrypted at rest using AES-256-GCM:

```
plaintext key → AES-256-GCM encrypt → { iv, authTag, ciphertext } → MongoDB
```

- `WALLET_ENCRYPTION_KEY` env var (32-byte hex)
- Unique IV per encryption operation
- Auth tag prevents tampering

### WalletManager

Central wallet operations class:

- `getOrCreateWallet(userId)` — Create or retrieve wallet
- `getBalance(userId)` — cUSD balance (with cache)
- `getAllBalances(userId)` — All token balances (cUSD, CELO, USDC, USDT, cEUR)
- `withdraw(userId, toAddress, amount)` — Send cUSD
- `autoSwapToCUSD(userId)` — Swap all non-cUSD tokens via Uniswap V3

---

## Security Architecture

### Defense Layers

```
┌─────────────────────────────────────────────┐
│ Layer 1: Network (CORS, Helmet, HTTPS)     │
├─────────────────────────────────────────────┤
│ Layer 2: Rate Limiting (20 req/5min API,   │
│          10 req/5min bot, $50/day cap)      │
├─────────────────────────────────────────────┤
│ Layer 3: Input Sanitization (phones,       │
│          amounts, prompt injection filter)  │
├─────────────────────────────────────────────┤
│ Layer 4: Authentication (x402 on-chain,    │
│          admin API key, webhook HMAC)       │
├─────────────────────────────────────────────┤
│ Layer 5: Wallet Encryption (AES-256-GCM)   │
├─────────────────────────────────────────────┤
│ Layer 6: Output Sanitization (safe errors) │
└─────────────────────────────────────────────┘
```

### Attack Surface

| Component | Public? | Attack Vectors | Mitigation |
|-----------|---------|---------------|------------|
| **x402 API** | Yes | DDoS, payment bypass, injection | Rate limit, on-chain verification, sanitization |
| **Telegram Bot** | Yes | Prompt injection, balance drain, spam | Prompt filter, rate limit, spending cap |
| **WhatsApp Bot** | Yes | Same as Telegram | Same mitigations + Baileys security |
| **Group Wallets** | Yes | Unauthorized spend, vote manipulation | Admin-only withdrawals, poll thresholds |
| **Wallet Keys** | No | Key theft if DB compromised | AES-256-GCM encryption at rest |
| **Reloadly API** | No | Balance drain if keys leaked | Server-only, env vars |
| **Admin Endpoints** | No | Data exfiltration | API key + timing-safe comparison |

---

## Data Flow

### Data Never Exposed to Client
- Private keys (encrypted in MongoDB, never sent over network)
- `CELO_PRIVATE_KEY` (agent wallet — server only)
- `RELOADLY_CLIENT_SECRET` (server only)
- `WALLET_ENCRYPTION_KEY` (server only)
- Internal file paths (filtered from errors)

### Data Exposed Safely
- Wallet addresses (public by design)
- Transaction hashes (public on-chain)
- Operator/biller names (public catalog)
- Error codes (not messages)

---

## Request Flow

### Telegram Message → Agent Response

```
1. User sends "Send $5 airtime to +1234567890"
   └─> bot/telegram/bot.ts: handleUpdate()
       ├─> Rate limit check (10 req/5min)
       ├─> @mention check (groups only)
       ├─> Prompt injection filter
       ├─> Sanitize input
       ├─> wallet/manager.ts: getBalance()
       └─> agent/graph.ts: runToppaAgent()
           ├─> Build system prompt + load history
           ├─> LangGraph invoke (agent ↔ tools loop)
           │   ├─> tools: check_country → "NG"
           │   ├─> tools: send_airtime → payment_required JSON
           │   └─> Short-circuit: return order confirmation
           ├─> Fidelity check
           └─> Save to memory (non-blocking)
       └─> Show inline buttons: [Confirm] [Cancel]
```

### Group Poll → Execution

```
1. Member asks "Buy $10 airtime from group wallet"
   └─> agent interprets → group_spend tool
       └─> Creates poll in MongoDB
           └─> Sends native poll to group chat

2. Members vote on poll
   └─> poll_answer event → recordPollVote()
       └─> If threshold met:
           ├─> Execute service (send_airtime via Reloadly)
           ├─> Record transaction in group_transactions
           └─> Notify group of result
```

---

## Deployment

### Production

```
Cloud Server (toppa.cc)
  ├─> Nginx (HTTPS, reverse proxy)
  │     └─> Node.js (port 3000)
  │           ├─> Telegram Bot (webhook)
  │           ├─> WhatsApp Bot (Baileys WS)
  │           ├─> x402 API
  │           ├─> MCP Server
  │           └─> A2A Server
  │
  ├─> MongoDB Atlas (wallets, conversations, groups, receipts)
  ├─> Celo Mainnet (via Forno RPC)
  └─> Reloadly Production
```

---

## Documentation Index

- **API Reference:** [docs/api/API.md](api/API.md)
- **Security:**
  - [docs/security/SECURITY_AUDIT.md](security/SECURITY_AUDIT.md)
  - [docs/security/SECURITY_2026_CHECKLIST.md](security/SECURITY_2026_CHECKLIST.md)
  - [docs/security/MONGODB_SECURITY.md](security/MONGODB_SECURITY.md)
  - [docs/security/TELEGRAM_BOT_SECURITY.md](security/TELEGRAM_BOT_SECURITY.md)
- **Architecture:** This file
