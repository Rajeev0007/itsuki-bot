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
| **MongoDB** | ≥ 5.0 — local, Docker or a free Atlas cluster |

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
| `npm run migrate` | Dry-run import of legacy `database/*.json` into MongoDB |
| `npm run deploy` | Public commands globally + owner tools to your dev guild |
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

## Database

Everything lives in MongoDB. Set `MONGO_URI` and the bot creates what it needs on
first write — there is no schema step.

```bash
MONGO_URI=mongodb://127.0.0.1:27017/itsuki          # local
MONGO_URI=mongodb+srv://user:pass@cluster.mongodb.net/itsuki   # Atlas
```

### Layout

One collection per store, one document per top-level key, with the value under
`v`:

```js
// getStore('economy').set('123456789.wallet', 500)
db.economy.findOne({ _id: '123456789' })
// { _id: '123456789', v: { wallet: 500, bank: 0 } }
```

So a key path maps to a document id plus a field path — `"123456789.wallet"`
becomes `_id: "123456789"`, field `v.wallet`. The `v` wrapper looks redundant for
objects, but top-level values are not always objects (`maintenance` stores a
boolean, some stores hold arrays) and a document cannot have a bare scalar body.
One wrapper means scalars, arrays and objects share a single code path.

Query it directly with `v.` prefixes:

```js
db.economy.find({ 'v.wallet': { $gt: 10000 } })
```

### Migrating from the old JSON files

```bash
npm run migrate              # dry run — reports what would happen, writes nothing
npm run migrate -- --write   # import
```

Dry run is the default because this touches live data. Re-running is safe:
existing documents are left alone unless you pass `--force`, so an interrupted
import can just be run again, and a re-run after people have been playing will
not roll their progress back.

The script verifies document counts against the JSON keys afterwards and will
tell you if anything is short. **Only delete `database/*.json` and
`database/JsonStore.ts` once it reports a clean match** and the bot has started
and looked correct.

`database/*.json` is now gitignored — data does not belong in version control.

### Why not the old JSON store

It held every collection wholly in memory and rewrote the **entire file** on
every change through a serialised queue. That is what made it slow under load,
and an interrupted write could truncate a file. Counters were also read-modify-
written in JavaScript, so two overlapping payouts could read the same balance and
one would be silently discarded. Writes now touch a single document, and
`add()`/`push()` use `$inc`/`$push`, which are atomic server-side.

---

## Installation contexts (server vs account)

Itsuki can be added two ways, and they are not the same thing:

| | What the user does | What works |
|---|---|---|
| **Server install** | Admin invites the bot to a server | Everything, including music, moderation and anything reading server data |
| **User install** | "Add to my apps" on the bot's profile | Commands that need no server state — economy, gambling, cards, profile, social, utility — usable in DMs, group DMs and even in servers the bot is not in |

Which commands appear where is derived automatically from each command's own
flags, so nothing needs annotating:

| Command flag | `contexts` | `integration_types` |
|---|---|---|
| `guildOnly: true` | `[Guild]` | `[GuildInstall]` |
| `ownerOnly: true` | `[Guild, BotDM]` | `[GuildInstall]` |
| has `setDefaultMemberPermissions` | `[Guild, BotDM]` | `[GuildInstall]` |
| anything else | `[Guild, BotDM, PrivateChannel]` | `[GuildInstall, UserInstall]` |

`PrivateChannel` is only ever added alongside user install, because Discord
rejects the whole registration if that context appears on a command that is not
user-installable.

### Enabling it

One code-side switch and one portal-side switch, and **both** are required:

1. `USER_INSTALL=true` in `.env` (the default).
2. Developer Portal → your app → **Installation** → **Installation Contexts** →
   tick **User Install**.

If step 2 is missing, Discord refuses the registration. Rather than failing to
start, the bot retries with server install only and logs what to change — so
check the boot log if account installs show no commands.

### Commands not showing up after a change

Guild-scoped commands (`npm run deploy:guild`) can **never** be user installs —
only global commands can. Use `npm run deploy` for that, and
`npm run deploy:clear-guild` to remove stale guild duplicates.

---

### Command count and Discord's 100-command cap

Discord allows **100 chat-input commands per scope** — 100 global, and 100 per
guild. Going over does not truncate: the **entire registration is rejected**, so
one command too many leaves the bot with whatever was registered last.

Itsuki has **103** commands, so owner-only tools are registered to your dev guild
rather than globally:

```
103 total  ->  92 global  +  11 dev guild        (8 global slots spare)
```

That is where owner tools belong anyway — they are useless to normal users, they
would clutter every server's command list, and guild commands appear instantly
instead of taking up to an hour. Classification comes from each command's
`ownerOnly` flag, not its folder, so `/noprefix` is included despite living under
`commands/utility/`.

Set `DISCORD_GUILD_ID` to your own server for this. If you leave it unset, the 92
public commands still register and the owner ones are skipped with a warning —
the bot stays fully usable, and owner tools remain available by prefix
(`,panel`) which does not depend on registration at all.

`npm run deploy:guild` still pushes **everything** to one guild for testing, and
will refuse if that exceeds 100.

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

**`Could not reach MongoDB` on startup**
`MONGO_URI` is missing or wrong, or the server is unreachable. The bot exits
rather than starting with no database, because a half-configured bot writes data
somewhere nobody looks. For Atlas, check that your IP is allow-listed and that
the password is URL-encoded.

**Commands missing for someone who used "Add to my apps"**
Check the boot log for `[AutoDeploy] Discord rejected the user-install
registration`. That means **User Install** is not ticked in the Developer Portal
(see [Installation contexts](#installation-contexts-server-vs-account)). Global
commands can also take up to an hour to propagate after a change.

**A user-install command replies "Bot Not In This Server"**
Working as intended. The command needs server data — channels, roles, voice
state — and an account install cannot see any of that. Invite the bot to the
server and it works immediately.

**`exceeds Discord's limit of 100`**
More than 100 commands in one scope. Set `DISCORD_GUILD_ID` so owner tools go to
your dev guild — see [Command count](#command-count-and-discords-100-command-cap).
Nothing is sent when this happens, so no commands are lost; fix it and restart.

**`canvas` fails to build**
Install the native libraries listed under [Requirements](#requirements), then
reinstall. `canvas` powers the leaderboard and stats images.

---

## License

[MIT](LICENSE) — free to use, modify, and distribute.
