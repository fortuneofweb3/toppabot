/**
 * User settings store — MongoDB-backed, persists across restarts
 */

import { Collection } from 'mongodb';
import { getDb } from '../wallet/mongo-store';

export interface UserSettings {
  telegramId: string;
  autoReviewEnabled: boolean;
  timezone: string; // IANA timezone e.g. "Africa/Lagos"
  createdAt: Date;
  updatedAt: Date;
}

// Map country calling codes to default IANA timezones
const COUNTRY_CODE_TIMEZONES: Record<string, string> = {
  '1': 'America/New_York',
  '7': 'Europe/Moscow',
  '20': 'Africa/Cairo',
  '27': 'Africa/Johannesburg',
  '30': 'Europe/Athens',
  '31': 'Europe/Amsterdam',
  '32': 'Europe/Brussels',
  '33': 'Europe/Paris',
  '34': 'Europe/Madrid',
  '39': 'Europe/Rome',
  '44': 'Europe/London',
  '49': 'Europe/Berlin',
  '55': 'America/Sao_Paulo',
  '61': 'Australia/Sydney',
  '81': 'Asia/Tokyo',
  '82': 'Asia/Seoul',
  '86': 'Asia/Shanghai',
  '91': 'Asia/Kolkata',
  '212': 'Africa/Casablanca',
  '213': 'Africa/Algiers',
  '216': 'Africa/Tunis',
  '220': 'Africa/Banjul',
  '221': 'Africa/Dakar',
  '223': 'Africa/Bamako',
  '224': 'Africa/Conakry',
  '225': 'Africa/Abidjan',
  '226': 'Africa/Ouagadougou',
  '227': 'Africa/Niamey',
  '228': 'Africa/Lome',
  '229': 'Africa/Porto-Novo',
  '230': 'Indian/Mauritius',
  '231': 'Africa/Monrovia',
  '232': 'Africa/Freetown',
  '233': 'Africa/Accra',
  '234': 'Africa/Lagos',
  '235': 'Africa/Ndjamena',
  '236': 'Africa/Bangui',
  '237': 'Africa/Douala',
  '238': 'Atlantic/Cape_Verde',
  '239': 'Africa/Sao_Tome',
  '240': 'Africa/Malabo',
  '241': 'Africa/Libreville',
  '242': 'Africa/Brazzaville',
  '243': 'Africa/Kinshasa',
  '244': 'Africa/Luanda',
  '245': 'Africa/Bissau',
  '248': 'Indian/Mahe',
  '249': 'Africa/Khartoum',
  '250': 'Africa/Kigali',
  '251': 'Africa/Addis_Ababa',
  '252': 'Africa/Mogadishu',
  '253': 'Africa/Djibouti',
  '254': 'Africa/Nairobi',
  '255': 'Africa/Dar_es_Salaam',
  '256': 'Africa/Kampala',
  '257': 'Africa/Bujumbura',
  '258': 'Africa/Maputo',
  '260': 'Africa/Lusaka',
  '261': 'Indian/Antananarivo',
  '263': 'Africa/Harare',
  '264': 'Africa/Windhoek',
  '265': 'Africa/Blantyre',
  '266': 'Africa/Maseru',
  '267': 'Africa/Gaborone',
  '268': 'Africa/Mbabane',
  '269': 'Indian/Comoro',
  '351': 'Europe/Lisbon',
  '353': 'Europe/Dublin',
  '354': 'Atlantic/Reykjavik',
  '380': 'Europe/Kiev',
  '966': 'Asia/Riyadh',
  '971': 'Asia/Dubai',
  '972': 'Asia/Jerusalem',
  '974': 'Asia/Qatar',
};

/**
 * Map Telegram language_code (BCP-47) to IANA timezone.
 * Regional subtags like "pt-br" give strong country signal.
 * Plain language codes like "en" are ambiguous — return null.
 */
const LANGUAGE_CODE_TIMEZONES: Record<string, string> = {
  'pt-br': 'America/Sao_Paulo',
  'es-ar': 'America/Argentina/Buenos_Aires',
  'es-mx': 'America/Mexico_City',
  'es-co': 'America/Bogota',
  'es-cl': 'America/Santiago',
  'es-pe': 'America/Lima',
  'en-gb': 'Europe/London',
  'en-au': 'Australia/Sydney',
  'en-in': 'Asia/Kolkata',
  'en-za': 'Africa/Johannesburg',
  'en-ng': 'Africa/Lagos',
  'en-ke': 'Africa/Nairobi',
  'en-gh': 'Africa/Accra',
  'fr-fr': 'Europe/Paris',
  'fr-ca': 'America/Toronto',
  'fr-ci': 'Africa/Abidjan',
  'fr-sn': 'Africa/Dakar',
  'fr-cm': 'Africa/Douala',
  'de-de': 'Europe/Berlin',
  'de-at': 'Europe/Vienna',
  'de-ch': 'Europe/Zurich',
  'it-it': 'Europe/Rome',
  'nl-nl': 'Europe/Amsterdam',
  'ja-jp': 'Asia/Tokyo',
  'ko-kr': 'Asia/Seoul',
  'zh-cn': 'Asia/Shanghai',
  'zh-tw': 'Asia/Taipei',
  'ar-sa': 'Asia/Riyadh',
  'ar-eg': 'Africa/Cairo',
  'ar-ae': 'Asia/Dubai',
  'hi-in': 'Asia/Kolkata',
  'sw': 'Africa/Nairobi',       // Swahili → East Africa
  'ha': 'Africa/Lagos',         // Hausa → West Africa
  'yo': 'Africa/Lagos',         // Yoruba → Nigeria
  'ig': 'Africa/Lagos',         // Igbo → Nigeria
  'am': 'Africa/Addis_Ababa',   // Amharic → Ethiopia
  'zu': 'Africa/Johannesburg',  // Zulu → South Africa
  'rw': 'Africa/Kigali',        // Kinyarwanda → Rwanda
};

function inferTimezoneFromLanguageCode(langCode: string): string | null {
  if (!langCode) return null;
  const lower = langCode.toLowerCase();
  // Try exact match first (e.g. "pt-br"), then language-only (e.g. "sw")
  return LANGUAGE_CODE_TIMEZONES[lower] || LANGUAGE_CODE_TIMEZONES[lower.split('-')[0]] || null;
}

/**
 * Infer timezone from a phone number's country calling code.
 * Returns UTC if no match found.
 */
export function inferTimezoneFromPhone(phone: string): string {
  // Strip leading + and whitespace
  const digits = phone.replace(/[^0-9]/g, '');
  // Try 3-digit, 2-digit, then 1-digit country codes
  for (const len of [3, 2, 1]) {
    const code = digits.slice(0, len);
    if (COUNTRY_CODE_TIMEZONES[code]) return COUNTRY_CODE_TIMEZONES[code];
  }
  return 'UTC';
}

const COLLECTION_NAME = 'user_settings';
let _collection: Collection<UserSettings> | null = null;
let _indexesCreated = false;

async function getCollection(): Promise<Collection<UserSettings>> {
  if (_collection && _indexesCreated) return _collection;

  const db = await getDb();
  _collection = db.collection<UserSettings>(COLLECTION_NAME);

  if (!_indexesCreated) {
    await _collection.createIndex({ telegramId: 1 }, { unique: true });
    _indexesCreated = true;
  }

  return _collection;
}

class UserSettingsStore {
  async get(telegramId: string): Promise<UserSettings> {
    try {
      const col = await getCollection();
      const existing = await col.findOne({ telegramId });
      if (existing) return existing;

      // Default settings — insert and return.
      // autoReview is ON by default: automatically submits 5★ on-chain reputation
      // after each successful service. Users can toggle off via /settings.
      const defaults: UserSettings = {
        telegramId,
        autoReviewEnabled: true,
        timezone: 'UTC',
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      await col.insertOne(defaults);
      return defaults;
    } catch (err: any) {
      console.error('[UserSettings] Failed to get settings:', err.message);
      // Return defaults on error — auto-review on by default
      return {
        telegramId,
        autoReviewEnabled: true,
        timezone: 'UTC',
        createdAt: new Date(),
        updatedAt: new Date(),
      };
    }
  }

  async update(telegramId: string, updates: Partial<UserSettings>): Promise<UserSettings> {
    try {
      const col = await getCollection();
      await col.updateOne(
        { telegramId },
        { $set: { ...updates, updatedAt: new Date() } },
        { upsert: true },
      );
      return this.get(telegramId);
    } catch (err: any) {
      console.error('[UserSettings] Failed to update settings:', err.message);
      return this.get(telegramId);
    }
  }

  async toggleAutoReview(telegramId: string): Promise<boolean> {
    const current = await this.get(telegramId);
    const newValue = !current.autoReviewEnabled;
    await this.update(telegramId, { autoReviewEnabled: newValue });
    return newValue;
  }

  async getTimezone(telegramId: string): Promise<string> {
    const settings = await this.get(telegramId);
    return settings.timezone || 'UTC';
  }

  async setTimezone(telegramId: string, timezone: string): Promise<void> {
    await this.update(telegramId, { timezone });
  }

  /**
   * Infer timezone from Telegram language_code if not already set.
   * Called on every message — cheap no-op if timezone already known.
   */
  async inferFromLanguageCode(telegramId: string, languageCode?: string): Promise<void> {
    if (!languageCode) return;
    const settings = await this.get(telegramId);
    if (settings.timezone && settings.timezone !== 'UTC') return;
    const tz = inferTimezoneFromLanguageCode(languageCode);
    if (tz) {
      await this.update(telegramId, { timezone: tz });
    }
  }

  /**
   * Set timezone from phone number if not already configured.
   * Phone numbers give stronger signal than language_code — overwrites language-based inference.
   */
  async inferTimezoneIfNeeded(telegramId: string, phone: string): Promise<void> {
    const tz = inferTimezoneFromPhone(phone);
    if (tz !== 'UTC') {
      await this.update(telegramId, { timezone: tz });
    }
  }
}

export const userSettingsStore = new UserSettingsStore();
