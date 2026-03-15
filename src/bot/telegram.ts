import { Telegraf, Context } from 'telegraf';
import { runJaraAgent } from '../agent/graph';
import { chargeX402Fee } from '../blockchain/x402';

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN!);

/**
 * Start command
 */
bot.command('start', async (ctx) => {
  await ctx.reply(
    `Welcome to Jara!\n\n` +
    `I convert cUSD on Celo into local currency across 15 countries.\n\n` +
    `I can:\n` +
    `- Send money to bank accounts or mobile money wallets\n` +
    `- Pay bills: electricity, airtime, data, cable TV\n` +
    `- Load virtual dollar cards\n` +
    `- Find the best conversion rates\n\n` +
    `Supported: Nigeria, Kenya, South Africa, Ghana, Uganda, Tanzania, Zambia, Brazil, Philippines, and more.\n\n` +
    `Just tell me what you need! Try:\n` +
    `"Send 20 cUSD to my bank in Nigeria"\n` +
    `"Convert 50 cUSD to KES via M-Pesa"\n` +
    `"Check rates for Ghana"`
  );
});

/**
 * Handle all text messages
 */
bot.on('text', async (ctx) => {
  const userMessage = ctx.message.text;
  const userId = ctx.from.id.toString();

  try {
    // Show typing indicator
    await ctx.sendChatAction('typing');

    // Run the agent
    const { response } = await runJaraAgent(userMessage, {
      userAddress: userId, // In production, map to actual Celo address
    });

    // Charge x402 fee (for demo purposes)
    await chargeX402Fee({
      userId,
      transactionType: 'chat_interaction',
      amount: 0,
    });

    // Send response
    await ctx.reply(response as string);
  } catch (error) {
    console.error('Error processing message:', error);
    await ctx.reply(
      `Sorry, I encountered an error: ${error.message}\n\n` +
      `Please try again or contact support.`
    );
  }
});

/**
 * Error handler
 */
bot.catch((err, ctx) => {
  console.error('Bot error:', err);
  ctx.reply('Something went wrong. Please try again.');
});

/**
 * Start the bot
 */
export function startTelegramBot() {
  bot.launch();
  console.log('🤖 Jara Telegram bot is running...');

  // Enable graceful stop
  process.once('SIGINT', () => bot.stop('SIGINT'));
  process.once('SIGTERM', () => bot.stop('SIGTERM'));
}
