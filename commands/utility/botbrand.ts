import {
  SlashCommandBuilder, MessageFlags, ContainerBuilder, SectionBuilder,
  TextDisplayBuilder, SeparatorBuilder, SeparatorSpacingSize, ThumbnailBuilder,
  MediaGalleryBuilder, MediaGalleryItemBuilder, PermissionFlagsBits,
  type ChatInputCommandInteraction,
} from 'discord.js';
import { Command } from '../../structures/Command';
import * as CB from '../../builders/ComponentBuilder';
import { getStore } from '../../database/JsonStore';
import logger from '../../utils/Logger';

const guildsDB = getStore('guilds');

function isImageUrl(str: string): boolean {
  try { const u = new URL(str); return (u.protocol === 'http:' || u.protocol === 'https:') && /\.(png|jpe?g|gif|webp)(\?.*)?$/i.test(str); }
  catch { return false; }
}

export default new Command({
  data: new SlashCommandBuilder()
    .setName('botbrand').setDescription('Customise how the bot appears in this server.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand((s) => s.setName('view').setDescription('View current branding settings.'))
    .addSubcommand((s) => s.setName('nickname').setDescription('Set a custom nickname.').addStringOption((o) => o.setName('name').setDescription('Nickname (empty to reset)').setMaxLength(32)))
    .addSubcommand((s) => s.setName('avatar').setDescription('Set a custom avatar URL.').addStringOption((o) => o.setName('url').setDescription('Image URL (empty to reset)')))
    .addSubcommand((s) => s.setName('banner').setDescription('Set a banner image.').addStringOption((o) => o.setName('url').setDescription('Image URL (empty to reset)')))
    .addSubcommand((s) => s.setName('about').setDescription('Set an about description.').addStringOption((o) => o.setName('text').setDescription('About text (empty to reset)').setMaxLength(300)))
    .addSubcommand((s) => s.setName('reset').setDescription('Reset all branding settings.')),
  category: 'utility',
  async execute(interaction: ChatInputCommandInteraction) {
    await interaction.deferReply({ flags: MessageFlags.IsComponentsV2 as any });
    if (!interaction.guild) return interaction.editReply({ ...CB.errorResponse('Server Only', 'Use in a server.') } as never);
    const sub = (interaction.options as { getSubcommand: () => string }).getSubcommand();
    const guildId = interaction.guild.id;
    const branding = (await guildsDB.ensure(`${guildId}.branding`, { nickname: null, avatarUrl: null, bannerUrl: null, about: null })) as Record<string, string | null>;
    const botUser = interaction.client.user!;

    const buildView = () => {
      const displayName = branding.nickname ?? interaction.guild!.members.me?.displayName ?? botUser.username;
      const avatarUrl = branding.avatarUrl ?? botUser.displayAvatarURL({ size: 256 });
      const c = new ContainerBuilder()
        .addSectionComponents(new SectionBuilder().addTextDisplayComponents(
          new TextDisplayBuilder().setContent([`# Bot Branding — ${interaction.guild!.name}`, `Name: **${displayName}**`].join('\n'))
        ).setThumbnailAccessory(new ThumbnailBuilder().setURL(avatarUrl)))
        .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Large).setDivider(true))
        .addTextDisplayComponents(new TextDisplayBuilder().setContent([
          `**Nickname:** ${branding.nickname ?? '*not set*'}`,
          `**Avatar:** ${branding.avatarUrl ? `[link](${branding.avatarUrl})` : '*default*'}`,
          `**Banner:** ${branding.bannerUrl ? `[link](${branding.bannerUrl})` : '*not set*'}`,
          `**About:** ${branding.about ?? '*not set*'}`,
        ].join('\n')));
      if (branding.bannerUrl) c.addMediaGalleryComponents(new MediaGalleryBuilder().addItems(new MediaGalleryItemBuilder().setURL(branding.bannerUrl)));
      return c;
    };

    if (sub === 'view') return interaction.editReply({ components: [buildView()] });
    if (sub === 'nickname') {
      const name = (interaction.options.get('name')?.value as string) ?? null;
      try {
        await interaction.guild.members.me!.setNickname(name);
      } catch (e) {
        logger.warn('[botbrand] nickname:', (e as Error).message);
        return interaction.editReply({
          ...CB.errorResponse(
            'Nickname Change Failed',
            `Discord rejected the nickname change: ${(e as Error).message}. This is usually a missing **Change Nickname** permission, or my role being below the position Discord requires.`,
          ),
        } as never);
      }
      await guildsDB.set(`${guildId}.branding.nickname`, name);
      return interaction.editReply({ components: [buildView()] });
    }
    if (sub === 'avatar') {
      const url = (interaction.options.get('url')?.value as string) ?? null;
      if (url && !isImageUrl(url)) return interaction.editReply({ ...CB.errorResponse('Invalid URL', 'Provide a direct image URL.') } as never);
      branding.avatarUrl = url; await guildsDB.set(`${guildId}.branding.avatarUrl`, url);
      return interaction.editReply({ components: [buildView()] });
    }
    if (sub === 'banner') {
      const url = (interaction.options.get('url')?.value as string) ?? null;
      if (url && !isImageUrl(url)) return interaction.editReply({ ...CB.errorResponse('Invalid URL', 'Provide a direct image URL.') } as never);
      branding.bannerUrl = url; await guildsDB.set(`${guildId}.branding.bannerUrl`, url);
      return interaction.editReply({ components: [buildView()] });
    }
    if (sub === 'about') {
      const text = (interaction.options.get('text')?.value as string) ?? null;
      branding.about = text; await guildsDB.set(`${guildId}.branding.about`, text);
      return interaction.editReply({ components: [buildView()] });
    }
    if (sub === 'reset') {
      await guildsDB.set(`${guildId}.branding`, { nickname: null, avatarUrl: null, bannerUrl: null, about: null });
      try { await interaction.guild.members.me!.setNickname(null); } catch { /* ignore */ }
      return interaction.editReply({ components: [new ContainerBuilder().addTextDisplayComponents(new TextDisplayBuilder().setContent(' All branding reset.'))] });
    }
  },
});
