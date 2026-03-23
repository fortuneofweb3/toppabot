Karma Profile — Updated Draft
(copy each section into the matching field on karmahq.xyz/project/toppa/about)


=== Description ===

Toppa is an AI-powered financial services agent for mobile airtime top-ups, data bundles, utility bill payments (electricity, water, internet, TV), and gift card purchases across 170+ countries. It connects 800+ telecom operators and 300+ gift card brands to the Celo blockchain, letting anyone pay with cUSD stablecoins via the x402 micropayment protocol.

Available on both Telegram and WhatsApp, Toppa understands natural language and voice notes — just say what you need and it handles the rest.

Beyond individual payments, Toppa supports:

- **Group wallets** — Pool money in any Telegram or WhatsApp group. Every spend goes through a democratic poll vote. Configurable thresholds, admin bypass, key export, and full group reporting.
- **Multi-currency deposits** — Send CELO, USDC, USDT, or cEUR. Toppa auto-swaps everything to cUSD via Uniswap V3.
- **Scheduled payments** — Set up recurring airtime, bills, or gift cards ("send mom airtime every Friday"). Heartbeat engine runs automatically with retry on failure.
- **Smart memory** — Learns your contacts, operators, and preferences. "Send airtime to my brother" just works.
- **Reports** — Generate PDF or Excel transaction statements for personal or group wallets.
- **Identity verification** — Self Protocol ZK proofs tied to passport/ID. No personal data stored. Verified users get higher spending limits ($20/day → $200/day).
- **Voice support** — Send a voice note in English, French, Yoruba, or Swahili. Transcribed via Deepgram in under a second.

Toppa is a registered on-chain agent (ERC-8004, Agent #1870) with verifiable identity on Celo Mainnet. It exposes services through multiple interoperability standards:

- **Google A2A** (agent-card.json) for agent-to-agent communication
- **MCP** (Model Context Protocol) with 13 tools for agent integration
- **Telegram and WhatsApp bots** for human end-users
- **Free discovery APIs** for operators, billers, countries, and gift cards

All paid operations are gated by x402 HTTP payments — no API keys, no accounts, just stablecoins.


=== Problem ===

Billions of people across Africa, Asia, and Latin America rely on prepaid mobile services. Airtime, data bundles, and utility bill payments are daily necessities, not luxuries. Yet, the infrastructure to perform these transactions across borders remains deeply fragmented:

- **Siloed Operators:** Telecom operators are isolated by country and carrier, each with proprietary top-up systems.
- **Cross-Border Friction:** Payments require navigating multiple fiat rails, tedious KYC processes, and numerous intermediaries.
- **Gatekeeping:** Existing platforms demand manual sign-ups, API key provisioning, and traditional payment methods.
- **No Group Infrastructure:** Friends, families, and offices pooling money for shared expenses have no transparent, governed way to manage collective funds digitally.
- **Agent Disconnect:** AI agents handling tasks autonomously have no standardized, permissionless way to discover and pay for real-world services using cryptocurrency.

The result: Sending $5 of airtime to a family member in another country is harder than sending $5,000 in crypto. Groups pooling money for shared expenses rely on trust and spreadsheets. And the emerging agentic economy has no bridge to essential real-world services.


=== Solution ===

Toppa solves this by wrapping 800+ telecom operators and 300+ gift card brands behind a single AI agent that accepts blockchain-native payments on Celo.

**Core capabilities:**

- **Airtime, data, bills, gift cards** — 170+ countries, one chat interface. Tell Toppa what you need in plain language or a voice note.
- **Group wallets** — Enable a shared wallet in any Telegram or WhatsApp group. Members contribute cUSD, every spend goes through a democratic poll (default 70% threshold). Admins can bypass for urgent purchases, export keys, configure expiry, and generate group reports.
- **Multi-currency swaps** — Deposit CELO, USDC, USDT, or cEUR. Toppa auto-swaps to cUSD via Uniswap V3.
- **Scheduled payments** — Recurring airtime, bills, or gift cards. Heartbeat engine runs every 15 minutes with automatic retry on failure.
- **Smart memory** — Remembers contacts, operators, preferences. "Send airtime to my brother" works because Toppa already knows who that is.
- **Reports** — PDF and Excel statements for personal and group transactions.
- **Identity verification** — Self Protocol ZK proofs for higher spending limits. No personal data stored.

**Protocol innovations:**

- **x402 Micropayments:** Every paid operation is gated by the x402 HTTP payment protocol. Attach a cUSD payment header to your request, and the service executes. No accounts, no API keys, no invoices.
- **Agent Interoperability:** Discoverable via Google A2A, invocable via MCP (13 tools), and accessible to end-users via Telegram and WhatsApp — all from a single codebase.
- **On-Chain Identity:** Registered as ERC-8004 Agent #1870 on Celo Mainnet with content-addressed metadata on IPFS, enabling verifiable reputation and trustless discovery.
- **Global Coverage:** 170+ countries, auto-detects operators from phone numbers, supports local currencies via real-time conversion.

A single HTTP request is all it takes — whether from a human, a chatbot, or another autonomous agent — to top up a phone, pay a bill, or buy a gift card anywhere in the world.


=== Mission Summary ===

We are on a mission to make real-world digital payments — airtime, data, bills, gift cards, and group finances — accessible to both humans and AI agents everywhere, using open standards (A2A, MCP, ERC-8004) and blockchain-native stablecoin payments on Celo.

No gatekeepers, no legacy rails — just open protocols connecting crypto to the services billions depend on daily. Whether you're an individual topping up a phone, a group pooling money for shared expenses, or an AI agent executing tasks autonomously, Toppa is the bridge between blockchain and the real world.


=== Location of Impact ===

Global — with primary focus on Africa, South Asia, Southeast Asia, and Latin America (170+ countries)
