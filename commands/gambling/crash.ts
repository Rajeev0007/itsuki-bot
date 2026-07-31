import {
  SlashCommandBuilder, MessageFlags, ContainerBuilder, SectionBuilder,
  TextDisplayBuilder, SeparatorBuilder, SeparatorSpacingSize,
  ActionRowBuilder, ButtonBuilder, ButtonStyle, ThumbnailBuilder,
  type ChatInputCommandInteraction,
} from 'discord.js';
import { Command } from '../../structures/Command';
import UserManager from '../../managers/UserManager';
import * as CB from '../../builders/ComponentBuilder';
import fmt from '../../utils/Formatter';
import config from '../../config/config';
import { EMOJI as E } from '../../utils/Constants';
import logger from '../../utils/Logger';

/** How often the rocket ticks, and how fast the multiplier grows per tick. */
const TICK_MS = 2_000;
const GROWTH = 1.2;
/** Generous upper bound; the rocket always resolves well before this. */
const COLLECTOR_MS = 120_000;

/**
 * Picks the crash point.
 *
 * `maxMultiplier` from the config was previously ignored, so `1 / (1 - r)`
 * could return several hundred x on a lucky roll and pay out accordingly.
 */
function generateCrash(): number {
  const { houseEdge, minMultiplier, maxMultiplier } = config.gambling.crash;
  const r = Math.random();
  if (r < houseEdge) return minMultiplier; // instant crash — the house edge
  const raw = Math.floor((1 / (1 - r)) * 100) / 100;
  return Math.min(Math.max(raw, minMultiplier), maxMultiplier);
}

export default new Command({
  data: new SlashCommandBuilder()
    .setName('crash').setDescription('Bet on a multiplier crash. Cash out before it crashes!')
    .addStringOption((o) => o.setName('bet').setDescription('Amount to bet').setRequired(true))
    .addNumberOption((o) => o.setName('cashout').setDescription('Auto cash-out multiplier (e.g. 2.0)').setMinValue(1.01).setMaxValue(100)),
  category: 'gambling',
  async execute(interaction: ChatInputCommandInteraction) {
    await interaction.deferReply({ flags: MessageFlags.IsComponentsV2 as never });

    const { wallet } = await UserManager.getBalance(interaction.user.id);
    const rawBet = interaction.options.getString('bet');
    if (!rawBet)
      return interaction.editReply({ ...CB.errorResponse('Missing Bet', 'Tell me how much to bet, e.g. `500`, `10k`, `half` or `all`.') } as never);

    const bet = fmt.parseAmount(rawBet, wallet);
    const autoCashout = interaction.options.getNumber('cashout') ?? null;
    if (!bet || bet < config.gambling.minBet || bet > config.gambling.maxBet)
      return interaction.editReply({ ...CB.errorResponse('Invalid Bet', `Bet between ${fmt.coins(config.gambling.minBet)} and ${fmt.coins(config.gambling.maxBet)}.`) } as never);
    if (bet > wallet)
      return interaction.editReply({ ...CB.errorResponse('Broke', `You only have ${fmt.coins(wallet)}.`) } as never);

    const crashPoint = generateCrash();
    const avatarUrl = interaction.user.displayAvatarURL({ size: 256 });
    let currentMult = 1.0;

    await UserManager.addWallet(interaction.user.id, -bet);

    const buildC = (mult: number, status: string) => new ContainerBuilder()
      .addSectionComponents(new SectionBuilder().addTextDisplayComponents(
        new TextDisplayBuilder().setContent([`# Crash`, status].join('\n')),
      ).setThumbnailAccessory(new ThumbnailBuilder().setURL(avatarUrl)))
      .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Large).setDivider(true))
      .addTextDisplayComponents(new TextDisplayBuilder().setContent([
        `**Multiplier:** \`${mult.toFixed(2)}x\``,
        `${E.COINS} **Bet:** ${fmt.coins(bet)}`,
        `**Potential payout:** ${fmt.coins(Math.floor(bet * mult))}`,
        autoCashout ? `**Auto cash-out:** ${autoCashout}x` : '',
      ].filter(Boolean).join('\n')));

    const cashoutRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`crash_cashout:${interaction.user.id}`).setLabel('Cash Out!').setStyle(ButtonStyle.Success),
    );

    // The outcome is locked in SYNCHRONOUSLY by decide(), separately from the
    // async settlement. That ordering matters: the collector uses `max: 1`, so
    // it emits 'end' the moment a click is collected — before the async
    // 'collect' handler has resumed. If 'end' were allowed to settle the round
    // itself, a successful cash-out would be recorded as a crash.
    let decided = false;
    let outcomeMult: number | null = null; // null = crashed / no cash-out
    const decide = (mult: number | null): boolean => {
      if (decided) return false;
      decided = true;
      outcomeMult = mult;
      return true;
    };

    /** Settles the round exactly once, using the already-decided outcome. */
    let settled = false;
    const finish = async () => {
      if (settled) return;
      settled = true;

      const cashoutMult = outcomeMult;
      const won = cashoutMult !== null && cashoutMult >= 1.0;
      const payout = won ? Math.floor(bet * cashoutMult) : 0;
      if (payout > 0) await UserManager.addWallet(interaction.user.id, payout);
      await UserManager.incrementStat(interaction.user.id, 'gamesPlayed');
      // Only count it as a win when the cash-out actually beat the stake.
      if (payout > bet) await UserManager.incrementStat(interaction.user.id, 'gamesWon');
      await UserManager.recordTransaction(
        interaction.user.id, payout > bet ? 'gambling_win' : 'gambling_loss', payout - bet, 'Crash',
      );

      const eco = await UserManager.getEconomy(interaction.user.id);
      const status = won
        ? `# ${E.WIN} Cashed out at ${cashoutMult!.toFixed(2)}x!\nYou made **${fmt.coins(payout - bet)}** profit. It would have crashed at \`${crashPoint.toFixed(2)}x\`.`
        : `# ${E.LOSE} Crashed at ${crashPoint.toFixed(2)}x!\nYou lost ${fmt.coins(bet)}.`;

      const c = buildC(won ? cashoutMult! : crashPoint, status);
      c.addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true))
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(`${E.WALLET} **Wallet:** ${fmt.coins(eco.wallet)}`));
      await interaction.editReply({ components: [c] }).catch(() => {});
    };

    // An instant crash (the configured house edge) resolves immediately — the
    // player never gets a window to cash out at 1.00x for a free refund.
    if (crashPoint <= config.gambling.crash.minMultiplier) {
      decide(null);
      await finish();
      return;
    }

    const msg = await interaction.editReply({
      components: [buildC(currentMult, 'Rocket is climbing… Cash out before it crashes!').addActionRowComponents(cashoutRow)],
    });

    const collector = (msg as unknown as {
      createMessageComponentCollector: (o: { filter: (i: { user: { id: string }; customId: string }) => boolean; time: number; max: number }) =>
        { on: (e: string, cb: (...a: never[]) => void) => void; stop: (r?: string) => void };
    }).createMessageComponentCollector({
      filter: (i) => i.user.id === interaction.user.id && i.customId.startsWith('crash_'),
      time: COLLECTOR_MS, max: 1,
    });

    const interval = setInterval(() => {
      void (async () => {
        if (decided) { clearInterval(interval); return; }

        const next = Math.round(currentMult * GROWTH * 100) / 100;

        if (next >= crashPoint) {
          clearInterval(interval);
          decide(null);
          collector.stop('crashed');
          await finish();
          return;
        }

        currentMult = next;

        if (autoCashout !== null && currentMult >= autoCashout) {
          clearInterval(interval);
          decide(Math.min(currentMult, autoCashout));
          collector.stop('autocashout');
          await finish();
          return;
        }

        // Actually render the climb. Without this the message sat at 1.00x for
        // the whole round, so "cash out before it crashes" was pure guesswork.
        await interaction.editReply({
          components: [buildC(currentMult, 'Rocket is climbing… Cash out before it crashes!').addActionRowComponents(cashoutRow)],
        }).catch((err) => logger.debug('[Crash] tick edit failed:', (err as Error).message));
      })();
    }, TICK_MS);

    collector.on('collect', async (i: { deferUpdate: () => Promise<void> }) => {
      // Lock the cash-out in before yielding to any await.
      const isOurs = decide(currentMult);
      clearInterval(interval);
      await i.deferUpdate().catch(() => {});
      if (isOurs) await finish();
    });

    collector.on('end', async () => {
      clearInterval(interval);
      // Safety net for a genuine timeout only; if the round was already
      // decided, whoever decided it is responsible for settling.
      if (decide(null)) await finish();
    });
  },
});
