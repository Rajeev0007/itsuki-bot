import {
  SlashCommandBuilder, MessageFlags, ContainerBuilder, SectionBuilder,
  TextDisplayBuilder, SeparatorBuilder, SeparatorSpacingSize,
  ActionRowBuilder, ButtonBuilder, ButtonStyle, ThumbnailBuilder,
  type ChatInputCommandInteraction,
} from 'discord.js';
import { Command } from '../../structures/Command';
import UserManager from '../../managers/UserManager';
import * as CB from '../../builders/ComponentBuilder';
import fmt from '../../utils/Formatter';
import config from '../../config/config';
import { EMOJI as E } from '../../utils/Constants';

export default new Command({
  data: new SlashCommandBuilder().setName('prestige').setDescription('Reset to level 1 in exchange for a permanent earnings bonus (requires max level).'),
  category: 'economy', cooldown: 5000,
  async execute(interaction: ChatInputCommandInteraction) {
    await interaction.deferReply({ flags: MessageFlags.IsComponentsV2 as any });
    const user = await UserManager.getUser(interaction.user.id, interaction.guild?.id);
    if (user.level < config.economy.maxLevel)
      return interaction.editReply({ ...CB.errorResponse('Not Ready', `You need **Level ${config.economy.maxLevel}** to prestige. Currently Level **${user.level}**.`) } as never);
    const next = (user.prestige ?? 0) + 1;
    const bonusPct = (next * config.economy.prestigeBonus * 100).toFixed(0);
    const container = new ContainerBuilder()
      .addSectionComponents(new SectionBuilder().addTextDisplayComponents(
        new TextDisplayBuilder().setContent([`# ${E.PRESTIGE} Prestige ${next}`, 'Are you sure you want to prestige?'].join('\n'))
      ).setThumbnailAccessory(new ThumbnailBuilder().setURL(interaction.user.displayAvatarURL({ size: 256 }))))
      .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Large).setDivider(true))
      .addTextDisplayComponents(new TextDisplayBuilder().setContent([
        '**What you lose:**', `> Level ${user.level} → Level 1`, `> Wallet reset to ${fmt.coins(config.economy.startingBalance)}`,
        '', '**What you gain:**', `> Prestige ${next} badge`, `> +${bonusPct}% permanent earnings bonus`,
      ].join('\n')));
    container.addActionRowComponents(
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId(`prestige_confirm:${interaction.user.id}`).setLabel(`Prestige ${next}`).setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId('prestige_cancel').setLabel('Cancel').setStyle(ButtonStyle.Secondary),
      ),
    );
    const msg = await interaction.editReply({ components: [container] });
    const collector = (msg as { createMessageComponentCollector: (opts: { filter: (i: { user: { id: string }; customId: string }) => boolean; time: number; max: number }) => { on: (e: string, cb: (i: { customId: string; update: (opts: unknown) => Promise<void> }) => void) => void } }).createMessageComponentCollector({
      filter: (i) => i.user.id === interaction.user.id, time: 30_000, max: 1,
    });
    collector.on('collect', async (i) => {
      if (i.customId.startsWith('prestige_confirm')) {
        const newPrestige = await UserManager.prestige(interaction.user.id);
        if (!newPrestige) { await i.update({ ...CB.errorResponse('Failed', 'Prestige failed unexpectedly.'), components: [] }); return; }
        const result = new ContainerBuilder()
          .addSectionComponents(new SectionBuilder().addTextDisplayComponents(
            new TextDisplayBuilder().setContent([`# Prestige ${newPrestige} Achieved!`, `${interaction.user} has been reborn!`].join('\n'))
          ).setThumbnailAccessory(new ThumbnailBuilder().setURL(interaction.user.displayAvatarURL({ size: 256 }))))
          .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Large).setDivider(true))
          .addTextDisplayComponents(new TextDisplayBuilder().setContent([
            `${E.PRESTIGE} **Prestige Level:** ${newPrestige}`, `${E.LIGHTNING} **Bonus:** +${bonusPct}% earnings`,
            `${E.COINS} **Wallet:** ${fmt.coins(config.economy.startingBalance)}`, `${E.LEVEL} **Level:** 1`,
          ].join('\n')));
        await i.update({ components: [result] });
      } else {
        await i.update({ ...CB.successResponse('Cancelled', 'Prestige cancelled. Keep grinding!'), components: [] });
      }
    });
  },
});
