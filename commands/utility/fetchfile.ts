import {
  SlashCommandBuilder, MessageFlags, PermissionFlagsBits, AttachmentBuilder,
  ContainerBuilder, TextDisplayBuilder, SeparatorBuilder, SeparatorSpacingSize,
  type ChatInputCommandInteraction,
} from 'discord.js';
import { Command } from '../../structures/Command';
import { downloadMedia, DownloadError, DISCORD_BASE_UPLOAD_LIMIT } from '../../services/SafeDownloader';
import * as CB from '../../builders/ComponentBuilder';
import logger from '../../utils/Logger';

/**
 * Relays a direct media URL into the channel as an attachment.
 *
 * Gated behind Manage Messages: this posts a file into the channel on the
 * caller's behalf, so it needs to be a moderator-level action rather than
 * something any member can use to spam attachments or bypass a channel's
 * attachment restrictions.
 *
 * It only accepts DIRECT file URLs. Extracting media from YouTube and other
 * streaming platforms is out of scope — that is a licensing question, not a
 * technical gap.
 */
export default new Command({
  data: new SlashCommandBuilder()
    .setName('fetchfile')
    .setDescription('Download a direct media URL and post it here as an attachment.')
    .addStringOption((o) => o.setName('url')
      .setDescription('Direct link to an image, video, audio or text file').setRequired(true))
    .addBooleanOption((o) => o.setName('private')
      .setDescription('Show the result only to you (default: false)'))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages),
  category: 'utility',
  permissions: ['ManageMessages'],
  cooldown: 10_000,

  async execute(interaction: ChatInputCommandInteraction) {
    const ephemeral = interaction.options.getBoolean('private') ?? false;
    await interaction.deferReply({
      flags: (ephemeral
        ? MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral
        : MessageFlags.IsComponentsV2) as never,
    });

    const url = (interaction.options.getString('url') ?? '').trim();
    if (!url) {
      return interaction.editReply({ ...CB.errorResponse('Missing URL', 'Provide a direct file URL.') } as never);
    }

    // Discord's limit depends on the server's boost tier. Reading it from the
    // guild means a boosted server can relay larger files, and an unboosted one
    // never produces a download it then can't upload.
    const guildLimit = interaction.guild?.premiumTier
      ? Math.max(DISCORD_BASE_UPLOAD_LIMIT, interaction.guild.maximumUploadLimit ?? 0)
      : DISCORD_BASE_UPLOAD_LIMIT;
    // Leave headroom for multipart overhead.
    const maxBytes = Math.max(1, guildLimit - 256 * 1024);

    try {
      const file = await downloadMedia(url, maxBytes);

      const container = new ContainerBuilder()
        .addTextDisplayComponents(new TextDisplayBuilder().setContent([
          `### 📥 ${file.filename}`,
          `-# ${(file.bytes / 1024).toFixed(0)} KB · \`${file.contentType}\``,
          file.redirects.length
            ? `-# Followed ${file.redirects.length} redirect${file.redirects.length !== 1 ? 's' : ''}`
            : '',
        ].filter(Boolean).join('\n')));

      logger.info(`[FetchFile] ${interaction.user.tag} relayed ${file.bytes}B ${file.contentType} from ${file.finalUrl}`);

      return interaction.editReply({
        components: [container],
        files: [new AttachmentBuilder(file.buffer, { name: file.filename })],
      } as never);
    } catch (err) {
      if (err instanceof DownloadError) {
        const titles: Record<DownloadError['kind'], string> = {
          blocked: 'Blocked',
          too_large: 'File Too Large',
          bad_type: 'Unsupported File Type',
          not_found: 'Not Found',
          network: 'Download Failed',
        };

        // A blocked request is worth logging — it's either a mistake or probing.
        if (err.kind === 'blocked') {
          logger.warn(`[FetchFile] Blocked request from ${interaction.user.tag}: ${url} — ${err.message}`);
        }

        const extra = err.kind === 'blocked'
          ? '\n-# Only public `http`/`https` links on ports 80 and 443 are permitted. Private and internal addresses are refused.'
          : err.kind === 'bad_type'
            ? '\n-# Streaming sites (YouTube and similar) are not supported — use a direct file link.'
            : '';

        return interaction.editReply({
          ...CB.errorResponse(titles[err.kind], `${err.message}${extra}`),
        } as never);
      }

      logger.error(`[FetchFile] Unexpected: ${(err as Error).message}`);
      return interaction.editReply({
        ...CB.errorResponse('Download Failed', 'Something went wrong fetching that file.'),
      } as never);
    }
  },
});
