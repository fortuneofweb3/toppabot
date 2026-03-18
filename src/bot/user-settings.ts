/**
 * User settings store — MongoDB-backed, persists across restarts
 */

import { Collection } from 'mongodb';
import { getDb } from '../wallet/mongo-store';

export interface UserSettings {
  telegramId: string;
  autoReviewEnabled: boolean;
  createdAt: Date;
  updatedAt: Date;
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
}

export const userSettingsStore = new UserSettingsStore();
