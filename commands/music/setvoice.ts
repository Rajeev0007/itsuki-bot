import { SlashCommandBuilder, PermissionFlagsBits, ChannelType, type ChatInputCommandInteraction, MessageFlags } from 'discord.js';
import { Command } from '../../structures/Command';
import music from '../../managers/MusicManager';
import { musicError, musicSuccess } from '../../utils/MusicUtil';

export default new Command({
  data: new SlashCommandBuilder()
    .setName('setvoice')
    .setDescription('Lock the bot to a specific voice channel for 24/7 playback.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addChannelOption((o) =>
      o.setName('channel').setDescription('Voice channel to lock to. Omit to clear the lock.')
        .addChannelTypes(ChannelType.GuildVoice, ChannelType.GuildStageVoice)),
  category: 'music',
  // Voice playback needs a guild voice channel — not available in DMs.
  guildOnly: true,
  async execute(interaction: ChatInputCommandInteraction) {
    await interaction.deferReply({ flags: MessageFlags.IsComponentsV2 as any });
    const channel = interaction.options.get('channel')?.channel as { id: string; permissionsFor?: (m: unknown) => { has: (f: bigint) => boolean } } | null;
    if (!channel) {
      music.setLockedChannel(interaction.guild!.id, null);
      return interaction.editReply(musicSuccess('🔓 Voice channel lock **cleared**.') as never);
    }
    const perms = channel.permissionsFor?.(interaction.guild!.members.me);
    if (!perms?.has(PermissionFlagsBits.Connect) || !perms?.has(PermissionFlagsBits.Speak))
      return interaction.editReply(musicError(`I need **Connect** and **Speak** permissions in <#${channel.id}>.`) as never);
    music.setLockedChannel(interaction.guild!.id, channel.id);
    const session = music.getSession(interaction.guild!.id);
    const player = music.getPlayer(interaction.guild!.id);
    if (session && player && session.voiceChannel.id !== channel.id) {
      try { await (player as { move: (id: string) => Promise<void> }).move(channel.id); session.voiceChannel = channel as never; }
      catch { /* non-fatal */ }
    }
    return interaction.editReply(musicSuccess(`🔒 Voice channel locked to <#${channel.id}>. The bot will always join this channel.`) as never);
  },
});
