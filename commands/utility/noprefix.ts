/**
 * @file noprefix.ts
 * @description Owner-only command to manage the NoPrefix premium list.
 *
 * Users on this list can run any bot command without the prefix —
 * just type the command name directly (e.g. "balance" instead of "!balance").
 *
 * Subcommands:
 * /noprefix add <user> — grants NoPrefix to a user
 * /noprefix remove <user> — revokes NoPrefix from a user
 * /noprefix list — shows all users with NoPrefix
 */

import {
  SlashCommandBuilder, MessageFlags,
  ContainerBuilder, TextDisplayBuilder,
  SeparatorBuilder, SeparatorSpacingSize,
  type ChatInputCommandInteraction,
} from 'discord.js';
import { Command } from '../../structures/Command';
import NoPrefixManager from '../../managers/NoPrefixManager';
import config from '../../config/config';

const IS_V2 = Number(MessageFlags.IsComponentsV2);

function ok(title: string, body: string) {
  return {
    flags: IS_V2,
    components: [
      new ContainerBuilder()
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(`# ${title}\n${body}`)),
    ],
  };
}

function err(title: string, body: string) {
  return {
    flags: IS_V2,
    components: [
      new ContainerBuilder()
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(`# ${title}\n${body}`)),
    ],
  };
}

export default new Command({
  data: new SlashCommandBuilder()
    .setName('noprefix')
    .setDescription('(Owner) Manage the NoPrefix premium list.')
    .addSubcommand((s) =>
      s.setName('add')
        .setDescription('Grant a user NoPrefix — they can run commands without the bot prefix.')
        .addUserOption((o) =>
          o.setName('user').setDescription('The user to grant NoPrefix to.').setRequired(true)
        )
    )
    .addSubcommand((s) =>
      s.setName('remove')
        .setDescription('Revoke NoPrefix from a user.')
        .addUserOption((o) =>
          o.setName('user').setDescription('The user to revoke NoPrefix from.').setRequired(true)
        )
    )
    .addSubcommand((s) =>
      s.setName('list')
        .setDescription('Show all users currently on the NoPrefix list.')
    ),

  category: 'utility',
  ownerOnly: true,
  aliases: ['np', 'nopfx'],
  cooldown: 1000,

  async execute(interaction: ChatInputCommandInteraction) {
    await interaction.deferReply({ flags: MessageFlags.IsComponentsV2 as never });

    const sub = interaction.options.getSubcommand();
    // Prefix users aren't restricted to the slash subcommand choices, so an
    // unrecognised value has to be rejected explicitly. Without this the
    // command fell through every branch and returned without ever editing its
    // deferred reply, leaving the message stuck on the loading placeholder.
    const SUBCOMMANDS = ['add', 'remove', 'list'];
    if (!SUBCOMMANDS.includes(sub)) {
      return interaction.editReply(err(
        'Unknown Subcommand',
        `\`${sub}\` isn't valid here. Use one of: ${SUBCOMMANDS.map((s) => `\`${s}\``).join(', ')}.`,
      ) as never);
    }


    // ── Add ─────────────────────────────────────────────────────────────────
    if (sub === 'add') {
      const target = interaction.options.getUser('user', true);
      if (target.bot) {
        return interaction.editReply(err('Cannot Add Bot', 'Bots cannot be granted NoPrefix.') as never);
      }
      if (config.owners.includes(target.id)) {
        return interaction.editReply(err('Already an Owner', 'Bot owners always have NoPrefix by default.') as never);
      }

      const added = await NoPrefixManager.add(target.id, target.username);
      if (!added) {
        return interaction.editReply(
          err('Already on List', `**${target.tag ?? target.username}** already has NoPrefix.`) as never
        );
      }

      return interaction.editReply(
        ok(
          'NoPrefix Granted',
          `**${target.tag ?? target.username}** can now run commands without the \`${config.prefix}\` prefix.\n\n` +
          `-# Total users with NoPrefix: ${NoPrefixManager.count()}`,
        ) as never
      );
    }

    // ── Remove ───────────────────────────────────────────────────────────────
    if (sub === 'remove') {
      const target = interaction.options.getUser('user', true);
      const removed = await NoPrefixManager.remove(target.id);
      if (!removed) {
        return interaction.editReply(
          err('Not on List', `**${target.tag ?? target.username}** does not have NoPrefix.`) as never
        );
      }

      return interaction.editReply(
        ok(
          'NoPrefix Revoked',
          `**${target.tag ?? target.username}** must now use the \`${config.prefix}\` prefix.\n\n` +
          `-# Total users with NoPrefix: ${NoPrefixManager.count()}`,
        ) as never
      );
    }

    // ── List ─────────────────────────────────────────────────────────────────
    if (sub === 'list') {
      const entries = NoPrefixManager.list();

      if (entries.length === 0) {
        return interaction.editReply({
          flags: IS_V2 as never,
          components: [
            new ContainerBuilder()
              .addTextDisplayComponents(
                new TextDisplayBuilder().setContent(
                  `# NoPrefix List\nNo users have NoPrefix yet.\n\n` +
                  `-# Use \`/noprefix add @user\` to grant it.`
                )
              ),
          ],
        } as never);
      }

      const lines = entries
        .sort((a, b) => b.addedAt - a.addedAt)
        .map((e, i) => {
          const date = new Date(e.addedAt).toLocaleDateString('en-GB');
          return `\`${String(i + 1).padStart(2, '0')}\` <@${e.userId}> — **${e.username}** • added ${date}`;
        });

      return interaction.editReply({
        flags: IS_V2 as never,
        components: [
          new ContainerBuilder()
            .addTextDisplayComponents(
              new TextDisplayBuilder().setContent(`# NoPrefix List`)
            )
            .addSeparatorComponents(
              new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Large).setDivider(true)
            )
            .addTextDisplayComponents(
              new TextDisplayBuilder().setContent(lines.join('\n'))
            )
            .addSeparatorComponents(
              new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true)
            )
            .addTextDisplayComponents(
              new TextDisplayBuilder().setContent(
                `-# ${entries.length} user${entries.length !== 1 ? 's' : ''} with NoPrefix`
              )
            ),
        ],
      } as never);
    }
  },
});
