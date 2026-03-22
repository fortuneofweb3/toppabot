# Security

## Reporting Vulnerabilities

If you find a security vulnerability, please report it privately. **Do not open a public issue.**

Email: security@toppa.cc

We'll respond within 48 hours and work with you on a fix before any public disclosure.

## Architecture Security

### Wallet Encryption
- Private keys are encrypted with AES-256-GCM using a random IV per key
- Encryption key is derived from `WALLET_ENCRYPTION_KEY` environment variable (32-byte hex)
- Keys are stored encrypted in MongoDB — never in plaintext

### Input Validation
- All user input is sanitized before processing (phone numbers, country codes, amounts)
- Prompt injection detection with homoglyph normalization and zero-width character stripping
- Rate limiting: 20 requests/minute, $50/day spending cap per user
- Message length limits enforced across all input boundaries (Telegram, WhatsApp, A2A, MCP)

### Payment Security
- x402 payments verified on-chain by checking cUSD Transfer events on Celo
- Transaction replay prevention via hash reservation (MongoDB-backed)
- Timing-safe comparison for admin API key validation
- Webhook signature verification (HMAC-SHA256) for external callbacks

### Bot Security
- Private key export (`/export`) blocked in group chats — only works in private DMs
- Group spending requires poll-based governance (configurable approval threshold)
- @mention-only mode in groups — bot ignores messages unless explicitly tagged
- Per-user spending limits with daily reset

## Deployment Checklist

Before deploying to production:

1. **Set `NODE_ENV=production`** — switches to mainnet RPCs and production API endpoints
2. **Generate a strong `WALLET_ENCRYPTION_KEY`** — `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`
3. **Set `ADMIN_API_KEY`** — protects admin endpoints; without it, admin routes return 503
4. **Set `PRESTMIT_WEBHOOK_SECRET`** — webhooks are rejected when secret is not configured
5. **Use a dedicated MongoDB user** with minimal permissions (read/write to toppa database only)
6. **Never commit `.env`** — it's in `.gitignore` but verify before pushing
7. **Rotate `CELO_PRIVATE_KEY`** if it was ever exposed — the agent wallet holds operational funds

## Known Limitations

- **Module-level request context** (`_requestCtx` in `graph.ts`) — concurrent requests could theoretically race. For single-instance deployments this is fine; for horizontal scaling, this needs refactoring to pass context through LangGraph state
- **Keyword-based injection detection** — catches common attacks but can be bypassed by rephrasing. The system prompt and tool constraints provide the primary defense layer
- **In-memory rate limits** — reset on server restart. Spending limits are persisted to MongoDB but request counts are not
