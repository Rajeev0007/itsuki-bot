/**
 * @file blacklist.ts
 * @description Owner-only command to manage the global user blacklist.
 * Blacklisted users cannot use the bot at all — no slash commands, no
 * prefix commands, no components.
 */

import {
  SlashCommandBuilder, MessageFlags,
  ContainerBuilder, TextDisplayBuilder,
  SeparatorBuilder, SeparatorSpacingSize,
  type ChatInputCommandInteraction,
} from 'discord.js';
import { Command }       from '../../structures/Command';
import BlacklistManager  from '../../managers/BlacklistManager';
import config            from '../../config/config';
import * as CB           from '../../builders/ComponentBuilder';

const IS_V2 = Number(MessageFlags.IsComponentsV2);
// `blacklist list` prints user IDs and the reasons they were blocked. That is
// owner-only information, but the reply was a normal channel message — readable
// by whoever happened to be in the channel the owner typed it in.
const V2_EPHEMERAL = Number(MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral);

export default new Command({
  data: new SlashCommandBuilder()
    .setName('blacklist')
    .setDescription('(Owner) Manage the global user blacklist.')
    .addSubcommand((s) =>
      s.setName('add')
        .setDescription('Block a user from using the bot entirely.')
        .addUserOption((o) => o.setName('user').setDescription('The user to blacklist.').setRequired(true))
        .addStringOption((o) => o.setName('reason').setDescription('Why this user is being blacklisted.').setRequired(false))
    )
    .addSubcommand((s) =>
      s.setName('remove')
        .setDescription('Unblock a user.')
        .addUserOption((o) => o.setName('user').setDescription('The user to unblacklist.').setRequired(true))
    )
    .addSubcommand((s) => s.setName('list').setDescription('Show all blacklisted users.')),

  category:  'owner',
  ownerOnly: true,
  aliases:   ['bl'],
  cooldown:  1000,

  async execute(interaction: ChatInputCommandInteraction) {
    await interaction.deferReply({ flags: V2_EPHEMERAL as never });
    const sub = interaction.options.getSubcommand();
    // Prefix users aren't restricted to the slash subcommand choices, so an
    // unrecognised value has to be rejected explicitly. Without this the
    // command fell through every branch and returned without ever editing its
    // deferred reply, leaving the message stuck on the loading placeholder.
    // NOTE: 'list' is handled by fall-through below rather than its own `if`,
    // so it must be listed here explicitly — omitting it made
    // `/blacklist list` reject itself as an unknown subcommand.
    const SUBCOMMANDS = ['add', 'remove', 'list'];
    if (!SUBCOMMANDS.includes(sub)) {
      return interaction.editReply({ ...CB.errorResponse(
        'Unknown Subcommand',
        `\`${sub}\` isn't valid here. Use one of: ${SUBCOMMANDS.map((s) => `\`${s}\``).join(', ')}.`,
      ) } as never);
    }


    if (sub === 'add') {
      const target = interaction.options.getUser('user', true);
      const reason = interaction.options.getString('reason') ?? 'No reason provided';

      if (target.bot) {
        return interaction.editReply(CB.errorResponse('Cannot Blacklist Bot', 'Bots cannot be blacklisted.') as never);
      }
      if (config.owners.includes(target.id)) {
        return interaction.editReply(CB.errorResponse('Cannot Blacklist Owner', 'Bot owners cannot be blacklisted.') as never);
      }

      const added = await BlacklistManager.add(target.id, reason, interaction.user.id);
      if (!added) {
        return interaction.editReply(
          CB.errorResponse('Already Blacklisted', `**${target.tag ?? target.username}** is already blacklisted.`) as never,
        );
      }

      return interaction.editReply(
        CB.successResponse(
          'User Blacklisted',
          `**${target.tag ?? target.username}** can no longer use any bot command.\n**Reason:** ${reason}\n\n` +
          `-# Total blacklisted: ${BlacklistManager.count()}`,
        ) as never,
      );
    }

    if (sub === 'remove') {
      const target  = interaction.options.getUser('user', true);
      const removed = await BlacklistManager.remove(target.id);
      if (!removed) {
        return interaction.editReply(
          CB.errorResponse('Not Blacklisted', `**${target.tag ?? target.username}** is not blacklisted.`) as never,
        );
      }
      return interaction.editReply(
        CB.successResponse(
          'User Unblacklisted',
          `**${target.tag ?? target.username}** can use the bot again.\n\n` +
          `-# Total blacklisted: ${BlacklistManager.count()}`,
        ) as never,
      );
    }

    // ── List ─────────────────────────────────────────────────────────────────
    const entries = BlacklistManager.list();

    if (entries.length === 0) {
      return interaction.editReply({
        flags: IS_V2 as never,
        components: [
          new ContainerBuilder().addTextDisplayComponents(
            new TextDisplayBuilder().setContent('# Blacklist\nNo users are currently blacklisted.'),
          ),
        ],
      } as never);
    }

    const lines = entries
      .sort((a, b) => b.addedAt - a.addedAt)
      .map((e, i) => {
        const date = new Date(e.addedAt).toLocaleDateString('en-GB');
        return `\`${String(i + 1).padStart(2, '0')}\` <@${e.userId}> — ${e.reason} • added ${date}`;
      });

    return interaction.editReply({
      flags: IS_V2 as never,
      components: [
        new ContainerBuilder()
          .addTextDisplayComponents(new TextDisplayBuilder().setContent('# Blacklist'))
          .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Large).setDivider(true))
          .addTextDisplayComponents(new TextDisplayBuilder().setContent(lines.join('\n')))
          .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true))
          .addTextDisplayComponents(
            new TextDisplayBuilder().setContent(`-# ${entries.length} user${entries.length !== 1 ? 's' : ''} blacklisted`),
          ),
      ],
    } as never);
  },
});
