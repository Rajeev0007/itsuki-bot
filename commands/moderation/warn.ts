import {
  SlashCommandBuilder, MessageFlags, PermissionFlagsBits, ContainerBuilder,
  TextDisplayBuilder, SeparatorBuilder, SeparatorSpacingSize,
  type ChatInputCommandInteraction,
} from 'discord.js';
import { Command } from '../../structures/Command';
import ModerationManager from '../../managers/ModerationManager';
import * as CB from '../../builders/ComponentBuilder';
import { resolveDisplayName } from '../../utils/UserResolver';

export default new Command({
  data: new SlashCommandBuilder()
    .setName('warn').setDescription('Warn a member, or review and clear warnings.')
    .addSubcommand((s) => s.setName('add').setDescription('Warn a member')
      .addUserOption((o) => o.setName('user').setDescription('Member to warn').setRequired(true))
      .addStringOption((o) => o.setName('reason').setDescription('Reason for the warning').setRequired(true).setMaxLength(400)))
    .addSubcommand((s) => s.setName('list').setDescription('List a member\'s warnings')
      .addUserOption((o) => o.setName('user').setDescription('Member to inspect').setRequired(true)))
    .addSubcommand((s) => s.setName('remove').setDescription('Remove one warning by its ID')
      .addUserOption((o) => o.setName('user').setDescription('Member').setRequired(true))
      .addStringOption((o) => o.setName('warn_id').setDescription('Warning ID (from /warn list)').setRequired(true)))
    .addSubcommand((s) => s.setName('clear').setDescription('Remove all warnings from a member')
      .addUserOption((o) => o.setName('user').setDescription('Member').setRequired(true)))
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers),
  category: 'moderation',
  guildOnly: true,
  permissions: ['ModerateMembers'],

  async execute(interaction: ChatInputCommandInteraction) {
    await interaction.deferReply({ flags: MessageFlags.IsComponentsV2 as never });

    const sub = (interaction.options as { getSubcommand: () => string }).getSubcommand();
    const SUBCOMMANDS = ['add', 'list', 'remove', 'clear'];
    if (!SUBCOMMANDS.includes(sub)) {
      return interaction.editReply({ ...CB.errorResponse(
        'Unknown Subcommand',
        `Use one of: ${SUBCOMMANDS.map((s) => `\`${s}\``).join(', ')}.`,
      ) } as never);
    }

    const target = interaction.options.getUser('user');
    if (!target) return interaction.editReply({ ...CB.errorResponse('Missing User', 'Specify a member.') } as never);

    const guild = interaction.guild!;

    if (sub === 'add') {
      const reason = interaction.options.getString('reason') ?? 'No reason provided';

      if (target.bot) {
        return interaction.editReply({ ...CB.errorResponse('Invalid Target', 'Bots cannot be warned.') } as never);
      }

      // A warning has no API side effect, but the hierarchy rules should still
      // hold — otherwise anyone with the permission could warn an admin.
      const member = guild.members.cache.get(target.id)
        ?? await guild.members.fetch(target.id).catch(() => null);
      if (member) {
        // canTarget, not canModerate('timeout'): a warning is a datastore write,
        // so requiring the bot to be *able to time the target out* blocked
        // warnings that have no API side effect at all.
        const denied = ModerationManager.canTarget(interaction.member as never, member, 'warn');
        if (denied) return interaction.editReply({ ...CB.errorResponse('Cannot Warn', denied) } as never);
      }

      const entry = await ModerationManager.addWarn(guild.id, target.id, interaction.user.id, reason);
      const total = (await ModerationManager.getWarns(guild.id, target.id)).length;

      const notified = await ModerationManager.notify(
        target, guild.name, 'warned', reason, `You now have **${total}** warning(s).`,
      );

      await ModerationManager.log(guild, {
        action: 'warn', target, moderator: interaction.user, reason,
        extra: [`**Warning ID:** \`${entry.id}\``, `**Total warnings:** ${total}`],
      });

      return interaction.editReply({ ...CB.successResponse(
        'Member Warned',
        [
          `**${target.username}** has been warned.`,
          `**Reason:** ${reason}`,
          `**Warning ID:** \`${entry.id}\` • **Total:** ${total}`,
          notified ? '' : '-# Could not DM them (DMs closed).',
        ].filter(Boolean).join('\n'),
      ) } as never);
    }

    if (sub === 'list') {
      const warns = await ModerationManager.getWarns(guild.id, target.id);
      if (!warns.length) {
        return interaction.editReply({ ...CB.successResponse('No Warnings', `**${target.username}** has a clean record.`) } as never);
      }

      // Show the most recent first, capped so the message can't exceed limits.
      const recent = [...warns].reverse().slice(0, 15);
      const lines = await Promise.all(recent.map(async (w, i) => {
        const modName = await resolveDisplayName(w.moderatorId, { guild, client: interaction.client });
        return [
          `**${i + 1}.** \`${w.id}\` — <t:${Math.floor(w.timestamp / 1000)}:R>`,
          `> ${w.reason}`,
          `> -# by ${modName}`,
        ].join('\n');
      }));

      const c = new ContainerBuilder()
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(
          `# Warnings — ${target.username}\n**${warns.length}** total`,
        ))
        .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Large).setDivider(true))
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(lines.join('\n\n')));

      if (warns.length > recent.length) {
        c.addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true))
          .addTextDisplayComponents(new TextDisplayBuilder().setContent(
            `-# Showing the ${recent.length} most recent of ${warns.length}.`,
          ));
      }
      return interaction.editReply({ components: [c] });
    }

    if (sub === 'remove') {
      const warnId = (interaction.options.getString('warn_id') ?? '').trim();
      const removed = await ModerationManager.removeWarn(guild.id, target.id, warnId);
      if (!removed) {
        return interaction.editReply({ ...CB.errorResponse(
          'Not Found',
          `No warning with ID \`${warnId}\` for **${target.username}**. Run \`/warn list\` to see valid IDs.`,
        ) } as never);
      }
      const total = (await ModerationManager.getWarns(guild.id, target.id)).length;
      await ModerationManager.log(guild, {
        action: 'clearwarns', target, moderator: interaction.user,
        reason: `Removed warning ${warnId}`, extra: [`**Remaining:** ${total}`],
      });
      return interaction.editReply({ ...CB.successResponse(
        'Warning Removed',
        `Removed \`${warnId}\` from **${target.username}**. **${total}** remaining.`,
      ) } as never);
    }

    // clear
    const cleared = await ModerationManager.clearWarns(guild.id, target.id);
    if (!cleared) {
      return interaction.editReply({ ...CB.errorResponse('Nothing to Clear', `**${target.username}** has no warnings.`) } as never);
    }
    await ModerationManager.log(guild, {
      action: 'clearwarns', target, moderator: interaction.user,
      reason: `Cleared all ${cleared} warning(s)`,
    });
    return interaction.editReply({ ...CB.successResponse(
      'Warnings Cleared',
      `Removed all **${cleared}** warning(s) from **${target.username}**.`,
    ) } as never);
  },
});
