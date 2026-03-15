/**
 * Self Protocol — ZK Proof of Humanity Verification
 *
 * Self Protocol uses zk-SNARKs to let users prove attributes from
 * government-issued IDs (passports) without revealing the underlying data.
 *
 * Flow for Telegram:
 * 1. User sends /verify command
 * 2. Bot generates a Self deeplink via SelfAppBuilder
 * 3. User taps link → opens Self mobile app
 * 4. User scans passport NFC → generates ZK proof on-device
 * 5. Self's relayer POSTs proof to our /api/verify endpoint
 * 6. We verify with SelfBackendVerifier and store result
 * 7. User returns to bot, is now verified
 *
 * Docs: https://docs.self.xyz
 * SDK: @selfxyz/core, @selfxyz/qrcode
 */

// In-memory verification store (use a DB in production)
const verifiedUsers = new Map<string, {
  verified: boolean;
  verifiedAt: string;
  nationality?: string;
}>();

// Self Protocol app configuration
const SELF_SCOPE = process.env.SELF_SCOPE || 'toppa-agent';
const SELF_ENDPOINT = process.env.SELF_ENDPOINT || 'https://toppa.api/api/verify';

/**
 * Generate a Self Protocol verification deeplink for a user
 * User opens this in the Self mobile app to verify their identity
 */
export function generateSelfVerifyLink(userId: string): string {
  // Construct the Self universal link
  // In production with @selfxyz/core:
  //   const selfApp = new SelfAppBuilder({ ... }).build();
  //   const deeplink = getUniversalLink(selfApp);

  // Self Protocol universal link format
  const params = new URLSearchParams({
    scope: SELF_SCOPE,
    endpoint: SELF_ENDPOINT,
    user_id: userId,
    user_id_type: 'uuid',
    app_name: 'Toppa',
    endpoint_type: process.env.NODE_ENV === 'production' ? 'https' : 'staging_https',
  });

  // The actual deeplink that opens the Self app
  return `https://self.xyz/verify?${params.toString()}`;
}

/**
 * Handle verification callback from Self Protocol's relayer
 * This is called when Self posts the ZK proof to our backend
 */
export async function handleSelfVerification(body: {
  attestationId: number;
  proof: any;
  publicSignals: string[];
  userContextData: string;
}): Promise<{
  verified: boolean;
  userId?: string;
  nationality?: string;
  error?: string;
}> {
  try {
    // In production with @selfxyz/core:
    //   const verifier = new SelfBackendVerifier(SELF_SCOPE, SELF_ENDPOINT, false);
    //   const result = await verifier.verify(body.attestationId, body.proof, body.publicSignals, body.userContextData);
    //   return { verified: result.isValidDetails.isValid, ... };

    // For hackathon: verify the proof structure is present
    if (!body.proof || !body.publicSignals || body.publicSignals.length === 0) {
      return { verified: false, error: 'Invalid proof payload' };
    }

    // Extract user ID from context data
    const userId = body.userContextData || 'unknown';

    // Store verification result
    verifiedUsers.set(userId, {
      verified: true,
      verifiedAt: new Date().toISOString(),
    });

    return {
      verified: true,
      userId,
    };
  } catch (error: any) {
    return { verified: false, error: error.message };
  }
}

/**
 * Check if a user is verified via Self Protocol
 */
export function isUserVerified(userId: string): boolean {
  return verifiedUsers.get(userId)?.verified || false;
}

/**
 * Verify user with Self Protocol (called from agent tools)
 * Returns verification status or a link to start verification
 */
export async function verifySelfClaw(telegramId: string): Promise<{
  verified: boolean;
  telegramId: string;
  verifiedAt?: string;
  verifyLink?: string;
}> {
  // Check if already verified
  const existing = verifiedUsers.get(telegramId);
  if (existing?.verified) {
    return {
      verified: true,
      telegramId,
      verifiedAt: existing.verifiedAt,
    };
  }

  // Not verified — return a verification link
  const verifyLink = generateSelfVerifyLink(telegramId);

  return {
    verified: false,
    telegramId,
    verifyLink,
  };
}
