import { updateAgentURI } from '../blockchain/erc8004';
import * as dotenv from 'dotenv';
dotenv.config();

/**
 * Maintenance script to sync on-chain agent metadata with the latest code.
 * Switches agentURI to: https://api.toppa.cc/registration.json
 */
async function main() {
  console.log('🚀 Starting on-chain metadata sync...');
  
  const result = await updateAgentURI();
  
  if (result.updated) {
    console.log('✅ Success! Metadata updated on-chain.');
    console.log(`🔗 Tx: https://celoscan.io/tx/${result.transactionHash}`);
  } else {
    console.log('❌ Failed to update metadata:', result.error);
    process.exit(1);
  }
}

main().catch(err => {
  console.error('Fatal error during sync:', err);
  process.exit(1);
});
