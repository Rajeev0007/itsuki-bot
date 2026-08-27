import {
  SlashCommandBuilder, MessageFlags, ContainerBuilder, TextDisplayBuilder,
  SeparatorBuilder, SeparatorSpacingSize,
  type ChatInputCommandInteraction,
} from 'discord.js';
import { Command } from '../../structures/Command';
import CardManager, { effectiveStats, type OwnedCard } from '../../managers/CardManager';
import { RARITIES } from '../../services/CardService';
import UserManager from '../../managers/UserManager';
import CooldownManager from '../../managers/CooldownManager';
import * as CB from '../../builders/ComponentBuilder';
import fmt from '../../utils/Formatter';
import config from '../../config/config';

function cardLine(card: OwnedCard, ownerName: string): string {
  const s = effectiveStats(card);
  const meta = RARITIES[card.rarity] ?? RARITIES.common;
  return `${meta.emoji} **${card.name}** (Lv.${card.level ?? 1}) — ${ownerName}\n> ATK ${fmt.number(s.attack)} · HP ${fmt.number(s.health)}`;
}

export default new Command({
  data: new SlashCommandBuilder()
    .setName('battle').setDescription('Battle another player using your anime cards.')
    .addUserOption((o) => o.setName('opponent').setDescription('Who to battle').setRequired(true))
    .addStringOption((o) => o.setName('card').setDescription('Your card (defaults to your strongest)')),
  category: 'cards',
  // Vote-locked to drive listing growth; premium members bypass it.
  voteLocked: true,
  cooldown: 5_000,

  async execute(interaction: ChatInputCommandInteraction) {
    await interaction.deferReply({ flags: MessageFlags.IsComponentsV2 as never });

    const opponent = interaction.options.getUser('opponent');
    if (!opponent) {
      return interaction.editReply({ ...CB.errorResponse('Missing Opponent', 'Pick someone to battle.') } as never);
    }
    if (opponent.id === interaction.user.id) {
      return interaction.editReply({ ...CB.errorResponse('Invalid Opponent', 'You cannot battle yourself.') } as never);
    }
    if (opponent.bot) {
      return interaction.editReply({ ...CB.errorResponse('Invalid Opponent', 'Bots do not collect cards.') } as never);
    }

    // Battles pay out coins, so they need their own cooldown independent of the
    // generic command cooldown to stop farming.
    const cd = CooldownManager.check(interaction.user.id, 'battle_reward');
    if (cd.onCooldown) {
      return interaction.editReply({ ...CB.errorResponse(
        'Still Recovering', `Your cards need rest. Battle again in **${fmt.duration(cd.remaining)}**.`,
      ) } as never);
    }

    // ── Pick the fighters ───────────────────────────────────────────────────
    const requested = (interaction.options.getString('card') ?? '').trim();
    const myCard = requested
      ? await CardManager.findCard(interaction.user.id, requested)
      : await CardManager.strongestCard(interaction.user.id);

    if (!myCard) {
      return interaction.editReply({ ...CB.errorResponse(
        requested ? 'Card Not Found' : 'No Cards',
        requested
          ? `You don't own a card matching \`${requested}\`.`
          : 'You have no cards yet — use `/roll` to draw one.',
      ) } as never);
    }
    // A card held in auction escrow isn't in the collection, so it can't be
    // used here — but guard explicitly in case of a stale lookup.
    if (await CardManager.isListed(interaction.user.id, myCard.id)) {
      return interaction.editReply({ ...CB.errorResponse(
        'Card Unavailable', `**${myCard.name}** is listed on the auction house.`,
      ) } as never);
    }

    const theirCard = await CardManager.strongestCard(opponent.id);
    if (!theirCard) {
      return interaction.editReply({ ...CB.errorResponse(
        'Opponent Has No Cards', `**${opponent.username}** has no cards to battle with.`,
      ) } as never);
    }

    // ── Fight ───────────────────────────────────────────────────────────────
    const { winner, rounds } = CardManager.simulateBattle(myCard, theirCard);
    const iWon = winner === 'a';
    const winnerId = iWon ? interaction.user.id : opponent.id;
    const winnerName = iWon ? interaction.user.username : opponent.username;

    // The winner is only PAID if their own reward cooldown is clear. The payout
    // used to be unconditional while the cooldown was set on the initiator only,
    // so two users could alternate who ran the command and collect roughly double
    // the intended rate — and an uninvolved opponent could be farmed as a payout
    // mule. Battles themselves stay unlimited; only the coins are rate-limited.
    const rewardBlocked = CooldownManager.check(winnerId, 'battle_reward').onCooldown;
    const reward = rewardBlocked
      ? 0
      : fmt.randomInt(config.cards.battleReward.min, config.cards.battleReward.max);
    if (reward > 0) {
      await UserManager.creditWallet(winnerId, reward);
      await UserManager.recordTransaction(winnerId, 'card_battle', reward, 'Card battle victory');
      CooldownManager.set(winnerId, 'battle_reward', config.cards.battleCooldown);
    }

    await UserManager.incrementStat(interaction.user.id, 'gamesPlayed');
    await UserManager.incrementStat(opponent.id, 'gamesPlayed');
    await UserManager.incrementStat(winnerId, 'gamesWon');

    // Condense the fight to a readable highlight reel.
    const log = rounds.slice(0, 6).map((r, i) => {
      const attacker = r.attacker === 'a' ? myCard.name : theirCard.name;
      const defender = r.attacker === 'a' ? theirCard.name : myCard.name;
      return `\`${i + 1}.\` **${attacker}** hits **${defender}** for **${fmt.number(r.damage)}** — ${fmt.number(r.targetHpLeft)} HP left`;
    });
    if (rounds.length > log.length) log.push(`-# …and ${rounds.length - log.length} more exchanges`);

    const container = new ContainerBuilder()
      .addTextDisplayComponents(new TextDisplayBuilder().setContent('# ⚔️ Card Battle'))
      .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true))
      .addTextDisplayComponents(new TextDisplayBuilder().setContent([
        cardLine(myCard, interaction.user.username),
        '',
        cardLine(theirCard, opponent.username),
      ].join('\n')))
      .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true))
      .addTextDisplayComponents(new TextDisplayBuilder().setContent(log.join('\n')))
      .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Large).setDivider(true))
      .addTextDisplayComponents(new TextDisplayBuilder().setContent([
        `## 🏆 ${winnerName} wins!`,
        rewardBlocked
          ? `-# No coins this time — ${iWon ? 'your' : `${winnerName}'s`} battle reward is still on cooldown.`
          : `Earned **${fmt.coins(reward)}**.`,
        `-# ${rounds.length} exchanges · higher ATK strikes first`,
      ].join('\n')));

    await interaction.editReply({ components: [container] });
  },
});
