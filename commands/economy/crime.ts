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
const CRIMES = ['robbed a convenience store','hacked a bitcoin wallet','pickpocketed a tourist','pulled off a bank heist','scammed crypto investors'];
const CAUGHT = ['The police were waiting for you.','A witness called the cops.','You tripped the alarm.'];
const FRAMES = [' Scoping out the target…',' Breaking in…',' Grabbing the goods…',' Making the getaway…'];

export default new Command({
  data: new SlashCommandBuilder().setName('crime').setDescription('Attempt a crime for big rewards — but you might get caught! (30 min cooldown)'),
  category: 'economy',
  async execute(interaction: ChatInputCommandInteraction) {
    await interaction.deferReply({ flags: MessageFlags.IsComponentsV2 as any });
    const result = await EconomyManager.crime(interaction.user.id);
    const av = interaction.user.displayAvatarURL({ size: 256 });
    if (!result.success && 'remaining' in result && result.remaining) {
      const c = new ContainerBuilder().addSectionComponents(new SectionBuilder().addTextDisplayComponents(
        new TextDisplayBuilder().setContent([`# ${E.COOLDOWN} Laying Low`, `Return ${fmt.relativeTime(Date.now() + result.remaining)}.`].join('\n'))
      ).setThumbnailAccessory(new ThumbnailBuilder().setURL(av)));
      return interaction.editReply({ components: [c] });
    }
    for (const frame of FRAMES) {
      await interaction.editReply({ components: [new ContainerBuilder().addTextDisplayComponents(new TextDisplayBuilder().setContent(`# Committing Crime\n> ${frame}`))] });
      await sleep(500);
    }
    const eco = await UserManager.getEconomy(interaction.user.id);
    if (result.success && 'amount' in result) {
      const c = new ContainerBuilder()
        .addSectionComponents(new SectionBuilder().addTextDisplayComponents(
          new TextDisplayBuilder().setContent([`# ${E.CRIME} Crime Successful!`, `You ${fmt.randomItem(CRIMES)} and got away clean.`].join('\n'))
        ).setThumbnailAccessory(new ThumbnailBuilder().setURL(av)))
        .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Large).setDivider(true))
        .addTextDisplayComponents(new TextDisplayBuilder().setContent([
          `${E.COINS} **Stolen:** ${fmt.coins(result.amount)}`, `${E.WALLET} **Wallet:** ${fmt.coins(eco.wallet)}`,
          '', `-# Next crime ${fmt.relativeTime(Date.now() + config.cooldowns.crime)}`,
        ].join('\n')));
      return interaction.editReply({ components: [c] });
    }
    const fine = 'fine' in result ? result.fine : 0;
    const c = new ContainerBuilder()
      .addSectionComponents(new SectionBuilder().addTextDisplayComponents(
        new TextDisplayBuilder().setContent([`# Busted!`, fmt.randomItem(CAUGHT)].join('\n'))
      ).setThumbnailAccessory(new ThumbnailBuilder().setURL(av)))
      .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Large).setDivider(true))
      .addTextDisplayComponents(new TextDisplayBuilder().setContent([`${E.COINS} **Fine:** -${fmt.coins(fine)}`, `${E.WALLET} **Wallet:** ${fmt.coins(eco.wallet)}`].join('\n')));
    await interaction.editReply({ components: [c] });
  },
});
