import {
  SlashCommandBuilder, MessageFlags, PermissionFlagsBits,
  ContainerBuilder, TextDisplayBuilder, SeparatorBuilder, SeparatorSpacingSize,
  type ChatInputCommandInteraction, type TextChannel, type Message,
} from 'discord.js';
import { Command } from '../../structures/Command';
import {
  getSlots, checkExpressionPerms, addEmoji, addSticker, creationDelay,
  sanitiseName, BULK_LIMIT, type AddOutcome,
} from '../../services/ExpressionService';
import * as CB from '../../builders/ComponentBuilder';
import logger from '../../utils/Logger';

/**
 * All custom emojis in a string: `<:name:id>` / `<a:name:id>`.
 *
 * Lenient on the name length (1-32) even though Discord enforces 2-32 on
 * creation: this parses somebody ELSE'S emoji, and being strict here silently
 * skipped valid input. Names are normalised on the way out instead — lenient
 * parsing, strict creation.
 *
 * Safe to share as a module-level global regex because `matchAll` clones it
 * internally; `exec` would carry `lastIndex` between calls and drop matches.
 */
const EMOJI_GLOBAL = /<(a)?:([\w~]{1,32}):(\d{15,25})>/g;
const BARE_ID = /^\d{15,25}$/;
const MESSAGE_LINK =
  /(?:https?:\/\/)?(?:canary\.|ptb\.)?discord(?:app)?\.com\/channels\/(\d{15,25})\/(\d{15,25})\/(\d{15,25})/;

interface EmojiRef { id: string; name: string; animated: boolean }

/** Parses every custom emoji out of arbitrary text, de-duplicated by ID. */
function parseEmojis(input: string): EmojiRef[] {
  const found = new Map<string, EmojiRef>();
  for (const m of input.matchAll(EMOJI_GLOBAL)) {
    // Discord requires 2+ characters on creation, so a 1-char source name is
    // given a derived one rather than being rejected later.
    const name = m[2].length >= 2 ? m[2] : `emoji_${m[3].slice(-6)}`;
    found.set(m[3], { animated: Boolean(m[1]), name, id: m[3] });
  }
  // A bare ID is accepted too, but animation is unknown at this point.
  if (found.size === 0) {
    for (const token of input.split(/[\s,]+/).filter(Boolean)) {
      if (BARE_ID.test(token)) found.set(token, { id: token, name: `emoji_${token.slice(-6)}`, animated: false });
    }
  }
  return [...found.values()];
}

function emojiCdnUrl(ref: EmojiRef): string {
  return `https://cdn.discordapp.com/emojis/${ref.id}.${ref.animated ? 'gif' : 'png'}?size=256&quality=lossless`;
}

/** Renders the outcome list, grouped into successes and failures. */
function summarise(title: string, results: AddOutcome[], slotLine: string): ContainerBuilder {
  const ok = results.filter((r) => r.ok);
  const failed = results.filter((r) => !r.ok);

  const container = new ContainerBuilder()
    .addTextDisplayComponents(new TextDisplayBuilder().setContent([
      `# ${title}`,
      `**${ok.length}** added${failed.length ? ` · **${failed.length}** failed` : ''}`,
    ].join('\n')));

  if (ok.length) {
    container.addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true))
      .addTextDisplayComponents(new TextDisplayBuilder().setContent(
        ok.map((r) => `${r.mention ?? '•'} \`:${r.name}:\``).join('  ').slice(0, 3900),
      ));
  }

  if (failed.length) {
    container.addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true))
      .addTextDisplayComponents(new TextDisplayBuilder().setContent(
        ['**Failed**', ...failed.slice(0, 8).map((r) => `> \`${r.name}\` — ${r.reason}`)].join('\n').slice(0, 1500),
      ));
  }

  return container
    .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true))
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(slotLine));
}

function slotLine(guild: Parameters<typeof getSlots>[0]): string {
  const s = getSlots(guild);
  return `-# Slots — static **${s.staticUsed}/${s.staticMax}** · animated **${s.animatedUsed}/${s.animatedMax}** · stickers **${s.stickersUsed}/${s.stickersMax}**`;
}

export default new Command({
  data: new SlashCommandBuilder()
    .setName('steal').setDescription('Copy emojis and stickers into this server.')
    .addSubcommand((s) => s.setName('emoji').setDescription('Steal one or many emojis at once')
      .addStringOption((o) => o.setName('emojis')
        .setDescription('Paste any number of custom emojis (or IDs)').setRequired(true))
      .addStringOption((o) => o.setName('name')
        .setDescription('Rename — only applies when stealing a single emoji')))
    .addSubcommand((s) => s.setName('sticker').setDescription('Steal the stickers from a message')
      .addStringOption((o) => o.setName('link').setDescription('Discord message link').setRequired(true)))
    .addSubcommand((s) => s.setName('message').setDescription('Steal every emoji AND sticker in a message')
      .addStringOption((o) => o.setName('link').setDescription('Discord message link').setRequired(true)))
    .addSubcommand((s) => s.setName('upload').setDescription('Add an image from a URL')
      .addStringOption((o) => o.setName('url').setDescription('Direct image URL').setRequired(true))
      .addStringOption((o) => o.setName('name').setDescription('Name for it').setRequired(true))
      .addStringOption((o) => o.setName('as').setDescription('Add as emoji or sticker')
        .addChoices({ name: 'Emoji', value: 'emoji' }, { name: 'Sticker', value: 'sticker' })))
    .addSubcommand((s) => s.setName('slots').setDescription('Show remaining emoji and sticker slots'))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuildExpressions),
  category: 'utility',
  guildOnly: true,
  permissions: ['ManageGuildExpressions'],
  cooldown: 10_000,

  async execute(interaction: ChatInputCommandInteraction) {
    await interaction.deferReply({ flags: MessageFlags.IsComponentsV2 as never });

    const sub = (interaction.options as { getSubcommand: () => string }).getSubcommand();
    const SUBCOMMANDS = ['emoji', 'sticker', 'message', 'upload', 'slots'];
    if (!SUBCOMMANDS.includes(sub)) {
      return interaction.editReply({ ...CB.errorResponse(
        'Unknown Subcommand', `Use one of: ${SUBCOMMANDS.map((s) => `\`${s}\``).join(', ')}.`,
      ) } as never);
    }

    const guild = interaction.guild!;
    const reason = `Stolen by ${interaction.user.tag ?? interaction.user.username}`;

    // ── slots (read-only, no permission needed beyond the command gate) ─────
    if (sub === 'slots') {
      const s = getSlots(guild);
      return interaction.editReply({ ...CB.successResponse(
        'Expression Slots',
        [
          `**Boost tier:** ${s.tier}`,
          '',
          `**Static emojis:** ${s.staticUsed} / ${s.staticMax}  (**${s.staticFree}** free)`,
          `**Animated emojis:** ${s.animatedUsed} / ${s.animatedMax}  (**${s.animatedFree}** free)`,
          `**Stickers:** ${s.stickersUsed} / ${s.stickersMax}  (**${s.stickersFree}** free)`,
          '',
          '-# Static and animated emojis use separate pools, so a full static list does not block animated ones.',
        ].join('\n'),
      ) } as never);
    }

    // Everything below writes to the guild.
    const permIssue = checkExpressionPerms(
      guild,
      interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuildExpressions) ?? false,
    );
    if (permIssue) {
      return interaction.editReply({ ...CB.errorResponse('Missing Permission', permIssue) } as never);
    }

    // ── upload from URL ─────────────────────────────────────────────────────
    if (sub === 'upload') {
      const url = (interaction.options.getString('url') ?? '').trim();
      const name = interaction.options.getString('name') ?? '';
      const as = interaction.options.getString('as') ?? 'emoji';

      const result = as === 'sticker'
        ? await addSticker(guild, url, name, name, reason)
        : await addEmoji(guild, url, name, reason);

      if (!result.ok) {
        return interaction.editReply({ ...CB.errorResponse(
          `Could Not Add ${as === 'sticker' ? 'Sticker' : 'Emoji'}`,
          `${result.reason}\n${slotLine(guild)}`,
        ) } as never);
      }

      return interaction.editReply({ ...CB.successResponse(
        as === 'sticker' ? 'Sticker Added' : 'Emoji Added',
        [
          as === 'sticker'
            ? `Added sticker **${result.name}**.`
            : `Added ${result.mention} as \`:${result.name}:\`${result.animated ? ' (animated)' : ''}.`,
          slotLine(guild),
        ].join('\n'),
      ) } as never);
    }

    // ── bulk emoji ──────────────────────────────────────────────────────────
    if (sub === 'emoji') {
      const input = interaction.options.getString('emojis') ?? '';
      const refs = parseEmojis(input);

      if (!refs.length) {
        return interaction.editReply({ ...CB.errorResponse(
          'No Custom Emojis Found',
          'Paste one or more **custom** emojis, or their IDs. Standard Unicode emojis are not files, so there is nothing to copy.',
        ) } as never);
      }

      const rename = interaction.options.getString('name');
      // Renaming many emojis to one name would just create duplicates, so the
      // option is honoured only for a single steal.
      const renameApplies = Boolean(rename) && refs.length === 1;

      const batch = refs.slice(0, BULK_LIMIT);
      const results: AddOutcome[] = [];

      for (const [i, ref] of batch.entries()) {
        const desired = renameApplies ? sanitiseName(rename) ?? ref.name : ref.name;
        let outcome = await addEmoji(guild, emojiCdnUrl(ref), desired, reason);

        // A bare ID guessed static; retry as animated on a 404-style failure.
        if (!outcome.ok && !ref.animated && /not exist|404|Download failed|Not Found/i.test(outcome.reason ?? '')) {
          outcome = await addEmoji(guild, emojiCdnUrl({ ...ref, animated: true }), desired, reason);
        }
        results.push(outcome);

        // Space out creations — this endpoint is rate limited tightly.
        if (i < batch.length - 1) await creationDelay();
      }

      if (refs.length > BULK_LIMIT) {
        results.push({
          ok: false,
          name: `+${refs.length - BULK_LIMIT} more`,
          reason: `Only ${BULK_LIMIT} can be stolen per command to stay within Discord's rate limits.`,
        });
      }

      logger.info(`[Steal] ${interaction.user.tag} added ${results.filter((r) => r.ok).length} emoji(s) to ${guild.id}`);
      return interaction.editReply({
        components: [summarise('Emoji Steal', results, slotLine(guild))],
      } as never);
    }

    // ── from a message link (stickers, or everything) ────────────────────────
    const link = (interaction.options.getString('link') ?? '').trim();
    const parsed = MESSAGE_LINK.exec(link);
    if (!parsed) {
      return interaction.editReply({ ...CB.errorResponse(
        'Invalid Link', 'Right-click a message → **Copy Message Link**, then paste it here.',
      ) } as never);
    }

    const [, linkGuildId, channelId, messageId] = parsed;

    // Same-server only, and the caller must be able to see the channel —
    // otherwise this reads other servers' or private channels' content through
    // the bot's own access.
    if (linkGuildId !== guild.id) {
      return interaction.editReply({ ...CB.errorResponse(
        'Different Server',
        'That link points at another server. Paste an emoji or sticker directly instead — `/steal emoji` works across servers.',
      ) } as never);
    }

    const channel = guild.channels.cache.get(channelId) as TextChannel | undefined;
    if (!channel || typeof channel.messages?.fetch !== 'function') {
      return interaction.editReply({ ...CB.errorResponse('Channel Not Found', 'I cannot see that channel.') } as never);
    }
    if (!channel.permissionsFor(interaction.user.id)?.has(PermissionFlagsBits.ViewChannel)) {
      return interaction.editReply({ ...CB.errorResponse('No Access', 'You do not have access to that channel.') } as never);
    }

    let message: Message;
    try {
      message = await channel.messages.fetch(messageId);
    } catch {
      return interaction.editReply({ ...CB.errorResponse('Message Not Found', 'That message no longer exists.') } as never);
    }

    const results: AddOutcome[] = [];

    // Stickers first — they're the scarcer resource.
    const stickers = [...message.stickers.values()];
    for (const [i, sticker] of stickers.slice(0, BULK_LIMIT).entries()) {
      results.push(await addSticker(guild, sticker.url, sticker.name, sticker.name, reason));
      if (i < stickers.length - 1) await creationDelay();
    }

    // `message` also sweeps up every custom emoji in the message body.
    if (sub === 'message') {
      const refs = parseEmojis(message.content ?? '');
      const room = Math.max(0, BULK_LIMIT - results.length);
      for (const [i, ref] of refs.slice(0, room).entries()) {
        results.push(await addEmoji(guild, emojiCdnUrl(ref), ref.name, reason));
        if (i < room - 1) await creationDelay();
      }
    }

    if (!results.length) {
      return interaction.editReply({ ...CB.errorResponse(
        'Nothing to Steal',
        sub === 'sticker'
          ? 'That message has no stickers.'
          : 'That message has no stickers or custom emojis.',
      ) } as never);
    }

    logger.info(`[Steal] ${interaction.user.tag} added ${results.filter((r) => r.ok).length} expression(s) to ${guild.id}`);
    return interaction.editReply({
      components: [summarise(
        sub === 'sticker' ? 'Sticker Steal' : 'Message Steal',
        results, slotLine(guild),
      )],
    } as never);
  },
});
