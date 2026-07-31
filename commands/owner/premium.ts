import {
  SlashCommandBuilder, MessageFlags, ContainerBuilder, TextDisplayBuilder,
  SeparatorBuilder, SeparatorSpacingSize,
  type ChatInputCommandInteraction,
} from 'discord.js';
import { Command } from '../../structures/Command';
import PremiumManager, { TIERS, type PremiumTier } from '../../managers/PremiumManager';
import * as CB from '../../builders/ComponentBuilder';
import fmt from '../../utils/Formatter';
import { resolveDisplayName } from '../../utils/UserResolver';

export default new Command({
  data: new SlashCommandBuilder()
    .setName('premiumadmin').setDescription('(Owner) Grant or revoke premium.')
    .addSubcommand((s) => s.setName('grantuser').setDescription('Give a user premium')
      .addUserOption((o) => o.setName('user').setDescription('Recipient').setRequired(true))
      .addStringOption((o) => o.setName('tier').setDescription('Tier').setRequired(true)
        .addChoices({ name: 'Premium', value: 'basic' }, { name: 'Premium+', value: 'plus' }))
      .addIntegerOption((o) => o.setName('days').setDescription('Duration in days (omit for lifetime)').setMinValue(1).setMaxValue(3650))
      .addStringOption((o) => o.setName('note').setDescription('Internal note')))
    .addSubcommand((s) => s.setName('grantguild').setDescription('Give a server premium')
      .addStringOption((o) => o.setName('guild_id').setDescription('Server ID (omit for this server)'))
      .addStringOption((o) => o.setName('tier').setDescription('Tier')
        .addChoices({ name: 'Premium', value: 'basic' }, { name: 'Premium+', value: 'plus' }))
      .addIntegerOption((o) => o.setName('days').setDescription('Duration in days (omit for lifetime)').setMinValue(1).setMaxValue(3650)))
    .addSubcommand((s) => s.setName('revokeuser').setDescription('Remove a user\'s premium')
      .addUserOption((o) => o.setName('user').setDescription('User').setRequired(true)))
    .addSubcommand((s) => s.setName('revokeguild').setDescription('Remove a server\'s premium')
      .addStringOption((o) => o.setName('guild_id').setDescription('Server ID (omit for this server)')))
    .addSubcommand((s) => s.setName('list').setDescription('All active grants')),
  category: 'owner',
  ownerOnly: true,
  cooldown: 0,

  async execute(interaction: ChatInputCommandInteraction) {
    await interaction.deferReply({
      flags: (MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral) as never,
    });

    const sub = (interaction.options as { getSubcommand: () => string }).getSubcommand();
    const SUBCOMMANDS = ['grantuser', 'grantguild', 'revokeuser', 'revokeguild', 'list'];
    if (!SUBCOMMANDS.includes(sub)) {
      return interaction.editReply({ ...CB.errorResponse(
        'Unknown Subcommand', `Use one of: ${SUBCOMMANDS.map((s) => `\`${s}\``).join(', ')}.`,
      ) } as never);
    }

    const describe = (expiresAt: number | null) =>
      expiresAt === null ? '**lifetime**' : `until <t:${Math.floor(expiresAt / 1000)}:D>`;

    if (sub === 'list') {
      const { users, guilds } = await PremiumManager.listActive();
      if (!users.length && !guilds.length) {
        return interaction.editReply({ ...CB.successResponse('No Grants', 'Nobody has premium right now.') } as never);
      }

      const userLines = await Promise.all(users.slice(0, 20).map(async ([id, g]) => {
        const name = await resolveDisplayName(id, { guild: interaction.guild, client: interaction.client });
        return `> **${name}** — ${TIERS[g.tier].label}, ${describe(g.expiresAt)}`;
      }));
      const guildLines = guilds.slice(0, 20).map(([id, g]) => {
        const name = interaction.client.guilds.cache.get(id)?.name ?? id;
        return `> **${name}** — ${TIERS[g.tier].label}, ${describe(g.expiresAt)}`;
      });

      const c = new ContainerBuilder()
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(
          `# ⭐ Active Premium\n**${users.length}** user(s) · **${guilds.length}** server(s)`,
        ));
      if (userLines.length) {
        c.addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true))
          .addTextDisplayComponents(new TextDisplayBuilder().setContent(`**Users**\n${userLines.join('\n')}`));
      }
      if (guildLines.length) {
        c.addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true))
          .addTextDisplayComponents(new TextDisplayBuilder().setContent(`**Servers**\n${guildLines.join('\n')}`));
      }
      return interaction.editReply({ components: [c] });
    }

    if (sub === 'revokeuser') {
      const target = interaction.options.getUser('user');
      if (!target) return interaction.editReply({ ...CB.errorResponse('Missing User', 'Pick a user.') } as never);
      const had = await PremiumManager.revokeUser(target.id);
      return interaction.editReply({ ...(had
        ? CB.successResponse('Revoked', `**${target.username}** no longer has premium.`)
        : CB.errorResponse('Nothing to Revoke', `**${target.username}** had no premium grant.`)) } as never);
    }

    if (sub === 'revokeguild') {
      const guildId = (interaction.options.getString('guild_id') ?? interaction.guildId ?? '').trim();
      if (!/^\d{15,25}$/.test(guildId)) {
        return interaction.editReply({ ...CB.errorResponse('Invalid ID', 'Provide a numeric server ID, or run this in the server.') } as never);
      }
      const had = await PremiumManager.revokeGuild(guildId);
      return interaction.editReply({ ...(had
        ? CB.successResponse('Revoked', `Server \`${guildId}\` no longer has premium.`)
        : CB.errorResponse('Nothing to Revoke', `Server \`${guildId}\` had no premium grant.`)) } as never);
    }

    // ── grants ──────────────────────────────────────────────────────────────
    // Validate the raw string BEFORE narrowing. Casting first would assert a
    // type the runtime can't guarantee — a prefix invocation can pass anything.
    const rawTier = (interaction.options.getString('tier') ?? 'basic').trim().toLowerCase();
    if (rawTier !== 'basic' && rawTier !== 'plus') {
      return interaction.editReply({ ...CB.errorResponse(
        'Invalid Tier', 'Choose `basic` (Premium) or `plus` (Premium+).',
      ) } as never);
    }
    const tier: Exclude<PremiumTier, 'none'> = rawTier;
    // Absent means lifetime; getInteger returns null rather than 0.
    const days = interaction.options.getInteger('days');
    const perks = TIERS[tier];

    const perkLines = [
      `> Cooldowns at **${Math.round(perks.cooldownMultiplier * 100)}%**`,
      `> Earnings **×${perks.earningsMultiplier}**`,
      `> **+${perks.bonusRolls}** bonus card rolls`,
      `> **${perks.maxListings}** auction listings`,
      '> Bypasses vote-locked commands',
    ].join('\n');

    if (sub === 'grantuser') {
      const target = interaction.options.getUser('user');
      if (!target) return interaction.editReply({ ...CB.errorResponse('Missing User', 'Pick a user.') } as never);

      const grant = await PremiumManager.grantUser(
        target.id, tier, days, interaction.user.id,
        interaction.options.getString('note') ?? undefined,
      );
      return interaction.editReply({ ...CB.successResponse(
        `${perks.label} Granted`,
        [
          `**${target.username}** now has **${perks.label}** ${describe(grant.expiresAt)}.`,
          '',
          perkLines,
          days !== null ? '-# Renewing later extends the existing expiry rather than resetting it.' : '',
        ].filter(Boolean).join('\n'),
      ) } as never);
    }

    const guildId = (interaction.options.getString('guild_id') ?? interaction.guildId ?? '').trim();
    if (!/^\d{15,25}$/.test(guildId)) {
      return interaction.editReply({ ...CB.errorResponse('Invalid ID', 'Provide a numeric server ID, or run this in the server.') } as never);
    }

    const grant = await PremiumManager.grantGuild(guildId, tier, days, interaction.user.id);
    const guildName = interaction.client.guilds.cache.get(guildId)?.name ?? guildId;
    return interaction.editReply({ ...CB.successResponse(
      `${perks.label} Granted`,
      [
        `**${guildName}** now has **${perks.label}** ${describe(grant.expiresAt)}.`,
        '-# Applies to every member of that server.',
        '',
        perkLines,
      ].join('\n'),
    ) } as never);
  },
});
