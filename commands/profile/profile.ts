import {
  SlashCommandBuilder, MessageFlags, AttachmentBuilder, ContainerBuilder,
  MediaGalleryBuilder, MediaGalleryItemBuilder, TextDisplayBuilder,
  SeparatorBuilder, SeparatorSpacingSize, type ChatInputCommandInteraction,
} from 'discord.js';
import { Command }            from '../../structures/Command';
import UserManager            from '../../managers/UserManager';
import { generateProfile }    from '../../services/ProfileCanvas';

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
    const pngBuffer = await generateProfile({
      username: target.username, avatarURL: target.displayAvatarURL({ extension: 'png', size: 256 }),
      level: user.level, xp: user.xp, xpNeeded, prestige: user.prestige ?? 0,
      wallet: eco.wallet, bank: eco.bank, gamesWon: user.stats?.gamesWon ?? 0,
      gamesPlayed: user.stats?.gamesPlayed ?? 0, title: user.title ?? 'Newcomer', memberSince: user.createdAt,
    });
    const attachment = new AttachmentBuilder(pngBuffer, { name: 'profile.png' });
    const c = new ContainerBuilder()
      .addMediaGalleryComponents(new MediaGalleryBuilder().addItems(new MediaGalleryItemBuilder().setURL('attachment://profile.png')))
      .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(false))
      .addTextDisplayComponents(new TextDisplayBuilder().setContent(target.id === interaction.user.id ? '-# Your profile card' : `-# ${target.username}'s profile`));
    await interaction.editReply({ files: [attachment], components: [c] });
  },
});
