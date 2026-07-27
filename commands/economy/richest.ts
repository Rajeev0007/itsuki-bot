import {
  SlashCommandBuilder, MessageFlags, ContainerBuilder, SectionBuilder,
  TextDisplayBuilder, SeparatorBuilder, SeparatorSpacingSize,
  type ChatInputCommandInteraction,
} from 'discord.js';
import { Command } from '../../structures/Command';
import UserManager from '../../managers/UserManager';
import * as CB from '../../builders/ComponentBuilder';
import fmt from '../../utils/Formatter';
import { MEDALS } from '../../utils/Constants';

export default new Command({
  data: new SlashCommandBuilder().setName('richest').setDescription('View the wealthiest users by net worth.'),
  category: 'economy', cooldown: 5000,
  async execute(interaction: ChatInputCommandInteraction) {
    await interaction.deferReply({ flags: MessageFlags.IsComponentsV2 as any });
    const lb = await UserManager.getLeaderboard('netWorth', 10);
    if (!lb.length) return interaction.editReply({ ...CB.errorResponse('No Data', 'No economy data found yet.') } as never);
    const lines = await Promise.all(lb.map(async (entry, i) => {
      let name: string;
      try { const m = await interaction.guild!.members.fetch(entry.userId).catch(() => null); name = m?.displayName ?? `User#${entry.userId.slice(-4)}`; }
      catch { name = `User#${entry.userId.slice(-4)}`; }
      return `${MEDALS[i] ?? `**${i + 1}.**`} **${name}** — ${fmt.coins(entry.value)}`;
    }));
    const c = new ContainerBuilder()
      .addTextDisplayComponents(new TextDisplayBuilder().setContent('# Richest Players'))
      .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Large).setDivider(true))
      .addTextDisplayComponents(new TextDisplayBuilder().setContent(lines.join('\n')))
      .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true))
      .addTextDisplayComponents(new TextDisplayBuilder().setContent('-# Updated just now • Rankings based on wallet + bank'));
    await interaction.editReply({ components: [c] });
  },
});
