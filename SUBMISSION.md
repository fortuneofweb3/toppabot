# Devfolio Submission — Synthesis Hackathon

## Project Name
Toppa — AI Agent for Real-World Payments on Celo

## Tagline
Autonomous AI agent that converts cUSD to airtime, data, bills & gift cards in 170+ countries via Telegram and WhatsApp

## Tracks Applied
Best Agent on Celo
Agents With Receipts — ERC-8004
Agentic Finance (Best Uniswap API Integration)
Best Self Protocol Integration
Synthesis Open Track
Ship Something Real with OpenServ
Student Founder's Bet
Let the Agent Cook — No Humans Required

## Links
Repo: https://github.com/fortunafinances/toppa-agent
Live Demo: https://t.me/toppa402bot
Video Demo: https://toppa.cc/demo
Website: https://toppa.cc

## Cover Image
MISSING — Upload a cover image on Devfolio. The first image becomes the project thumbnail on the Mandate showcase. Without it, your project shows as blank.

## Problem
Billions of people across emerging markets need to buy airtime, pay utility bills, and access digital goods daily — but traditional payment rails exclude them. Crypto has the infrastructure for borderless payments, but the UX gap between holding stablecoins and actually buying real-world goods remains massive. There's no simple way to go from cUSD on Celo to airtime on an MTN phone in Nigeria, or to pay a DStv bill in Lagos, without navigating multiple apps, KYC processes, and fiat offramps.

Toppa solves this by acting as an autonomous agent that bridges on-chain stablecoins to real-world digital goods delivery. Users interact in natural language (text or voice), the agent handles everything else — operator detection, currency conversion, payment execution, delivery confirmation, and on-chain reputation tracking.

The result: anyone with cUSD can buy airtime in 170+ countries in under 10 seconds, with verifiable proof of delivery on-chain.

## Description (copy-paste this into Devfolio — plain text, no markdown)

Toppa is an autonomous AI agent (ERC-8004 Agent #1870 on Celo) that lets anyone buy digital goods using cUSD — airtime, data, utility bills, and gift cards across 170+ countries, 800+ operators, 14,000+ products. No bank account, no KYC, no fiat offramp complexity. Just tell it what you need in plain language or send a voice note.

Real users send real money through Toppa every day via Telegram and WhatsApp. Every successful delivery builds verifiable on-chain reputation via ERC-8004. Every failed delivery triggers an automatic refund and negative reputation feedback. The agent's trust is literally on-chain.


CORE ARCHITECTURE

The agent runs on a LangGraph StateGraph — an agentic tool-calling loop with conditional edges, payment short-circuit, and post-response fidelity checking. It has 36 tools (32 free + 4 paid) covering operator detection, currency conversion, balance checks, and airtime/data/bill/gift card execution. The LLM is Gemini 2.0 Flash via OpenRouter with automatic fallback to Llama 3.3 70B.

Every paid service call goes through a 3-stage validation pipeline: (1) LLM calls the tool with user's request, (2) tool validates server-side against Reloadly's real data (operator detection, price range, product availability), (3) short-circuit creates an order confirmation from validated tool output. The LLM never generates order confirmations directly — any attempt to bypass validation is caught and blocked.


CELO INTEGRATION (Best Agent on Celo)

Toppa is built natively on Celo. All payments use cUSD stablecoin on Celo mainnet. The agent wallet uses viem for all on-chain interactions. Every user gets a custodial Celo wallet with AES-256-GCM encrypted private keys stored in MongoDB. Users can deposit cUSD, CELO, USDC, USDT, or cEUR and auto-swap to cUSD. Withdrawals go to any Celo address. The agent's on-chain identity is registered as ERC-8004 Agent #1870 on Celo's identity registry at 0x8004BAa17C55a88189AE136b182e5fdA19dE9b63.

Group wallets are also Celo wallets — shared by Telegram/WhatsApp groups with democratic poll-based governance. Members contribute cUSD from their personal wallets. All group spending requires poll approval (configurable threshold, default 70%). Admin can bypass polls, configure poll expiry, export group wallet keys, and withdraw funds. Contribution notifications are sent as private DMs with balance deduction details.


ERC-8004 INTEGRATION (Agents With Receipts)

Toppa is registered as Agent #1870 on Celo's ERC-8004 identity registry. Every successful service delivery submits signed on-chain feedback to the reputation registry at 0x8004B663056A597Dffe9eCcC1965A193B7388713. Feedback includes engagement tags (tag1 = engagement type, tag2 = service category) and a positive/negative score. Failed deliveries submit negative feedback. This creates a verifiable, immutable track record of the agent's performance.

On-chain receipts bind payment transactions to service delivery outcomes. Each receipt includes the payment tx hash, service type, delivery status, and Reloadly transaction ID. Failed services trigger automatic refunds to the user's wallet (or group wallet in group context).

Verify at: 8004scan.io/agents/celo/1870, agentscan.info, karmahq.xyz/project/toppa


UNISWAP INTEGRATION (Best Uniswap API Integration)

Users deposit any Celo token (CELO, USDC, USDT, cEUR) and use /swap to convert everything to cUSD. The primary swap path uses the Uniswap Trading API — it finds the optimal route across all available liquidity pools and returns a pre-built transaction. The agent signs and submits this transaction on Celo.

When the Trading API fails (common for small amounts or illiquid pairs), the agent falls back to direct SwapRouter02 V3 contract interaction. It encodes the swap parameters, sets appropriate slippage, and executes the swap at the contract level. This dual approach ensures swaps always work regardless of amount size.

The swap command shows a before/after breakdown of all token balances so users can see exactly what was converted.


SELF PROTOCOL INTEGRATION (Best Self Protocol Integration)

Toppa uses Self Protocol for ZK proof-of-humanity, enabling tiered spending limits without any KYC or personal data disclosure. Unverified users have a $20/day spending limit. Self-verified users unlock $200/day.

The verification flow: user types /verify in Telegram or WhatsApp. The bot creates a verification session and generates a Self universal deep link using getUniversalLink from @selfxyz/core. User taps the link, the Self app opens, and they scan their passport via NFC (takes about 30 seconds). Self Protocol sends a ZK proof to the POST /api/verify callback endpoint. The server verifies the proof using SelfBackendVerifier from @selfxyz/core. On success, the user's spending limit is upgraded from $20 to $200/day. The bot sends a confirmation message.

Sybil resistance is built in — one passport equals one identity across all accounts, enforced via nullifiers. No personal data is stored or disclosed. Self Agent ID is #48 on Celo Sepolia at 0x9480a88916074D9B2f62c6954a41Ea4B9B40b64c.

Endpoints: GET /verify?token=... (landing page), POST /api/verify (ZK proof callback), GET /api/verify/status?userId=... (status check).


x402 PAYMENT PROTOCOL

Toppa implements x402 (HTTP 402 Payment Required) for agent-to-agent micropayments. Other AI agents can call POST /send-airtime, /send-data, /pay-bill, or /buy-gift-card. Without payment, the server returns 402 with pricing info. The agent pays cUSD on Celo, includes the tx hash in X-PAYMENT header, and the server verifies the Transfer event on-chain before executing the service. This enables any AI agent to buy real-world goods programmatically.


MCP (MODEL CONTEXT PROTOCOL)

Toppa exposes 13 tools via MCP Streamable HTTP transport. Claude Desktop, Cursor, and other MCP clients can connect and use tools like send_airtime, search_gift_cards, convert_currency, get_operators, etc. This lets any MCP-compatible AI assistant access Toppa's full service catalog.


A2A (AGENT-TO-AGENT PROTOCOL)

Toppa implements Google's A2A JSON-RPC protocol for agent interoperability. It publishes an Agent Card with capabilities, supported services, and pricing. Other agents discover Toppa via the Agent Card and send JSON-RPC requests to execute services.


MULTI-INTENT RESOLUTION

"Get my brother 500 naira airtime in Nigeria, pay mom's DStv bill in Lagos, and buy me a $25 Steam gift card" — Toppa parses this into three parallel tool calls and executes them all in a single turn. The agent detects operators, validates billers, searches gift cards, and creates order confirmations for each service simultaneously.


PLATFORMS

Telegram Bot: Personal wallets with deposit/withdraw/swap, inline button order confirmation, voice note transcription via Deepgram, group wallets with democratic poll-based governance (native Telegram polls), scheduled and recurring payments with interactive task buttons, gift card claiming and gifting in groups, /verify for Self Protocol identity, /settings with timezone and auto-review toggles, expenditure report generation (PDF/Excel).

WhatsApp Bot: Same personal wallet system via Baileys WebSocket, multi-currency deposits with /swap, voice note transcription, group wallets with native WhatsApp poll voting, /tasks and /task commands for scheduled payment management, /export group for admin group key export, contribution DM notifications, QR code pairing for self-hosted setup.


SCHEDULED PAYMENTS

A heartbeat engine runs every 15 minutes checking for due tasks. Users say "send mom airtime every Friday" or "pay my DStv on the 15th of every month" and the agent creates recurring tasks. One-time scheduled tasks also supported. Tasks are viewable with interactive buttons in Telegram and text commands in WhatsApp. Recurring tasks show frequency indicators. Failed tasks retry with exponential backoff and auto-pause after consecutive failures.


EXPENDITURE REPORTS

Users can request PDF or Excel statements of their transaction history. Works for both personal wallets and group wallets. Supports date range filtering. Reports are generated using pdfkit (PDF) and exceljs (Excel) and delivered as documents directly in the chat.


VOICE NOTES

Send a voice message on Telegram or WhatsApp and Toppa transcribes it via Deepgram STT, then processes the request as text. Supports English, French, Yoruba, Swahili, and other languages. Works for all services — "send 500 naira airtime to my brother" spoken into a voice note works the same as typing it.


SMART MEMORY

Toppa remembers contacts, phone numbers, preferences, and transaction patterns across sessions using MongoDB-backed conversation history with 24-hour TTL. If someone always sends airtime to the same number, the agent offers to do it again. Users can explicitly save instructions like "my brother's number is +234..." and the agent stores them as long-term preferences.


SECURITY

All wallet private keys are AES-256-GCM encrypted in MongoDB. Input sanitization catches injection attempts in phone numbers, account numbers, and amounts. Rate limiting prevents abuse. The LLM is treated as an untrusted intermediary — every tool argument is re-validated server-side against Reloadly's real API data before execution. Failed services trigger automatic refunds. Group wallet keys are only exportable by the admin from private DM (never in group chat).


ON-CHAIN VERIFICATION

ERC-8004 Agent #1870: https://www.8004scan.io/agents/celo/1870
Agentscan: https://agentscan.info/agents/e42ebcb1-fd03-4fe8-ac1a-3cf1c24d80df
Karma: https://www.karmahq.xyz/project/toppa
Self Agent ID: https://app.ai.self.xyz

Smart Contracts:
Identity Registry: 0x8004BAa17C55a88189AE136b182e5fdA19dE9b63 (Celo Mainnet)
Reputation Registry: 0x8004B663056A597Dffe9eCcC1965A193B7388713 (Celo Mainnet)
Self Agent ID #48 (Celo Sepolia): 0x9480a88916074D9B2f62c6954a41Ea4B9B40b64c


## Challenges Overcome (copy-paste into Devfolio)

1. LLM hallucinating operatorIds — Deepseek/Gemini would invent operator IDs from training data instead of calling detect_operator. Fixed by server-side re-validation in the service executor layer. All LLM-provided operator IDs are ignored; auto-detection runs at execution time against Reloadly's real API.

2. Gift card product availability race condition — Reloadly's catalog API returns delisted products that fail at purchase time. Added 3-layer defense: filter unavailable products from search results, check product.status before showing order confirmation, and re-check at execution time with auto-refund.

3. Order confirmation bypass — LLM would sometimes generate order_confirmation JSON directly (bypassing tool validation), leading to hallucinated amounts and operators. Solved with a post-response safety check that strips any LLM-generated order_confirmation and forces the tool -> validate -> short-circuit pipeline.

4. Poll vs Task confusion — LLM would call schedule_recurring (private task) and tell the user "I've created a poll" when in a group chat. Added post-response safety check that catches this lie and corrects it, plus explicit system prompt separation of polls vs tasks.

5. Group wallet balance leak — When admin bypassed polls in group chat, the bot was using the personal wallet balance instead of the group wallet. Traced the full flow from group_spend tool through checkPaymentShortCircuit to the bot layer and added payFrom/groupWalletId passthrough.

6. Uniswap swap failures — Trading API sometimes rejects quotes for small amounts or illiquid pairs. Implemented a direct SwapRouter02 V3 contract fallback that executes the swap at the contract level when the Trading API fails.

7. WhatsApp 405 version errors — Baileys would connect with a stale WhatsApp Web version, causing 405 disconnects. Added fetchLatestBaileysVersion() at startup to always use the current WA Web version.

## Technologies Used
Celo, LangGraph, Uniswap V3, Self Protocol, ERC-8004, x402, MCP, A2A, MongoDB, TypeScript, Express, Telegram Bot API, Baileys (WhatsApp), Deepgram, Reloadly, viem, pdfkit, exceljs

## Video Demo
https://toppa.cc/demo
