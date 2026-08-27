/**
 * @file action.ts
 * @description /action — every roleplay action, including the ones without their
 * own command.
 *
 * Why this exists: Discord allows 100 global chat-input commands and rejects the
 * whole registration if that is exceeded (see utils/AutoDeploy). Giving all ~40
 * actions their own command would blow the cap, so the popular ones are
 * standalone and this covers the rest for the price of one slot.
 *
 * It renders through the same buildActionReply as the standalone commands, so an
 * action behaves identically however it is invoked.
 */

import {
  SlashCommandBuilder, MessageFlags,
  type ChatInputCommandInteraction, type AutocompleteInteraction,
} from 'discord.js';
import { Command } from '../../structures/Command';
import { buildActionReply } from '../../utils/SocialCommandFactory';
import { ACTIONS, getAction, actionNames } from '../../config/actions';
import * as CB from '../../builders/ComponentBuilder';

export default new Command({
  data: new SlashCommandBuilder()
    .setName('action')
    .setDescription('Any roleplay action — hug, punch, wink, facepalm and more.')
    .addStringOption((o) => o.setName('type')
      .setDescription('Which action')
      .setRequired(true)
      .setAutocomplete(true))
    .addUserOption((o) => o.setName('user')
      .setDescription('Who to aim it at (optional for solo actions like /action dance)'))
    .addStringOption((o) => o.setName('message')
      .setDescription('Optional message').setMaxLength(200)),
  category: 'social',
  aliases: ['react', 'roleplay', 'rp'],
  cooldown: 3000,

  async autocomplete(interaction: AutocompleteInteraction) {
    const typed = String(interaction.options.getFocused() ?? '').toLowerCase().trim();
    const matches = ACTIONS
      .filter((a) => !typed || a.name.startsWith(typed) || a.name.includes(typed))
      // Prefix matches first — typing "ki" should offer "kiss" before "tickle".
      .sort((a, b) => {
        const aStarts = a.name.startsWith(typed) ? 0 : 1;
        const bStarts = b.name.startsWith(typed) ? 0 : 1;
        return aStarts - bStarts || a.name.localeCompare(b.name);
      })
      // Discord rejects a response containing more than 25 choices outright.
      .slice(0, 25)
      .map((a) => ({
        name: `${a.emoji} ${a.name}${a.soloText ? ' (works solo)' : ''}`.slice(0, 100),
        value: a.name,
      }));
    await interaction.respond(matches).catch(() => {});
  },

  async execute(interaction: ChatInputCommandInteraction) {
    await interaction.deferReply({ flags: MessageFlags.IsComponentsV2 as never });

    const requested = interaction.options.getString('type');
    const action = getAction(requested);
    if (!action) {
      // Autocomplete suggests valid values but does not enforce them — a user can
      // submit free text, and the prefix router always does.
      const sample = actionNames().slice(0, 12).join('`, `');
      return interaction.editReply({
        ...CB.errorResponse(
          'Unknown Action',
          `There is no \`${requested ?? ''}\` action.\nTry: \`${sample}\`… — ${actionNames().length} available in total.`,
        ),
      } as never);
    }

    const target = interaction.options.getUser('user');
    const solo = Boolean(action.soloText);

    if (!target && !solo) {
      return interaction.editReply({
        ...CB.errorResponse('Missing User', `\`${action.name}\` needs a target, e.g. \`/action ${action.name} @user\`.`),
      } as never);
    }
    if (target && target.id === interaction.client.user.id) {
      return interaction.editReply({
        ...CB.errorResponse('Nice Try!', `You can't ${action.name} me! I'm just a bot.`),
      } as never);
    }

    const payload = await buildActionReply({
      action,
      invoker: interaction.user,
      target,
      message: interaction.options.getString('message'),
    });
    await interaction.editReply(payload as never);
  },
});
