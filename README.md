<div align="center">

# ✦ Itsuki Bot

**A premium all-in-one Discord bot — economy, gambling, music, anime, social, and more.**

[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178c6?style=flat-square&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Discord.js](https://img.shields.io/badge/Discord.js-v14-5865f2?style=flat-square&logo=discord&logoColor=white)](https://discord.js.org/)
[![Node.js](https://img.shields.io/badge/Node.js-≥20-339933?style=flat-square&logo=node.js&logoColor=white)](https://nodejs.org/)
[![License](https://img.shields.io/badge/License-MIT-lightgrey?style=flat-square)](LICENSE)

</div>

---

## Features

| Category | Commands |
|---|---|
| 💰 **Economy** | `balance` `daily` `weekly` `work` `crime` `rob` `beg` `search` `deposit` `withdraw` `transfer` `prestige` `richest` |
| 🎰 **Gambling** | `slots` `blackjack` `coinflip` `dice` `roulette` `crash` `mines` |
| 🎵 **Music** | `play` `queue` `skip` `pause` `resume` `stop` `leave` `loop` `nowplaying` `seek` `shuffle` `volume` `247` `autoplay` `setvoice` |
| 🎌 **Anime** | `anime` `waifu` |
| 🐾 **Pets** | `pet` |
| 🏪 **Shop & Inventory** | `shop` `inventory` |
| 🧑‍💼 **Profile** | `profile` |
| 🏆 **Leaderboard** | `leaderboard` |
| 🤗 **Social** | `hug` `kiss` `pat` `slap` `poke` `cuddle` `bonk` `wave` `dance` `cry` |
| ⚙️ **Utility** | `help` `ping` `stats` `botbrand` `noprefix` |

---

## Requirements

| Tool | Version |
|---|---|
| **Node.js** | ≥ 20.18.0 (22 LTS recommended) |
| **npm** | ≥ 8 |

> **Linux/Ubuntu** — the `canvas` package needs native libraries:
> ```bash
> sudo apt-get install -y build-essential libcairo2-dev libpango1.0-dev libjpeg-dev libgif-dev librsvg2-dev
> ```
> **macOS** — `brew install pkg-config cairo pango libpng jpeg giflib librsvg`

---

## Quick Start

```bash
# 1. Clone
git clone https://github.com/yourusername/itsuki-bot.git
cd itsuki-bot

# 2. Install dependencies
npm install

# 3. Set environment variables (see table below)
cp .env.example .env   # edit .env with your values

# 4. Register slash commands
npm run deploy

# 5. Start
npm start
```

No build step required — TypeScript runs directly via `tsx`.

---

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `DISCORD_TOKEN` | ✅ | Bot token from the [Discord Developer Portal](https://discord.com/developers/applications) |
| `DISCORD_CLIENT_ID` | ✅ | Application / Client ID |
| `DISCORD_GUILD_ID` | ❌ | Dev guild ID — commands register instantly instead of globally |
| `BOT_OWNERS` | ❌ | Comma-separated owner Discord user IDs |
| `PREFIX` | ❌ | Message command prefix (default: `!`) |
| `LOG_LEVEL` | ❌ | Log verbosity: `error` `warn` `info` `debug` (default: `info`) |

**Getting your token:**
1. Open the [Developer Portal](https://discord.com/developers/applications) → **New Application**
2. **Bot** tab → **Reset Token** → copy it
3. Enable **Server Members Intent** and **Message Content Intent** under Privileged Gateway Intents
4. **OAuth2 → URL Generator** → scopes: `bot` + `applications.commands` → invite the bot

---

## Scripts

| Command | Description |
|---|---|
| `npm start` | Start the bot |
| `npm run dev` | Watch mode — auto-restart on file changes |
| `npm run deploy` | Register slash commands globally |
| `npm run deploy:guild` | Register to dev guild instantly |
| `npm run typecheck` | Type-check without running |

---

## Project Structure

```
index.ts               ← entry point
deploy-commands.ts     ← slash command registration
start.js               ← plain-JS bootstrap (for hosts that need it)
─────────────────────────────────────────────
commands/
  economy/             ← balance, daily, work, rob…
  gambling/            ← slots, blackjack, mines…
  music/               ← play, queue, skip…
  anime/               ← anime, waifu
  pets/                ← pet
  shop/                ← shop
  inventory/           ← inventory
  leaderboard/         ← leaderboard
  profile/             ← profile
  social/              ← hug, kiss, pat…
  utility/             ← help, ping, stats…
─────────────────────────────────────────────
config/                ← bot config, music config
database/              ← JsonStore.ts + runtime JSON data files
events/                ← Discord event listeners
handlers/              ← command / event / interaction loaders
interactions/          ← button & select-menu handlers
managers/              ← EconomyManager, MusicManager, UserManager…
services/              ← AnimeService, ProfileService (canvas)
structures/            ← base Command and Event classes
utils/                 ← Logger, Formatter, ProgressBar, helpers
builders/              ← Discord Components V2 helpers
emojis/                ← custom emoji PNG assets
scripts/               ← one-off scripts (emoji upload)
```

---

## Configuration

All bot behaviour lives in **`config/config.ts`**:

| Key | Controls |
|---|---|
| `economy` | Starting balance, daily/weekly amounts, XP thresholds, prestige bonuses |
| `cooldowns` | Per-command cooldown durations (ms) |
| `shop` | Shop items, prices, and categories |
| `gambling` | Slot symbols & weights, blackjack rules, mines grid size |
| `pets` | Pet types and base stats |
| `achievements` | Achievement definitions and coin rewards |
| `presence` | Bot status and rotating activity messages |

---

## Hosting

### Any x86-64 VPS (Ubuntu / Debian)

```bash
# Node.js 22
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs

# canvas build deps
sudo apt-get install -y build-essential libcairo2-dev libpango1.0-dev \
  libjpeg-dev libgif-dev librsvg2-dev

# clone & start
git clone https://github.com/yourusername/itsuki-bot.git && cd itsuki-bot
npm install && npm run deploy && npm start
```

**Keep it alive with PM2:**

```bash
npm install -g pm2
pm2 start start.js --name itsuki-bot --interpreter node
pm2 save && pm2 startup
```

> ⚠️ **Architecture note:** The music engine (`lavende`) ships x86-64 binaries only.
> Use an **x86-64 / amd64** server. Check with `uname -m` — must output `x86_64`.

### Pterodactyl / Pelican game panels

Works with the stock Node.js egg — no startup-command edit needed. Set the
**main file** variable to any of these:

| `MAIN_FILE` | How the egg launches it |
|---|---|
| `index.ts` | `ts-node index.ts` — works; `typescript` is a runtime dependency and `transpileOnly` is set |
| `index.js` | `node index.js` — delegates to `start.js` |
| `start.js` | `node start.js` — registers `tsx`, then loads `index.ts` |

All three end up in the same place. `start.js` detects whether a TypeScript
require hook is already registered, so it never stacks a second one on top of
ts-node.

Two notes on the stock egg:

- Its last line is
  `if [[ "${MAIN_FILE}" == "*.js" ]]; then node ...; else ts-node ...; fi`.
  The pattern is quoted, which makes it a literal string test that never
  matches, so *every* `MAIN_FILE` value actually runs through ts-node. That is
  supported, so it does not matter — but it does mean picking a `.js` main file
  will not change which runtime is used.
- `AUTO_UPDATE=1` makes the panel `git pull` on boot. It pulls the **branch
  checked out in `/home/container`**, so work sitting on an unmerged branch will
  never arrive.

If you would rather bypass the egg's logic entirely:

```bash
if [ -f /home/container/package.json ]; then npm install; fi; npm start
```

### Railway / Render / Fly.io

1. Fork this repo and connect it in the platform dashboard
2. Set environment variables in the platform dashboard
3. Build command: `npm install`
4. Start command: `npm start`
5. Run `npm run deploy` once locally to register slash commands

### Replit

1. Import this repo into Replit
2. Add Secrets: `DISCORD_TOKEN`, `DISCORD_CLIENT_ID`
3. The `Itsuki Bot` workflow runs `npm start` automatically

---

## Troubleshooting

**`npm error code ERESOLVE` mentioning `opusscript`**
Read the version npm reports as "from the root project". If it says
`opusscript@"^0.1.1"`, the deployed `package.json` is out of date — the fix is
to get the current one onto the host, not to change anything else. This repo
pins `^0.0.8`, which is the only range `prism-media@1.3.5` accepts (for `0.x`
versions `^0.0.8` means `>=0.0.8 <0.0.9`, so `0.1.1` can never satisfy it).

`.npmrc` also sets `legacy-peer-deps=true`, because every peer dependency here
is an *optional* voice codec and npm should not fail the whole install over
one. A bare `npm install` picks that up automatically.

**`TypeError: Cannot read properties of undefined (reading 'fileExists')`**
ts-node could not load the `typescript` module, so its internal `ts` binding
was undefined. Almost always this means **`npm install` failed earlier in the
same command** — check further up the log — and `node_modules` was never
populated. Fix the install and this goes away.

`typescript` is a runtime `dependency` rather than a devDependency precisely so
it survives `npm install --omit=dev`, and `tsconfig.json` sets
`ts-node.transpileOnly` so start-up skips type checking (fast, and a stray type
error cannot stop the bot booting).

**`Cannot find module 'tsx/cjs'`**
Dependencies are not installed. Run `npm install`.

**`npm ci` fails with a lockfile error**
There is no committed `package-lock.json` — run `npm install` once to generate
one, then `npm ci` works on later deploys.

**`Cannot play audio as no valid encryption package is installed`**
`libsodium-wrappers` did not install. Re-run `npm install`; it is a pure-JS
package and needs no build tools.

**`canvas` fails to build**
Install the native libraries listed under [Requirements](#requirements), then
reinstall. `canvas` powers the leaderboard and stats images.

---

## License

[MIT](LICENSE) — free to use, modify, and distribute.
