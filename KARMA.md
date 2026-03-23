Karma About — Draft
(copy this into karmahq.xyz/project/toppa/about)


Toppa is an AI agent that lets you buy airtime, pay bills, purchase gift cards, and manage group finances — all through Telegram or WhatsApp. Just type what you need in plain language. Toppa handles the rest.

Built on Celo, payments happen in cUSD. You can deposit CELO, USDC, USDT, or cEUR — Toppa auto-swaps everything to cUSD via Uniswap V3.


What it does

- Airtime & data for 800+ operators in 170+ countries
- Utility bill payments (electricity, internet, TV, water)
- Gift cards from 300+ brands (Amazon, Steam, Netflix, PlayStation, etc.)
- Group wallets — pool money in any group chat, spend with democratic poll voting
- Multi-currency swaps — deposit any supported token, auto-convert to cUSD
- Scheduled payments — "send mom airtime every Friday" and it just runs
- Smart memory — remembers your contacts, operators, preferences
- Reports — PDF or Excel statements of all transactions
- Voice notes — send a voice message, Toppa transcribes and acts on it
- Identity verification — Self Protocol ZK proofs for higher limits


How it works

You message the bot. Toppa's AI agent (LangGraph with 36 tools) parses your request, detects the operator or biller, calculates the cost, and presents a confirmation. You tap confirm, cUSD gets deducted, service gets delivered. That's it.

For groups: enable a shared wallet, members contribute, and every spend goes through a vote. 70% approval = purchased. Admins can bypass for urgent stuff.


Protocol & interoperability

- x402 — HTTP-native micropayments. Every paid endpoint returns 402 with a cUSD payment offer. No API keys, no subscriptions.
- MCP server — 13 tools. Any MCP-compatible AI agent can use Toppa as a tool.
- A2A (Google Agent-to-Agent) — Toppa can receive tasks from other agents.
- ERC-8004 — Registered on-chain as Agent #1870 on Celo Mainnet.
- Discovery APIs — Free endpoints for operators, billers, countries, gift cards.
- Open source — MIT licensed. github.com/fortuneofweb3/toppabot


Who it's for

- People in emerging markets who rely on prepaid mobile services
- Diaspora users sending airtime/bills to family back home
- Groups (offices, friend circles, families) pooling money for shared expenses
- Developers building AI agents that need real-world payment capabilities
- Anyone who wants to pay for digital services with crypto without the friction


Why Celo

- Sub-cent transaction fees
- Fast finality (~5 seconds)
- Native stablecoins (cUSD, cEUR, cREAL)
- Fee abstraction — gas paid in stablecoins
- Mobile-first ecosystem (MiniPay, Valora)


Links

- Website: https://toppa.cc
- Docs: https://toppa.cc/docs
- Telegram: https://t.me/toppa402Bot
- GitHub: https://github.com/fortuneofweb3/toppabot
- Agent Card: https://api.toppa.cc/.well-known/agent-card.json
- MCP: https://api.toppa.cc/mcp
- Agentscan: https://agentscan.info/agents/e42ebcb1-fd03-4fe8-ac1a-3cf1c24d80df
- 8004scan: https://www.8004scan.io/agents/celo/1870
