import {
  SlashCommandBuilder, MessageFlags, ContainerBuilder, SectionBuilder,
  TextDisplayBuilder, SeparatorBuilder, SeparatorSpacingSize,
  ActionRowBuilder, ButtonBuilder, ButtonStyle, type ChatInputCommandInteraction,
} from 'discord.js';
import { Command } from '../../structures/Command';
import UserManager from '../../managers/UserManager';
import * as CB from '../../builders/ComponentBuilder';
import fmt from '../../utils/Formatter';
import { MEDALS } from '../../utils/Constants';

const CATS = [
  { id: 'netWorth', label: ' Net Worth', field: (v: number) => fmt.coins(v) },
  { id: 'level', label: ' Level', field: (v: number) => `Level ${v}` },
  { id: 'gamesWon', label: ' Games Won', field: (v: number) => `${fmt.number(v)} wins` },
  { id: 'totalEarned', label: ' Total Earned', field: (v: number) => fmt.coins(v) },
];

export default new Command({
  data: new SlashCommandBuilder()
    .setName('leaderboard').setDescription('View global leaderboards.')
    .addStringOption((o) => o.setName('category').setDescription('Category')
      .addChoices(...CATS.map((c) => ({ name: c.label, value: c.id })))),
  category: 'leaderboard', cooldown: 5000,
  async execute(interaction: ChatInputCommandInteraction) {
    await interaction.deferReply({ flags: MessageFlags.IsComponentsV2 as any });
    const catId = (interaction.options.get('category')?.value as string) ?? CATS[0].id;
    const cat = CATS.find((c) => c.id === catId) ?? CATS[0];
    const entries = await UserManager.getLeaderboard(cat.id, 10);
    if (!entries.length) return interaction.editReply({ ...CB.errorResponse('No Data', 'No leaderboard data yet.') } as never);
    const lines = await Promise.all(entries.map(async (e, i) => {
      let name: string;
      try { const m = await interaction.guild!.members.fetch(e.userId).catch(() => null); name = m?.displayName ?? `User#${e.userId.slice(-4)}`; }
      catch { name = `User#${e.userId.slice(-4)}`; }
      return `${MEDALS[i] ?? `**${i + 1}.**`} **${name}** — ${cat.field(e.value)}`;
    }));
    const c = new ContainerBuilder()
      .addTextDisplayComponents(new TextDisplayBuilder().setContent(`# Leaderboard — ${cat.label}`))
      .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Large).setDivider(true))
      .addTextDisplayComponents(new TextDisplayBuilder().setContent(lines.join('\n')))
      .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true))
      .addTextDisplayComponents(new TextDisplayBuilder().setContent('-# Updated just now'));
    await interaction.editReply({ components: [c] });
  },
});
