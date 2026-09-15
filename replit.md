# Itsuki Bot

A premium Discord economy bot built with TypeScript and Discord.js v14.

## Stack

- **Runtime:** Node.js ≥ 22 + tsx (runs TypeScript directly — no build step)
- **Framework:** Discord.js v14
- **Music:** Lavende
- **Canvas:** node-canvas (profile cards)
- **Data:** JSON file store (`database/`)

## Project structure

```
index.ts              ← entry point (run this)
deploy-commands.ts    ← slash command registration
commands/             ← commands by category (economy, gambling, music…)
config/               ← bot config and music source config
database/             ← JsonStore.ts + all runtime JSON data files
events/               ← Discord event listeners
handlers/             ← command/event/interaction loaders
interactions/         ← button handlers
managers/             ← EconomyManager, MusicManager, etc.
scripts/              ← one-off scripts (emoji upload)
services/             ← external APIs, profile canvas
structures/           ← base Command and Event classes
utils/                ← logger, formatter, helpers
builders/             ← Discord component builders
emojis/               ← emoji PNG assets
```

## Environment variables

| Variable | Required | Description |
|---|---|---|
| `DISCORD_TOKEN` | ✅ | Bot token from Discord Developer Portal |
| `DISCORD_CLIENT_ID` | ✅ | Application/Client ID |
| `DISCORD_GUILD_ID` | ❌ | Dev guild for instant command registration |
| `BOT_OWNERS` | ❌ | Comma-separated owner Discord user IDs |
| `PREFIX` | ❌ | Message command prefix (default: `!`) |

## Hosting — start command

```bash
npm install
npx tsx index.ts
```

That's it. No build step required.

## Scripts

| Command | Description |
|---|---|
| `npm start` | Start the bot (`tsx index.ts`) |
| `npm run dev` | Watch mode — auto-restart on file changes |
| `npm run deploy` | Register slash commands globally |
| `npm run deploy:guild` | Register to dev guild instantly |
| `npm run typecheck` | Type-check without running |

## User preferences

- No build step — run directly with `npx tsx index.ts`
- Flat structure — source files at root, no `src/` wrapper
