import {
  SlashCommandBuilder, MessageFlags, AttachmentBuilder, ContainerBuilder,
  MediaGalleryBuilder, MediaGalleryItemBuilder, TextDisplayBuilder,
  SeparatorBuilder, SeparatorSpacingSize, type ChatInputCommandInteraction,
} from 'discord.js';
import { Command }            from '../../structures/Command';
import UserManager            from '../../managers/UserManager';
import { generateProfile }    from '../../services/ProfileCanvas';
import fmt                    from '../../utils/Formatter';
import ProgressBar            from '../../utils/ProgressBar';
import logger                 from '../../utils/Logger';

export default new Command({
  data: new SlashCommandBuilder()
    .setName('profile').setDescription('View your profile card.')
    .addUserOption((o) => o.setName('user').setDescription('User to view')),
  category: 'profile', cooldown: 5000,
  async execute(interaction: ChatInputCommandInteraction) {
    await interaction.deferReply({ flags: MessageFlags.IsComponentsV2 as any });
    const target = interaction.options.get('user')?.user ?? interaction.user;
    const [user, eco] = await Promise.all([UserManager.getUser(target.id, interaction.guild?.id), UserManager.getEconomy(target.id)]);
    // xpNeeded(level) is the XP required to go FROM this level to the next.
    // Passing level + 1 showed the *following* level's requirement, so the bar
    // never filled at the point the user actually levelled up.
    const xpNeeded = UserManager.xpNeeded(user.level);

    // `canvas` is a native module — if it failed to build, or an avatar fetch
    // times out, generateProfile throws. Rather than turning the whole command
    // into "An error occurred", fall back to a text card that shows the same
    // information.
    let pngBuffer: Buffer | null = null;
    try {
      pngBuffer = await generateProfile({
        username: target.username, avatarURL: target.displayAvatarURL({ extension: 'png', size: 256 }),
        level: user.level, xp: user.xp, xpNeeded, prestige: user.prestige ?? 0,
        wallet: eco.wallet, bank: eco.bank, gamesWon: user.stats?.gamesWon ?? 0,
        gamesPlayed: user.stats?.gamesPlayed ?? 0, title: user.title ?? 'Newcomer', memberSince: user.createdAt,
      });
    } catch (err) {
      logger.warn(`[profile] Card render failed, using text fallback: ${(err as Error).message}`);
    }

    if (!pngBuffer) {
      const winRate = (user.stats?.gamesPlayed ?? 0) > 0
        ? Math.round(((user.stats?.gamesWon ?? 0) / (user.stats!.gamesPlayed)) * 100)
        : 0;
      const textCard = new ContainerBuilder()
        .addTextDisplayComponents(new TextDisplayBuilder().setContent([
          `# ${target.username}`,
          `*${user.title ?? 'Newcomer'}*${user.prestige ? ` • Prestige ${user.prestige}` : ''}`,
        ].join('\n')))
        .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Large).setDivider(true))
        .addTextDisplayComponents(new TextDisplayBuilder().setContent([
          `**Level:** ${user.level} — ${fmt.number(user.xp)} / ${fmt.number(xpNeeded)} XP`,
          ProgressBar.create(user.xp, xpNeeded, 14),
          '',
          `**Wallet:** ${fmt.coins(eco.wallet)}`,
          `**Bank:** ${fmt.coins(eco.bank)}`,
          `**Games:** ${fmt.number(user.stats?.gamesWon ?? 0)} won / ${fmt.number(user.stats?.gamesPlayed ?? 0)} played (${winRate}%)`,
        ].join('\n')))
        .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true))
        .addTextDisplayComponents(new TextDisplayBuilder().setContent('-# Image card unavailable — showing text instead.'));
      return interaction.editReply({ components: [textCard] });
    }

    const attachment = new AttachmentBuilder(pngBuffer, { name: 'profile.png' });
    const c = new ContainerBuilder()
      .addMediaGalleryComponents(new MediaGalleryBuilder().addItems(new MediaGalleryItemBuilder().setURL('attachment://profile.png')))
      .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(false))
      .addTextDisplayComponents(new TextDisplayBuilder().setContent(target.id === interaction.user.id ? '-# Your profile card' : `-# ${target.username}'s profile`));
    await interaction.editReply({ files: [attachment], components: [c] });
  },
});
