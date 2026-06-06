import { Mistral } from '@mistralai/mistralai';
import 'dotenv/config';

const client = new Mistral({ apiKey: process.env.MISTRAL_API_KEY });

async function main() {
  console.log('Fetching all voices from Mistral account...\n');
  
  const allVoices = [];
  const limit = 50;
  let offset = 0;

  while (true) {
    const result = await client.audio.voices.list({ limit, offset });
    const items = result.items ?? [];
    allVoices.push(...items);
    offset += items.length;
    if (items.length < limit) break;
  }
  
  console.log('Available voices:\n');
  console.log('ID                                  | Name                              | Custom');
  console.log('------------------------------------|-----------------------------------|--------');
  
  for (const voice of allVoices) {
    const isCustom = voice.userId ? 'YES' : 'no';
    console.log(`${voice.id}  | ${voice.name.padEnd(35)} | ${isCustom}`);
  }
  
  console.log(`\nTotal: ${allVoices.length} voices`);
  
  const customVoices = allVoices.filter(v => v.userId);
  console.log(`\nYour custom voices (${customVoices.length}):`);
  for (const v of customVoices) {
    console.log(`  - ${v.name}: ${v.id}`);
  }
}

main().catch(console.error);