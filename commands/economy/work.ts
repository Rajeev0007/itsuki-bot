import {
  SlashCommandBuilder, MessageFlags, ContainerBuilder, SectionBuilder,
  TextDisplayBuilder, SeparatorBuilder, SeparatorSpacingSize, ThumbnailBuilder,
  type ChatInputCommandInteraction,
} from 'discord.js';
import { Command } from '../../structures/Command';
import EconomyManager from '../../managers/EconomyManager';
import UserManager from '../../managers/UserManager';
import fmt from '../../utils/Formatter';
import config from '../../config/config';
import { EMOJI as E } from '../../utils/Constants';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const FRAMES = ['🕑 Clocking in…','💼 Putting in the work…','⏳ Almost done with your shift…','💵 Collecting your pay…'];

export default new Command({
  data: new SlashCommandBuilder().setName('work').setDescription('Work at a random job to earn coins. (1 hour cooldown)'),
  category: 'economy',
  async execute(interaction: ChatInputCommandInteraction) {
    await interaction.deferReply({ flags: MessageFlags.IsComponentsV2 as any });
    const result = await EconomyManager.work(interaction.user.id);
    if (!result.success) {
      const c = new ContainerBuilder().addSectionComponents(
        new SectionBuilder().addTextDisplayComponents(
          new TextDisplayBuilder().setContent([`# ${E.COOLDOWN} Still Working`, `Come back ${fmt.relativeTime(Date.now() + result.remaining)}.`].join('\n'))
        ).setThumbnailAccessory(new ThumbnailBuilder().setURL(interaction.user.displayAvatarURL({ size: 256 })))
      );
      return interaction.editReply({ components: [c] });
    }
    for (const frame of FRAMES) {
      await interaction.editReply({ components: [new ContainerBuilder().addTextDisplayComponents(new TextDisplayBuilder().setContent(`# ${E.WORK} Working\n> ${frame}`))] });
      await sleep(500);
    }
    const eco = await UserManager.getEconomy(interaction.user.id);
    const msgs = [`You clocked in as a **${result.job}** and worked your shift!`, `You put in a hard day's work as a **${result.job}**.`, `You picked up a shift as a **${result.job}** and earned your pay.`];
    const c = new ContainerBuilder()
      .addSectionComponents(new SectionBuilder().addTextDisplayComponents(
        new TextDisplayBuilder().setContent([`# ${E.WORK} Work Complete`, fmt.randomItem(msgs)].join('\n'))
      ).setThumbnailAccessory(new ThumbnailBuilder().setURL(interaction.user.displayAvatarURL({ size: 256 }))))
      .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Large).setDivider(true))
      .addTextDisplayComponents(new TextDisplayBuilder().setContent([
        `**Job:** ${result.job}`, `${E.COINS} **Earned:** ${fmt.coins(result.amount)}`,
        `${E.WALLET} **Wallet:** ${fmt.coins(eco.wallet)}`, '',
        `-# Next shift available ${fmt.relativeTime(Date.now() + config.cooldowns.work)}`,
      ].join('\n')));
    await interaction.editReply({ components: [c] });
  },
});
