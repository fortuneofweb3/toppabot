// Load environment variables FIRST (before any other imports)
import 'dotenv/config';

import { startTelegramBot } from './bot/telegram';
import { startApiServer } from './api/server';

/**
 * Main entry point for Jara Agent
 *
 * Jara runs two interfaces:
 * 1. Telegram Bot - for human users (chat-based)
 * 2. HTTP API    - for other agents (x402 payment-gated)
 */
async function main() {
  console.log('🚀 Starting Jara Agent...');
  console.log('   "Jara" = extra/bonus in Nigerian pidgin');
  console.log('');

  // Validate core environment variables
  const required = ['OPENAI_API_KEY', 'CELO_RPC_URL', 'CELO_PRIVATE_KEY'];
  const missing = required.filter(env => !process.env[env] || process.env[env]?.startsWith('your_'));
  if (missing.length > 0) {
    console.warn(`Warning: Missing env vars: ${missing.join(', ')}`);
  }

  // Start HTTP API server (for agent-to-agent x402 interactions)
  startApiServer();

  // Start Telegram bot only if token is configured
  if (process.env.TELEGRAM_BOT_TOKEN && !process.env.TELEGRAM_BOT_TOKEN.startsWith('your_')) {
    startTelegramBot();
  } else {
    console.log('Telegram bot skipped (no TELEGRAM_BOT_TOKEN configured)');
  }

  console.log('');
  console.log('✅ Jara is live!');
  console.log('💬 Telegram: Send messages to your bot');
  console.log('🤖 API: Other agents can call via x402');
}

// Run the application
main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
