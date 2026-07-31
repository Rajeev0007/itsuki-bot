import {
  SlashCommandBuilder, MessageFlags,
  ContainerBuilder, TextDisplayBuilder, SeparatorBuilder, SeparatorSpacingSize,
  type ChatInputCommandInteraction,
} from 'discord.js';
import { Command } from '../../structures/Command';
import PremiumKeyManager, { type KeyTier } from '../../managers/PremiumKeyManager';
import * as CB from '../../builders/ComponentBuilder';
import config from '../../config/config';
import logger from '../../utils/Logger';

const fmtDuration = (days: number | null): string =>
  days === null ? 'lifetime' : `${days} day${days === 1 ? '' : 's'}`;

/**
 * Premium key generation and management.
 *
 * Keys are stored only as a SHA-256 hash, so a key is visible exactly once —
 * at generation — and is delivered by DM rather than shown in the channel.
 * That matters because this command also runs through the prefix router, where
 * there is no ephemeral reply and anything printed lands in public chat.
 */
export default new Command({
  data: new SlashCommandBuilder()
    .setName('premiumkey').setDescription('(Owner) Generate and manage premium keys.')
    .addSubcommand((s) => s.setName('generate').setDescription('Create a key and receive it by DM')
      .addStringOption((o) => o.setName('tier').setDescription('Which tier the key grants').setRequired(true)
        .addChoices({ name: 'Premium', value: 'basic' }, { name: 'Premium+', value: 'plus' }))
      .addIntegerOption((o) => o.setName('days').setDescription('Days of premium granted (0 = lifetime)')
        .setMinValue(0).setMaxValue(3650))
      .addIntegerOption((o) => o.setName('uses').setDescription('How many people can redeem it (default 1)')
        .setMinValue(1).setMaxValue(1000))
      .addIntegerOption((o) => o.setName('valid_days').setDescription('Key itself expires after N days (0 = never)')
        .setMinValue(0).setMaxValue(3650))
      .addStringOption((o) => o.setName('note').setDescription('Reminder of what this key is for')))
    .addSubcommand((s) => s.setName('list').setDescription('List generated keys'))
    .addSubcommand((s) => s.setName('info').setDescription('Details of one key')
      .addStringOption((o) => o.setName('id').setDescription('Key id').setRequired(true)))
    .addSubcommand((s) => s.setName('revoke').setDescription('Disable a key without deleting its history')
      .addStringOption((o) => o.setName('id').setDescription('Key id').setRequired(true)))
    .addSubcommand((s) => s.setName('delete').setDescription('Forget a key entirely')
      .addStringOption((o) => o.setName('id').setDescription('Key id').setRequired(true))),
  category: 'owner',
  ownerOnly: true,
  aliases: ['pkey', 'genkey'],
  cooldown: 2_000,

  async execute(interaction: ChatInputCommandInteraction) {
    await interaction.deferReply({
      flags: (MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral) as never,
    });

    const sub = (interaction.options as { getSubcommand: () => string }).getSubcommand();
    const SUBCOMMANDS = ['generate', 'list', 'info', 'revoke', 'delete'];
    if (!SUBCOMMANDS.includes(sub)) {
      return interaction.editReply({ ...CB.errorResponse(
        'Unknown Subcommand', `Use one of: ${SUBCOMMANDS.map((s) => `\`${s}\``).join(', ')}.`,
      ) } as never);
    }

    // ── generate ────────────────────────────────────────────────────────────
    if (sub === 'generate') {
      const tier = (interaction.options.getString('tier') === 'plus' ? 'plus' : 'basic') as KeyTier;
      const daysOpt = interaction.options.getInteger('days');
      // 0 means lifetime. An explicit sentinel avoids the "omitted or zero?"
      // ambiguity the prefix adapter would otherwise introduce.
      const days = daysOpt === null ? 30 : (daysOpt === 0 ? null : daysOpt);
      const uses = interaction.options.getInteger('uses') ?? 1;
      const validDays = interaction.options.getInteger('valid_days') ?? 0;
      const note = interaction.options.getString('note');

      const { key, record } = await PremiumKeyManager.generate({
        tier, days, maxUses: uses, validDays, createdBy: interaction.user.id, note,
      });

      const dm = [
        '## 🔑 Premium Key',
        '```',
        key,
        '```',
        `**Grants:** ${tier === 'plus' ? 'Premium+' : 'Premium'} for ${fmtDuration(days)}`,
        `**Redeemable by:** ${uses} ${uses === 1 ? 'person' : 'people'}`,
        `**Key expires:** ${record.validUntil === null ? 'never' : `<t:${Math.floor(record.validUntil / 1000)}:R>`}`,
        record.note ? `**Note:** ${record.note}` : '',
        `**Id:** \`${record.id}\` — use this to revoke it later.`,
        '',
        '-# This is the only time the key is shown. Only a hash is stored, so it',
        '-# cannot be recovered — if you lose it, revoke the id and make another.',
        `-# Redeem with \`/redeem code:${key}\``,
      ].filter(Boolean).join('\n');

      try {
        await interaction.user.send(dm);
      } catch (err) {
        // No point keeping a key nobody can ever see, so remove it rather than
        // leaving an unusable record behind.
        await PremiumKeyManager.delete(record.id);
        logger.warn(`[PremiumKey] DM to ${interaction.user.id} failed, key discarded: ${(err as Error).message}`);
        return interaction.editReply({ ...CB.errorResponse(
          'Could Not DM You',
          [
            'The key was **not** created, because it could only have been shown once and I could not deliver it.',
            '',
            'Enable **Settings → Privacy & Safety → Direct Messages** for a server we share, then run this again.',
          ].join('\n'),
        ) } as never);
      }

      return interaction.editReply({ ...CB.successResponse(
        'Key Sent',
        [
          `Check your DMs — the key is there and will not be shown again.`,
          '',
          `**Id:** \`${record.id}\``,
          `**Tier:** ${tier === 'plus' ? 'Premium+' : 'Premium'} · **Grants:** ${fmtDuration(days)}`,
          `**Uses:** ${uses} · **Key expires:** ${record.validUntil === null ? 'never' : `<t:${Math.floor(record.validUntil / 1000)}:R>`}`,
          '',
          '-# Sent by DM on purpose: this command also works with the prefix, where a reply would be public.',
        ].join('\n'),
      ) } as never);
    }

    // ── list ────────────────────────────────────────────────────────────────
    if (sub === 'list') {
      const keys = await PremiumKeyManager.list();
      const container = new ContainerBuilder()
        .setAccentColor(config.colors.gold)
        .addTextDisplayComponents(new TextDisplayBuilder().setContent('# 🔑 Premium Keys'))
        .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true));

      if (!keys.length) {
        container.addTextDisplayComponents(new TextDisplayBuilder().setContent(
          'No keys yet. Create one with `/premiumkey generate tier:Premium days:30`.',
        ));
      } else {
        const shown = keys.slice(0, 20);
        container.addTextDisplayComponents(new TextDisplayBuilder().setContent(
          shown.map((k) => [
            `\`${k.id}\` **${k.tier === 'plus' ? 'Premium+' : 'Premium'}** · ${fmtDuration(k.days)}`,
            `> ${k.uses}/${k.maxUses} used · ${PremiumKeyManager.statusOf(k)}`,
            k.note ? `> ${k.note}` : '',
          ].filter(Boolean).join('\n')).join('\n\n'),
        ))
          .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true))
          .addTextDisplayComponents(new TextDisplayBuilder().setContent(
            `-# ${keys.length} total${keys.length > 20 ? ' (showing the 20 newest)' : ''} · keys themselves are hashed and cannot be displayed`,
          ));
      }
      return interaction.editReply({ components: [container] });
    }

    // ── info / revoke / delete ──────────────────────────────────────────────
    const id = (interaction.options.getString('id') ?? '').trim().toLowerCase();
    if (!id) return interaction.editReply({ ...CB.errorResponse('Missing Id', 'Provide the key id from `/premiumkey list`.') } as never);

    if (sub === 'revoke') {
      const result = await PremiumKeyManager.revoke(id);
      return interaction.editReply({
        ...(result.ok
          ? CB.successResponse('Key Revoked', `\`${id}\` can no longer be redeemed.\n-# Premium already granted by it is unaffected — revoke that with \`/premiumadmin revokeuser\`.`)
          : CB.errorResponse('Could Not Revoke', result.reason!)),
      } as never);
    }

    if (sub === 'delete') {
      const gone = await PremiumKeyManager.delete(id);
      return interaction.editReply({
        ...(gone
          ? CB.successResponse('Key Deleted', `\`${id}\` and its redemption history are gone.\n-# Prefer \`revoke\` if you want to keep the record.`)
          : CB.errorResponse('Not Found', `No key with id \`${id}\`.`)),
      } as never);
    }

    const key = await PremiumKeyManager.byId(id);
    if (!key) return interaction.editReply({ ...CB.errorResponse('Not Found', `No key with id \`${id}\`.`) } as never);

    const container = new ContainerBuilder()
      .setAccentColor(config.colors.gold)
      .addTextDisplayComponents(new TextDisplayBuilder().setContent(`# 🔑 Key \`${key.id}\``))
      .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true))
      .addTextDisplayComponents(new TextDisplayBuilder().setContent([
        `**Tier:** ${key.tier === 'plus' ? 'Premium+' : 'Premium'}`,
        `**Grants:** ${fmtDuration(key.days)}`,
        `**Uses:** ${key.uses}/${key.maxUses} · **Status:** ${PremiumKeyManager.statusOf(key)}`,
        `**Created:** <t:${Math.floor(key.createdAt / 1000)}:R> by <@${key.createdBy}>`,
        `**Key expires:** ${key.validUntil === null ? 'never' : `<t:${Math.floor(key.validUntil / 1000)}:R>`}`,
        key.note ? `**Note:** ${key.note}` : '',
      ].filter(Boolean).join('\n')));

    if (key.redeemedBy.length) {
      container.addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true))
        .addTextDisplayComponents(new TextDisplayBuilder().setContent([
          '**Redeemed by**',
          ...key.redeemedBy.slice(0, 15).map((r) => `> <@${r.userId}> — <t:${Math.floor(r.at / 1000)}:R>`),
          key.redeemedBy.length > 15 ? `> …and ${key.redeemedBy.length - 15} more` : '',
        ].filter(Boolean).join('\n')));
    }

    return interaction.editReply({ components: [container] });
  },
});
