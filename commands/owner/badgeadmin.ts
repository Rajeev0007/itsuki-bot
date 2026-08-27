/**
 * @file badgeadmin.ts
 * @description (Owner) Grants, revokes and inspects profile badges.
 *
 * Owner-only, so it is registered to the dev guild rather than globally and does
 * not consume one of the 100 global command slots — see utils/AutoDeploy.
 *
 * Only `manual` badges can be handed out. Automatic ones are derived from account
 * state on every profile render, so writing one by hand would be overwritten
 * silently; BadgeManager rejects that and this command surfaces the reason.
 */

import {
  SlashCommandBuilder, MessageFlags, ContainerBuilder, TextDisplayBuilder,
  SeparatorBuilder, SeparatorSpacingSize,
  type ChatInputCommandInteraction, type AutocompleteInteraction,
} from 'discord.js';
import { Command } from '../../structures/Command';
import BadgeManager from '../../managers/BadgeManager';
import { getBadge, manualBadges, automaticBadges } from '../../config/badges';
import * as CB from '../../builders/ComponentBuilder';
import { resolveDisplayName } from '../../utils/UserResolver';

const V2_EPHEMERAL = (MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral) as never;

export default new Command({
  data: new SlashCommandBuilder()
    .setName('badgeadmin').setDescription('(Owner) Manage profile badges.')
    .addSubcommand((s) => s.setName('grant').setDescription('Give a user a badge')
      .addUserOption((o) => o.setName('user').setDescription('Recipient').setRequired(true))
      .addStringOption((o) => o.setName('badge').setDescription('Badge to grant').setRequired(true).setAutocomplete(true)))
    .addSubcommand((s) => s.setName('revoke').setDescription('Take a badge away')
      .addUserOption((o) => o.setName('user').setDescription('User').setRequired(true))
      .addStringOption((o) => o.setName('badge').setDescription('Badge to revoke').setRequired(true).setAutocomplete(true)))
    .addSubcommand((s) => s.setName('clear').setDescription('Remove every granted badge from a user')
      .addUserOption((o) => o.setName('user').setDescription('User').setRequired(true)))
    .addSubcommand((s) => s.setName('view').setDescription("Show a user's badges")
      .addUserOption((o) => o.setName('user').setDescription('User').setRequired(true)))
    .addSubcommand((s) => s.setName('catalogue').setDescription('List every badge in the bot')),
  category: 'owner',
  ownerOnly: true,
  cooldown: 0,

  /** Autocomplete over grantable badges, so ids never have to be memorised. */
  async autocomplete(interaction: AutocompleteInteraction) {
    const typed = (interaction.options.getFocused() ?? '').toString().toLowerCase();
    const choices = manualBadges()
      .filter((b) => !typed || b.id.includes(typed) || b.name.toLowerCase().includes(typed))
      // Discord rejects a response with more than 25 choices outright.
      .slice(0, 25)
      .map((b) => ({ name: `${b.icon} ${b.name} (${b.id})`.slice(0, 100), value: b.id }));
    await interaction.respond(choices).catch(() => {});
  },

  async execute(interaction: ChatInputCommandInteraction) {
    await interaction.deferReply({ flags: V2_EPHEMERAL });

    const sub = (interaction.options as { getSubcommand: () => string }).getSubcommand();
    const SUBCOMMANDS = ['grant', 'revoke', 'clear', 'view', 'catalogue'];
    if (!SUBCOMMANDS.includes(sub)) {
      return interaction.editReply({ ...CB.errorResponse(
        'Unknown Subcommand', `Use one of: ${SUBCOMMANDS.map((s) => `\`${s}\``).join(', ')}.`,
      ) } as never);
    }

    /* ── catalogue ───────────────────────────────────────────────────────── */
    if (sub === 'catalogue') {
      const manual = manualBadges();
      const auto = automaticBadges();
      const container = new ContainerBuilder()
        .addTextDisplayComponents(new TextDisplayBuilder().setContent('# 🏅 Badge Catalogue'))
        .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true))
        .addTextDisplayComponents(new TextDisplayBuilder().setContent([
          `**Owner-granted** (${manual.length}) — use \`/badgeadmin grant\``,
          ...manual.map((b) => `> ${b.icon} **${b.name}** \`${b.id}\`\n> -# ${b.description}`),
        ].join('\n')))
        .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true))
        .addTextDisplayComponents(new TextDisplayBuilder().setContent([
          `**Earned automatically** (${auto.length}) — cannot be granted or revoked`,
          ...auto.map((b) => `> ${b.icon} **${b.name}** — -# ${b.description}`),
        ].join('\n')));
      return interaction.editReply({ components: [container] } as never);
    }

    const target = interaction.options.getUser('user', true);
    const name = await resolveDisplayName(target.id, {
      guild: interaction.guild, client: interaction.client,
    });

    /* ── view ────────────────────────────────────────────────────────────── */
    if (sub === 'view') {
      const [granted, all] = await Promise.all([
        BadgeManager.storedIds(target.id),
        BadgeManager.resolve(target.id),
      ]);
      const grantedSet = new Set(granted);
      if (!all.length) {
        return interaction.editReply({ ...CB.successResponse(
          'No Badges', `**${name}** has no badges yet.`,
        ) } as never);
      }
      const lines = all.map((b) =>
        `> ${b.icon} **${b.name}** — ${grantedSet.has(b.id) ? `granted \`${b.id}\`` : 'earned'}`);
      const container = new ContainerBuilder()
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(`# 🏅 ${name}'s Badges`))
        .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true))
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(lines.join('\n')))
        .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true))
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(
          `-# ${granted.length} granted · ${all.length - granted.length} earned automatically`,
        ));
      return interaction.editReply({ components: [container] } as never);
    }

    /* ── clear ───────────────────────────────────────────────────────────── */
    if (sub === 'clear') {
      const removed = await BadgeManager.clear(target.id);
      if (!removed) {
        return interaction.editReply({ ...CB.errorResponse(
          'Nothing to Clear', `**${name}** has no granted badges. Automatically earned ones cannot be removed.`,
        ) } as never);
      }
      return interaction.editReply({ ...CB.successResponse(
        'Badges Cleared',
        `Removed **${removed}** granted badge${removed === 1 ? '' : 's'} from **${name}**.\n`
        + '-# Automatically earned badges are unaffected.',
      ) } as never);
    }

    /* ── grant / revoke ──────────────────────────────────────────────────── */
    const badgeId = interaction.options.getString('badge', true).trim().toLowerCase();
    if (!getBadge(badgeId)) {
      return interaction.editReply({ ...CB.errorResponse(
        'Unknown Badge',
        `There is no badge with the id \`${badgeId}\`. Run \`/badgeadmin catalogue\` to see them all.`,
      ) } as never);
    }

    const result = sub === 'grant'
      ? await BadgeManager.grant(target.id, badgeId)
      : await BadgeManager.revoke(target.id, badgeId);

    if (!result.ok) {
      return interaction.editReply({ ...CB.errorResponse(
        sub === 'grant' ? 'Could Not Grant' : 'Could Not Revoke', result.reason,
      ) } as never);
    }

    return interaction.editReply({ ...CB.successResponse(
      sub === 'grant' ? 'Badge Granted' : 'Badge Revoked',
      [
        sub === 'grant'
          ? `${result.badge.icon} **${result.badge.name}** granted to **${name}**.`
          : `${result.badge.icon} **${result.badge.name}** removed from **${name}**.`,
        `-# ${result.badge.description}`,
        '-# It shows on their `/profile` card immediately.',
      ].join('\n'),
    ) } as never);
  },
});
