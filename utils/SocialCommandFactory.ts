/**
 * @file SocialCommandFactory.ts
 * @description Builds a roleplay command, and the shared reply every action uses.
 *
 * The action's wording, counters and — critically — its GIF category all come
 * from config/actions.ts. Nothing here infers the category from the command name,
 * which is what let /bonk quietly show a slap.
 *
 * `buildActionReply` is exported so /action renders through exactly the same path
 * as the standalone commands, rather than being a second implementation that can
 * drift.
 *
 * Earlier fixes kept: empty emoji no longer produces " Hug someone!" or "#  Hug!",
 * the footer no longer pluralises to "kisss"/"crys", solo actions do not force a
 * target, and a self-action no longer bumps both the sent and received counters.
 */

import {
  SlashCommandBuilder, MessageFlags, ContainerBuilder, SectionBuilder,
  TextDisplayBuilder, SeparatorBuilder, SeparatorSpacingSize, ThumbnailBuilder,
  type User,
} from 'discord.js';
import { Command }  from '../structures/Command';
import GifService   from '../services/GifService';
import UserManager  from '../managers/UserManager';
import { getStore } from '../database/Store';
import { type ActionDef } from '../config/actions';
import * as CB      from '../builders/ComponentBuilder';
import logger       from '../utils/Logger';

const socialDB = getStore('social');

function titleCase(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export interface ActionReplyOptions {
  action: ActionDef;
  invoker: User;
  target: User | null;
  message?: string | null;
}

/**
 * Renders one action.
 *
 * Shared by the standalone commands and /action so both count, word and
 * illustrate an action identically.
 */
export async function buildActionReply(
  opts: ActionReplyOptions,
): Promise<{ components: ContainerBuilder[] }> {
  const { action, invoker, target, message } = opts;
  const label = titleCase(action.name);
  const solo = Boolean(action.soloText);

  const selfAction = Boolean(target) && target!.id === invoker.id;
  const soloMode = !target;

  // The category and its declared substitutes are passed explicitly — the service
  // never guesses which GIF belongs to this action.
  const gif = await GifService.resolve(action.category, action.fallbacks ?? []);
  if (!gif.url) {
    logger.debug(`[actions] No GIF for "${action.name}" (category "${action.category}").`);
  }

  /* ── Counters ────────────────────────────────────────────────────────────── */
  // Only credit "received" to a different person; a self-action used to bump both
  // counters for the same user.
  const senderKey = `${invoker.id}.${action.name}.sent`;
  await socialDB.ensure(`${invoker.id}`, {});
  await socialDB.ensure(senderKey, 0);
  const sentCount = await socialDB.add(senderKey, 1);

  let receivedCount: number | null = null;
  if (target && !selfAction) {
    const targetKey = `${target.id}.${action.name}.received`;
    await socialDB.ensure(`${target.id}`, {});
    await socialDB.ensure(targetKey, 0);
    receivedCount = await socialDB.add(targetKey, 1);
  }

  await UserManager.recordSocialAction(invoker.id, target?.id ?? invoker.id, action.name);
  await UserManager.checkAchievements(invoker.id);

  /* ── Text ────────────────────────────────────────────────────────────────── */
  const mainText = soloMode && solo
    ? `${invoker} ${action.soloText} ${action.emoji}`
    : selfAction
      ? `${invoker} ${action.pastTense} themselves ${action.emoji}`
      : `${invoker} ${action.pastTense} ${target} ${action.emoji}`;

  // The thumbnail shows whoever the action lands on.
  const thumbUser = target ?? invoker;

  const container = new ContainerBuilder()
    .addSectionComponents(
      new SectionBuilder()
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent([
            `# ${action.emoji} ${label}!`,
            mainText,
            message ? `\n> *${message}*` : '',
          ].filter(Boolean).join('\n')),
        )
        .setThumbnailAccessory(new ThumbnailBuilder().setURL(thumbUser.displayAvatarURL({ size: 256 }))),
    );

  // Components V2 never renders a bare `files` attachment inline — the GIF has to
  // go through a MediaGallery component to show up at all.
  if (gif.url) container.addMediaGalleryComponents(CB.gallery(gif.url));

  const footerBits: string[] = [];
  if (soloMode && solo) {
    footerBits.push(`${invoker.username} has ${action.pastTense.replace(/ (at|with|to|of|around)$/, '')} **${sentCount}** times`);
  } else if (selfAction) {
    footerBits.push(`${invoker.username} has sent **${sentCount}** ${action.plural} — this one to themselves`);
  } else {
    footerBits.push(`${invoker.username} has sent **${sentCount}** ${action.plural}`);
    footerBits.push(`${target!.username} has received **${receivedCount}**`);
  }
  // Stated plainly when the GIF is not from this action's own category, so a
  // substitution is never passed off as the real thing.
  if (gif.substituted && gif.category) footerBits.push(`GIF from \`${gif.category}\``);
  if (!gif.url) footerBits.push('no GIF available right now');

  container
    .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true))
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(`-# ${footerBits.join(' • ')}`));

  return { components: [container] };
}

/** Builds the standalone slash command for an action. */
export function createSocialCommand(action: ActionDef): Command {
  const label = titleCase(action.name);
  const solo = Boolean(action.soloText);

  const builder = new SlashCommandBuilder()
    .setName(action.name)
    .setDescription(solo ? `${label} — on your own or aimed at someone.` : `${label} someone!`)
    .addUserOption((o) =>
      o.setName('user')
        .setDescription(solo ? `Who do you want to ${action.name} with? (optional)` : `Who do you want to ${action.name}?`)
        // Solo actions must not force a target.
        .setRequired(!solo))
    .addStringOption((o) => o.setName('message').setDescription('Optional message').setMaxLength(200));

  return new Command({
    data: builder,
    category: 'social',
    cooldown: 3000,

    async execute(interaction) {
      await interaction.deferReply({ flags: MessageFlags.IsComponentsV2 as never });

      const target = interaction.options.getUser('user');
      const message = interaction.options.getString('message');

      // A solo-capable action with no target is valid; anything else needs one.
      if (!target && !solo) {
        return interaction.editReply({
          ...CB.errorResponse('Missing User', `Tell me who to ${action.name}, e.g. \`/${action.name} @user\`.`),
        } as never);
      }
      if (target && target.id === interaction.client.user.id) {
        return interaction.editReply({
          ...CB.errorResponse('Nice Try!', `You can't ${action.name} me! I'm just a bot.`),
        } as never);
      }

      const payload = await buildActionReply({
        action, invoker: interaction.user, target, message,
      });
      await interaction.editReply(payload as never);
    },
  });
}
