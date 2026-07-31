/**
 * @file navigation.ts
 * @description Handles nav_ prefixed buttons (nav_balance, nav_shop, etc.)
 */

import {
  MessageFlags, ContainerBuilder, SectionBuilder, TextDisplayBuilder,
  SeparatorBuilder, SeparatorSpacingSize, ThumbnailBuilder,
  type ButtonInteraction, type Client,
} from 'discord.js';
import UserManager from '../../managers/UserManager';
import fmt         from '../../utils/Formatter';
import ProgressBar from '../../utils/ProgressBar';
import config      from '../../config/config';
import { EMOJI as E } from '../../utils/Constants';

export const customId = 'nav_:*';

export async function execute(interaction: ButtonInteraction, _client: Client): Promise<void> {
  const rawId = interaction.customId;

  // These buttons EDIT the original message. When a customId carries an owner
  // id (`nav_balance:<userId>`) only that user may use it — otherwise anyone
  // could click someone else's /daily message and overwrite it with their own
  // balance.
  const ownerId = rawId.includes(':') ? rawId.split(':')[1] : null;
  if (ownerId && ownerId !== interaction.user.id) {
    await interaction.reply({
      content: 'This button belongs to someone else — run the command yourself to get your own.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (rawId === 'nav_balance' || rawId.startsWith('nav_balance:')) {
    await interaction.deferUpdate();
    const eco      = await UserManager.getEconomy(interaction.user.id);
    const user     = await UserManager.getUser(interaction.user.id, interaction.guild?.id);
    // XP needed to advance FROM the current level (see UserManager.xpNeeded).
    const xpNeeded = UserManager.xpNeeded(user.level);
    const xpBar    = ProgressBar.create(user.xp, xpNeeded, 12);

    const container = new ContainerBuilder()
      .addSectionComponents(
        new SectionBuilder().addTextDisplayComponents(
          new TextDisplayBuilder().setContent([
            `# ${E.COINS} Your Balance`,
            `*Quick view*`,
          ].join('\n'))
        ).setThumbnailAccessory(new ThumbnailBuilder().setURL(interaction.user.displayAvatarURL({ size: 256 })))
      )
      .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Large).setDivider(true))
      .addTextDisplayComponents(new TextDisplayBuilder().setContent([
        `${E.WALLET} **Wallet:** ${fmt.coins(eco.wallet)}`,
        `${E.BANK} **Bank:** ${fmt.coins(eco.bank)}`,
        `**Net Worth:** ${fmt.coins(eco.wallet + eco.bank)}`,
        '',
        `${E.LEVEL} **Level:** ${user.level} • ${E.XP} **XP:** ${fmt.number(user.xp)} / ${fmt.number(xpNeeded)}`,
        xpBar,
      ].join('\n')));

    await interaction.editReply({ components: [container] });
    return;
  }

  if (rawId === 'nav_shop' || rawId.startsWith('nav_shop:')) {
    await interaction.deferUpdate();
    const items = config.shop.items.slice(0, 8);
    const lines = items.map((i) => `**${i.name}** — ${fmt.coins(i.price)}`);

    const container = new ContainerBuilder()
      .addTextDisplayComponents(
          new TextDisplayBuilder().setContent([
            `# ${E.SHOP} Shop Preview`,
            `Use \`/shop\` for the full shop.`,
          ].join('\n'))
        )
      .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Large).setDivider(true))
      .addTextDisplayComponents(new TextDisplayBuilder().setContent(lines.join('\n')));

    await interaction.editReply({ components: [container] });
    return;
  }

  if (rawId === 'nav_home' || rawId.startsWith('nav_home:')) {
    await interaction.deferUpdate();
    const container = new ContainerBuilder()
      .addTextDisplayComponents(new TextDisplayBuilder().setContent(
        `# ${E.HOME} Home\nUse slash commands to interact with the bot. Try \`/help\` for a list of commands.`
      ));
    await interaction.editReply({ components: [container] });
    return;
  }

  if (rawId === 'nav_close' || rawId.startsWith('nav_close:')) {
    await interaction.deferUpdate();
    await interaction.deleteReply().catch(() => {});
    return;
  }

  // Unknown nav button — acknowledge silently
  await interaction.deferUpdate();
}
