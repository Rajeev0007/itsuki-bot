import { SlashCommandBuilder, PermissionFlagsBits, type ChatInputCommandInteraction, MessageFlags } from 'discord.js';
import { Command } from '../../structures/Command';
import music from '../../managers/MusicManager';
import { musicSuccess } from '../../utils/MusicUtil';

export default new Command({
  data: new SlashCommandBuilder()
    .setName('247')
    .setDescription('Toggle 24/7 mode — bot stays in VC even when queue is empty.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
  category: 'music',
  async execute(interaction: ChatInputCommandInteraction) {
    await interaction.deferReply({ flags: MessageFlags.IsComponentsV2 as any });
    const enabled = music.toggleAlwaysOn(interaction.guild!.id);
    const session = music.getSession(interaction.guild!.id);
    if (session) session.alwaysOn = enabled;
    if (enabled && session?.leaveTimer) { clearTimeout(session.leaveTimer); session.leaveTimer = null; }
    return interaction.editReply(musicSuccess(
      enabled
        ? ' **24/7 mode enabled.** I will stay in the voice channel until manually stopped.'
        : ' **24/7 mode disabled.** I will leave after the queue ends or everyone leaves.'
    ) as never);
  },
});
