import {
  SlashCommandBuilder, MessageFlags, PermissionFlagsBits, AttachmentBuilder,
  ContainerBuilder, TextDisplayBuilder, SeparatorBuilder, SeparatorSpacingSize,
  type ChatInputCommandInteraction, type TextChannel, type Message,
} from 'discord.js';
import { Command } from '../../structures/Command';
import { downloadMedia, DownloadError, DISCORD_BASE_UPLOAD_LIMIT } from '../../services/SafeDownloader';
import * as CB from '../../builders/ComponentBuilder';
import fmt from '../../utils/Formatter';
import logger from '../../utils/Logger';

/** `<:name:id>` / `<a:name:id>`, or a bare emoji id. */
const EMOJI_RE = /<(a)?:([\w~]+):(\d{15,25})>/;
const BARE_ID_RE = /^\d{15,25}$/;

/** https://discord.com/channels/<guild>/<channel>/<message> */
const MESSAGE_LINK_RE =
  /(?:https?:\/\/)?(?:canary\.|ptb\.)?discord(?:app)?\.com\/channels\/(\d{15,25}|@me)\/(\d{15,25})\/(\d{15,25})/;

function uploadLimitFor(interaction: ChatInputCommandInteraction): number {
  const guildLimit = interaction.guild?.premiumTier
    ? Math.max(DISCORD_BASE_UPLOAD_LIMIT, interaction.guild.maximumUploadLimit ?? 0)
    : DISCORD_BASE_UPLOAD_LIMIT;
  return Math.max(1, guildLimit - 256 * 1024);
}

function describeError(err: unknown): { title: string; body: string } {
  if (err instanceof DownloadError) {
    const titles: Record<DownloadError['kind'], string> = {
      blocked: 'Blocked', too_large: 'Too Large', bad_type: 'Unsupported Type',
      not_found: 'Not Found', network: 'Download Failed',
    };
    return { title: titles[err.kind], body: err.message };
  }
  logger.warn(`[Grab] Unexpected: ${(err as Error).message}`);
  return { title: 'Failed', body: 'Something went wrong fetching that.' };
}

export default new Command({
  data: new SlashCommandBuilder()
    .setName('grab').setDescription('Download emojis, avatars, banners and message attachments.')
    .addSubcommand((s) => s.setName('emoji').setDescription('Download a custom emoji (optionally add it here)')
      .addStringOption((o) => o.setName('emoji').setDescription('The emoji, or its ID').setRequired(true))
      .addBooleanOption((o) => o.setName('add').setDescription('Also upload it to this server')))
    .addSubcommand((s) => s.setName('avatar').setDescription("Download a user's avatar")
      .addUserOption((o) => o.setName('user').setDescription('Defaults to you'))
      .addBooleanOption((o) => o.setName('server').setDescription('Use their server-specific avatar if set')))
    .addSubcommand((s) => s.setName('banner').setDescription("Download a user's profile banner")
      .addUserOption((o) => o.setName('user').setDescription('Defaults to you')))
    .addSubcommand((s) => s.setName('icon').setDescription("Download this server's icon or banner")
      .addStringOption((o) => o.setName('which').setDescription('Which asset')
        .addChoices({ name: 'Icon', value: 'icon' }, { name: 'Banner', value: 'banner' }, { name: 'Splash', value: 'splash' })))
    .addSubcommand((s) => s.setName('message').setDescription('Mirror the attachments from a message link')
      .addStringOption((o) => o.setName('link').setDescription('Discord message link').setRequired(true))),
  category: 'utility',
  guildOnly: true,
  cooldown: 8_000,

  async execute(interaction: ChatInputCommandInteraction) {
    await interaction.deferReply({ flags: MessageFlags.IsComponentsV2 as never });

    const sub = (interaction.options as { getSubcommand: () => string }).getSubcommand();
    const SUBCOMMANDS = ['emoji', 'avatar', 'banner', 'icon', 'message'];
    if (!SUBCOMMANDS.includes(sub)) {
      return interaction.editReply({ ...CB.errorResponse(
        'Unknown Subcommand', `Use one of: ${SUBCOMMANDS.map((s) => `\`${s}\``).join(', ')}.`,
      ) } as never);
    }

    const guild = interaction.guild!;
    const maxBytes = uploadLimitFor(interaction);

    try {
      // ── emoji ─────────────────────────────────────────────────────────────
      if (sub === 'emoji') {
        const raw = (interaction.options.getString('emoji') ?? '').trim();
        const match = EMOJI_RE.exec(raw);

        let emojiId: string;
        let animated: boolean;
        let name: string;

        if (match) {
          animated = Boolean(match[1]);
          name = match[2];
          emojiId = match[3];
        } else if (BARE_ID_RE.test(raw)) {
          emojiId = raw;
          // A bare ID gives no hint about animation. Try GIF first and fall
          // back to PNG, rather than guessing wrong and 404ing.
          animated = false;
          name = `emoji_${raw.slice(-6)}`;
        } else {
          return interaction.editReply({ ...CB.errorResponse(
            'Not a Custom Emoji',
            'Paste a **custom** emoji (or its ID). Standard Unicode emoji are not files, so there is nothing to download.',
          ) } as never);
        }

        const attempt = async (isAnimated: boolean) =>
          downloadMedia(`https://cdn.discordapp.com/emojis/${emojiId}.${isAnimated ? 'gif' : 'png'}?size=256`, maxBytes);

        let file;
        try {
          file = await attempt(animated);
        } catch (err) {
          if (!match && err instanceof DownloadError && err.kind === 'not_found') {
            file = await attempt(true); // bare ID: retry as animated
            animated = true;
          } else {
            throw err;
          }
        }

        const shouldAdd = interaction.options.getBoolean('add') ?? false;
        let addNote = '';

        if (shouldAdd) {
          // Both parties need the permission: the caller to authorise it, and
          // the bot to perform it.
          const callerCan = interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuildExpressions);
          const botCan = guild.members.me?.permissions.has(PermissionFlagsBits.ManageGuildExpressions);

          if (!callerCan) {
            addNote = '\n-# Not added: you need **Manage Expressions** to add emojis.';
          } else if (!botCan) {
            addNote = '\n-# Not added: I need **Manage Expressions** to add emojis.';
          } else {
            try {
              const created = await guild.emojis.create({
                attachment: file.buffer,
                name: name.slice(0, 32),
                reason: `Added by ${interaction.user.tag ?? interaction.user.username} via /grab`,
              });
              addNote = `\n✅ Added to this server as ${created}`;
            } catch (err) {
              // Almost always a full emoji slot list or an oversized file.
              addNote = `\n-# Could not add it: ${(err as Error).message}`;
            }
          }
        }

        return interaction.editReply({
          components: [new ContainerBuilder().addTextDisplayComponents(
            new TextDisplayBuilder().setContent([
              `### ${animated ? '🎞️' : '🖼️'} ${name}`,
              `-# \`${emojiId}\` · ${(file.bytes / 1024).toFixed(0)} KB · ${animated ? 'animated' : 'static'}`,
              addNote,
            ].filter(Boolean).join('\n')),
          )],
          files: [new AttachmentBuilder(file.buffer, { name: file.filename })],
        } as never);
      }

      // ── avatar ────────────────────────────────────────────────────────────
      if (sub === 'avatar') {
        const target = interaction.options.getUser('user') ?? interaction.user;
        const preferServer = interaction.options.getBoolean('server') ?? false;

        let url = target.displayAvatarURL({ size: 1024, extension: 'png' });
        let source = 'global';
        if (preferServer) {
          const member = guild.members.cache.get(target.id)
            ?? await guild.members.fetch(target.id).catch(() => null);
          // avatarURL() is null when the member has no server-specific avatar,
          // so fall back rather than producing an empty request.
          const serverAvatar = member?.avatarURL({ size: 1024, extension: 'png' });
          if (serverAvatar) { url = serverAvatar; source = 'server-specific'; }
          else source = 'global (no server avatar set)';
        }

        const file = await downloadMedia(url, maxBytes);
        return interaction.editReply({
          components: [new ContainerBuilder().addTextDisplayComponents(
            new TextDisplayBuilder().setContent([
              `### 🖼️ ${target.username}'s avatar`,
              `-# ${source} · ${(file.bytes / 1024).toFixed(0)} KB`,
            ].join('\n')),
          )],
          files: [new AttachmentBuilder(file.buffer, { name: `avatar-${target.id}.png` })],
        } as never);
      }

      // ── banner ────────────────────────────────────────────────────────────
      if (sub === 'banner') {
        const target = interaction.options.getUser('user') ?? interaction.user;
        // Banners are not present on a cached User — a force fetch is required.
        const fetched = await interaction.client.users.fetch(target.id, { force: true }).catch(() => null);
        const url = fetched?.bannerURL({ size: 1024, extension: 'png' });

        if (!url) {
          return interaction.editReply({ ...CB.errorResponse(
            'No Banner', `**${target.username}** has no profile banner set.`,
          ) } as never);
        }

        const file = await downloadMedia(url, maxBytes);
        return interaction.editReply({
          components: [new ContainerBuilder().addTextDisplayComponents(
            new TextDisplayBuilder().setContent([
              `### 🏞️ ${target.username}'s banner`,
              `-# ${(file.bytes / 1024).toFixed(0)} KB`,
            ].join('\n')),
          )],
          files: [new AttachmentBuilder(file.buffer, { name: `banner-${target.id}.png` })],
        } as never);
      }

      // ── server icon / banner / splash ─────────────────────────────────────
      if (sub === 'icon') {
        const which = interaction.options.getString('which') ?? 'icon';
        const url = which === 'banner' ? guild.bannerURL({ size: 1024, extension: 'png' })
          : which === 'splash' ? guild.splashURL({ size: 1024, extension: 'png' })
          : guild.iconURL({ size: 1024, extension: 'png' });

        if (!url) {
          return interaction.editReply({ ...CB.errorResponse(
            'Not Set', `This server has no ${which} set.`,
          ) } as never);
        }

        const file = await downloadMedia(url, maxBytes);
        return interaction.editReply({
          components: [new ContainerBuilder().addTextDisplayComponents(
            new TextDisplayBuilder().setContent([
              `### 🏛️ ${guild.name} — ${which}`,
              `-# ${(file.bytes / 1024).toFixed(0)} KB`,
            ].join('\n')),
          )],
          files: [new AttachmentBuilder(file.buffer, { name: `${which}-${guild.id}.png` })],
        } as never);
      }

      // ── message attachments ───────────────────────────────────────────────
      const link = (interaction.options.getString('link') ?? '').trim();
      const parsed = MESSAGE_LINK_RE.exec(link);
      if (!parsed) {
        return interaction.editReply({ ...CB.errorResponse(
          'Invalid Link',
          'Paste a Discord message link (right-click a message → **Copy Message Link**).',
        ) } as never);
      }

      const [, linkGuildId, channelId, messageId] = parsed;

      // Only same-server links: fetching from an arbitrary guild would let
      // anyone pull attachments out of servers they may not even be in.
      if (linkGuildId !== guild.id) {
        return interaction.editReply({ ...CB.errorResponse(
          'Different Server', 'That link points to another server. Only messages from this server can be mirrored.',
        ) } as never);
      }

      const channel = guild.channels.cache.get(channelId) as TextChannel | undefined;
      if (!channel || typeof channel.messages?.fetch !== 'function') {
        return interaction.editReply({ ...CB.errorResponse(
          'Channel Not Found', 'That channel no longer exists, or I cannot see it.',
        ) } as never);
      }

      // The CALLER must be able to read the channel — otherwise this becomes a
      // way to read private channels through the bot.
      const callerPerms = interaction.memberPermissions;
      const canView = channel.permissionsFor(interaction.user.id)?.has(PermissionFlagsBits.ViewChannel)
        ?? callerPerms?.has(PermissionFlagsBits.ViewChannel)
        ?? false;
      if (!canView) {
        return interaction.editReply({ ...CB.errorResponse(
          'No Access', 'You do not have access to that channel.',
        ) } as never);
      }

      let message: Message;
      try {
        message = await channel.messages.fetch(messageId);
      } catch {
        return interaction.editReply({ ...CB.errorResponse(
          'Message Not Found', 'That message no longer exists, or I cannot read it.',
        ) } as never);
      }

      const targets = [
        ...message.attachments.map((a) => ({ url: a.url, name: a.name })),
        ...message.stickers.map((s) => ({ url: s.url, name: `${s.name}.png` })),
      ];

      if (!targets.length) {
        return interaction.editReply({ ...CB.errorResponse(
          'Nothing to Mirror', 'That message has no attachments or stickers.',
        ) } as never);
      }

      // Discord permits 10 attachments per message.
      const files: AttachmentBuilder[] = [];
      const failed: string[] = [];
      let totalBytes = 0;

      for (const t of targets.slice(0, 10)) {
        try {
          const file = await downloadMedia(t.url, maxBytes);
          // Respect the aggregate limit, not just per-file.
          if (totalBytes + file.bytes > maxBytes) {
            failed.push(`${t.name} (would exceed the upload limit)`);
            continue;
          }
          totalBytes += file.bytes;
          files.push(new AttachmentBuilder(file.buffer, { name: t.name || file.filename }));
        } catch (err) {
          failed.push(`${t.name} (${err instanceof DownloadError ? err.message : 'failed'})`);
        }
      }

      if (!files.length) {
        return interaction.editReply({ ...CB.errorResponse(
          'Nothing Downloaded', failed.length ? failed.slice(0, 5).join('\n') : 'All downloads failed.',
        ) } as never);
      }

      const container = new ContainerBuilder()
        .addTextDisplayComponents(new TextDisplayBuilder().setContent([
          `### 📎 ${files.length} file${files.length !== 1 ? 's' : ''} mirrored`,
          `-# From a message by ${message.author?.username ?? 'unknown'} · ${(totalBytes / 1024).toFixed(0)} KB total`,
        ].join('\n')));

      if (failed.length) {
        container.addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true))
          .addTextDisplayComponents(new TextDisplayBuilder().setContent(
            `-# Skipped: ${failed.slice(0, 4).join(' · ')}`,
          ));
      }

      return interaction.editReply({ components: [container], files } as never);
    } catch (err) {
      const { title, body } = describeError(err);
      return interaction.editReply({ ...CB.errorResponse(title, body) } as never);
    }
  },
});
