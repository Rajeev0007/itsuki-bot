/**
 * @file SocialCommandFactory.ts
 * @description Factory that generates social action slash commands.
 */

import {
  SlashCommandBuilder, MessageFlags, ContainerBuilder, SectionBuilder,
  TextDisplayBuilder, SeparatorBuilder, SeparatorSpacingSize,
  ActionRowBuilder, ButtonBuilder, ButtonStyle, ThumbnailBuilder,
} from 'discord.js';
import { Command }  from '../structures/Command';
import GifService   from '../services/GifService';
import UserManager  from '../managers/UserManager';
import { getStore } from '../database/JsonStore';
import * as CB      from '../builders/ComponentBuilder';

const socialDB = getStore('social');

export function createSocialCommand(
  action:    string,
  emoji:     string,
  pastTense: string,
  category  = 'social',
): Command {
  return new Command({
    data: new SlashCommandBuilder()
      .setName(action)
      .setDescription(`${emoji} ${action.charAt(0).toUpperCase() + action.slice(1)} someone!`)
      .addUserOption((o) =>
        o.setName('user').setDescription(`Who do you want to ${action}?`).setRequired(true)
      )
      .addStringOption((o) =>
        o.setName('message').setDescription('Optional message').setMaxLength(200)
      ),
    category,
    cooldown: 3000,

    async execute(interaction) {
      await interaction.deferReply({ flags: MessageFlags.IsComponentsV2 as any });
      const target  = interaction.options.getUser('user');
      const message = interaction.options.getString('message');

      // Silently returning left the command hanging on its "Working…"
      // placeholder forever when no user could be resolved.
      if (!target) {
        return interaction.editReply({
          ...CB.errorResponse('Missing User', `Mention someone to ${action}, e.g. \`${action} @user\`.`),
        });
      }

      if (target.id === interaction.client.user.id) {
        return interaction.editReply({
          ...CB.errorResponse('Nice Try!', `You can't ${action} me! I'm just a bot.`),
        });
      }

      const gifUrl = await GifService.getGif(action);

      const senderKey = `${interaction.user.id}.${action}.sent`;
      const targetKey = `${target.id}.${action}.received`;
      await socialDB.ensure(`${interaction.user.id}`, {});
      await socialDB.ensure(`${target.id}`, {});
      await socialDB.ensure(senderKey, 0);
      await socialDB.ensure(targetKey, 0);
      const sentCount     = await socialDB.add(senderKey, 1);
      const receivedCount = await socialDB.add(targetKey, 1);

      // Nothing used to call this, so actions.json stayed empty, the
      // `socialActions` stat never moved, and the "Social Butterfly"
      // achievement (100 social actions) was impossible to earn.
      await UserManager.recordSocialAction(interaction.user.id, target.id, action);
      await UserManager.checkAchievements(interaction.user.id);

      const selfAction = target.id === interaction.user.id;
      const mainText   = selfAction
        ? `**${interaction.user}** ${pastTense} themselves ${emoji}`
        : `**${interaction.user}** ${pastTense} **${target}** ${emoji}`;

      const container = new ContainerBuilder()
        .addSectionComponents(
          new SectionBuilder()
            .addTextDisplayComponents(
              new TextDisplayBuilder().setContent([
                `# ${emoji} ${action.charAt(0).toUpperCase() + action.slice(1)}!`,
                mainText,
                message ? `\n> *${message}*` : '',
              ].filter(Boolean).join('\n'))
            )
            .setThumbnailAccessory(new ThumbnailBuilder().setURL(target.displayAvatarURL({ size: 256 })))
        );

      // Components V2 never renders a plain `files` attachment inline — it
      // has to be wired into a MediaGallery component to actually show up.
      if (gifUrl) {
        container.addMediaGalleryComponents(CB.gallery(gifUrl));
      }

      container
        .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true))
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent(
            `-# ${interaction.user.username} has ${pastTense} ${selfAction ? 'themselves' : target.username} **${sentCount}** times • ${target.username} received **${receivedCount}** ${action}s`
          )
        );

      await interaction.editReply({ components: [container] } as Parameters<typeof interaction.editReply>[0]);
    },
  });
}
