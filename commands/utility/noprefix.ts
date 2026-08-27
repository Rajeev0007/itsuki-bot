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

/**
 * Failure card.
 *
 * Was a byte-for-byte copy of `ok()`, so "Unknown Subcommand", "Cannot Add Bot"
 * and "Could Not Grant" rendered identically to a successful grant and the
 * operator could not tell whether the command had actually worked. The marker is
 * added here rather than by switching to CB.errorResponse because that helper
 * currently renders the same as CB.successResponse.
 */
function err(title: string, body: string) {
  return {
    flags: IS_V2,
    components: [
      new ContainerBuilder()
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(`# ⚠️ ${title}\n${body}`)),
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
        .addIntegerOption((o) =>
          o.setName('days').setDescription('Expire after N days (omit for permanent).')
            .setMinValue(1).setMaxValue(3650)
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
    // Ephemeral: `noprefix list` discloses who has been granted prefix-free
    // access, which is owner-only information.
    await interaction.deferReply({
      flags: (MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral) as never,
    });

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
      // Owners are covered by NoPrefixManager.has() itself, so there is
      // nothing to store. This used to be an error saying owners "always have
      // NoPrefix by default" while has() never actually checked for them —
      // owners were the only group who could never get the perk at all.
      if (config.owners.includes(target.id)) {
        return interaction.editReply(ok(
          'Already Covered',
          `**${target.tag ?? target.username}** is a bot owner, and owners always have NoPrefix — nothing to add.`,
        ) as never);
      }

      const days = interaction.options.getInteger('days');
      const result = await NoPrefixManager.add(target.id, target.username, {
        expiresAt: days ? Date.now() + days * 86_400_000 : null,
        source: 'manual',
        grantedBy: interaction.user.id,
      });

      if (!result.ok) {
        return interaction.editReply(err('Could Not Grant', result.reason!) as never);
      }

      const entry = result.entry!;
      return interaction.editReply(
        ok(
          result.extended ? 'NoPrefix Extended' : 'NoPrefix Granted',
          [
            `**${target.tag ?? target.username}** can now run commands without the \`${config.prefix}\` prefix.`,
            entry.expiresAt === null
              ? '**Expires:** never'
              : `**Expires:** <t:${Math.floor(entry.expiresAt / 1000)}:R>`,
            '',
            '**Two limits apply without a prefix**, so ordinary chat cannot fire commands:',
            '> Aliases shorter than 3 letters are ignored (`h`, `v`, `w`, `lb`…). They still work with the prefix.',
            '> A command that takes no arguments must be the whole message — `daily` runs, `daily routine` does not.',
            '',
            `-# Users with NoPrefix: ${NoPrefixManager.count()} (owners not counted)`,
          ].join('\n'),
        ) as never
      );
    }

    // ── Remove ───────────────────────────────────────────────────────────────
    if (sub === 'remove') {
      const target = interaction.options.getUser('user', true);
      const result = await NoPrefixManager.remove(target.id);
      if (!result.ok) {
        return interaction.editReply(err(
          result.reason === 'not-listed' ? 'Not on List' : 'Could Not Revoke',
          result.reason === 'not-listed'
            ? `**${target.tag ?? target.username}** does not have NoPrefix.`
              + (config.owners.includes(target.id)
                ? '\n-# They are a bot owner, so they keep it regardless — remove them from the owner list to change that.'
                : '')
            : result.reason!,
        ) as never);
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

      // Entries already arrive newest-first and expired ones are filtered out
      // by the manager.
      //
      // The list is capped: a Components V2 message allows 4000 characters
      // across all components, and an uncapped join() would throw on a long
      // list instead of rendering anything at all.
      const MAX_SHOWN = 25;
      const shown = entries.slice(0, MAX_SHOWN);

      const lines = shown.map((e, i) => {
        const expiry = e.expiresAt === null
          ? 'permanent'
          : `expires <t:${Math.floor(e.expiresAt / 1000)}:R>`;
        const origin = e.source === 'premium' ? ' · from premium' : '';
        return [
          `\`${String(i + 1).padStart(2, '0')}\` <@${e.userId}> — **${e.username}**`,
          `> added <t:${Math.floor(e.addedAt / 1000)}:R> · ${expiry}${origin}`,
        ].join('\n');
      });

      const footer = [
        `-# ${entries.length} user${entries.length !== 1 ? 's' : ''} with NoPrefix`
          + (entries.length > MAX_SHOWN ? ` (showing the ${MAX_SHOWN} newest)` : ''),
        '-# Bot owners are not listed — they always have it.',
      ].join('\n');

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
              new TextDisplayBuilder().setContent(footer)
            ),
        ],
      } as never);
    }
  },
});
