/**
 * User settings store (in-memory for now, can swap to MongoDB later)
 */

export interface UserSettings {
  telegramId: string;
  autoReviewEnabled: boolean;
  createdAt: Date;
  updatedAt: Date;
}

class UserSettingsStore {
  private settings = new Map<string, UserSettings>();

  get(telegramId: string): UserSettings {
    if (!this.settings.has(telegramId)) {
      // Default settings
      this.settings.set(telegramId, {
        telegramId,
        autoReviewEnabled: true, // ON by default
        createdAt: new Date(),
        updatedAt: new Date(),
      });
    }
    return this.settings.get(telegramId)!;
  }

  update(telegramId: string, updates: Partial<UserSettings>): UserSettings {
    const current = this.get(telegramId);
    const updated = {
      ...current,
      ...updates,
      updatedAt: new Date(),
    };
    this.settings.set(telegramId, updated);
    return updated;
  }

  toggleAutoReview(telegramId: string): boolean {
    const current = this.get(telegramId);
    const newValue = !current.autoReviewEnabled;
    this.update(telegramId, { autoReviewEnabled: newValue });
    return newValue;
  }
}

export const userSettingsStore = new UserSettingsStore();
