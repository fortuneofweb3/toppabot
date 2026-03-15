import { getRate, SUPPORTED_COUNTRIES } from './fonbnk';

/**
 * Check cUSD → local currency rates
 * Uses Fonbnk as primary provider (native cUSD on Celo support)
 */
export async function checkRates(amount: number, country?: string) {
  try {
    const countryCode = (country || 'NG').toUpperCase();
    const countryInfo = SUPPORTED_COUNTRIES[countryCode];
    const fonbnkRate = await getRate(countryCode);

    const rates = {
      fonbnk: {
        rate: fonbnkRate.rate,
        currency: fonbnkRate.currency,
        country: fonbnkRate.country,
        countryName: fonbnkRate.countryName,
        fee: 2.4,                              // ~2.4% Fonbnk fee
        finalAmount: amount * fonbnkRate.rate * 0.976,
        estimatedTime: '2-10 minutes',
        supported: true,
        source: fonbnkRate.source,
        offerId: fonbnkRate.offerId,
      },
    };

    return {
      best: 'fonbnk',
      bestRate: rates.fonbnk,
      all: rates,
      recommendation: fonbnkRate.source === 'error'
        ? 'Using mock rates - configure FONBNK_CLIENT_ID for live rates'
        : `Fonbnk: fastest cUSD → ${countryInfo?.currency || fonbnkRate.currency} settlement`,
    };
  } catch (error) {
    throw new Error(`Failed to fetch rates: ${error.message}`);
  }
}
