import {
  SlashCommandBuilder, MessageFlags, ContainerBuilder, TextDisplayBuilder,
  SeparatorBuilder, SeparatorSpacingSize, ActionRowBuilder, ButtonBuilder,
  ButtonStyle,
  type ChatInputCommandInteraction, type Client,
} from 'discord.js';
import { Command } from '../../structures/Command';
import VoteManager, { PROVIDERS } from '../../managers/VoteManager';
import PremiumManager from '../../managers/PremiumManager';
import * as CB from '../../builders/ComponentBuilder';
import fmt from '../../utils/Formatter';
import config from '../../config/config';
import { resolveDisplayName } from '../../utils/UserResolver';

export default new Command({
  data: new SlashCommandBuilder()
    .setName('vote').setDescription('Vote for the bot to unlock commands and earn rewards.')
    .addSubcommand((s) => s.setName('links').setDescription('Get the vote links and your status'))
    .addSubcommand((s) => s.setName('reminders').setDescription('Turn vote reminder DMs on or off')
      .addBooleanOption((o) => o.setName('enabled').setDescription('Receive a DM when you can vote again').setRequired(true)))
    .addSubcommand((s) => s.setName('top').setDescription('Most prolific voters')),
  category: 'utility',
  aliases: ['v'],
  cooldown: 5_000,

  async execute(interaction: ChatInputCommandInteraction, client?: Client) {
    await interaction.deferReply({ flags: MessageFlags.IsComponentsV2 as never });

    const sub = (interaction.options as { getSubcommand: () => string }).getSubcommand();
    const SUBCOMMANDS = ['links', 'reminders', 'top'];
    if (!SUBCOMMANDS.includes(sub)) {
      return interaction.editReply({ ...CB.errorResponse(
        'Unknown Subcommand', `Use one of: ${SUBCOMMANDS.map((s) => `\`${s}\``).join(', ')}.`,
      ) } as never);
    }

    const botId = (client ?? interaction.client).user?.id ?? config.clientId;

    // ── reminders ───────────────────────────────────────────────────────────
    if (sub === 'reminders') {
      const enabled = interaction.options.getBoolean('enabled') ?? true;
      await VoteManager.setReminders(interaction.user.id, enabled);
      return interaction.editReply({ ...CB.successResponse(
        enabled ? 'Reminders On' : 'Reminders Off',
        enabled
          ? "I'll DM you when your vote cooldown expires.\n-# Make sure DMs from server members are enabled, or the reminder can't reach you."
          : "You won't receive vote reminder DMs any more.",
      ) } as never);
    }

    // ── top ─────────────────────────────────────────────────────────────────
    if (sub === 'top') {
      const board = await VoteManager.leaderboard(10);
      if (!board.length) {
        return interaction.editReply({ ...CB.successResponse(
          'No Votes Yet', 'Be the first — `/vote links`.',
        ) } as never);
      }
      const names = await Promise.all(board.map((e) =>
        resolveDisplayName(e.userId, { guild: interaction.guild, client: interaction.client })));

      const c = new ContainerBuilder()
        .addTextDisplayComponents(new TextDisplayBuilder().setContent('# 🗳️ Top Voters'))
        .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true))
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(
          board.map((e, i) => `\`#${i + 1}\` **${names[i]}** — ${fmt.number(e.value)} votes`).join('\n'),
        ));
      return interaction.editReply({ components: [c] });
    }

    // ── links + status ──────────────────────────────────────────────────────
    const [totals, topggLeft, dblLeft, perks] = await Promise.all([
      VoteManager.totals(interaction.user.id),
      VoteManager.cooldownRemaining(interaction.user.id, 'topgg'),
      VoteManager.cooldownRemaining(interaction.user.id, 'dbl'),
      PremiumManager.perksFor(interaction.user.id, interaction.guild?.id ?? null),
    ]);
    const record = await VoteManager.getRecord(interaction.user.id);

    const status = (remaining: number) => remaining > 0
      ? `⏳ available in **${fmt.duration(remaining)}**`
      : '✅ **ready to vote**';

    const container = new ContainerBuilder()
      .addTextDisplayComponents(new TextDisplayBuilder().setContent([
        '# 🗳️ Vote for the Bot',
        'Voting is free, takes seconds, and resets every 12 hours on each site.',
      ].join('\n')))
      .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true))
      .addTextDisplayComponents(new TextDisplayBuilder().setContent([
        `**${PROVIDERS.topgg.label}** — ${status(topggLeft)}`,
        `**${PROVIDERS.dbl.label}** — ${status(dblLeft)}`,
        '',
        `**Your votes:** ${fmt.number(totals.all)} total`
          + `${totals.streak > 1 ? ` · 🔥 **${totals.streak}-day streak**` : ''}`,
        `**Reminders:** ${record.remindersEnabled ? 'on' : 'off'} — change with \`/vote reminders\``,
      ].join('\n')))
      .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true))
      .addTextDisplayComponents(new TextDisplayBuilder().setContent(
        perks.tier !== 'none'
          ? `-# You have **${perks.label}**, so vote-locked commands are already unlocked for you. Votes still help the bot grow.`
          : '-# Voting on **either** site unlocks vote-locked commands for 12 hours.',
      ))
      .addActionRowComponents(
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder().setLabel('Vote on Top.gg').setStyle(ButtonStyle.Link)
            .setURL(PROVIDERS.topgg.url(botId)),
          new ButtonBuilder().setLabel('Vote on Discord Bot List').setStyle(ButtonStyle.Link)
            .setURL(PROVIDERS.dbl.url(botId)),
        ),
      );

    return interaction.editReply({ components: [container] });
  },
});
