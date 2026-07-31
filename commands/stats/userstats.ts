import {
  SlashCommandBuilder, MessageFlags, ContainerBuilder, TextDisplayBuilder,
  SeparatorBuilder, SeparatorSpacingSize, AttachmentBuilder,
  MediaGalleryBuilder, MediaGalleryItemBuilder,
  type ChatInputCommandInteraction,
} from 'discord.js';
import { Command } from '../../structures/Command';
import StatsManager from '../../managers/StatsManager';
import UserManager from '../../managers/UserManager';
import CardManager from '../../managers/CardManager';
import { renderUserStats } from '../../services/StatsCanvas';
import * as CB from '../../builders/ComponentBuilder';
import fmt from '../../utils/Formatter';
import logger from '../../utils/Logger';

export default new Command({
  data: new SlashCommandBuilder()
    .setName('userstats').setDescription('Activity stats for a member of this server.')
    .addUserOption((o) => o.setName('user').setDescription('Whose stats to show')),
  category: 'stats',
  // Activity is tracked per server, so there is nothing to show in a DM.
  guildOnly: true,
  aliases: ['us', 'activity'],
  cooldown: 5_000,

  async execute(interaction: ChatInputCommandInteraction) {
    await interaction.deferReply({ flags: MessageFlags.IsComponentsV2 as never });

    const target = interaction.options.getUser('user') ?? interaction.user;
    const guild = interaction.guild!;

    if (target.bot) {
      return interaction.editReply({ ...CB.errorResponse('No Stats', 'Bots are not tracked.') } as never);
    }

    const [stats, week, series, msgRank, voiceRank, user, cards] = await Promise.all([
      StatsManager.getStats(guild.id, target.id),
      StatsManager.getRecent(guild.id, target.id, 7),
      StatsManager.getSeries(guild.id, target.id, 14),
      StatsManager.getRank(guild.id, target.id, 'messages'),
      StatsManager.getRank(guild.id, target.id, 'voiceSeconds'),
      UserManager.getUser(target.id, guild.id),
      CardManager.summarise(target.id),
    ]);

    if (stats.messages === 0 && stats.voiceSeconds === 0 && stats.commands === 0) {
      return interaction.editReply({ ...CB.errorResponse(
        'No Activity Yet',
        `No activity recorded for **${target.username}** in this server yet. Tracking begins from the first message after the bot came online.`,
      ) } as never);
    }

    const container = new ContainerBuilder()
      .addTextDisplayComponents(new TextDisplayBuilder().setContent(
        `# 📊 ${target.username}\n-# Activity in ${guild.name}`,
      ));

    const files: AttachmentBuilder[] = [];
    try {
      const png = await renderUserStats({
        username: target.username,
        avatarUrl: target.displayAvatarURL({ extension: 'png', size: 128 }),
        messages: stats.messages,
        voiceSeconds: stats.voiceSeconds,
        commands: stats.commands,
        messageRank: msgRank,
        voiceRank: voiceRank,
        series,
      });
      files.push(new AttachmentBuilder(png, { name: 'userstats.png' }));
      container.addMediaGalleryComponents(
        new MediaGalleryBuilder().addItems(new MediaGalleryItemBuilder().setURL('attachment://userstats.png')),
      );
    } catch (err) {
      logger.warn(`[userstats] Canvas render failed, using text: ${(err as Error).message}`);
      container.addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true))
        .addTextDisplayComponents(new TextDisplayBuilder().setContent([
          `**Messages:** ${fmt.number(stats.messages)}${msgRank ? ` (#${msgRank})` : ''}`,
          `**Voice:** ${fmt.duration(stats.voiceSeconds * 1000)}${voiceRank ? ` (#${voiceRank})` : ''}`,
          `**Commands:** ${fmt.number(stats.commands)}`,
        ].join('\n')));
    }

    container.addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true))
      .addTextDisplayComponents(new TextDisplayBuilder().setContent([
        `**Last 7 days:** ${fmt.number(week.messages)} messages · ${fmt.duration(week.voiceSeconds * 1000)} in voice`,
        `**Level:** ${user.level} · **Cards:** ${cards.total} (${fmt.number(cards.power)} power)`,
        `-# First seen <t:${Math.floor(stats.firstSeen / 1000)}:D> · last active <t:${Math.floor(stats.lastSeen / 1000)}:R>`,
      ].join('\n')));

    await interaction.editReply({ components: [container], files } as never);
  },
});
