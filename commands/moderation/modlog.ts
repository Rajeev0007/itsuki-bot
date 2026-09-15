import {
  SlashCommandBuilder, MessageFlags, PermissionFlagsBits, ChannelType,
  type ChatInputCommandInteraction, type TextChannel,
} from 'discord.js';
import { Command } from '../../structures/Command';
import ModerationManager from '../../managers/ModerationManager';
import * as CB from '../../builders/ComponentBuilder';

export default new Command({
  data: new SlashCommandBuilder()
    .setName('modlog').setDescription('Choose where moderation actions are logged.')
    .addSubcommand((s) => s.setName('set').setDescription('Set the mod-log channel')
      .addChannelOption((o) => o.setName('channel').setDescription('Channel to log to').setRequired(true)
        .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)))
    .addSubcommand((s) => s.setName('disable').setDescription('Stop logging moderation actions'))
    .addSubcommand((s) => s.setName('status').setDescription('Show the current mod-log channel'))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
  category: 'moderation',
  guildOnly: true,
  permissions: ['ManageGuild'],

  async execute(interaction: ChatInputCommandInteraction) {
    await interaction.deferReply({ flags: MessageFlags.IsComponentsV2 as never });

    const sub = (interaction.options as { getSubcommand: () => string }).getSubcommand();
    const SUBCOMMANDS = ['set', 'disable', 'status'];
    if (!SUBCOMMANDS.includes(sub)) {
      return interaction.editReply({ ...CB.errorResponse(
        'Unknown Subcommand',
        `Use one of: ${SUBCOMMANDS.map((s) => `\`${s}\``).join(', ')}.`,
      ) } as never);
    }

    const guild = interaction.guild!;

    if (sub === 'status') {
      const id = await ModerationManager.getLogChannelId(guild.id);
      if (!id) {
        return interaction.editReply({ ...CB.successResponse(
          'Mod Log Disabled', 'No mod-log channel is set. Use `/modlog set` to choose one.',
        ) } as never);
      }
      const exists = guild.channels.cache.has(id);
      return interaction.editReply({ ...CB.successResponse(
        'Mod Log',
        exists
          ? `Moderation actions are logged to <#${id}>.`
          : `Configured channel \`${id}\` no longer exists — set a new one with \`/modlog set\`.`,
      ) } as never);
    }

    if (sub === 'disable') {
      await ModerationManager.setLogChannelId(guild.id, null);
      return interaction.editReply({ ...CB.successResponse('Mod Log Disabled', 'Moderation actions will no longer be logged.') } as never);
    }

    const channel = interaction.options.getChannel('channel') as TextChannel | null;
    if (!channel) return interaction.editReply({ ...CB.errorResponse('Missing Channel', 'Pick a channel to log to.') } as never);

    // Verify the bot can actually post there now, rather than silently failing
    // on every future moderation action.
    const me = guild.members.me;
    const perms = me ? channel.permissionsFor(me) : null;
    if (!perms?.has(PermissionFlagsBits.ViewChannel) || !perms?.has(PermissionFlagsBits.SendMessages)) {
      return interaction.editReply({ ...CB.errorResponse(
        'Cannot Post There',
        `I need **View Channel** and **Send Messages** in ${channel}. Fix my permissions and run this again.`,
      ) } as never);
    }

    await ModerationManager.setLogChannelId(guild.id, channel.id);
    return interaction.editReply({ ...CB.successResponse(
      'Mod Log Set', `Moderation actions will be logged to ${channel}.`,
    ) } as never);
  },
});
