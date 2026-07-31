/**
 * @file SocialCommandFactory.ts
 * @description Factory that generates the roleplay / social action commands.
 *
 * Fixes applied here:
 * - Every command used to be created with an empty emoji string, which produced
 *   slash descriptions that began with a space (" Hug someone!") and headings
 *   that rendered as "#  Hug!".
 * - The footer pluralised by appending "s" to the verb, giving "kisss" and
 *   "crys".
 * - `dance` and `cry` are solo actions but the target user was `required: true`,
 *   so `/dance` on its own was rejected and the only way to use them was to
 *   aim them at somebody else.
 * - A self-target incremented both the "sent" and "received" counters for the
 *   same person, double counting.
 */

import {
  SlashCommandBuilder, MessageFlags, ContainerBuilder, SectionBuilder,
  TextDisplayBuilder, SeparatorBuilder, SeparatorSpacingSize, ThumbnailBuilder,
} from 'discord.js';
import { Command }  from '../structures/Command';
import GifService   from '../services/GifService';
import UserManager  from '../managers/UserManager';
import { getStore } from '../database/JsonStore';
import * as CB      from '../builders/ComponentBuilder';

const socialDB = getStore('social');

export interface SocialActionOptions {
  /** Command name, also the default GIF endpoint. */
  action: string;
  emoji: string;
  /** Past tense used with a target: "hugged", "waved at". */
  pastTense: string;
  /** Noun plural for the counters: "hugs", "kisses". */
  plural: string;
  /**
   * Present-tense phrasing for a solo use ("is dancing"). Supplying this makes
   * the target optional — the action reads naturally on its own.
   */
  soloText?: string;
  category?: string;
}

function titleCase(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function createSocialCommand(opts: SocialActionOptions): Command {
  const { action, emoji, pastTense, plural, soloText, category = 'social' } = opts;
  const solo = Boolean(soloText);
  const label = titleCase(action);

  const builder = new SlashCommandBuilder()
    .setName(action)
    .setDescription(
      solo
        ? `${label} — on your own or aimed at someone.`
        : `${label} someone!`,
    )
    .addUserOption((o) =>
      o.setName('user')
        .setDescription(solo ? `Who do you want to ${action} with? (optional)` : `Who do you want to ${action}?`)
        // Solo actions must not force a target.
        .setRequired(!solo),
    )
    .addStringOption((o) =>
      o.setName('message').setDescription('Optional message').setMaxLength(200),
    );

  return new Command({
    data: builder,
    category,
    cooldown: 3000,

    async execute(interaction) {
      await interaction.deferReply({ flags: MessageFlags.IsComponentsV2 as any });

      const target  = interaction.options.getUser('user');
      const message = interaction.options.getString('message');

      // A solo-capable action with no target is valid; anything else needs one.
      if (!target && !solo) {
        return interaction.editReply({
          ...CB.errorResponse(
            'Missing User',
            `Tell me who to ${action}, e.g. \`/${action} @user\`.`,
          ),
        });
      }

      if (target && target.id === interaction.client.user.id) {
        return interaction.editReply({
          ...CB.errorResponse('Nice Try!', `You can't ${action} me! I'm just a bot.`),
        });
      }

      const selfAction = Boolean(target) && target!.id === interaction.user.id;
      const soloMode   = !target;

      const gifUrl = await GifService.getGif(action);

      // ── Counters ──────────────────────────────────────────────────────────
      // Only credit "received" to a different person; a self-action used to
      // bump both counters for the same user.
      const senderKey = `${interaction.user.id}.${action}.sent`;
      await socialDB.ensure(`${interaction.user.id}`, {});
      await socialDB.ensure(senderKey, 0);
      const sentCount = await socialDB.add(senderKey, 1);

      let receivedCount: number | null = null;
      if (target && !selfAction) {
        const targetKey = `${target.id}.${action}.received`;
        await socialDB.ensure(`${target.id}`, {});
        await socialDB.ensure(targetKey, 0);
        receivedCount = await socialDB.add(targetKey, 1);
      }

      await UserManager.recordSocialAction(interaction.user.id, target?.id ?? interaction.user.id, action);
      await UserManager.checkAchievements(interaction.user.id);

      // ── Text ──────────────────────────────────────────────────────────────
      const mainText = soloMode
        ? `${interaction.user} ${soloText} ${emoji}`
        : selfAction
          ? `${interaction.user} ${pastTense} themselves ${emoji}`
          : `${interaction.user} ${pastTense} ${target} ${emoji}`;

      // The thumbnail shows whoever the action lands on.
      const thumbUser = target ?? interaction.user;

      const container = new ContainerBuilder()
        .addSectionComponents(
          new SectionBuilder()
            .addTextDisplayComponents(
              new TextDisplayBuilder().setContent([
                `# ${emoji} ${label}!`,
                mainText,
                message ? `\n> *${message}*` : '',
              ].filter(Boolean).join('\n')),
            )
            .setThumbnailAccessory(new ThumbnailBuilder().setURL(thumbUser.displayAvatarURL({ size: 256 }))),
        );

      // Components V2 never renders a bare `files` attachment inline — the GIF
      // has to go through a MediaGallery component to show up at all.
      if (gifUrl) container.addMediaGalleryComponents(CB.gallery(gifUrl));

      const footer = soloMode
        ? `-# ${interaction.user.username} has ${pastTense.replace(/ (at|with)$/, '')} **${sentCount}** times`
        : selfAction
          ? `-# ${interaction.user.username} has sent **${sentCount}** ${plural} — this one to themselves`
          : `-# ${interaction.user.username} has sent **${sentCount}** ${plural} • ${target!.username} has received **${receivedCount}**`;

      container
        .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true))
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(footer));

      await interaction.editReply({ components: [container] } as Parameters<typeof interaction.editReply>[0]);
    },
  });
}
