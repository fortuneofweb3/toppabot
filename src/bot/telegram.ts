import { Telegraf, Context } from 'telegraf';
import { runToppaAgent } from '../agent/graph';
import { generateSelfVerifyLink, isUserVerified } from '../apis/selfclaw';

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN!);

/**
 * Start command
 */
bot.command('start', async (ctx) => {
  await ctx.reply(
    `Welcome to Toppa!\n\n` +
    `I'm your AI agent for digital goods and utility payments across 170+ countries, powered by Celo.\n\n` +
    `I can:\n` +
    `- Buy airtime & data for any phone number worldwide\n` +
    `- Pay utility bills (electricity, water, TV, internet)\n` +
    `- Buy gift cards (Amazon, Steam, Netflix, Spotify, PlayStation, Xbox, Uber, Apple, and 300+ more)\n\n` +
    `I handle multiple requests at once! Try:\n` +
    `"Get 500 naira airtime for 08147658721 in Nigeria"\n` +
    `"Buy me a $25 Steam gift card"\n` +
    `"Pay my DStv bill and get airtime for my brother in Kenya"\n\n` +
    `Commands:\n` +
    `/verify - Verify your identity with Self Protocol (ZK proof of humanity)`
  );
});

/**
 * Verify command — Self Protocol ZK identity verification
 */
bot.command('verify', async (ctx) => {
  const userId = ctx.from.id.toString();

  if (isUserVerified(userId)) {
    await ctx.reply('You are already verified! Your identity has been confirmed via Self Protocol.');
    return;
  }

  const verifyLink = generateSelfVerifyLink(userId);

  await ctx.reply(
    `To verify your identity, tap the link below to open the Self app:\n\n` +
    `${verifyLink}\n\n` +
    `Self Protocol uses ZK proofs to verify you're a real person without revealing your personal data.\n\n` +
    `After verification, come back here and I'll confirm your status.`,
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
    const { response } = await runToppaAgent(userMessage, {
      userAddress: userId,
    });

    // Send response
    await ctx.reply(response as string);
  } catch (error: any) {
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
  console.log('Toppa Telegram bot is running...');

  // Enable graceful stop
  process.once('SIGINT', () => bot.stop('SIGINT'));
  process.once('SIGTERM', () => bot.stop('SIGTERM'));
}
