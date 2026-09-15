/**
 * @file verifyAnswer.ts
 * @description Checks a submitted verification answer (captcha, maths or
 * passphrase) and grants the role on success.
 *
 * The expected answer is never present in the modal or its customId — it lives
 * in VerificationManager's in-memory store, keyed by guild+user.
 */

import { MessageFlags, type ModalSubmitInteraction, type GuildMember } from 'discord.js';
import VerificationManager from '../../managers/VerificationManager';
import fmt from '../../utils/Formatter';
import logger from '../../utils/Logger';

export const customId = 'verify_modal:*';

export async function execute(interaction: ModalSubmitInteraction): Promise<void> {
  const guild = interaction.guild;
  if (!guild) {
    await interaction.reply({ content: 'Verification only works inside a server.', flags: MessageFlags.Ephemeral });
    return;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const cfg = await VerificationManager.getConfig(guild.id);
  if (!cfg.enabled || !cfg.roleId) {
    await interaction.editReply({ content: 'Verification is no longer active in this server.' });
    return;
  }

  const member = interaction.member as GuildMember | null;
  if (!member) {
    await interaction.editReply({ content: 'I could not read your membership. Try again.' });
    return;
  }

  // A second submission after success shouldn't look like a failure.
  if (member.roles.cache.has(cfg.roleId)) {
    await interaction.editReply({ content: `You're already verified — you have <@&${cfg.roleId}>.` });
    return;
  }

  const submitted = interaction.fields.getTextInputValue('verify_input') ?? '';
  const check = VerificationManager.checkChallenge(guild.id, interaction.user.id, submitted);

  if (!check.ok) {
    if (check.lockedOut) {
      await VerificationManager.log(guild, cfg,
        `⚠️ **${interaction.user.tag ?? interaction.user.username}** was locked out after too many failed verification attempts.`);
    }
    const reason = check.reason ?? 'That answer was not accepted.';
    await interaction.editReply({
      content: check.lockedOut
        ? reason
        : `${reason}\n-# Press **Verify** again if you need a new challenge.`,
    });
    return;
  }

  const result = await VerificationManager.grant(member, cfg);
  if (!result.ok) {
    const why = result.reason ?? 'Unknown error.';
    logger.warn(`[Verify] Grant failed in ${guild.id}: ${why}`);
    await interaction.editReply({
      content: `You answered correctly, but I couldn't assign the role: ${why}\nPlease tell a server admin.`,
    });
    return;
  }

  await VerificationManager.log(guild, cfg,
    `✅ **${interaction.user.tag ?? interaction.user.username}** verified (${cfg.method}).`);

  await interaction.editReply({
    content: `✅ Correct — you now have <@&${cfg.roleId}>. Welcome to **${guild.name}**!`,
  });
}
