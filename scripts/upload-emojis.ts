/**
 * @file upload-emojis.ts
 * @description Uploads all emoji PNGs from the /emojis folder to the Discord Application
 * with clean, professional naming. Run: npx ts-node scripts/upload-emojis.ts
 */

import 'dotenv/config';
import fs from 'fs';
import path from 'path';

const token = process.env.DISCORD_TOKEN!;
const clientId = process.env.DISCORD_CLIENT_ID!;

if (!token || !clientId) { console.error(' Set DISCORD_TOKEN and DISCORD_CLIENT_ID'); process.exit(1); }

const EMOJI_DIR = path.join(__dirname, '../emojis');
const API_BASE = `https://discord.com/api/v10/applications/${clientId}/emojis`;

/** Clean up the raw filename into a professional emoji name */
function cleanName(filename: string): string {
  let name = filename.replace(/\.png$/i, '');
  // Remove the random hash suffix (pattern: -hexchars at end)
  name = name.replace(/-[a-f0-9]{8,}$/i, '');
  // Remove iconsax- prefix
  name = name.replace(/^iconsax-/i, '');
  // Remove ai- prefix
  name = name.replace(/^ai-/i, '');
  // Replace dashes/spaces with underscores
  name = name.replace(/[-\s]+/g, '_');
  // Remove trailing/leading underscores
  name = name.replace(/^_+|_+$/g, '');
  // Ensure within Discord emoji name limits (2-32 chars, alphanumeric + underscore)
  name = name.replace(/[^a-zA-Z0-9_]/g, '');
  // Truncate to 32 chars
  name = name.slice(0, 32);
  // Ensure at least 2 chars
  if (name.length < 2) name = `emoji_${name}`;
  return name.toLowerCase();
}

async function uploadEmoji(filename: string): Promise<{ name: string; id: string } | null> {
  const filePath = path.join(EMOJI_DIR, filename);
  const buffer = fs.readFileSync(filePath);
  const base64 = buffer.toString('base64');
  const dataUri = `data:image/png;base64,${base64}`;
  const name = cleanName(filename);

  try {
    const res = await fetch(API_BASE, {
      method: 'POST',
      headers: {
        'Authorization': `Bot ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ name, image: dataUri }),
    });

    if (!res.ok) {
      const err = await res.text();
      console.error(` ${filename} → ${name}: ${res.status} ${err}`);
      return null;
    }

    const data = await res.json() as { id: string; name: string };
    console.log(` ${filename} → ${data.name} (ID: ${data.id})`);
    return { name: data.name, id: data.id };
  } catch (err) {
    console.error(` ${filename} → ${name}: ${(err as Error).message}`);
    return null;
  }
}

async function main() {
  if (!fs.existsSync(EMOJI_DIR)) { console.error(` Emoji directory not found: ${EMOJI_DIR}`); process.exit(1); }

  const files = fs.readdirSync(EMOJI_DIR).filter((f) => f.endsWith('.png')).sort();
  console.log(`\n Uploading ${files.length} emojis to application ${clientId}…\n`);

  const results: Array<{ name: string; id: string }> = [];
  for (const file of files) {
    // Rate limit: Discord allows ~5 per second for emoji creation
    const result = await uploadEmoji(file);
    if (result) results.push(result);
    await new Promise((r) => setTimeout(r, 300)); // 300ms delay between uploads
  }

  console.log(`\n Done! Uploaded ${results.length}/${files.length} emojis.`);

  // Save mapping to a JSON file for use in the bot
  const mapPath = path.join(__dirname, '../config/emoji-map.json');
  const map: Record<string, string> = {};
  for (const r of results) map[r.name] = r.id;
  fs.writeFileSync(mapPath, JSON.stringify(map, null, 2));
  console.log(` Emoji map saved to config/emoji-map.json`);
  console.log(` Usage in bot: <:emoji_name:${results[0]?.id ?? 'ID'}>`);
}

main().catch(console.error);
