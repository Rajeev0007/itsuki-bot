/**
 * @file verify.ts
 * @description The "Verify" button on the verification panel.
 *
 * Dispatches by configured method. Note the ordering: every gate that can
 * reject a member is checked BEFORE a challenge is issued, so we never hand out
 * a captcha to someone who is going to be refused anyway.
 */

import {
  MessageFlags, ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder,
  ButtonBuilder, ButtonStyle, AttachmentBuilder, ContainerBuilder,
  TextDisplayBuilder, SeparatorBuilder, SeparatorSpacingSize,
  MediaGalleryBuilder, MediaGalleryItemBuilder,
  type ButtonInteraction, type GuildMember,
} from 'discord.js';
import VerificationManager from '../../managers/VerificationManager';
import { renderCaptcha } from '../../services/CaptchaCanvas';
import * as CB from '../../builders/ComponentBuilder';
import fmt from '../../utils/Formatter';
import logger from '../../utils/Logger';

/**
 * Registered as the `verify_` prefix so it also receives
 * `verify_answer_open` — the router strips `:*` and matches with
 * `startsWith`, so `verify_start:*` alone would leave that button unhandled.
 */
export const customId = 'verify_:*';

export async function execute(interaction: ButtonInteraction): Promise<void> {
  const action = interaction.customId.split(':')[0];

  // The captcha flow needs a second button to open the modal, because a modal
  // cannot be shown from an interaction that was already deferred.
  if (action === 'verify_answer_open') {
    const guildId = interaction.customId.split(':')[1] ?? interaction.guildId ?? '';
    await interaction.showModal(buildModal(guildId, 'Enter the code from the image', 'Code'));
    return;
  }

  const guild = interaction.guild;
  if (!guild) {
    await interaction.reply({ content: 'Verification only works inside a server.', flags: MessageFlags.Ephemeral });
    return;
  }

  const cfg = await VerificationManager.getConfig(guild.id);

  if (!cfg.enabled || !cfg.roleId) {
    await interaction.reply({
      content: 'Verification is not currently active in this server.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const member = interaction.member as GuildMember | null;
  if (!member) {
    await interaction.reply({ content: 'I could not read your membership. Try again.', flags: MessageFlags.Ephemeral });
    return;
  }

  // Already verified — answer plainly instead of issuing a pointless challenge.
  if (member.roles.cache.has(cfg.roleId)) {
    await interaction.reply({
      content: `You're already verified — you have <@&${cfg.roleId}>.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  // Confirm the bot can still assign the role before asking anything of the
  // user. Roles get moved after setup, and failing here is far clearer than
  // failing after they solve a captcha.
  const denial = VerificationManager.canAssign(guild, cfg.roleId);
  if (denial) {
    logger.warn(`[Verify] Misconfigured in ${guild.id}: ${denial}`);
    await interaction.reply({
      content: `Verification is misconfigured, so I can't complete it: ${denial}\nPlease let a server admin know.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  // Lockout from previous failed attempts.
  const lockedFor = VerificationManager.isLockedOut(guild.id, interaction.user.id);
  if (lockedFor > 0) {
    await interaction.reply({
      content: `Too many incorrect attempts. Try again in **${fmt.duration(lockedFor)}**.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  // Account-age gate applies to EVERY method, not just the 'age' one.
  if (cfg.minAccountAgeDays > 0) {
    const age = VerificationManager.accountAgeDays(member);
    if (age < cfg.minAccountAgeDays) {
      await interaction.reply({
        content: [
          `Your Discord account is **${age} day${age !== 1 ? 's' : ''}** old, but this server requires **${cfg.minAccountAgeDays}**.`,
          '-# This is an automated anti-raid measure — contact a moderator if you need access sooner.',
        ].join('\n'),
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
  }

  // ── Instant methods ───────────────────────────────────────────────────────
  if (cfg.method === 'button' || cfg.method === 'age') {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const result = await VerificationManager.grant(member, cfg);
    if (!result.ok) {
      await interaction.editReply({ content: `Verification failed: ${result.reason ?? 'Unknown error.'}` });
      return;
    }
    await VerificationManager.log(guild, cfg,
      `✅ **${interaction.user.tag ?? interaction.user.username}** verified (${cfg.method}).`);
    await interaction.editReply({
      content: `✅ Verified — you now have <@&${cfg.roleId}>. Welcome to **${guild.name}**!`,
    });
    return;
  }

  // ── Passphrase / maths — modal, no image needed ────────────────────────────
  if (cfg.method === 'passphrase' || cfg.method === 'math') {
    if (cfg.method === 'passphrase') {
      if (!cfg.passphrase) {
        await interaction.reply({
          content: 'Verification is misconfigured: no passphrase is set. Please tell an admin.',
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      VerificationManager.issueChallenge(guild.id, interaction.user.id, cfg.passphrase);
    } else {
      const { question, answer } = VerificationManager.generateMathChallenge();
      VerificationManager.issueChallenge(guild.id, interaction.user.id, answer);
      // The question is safe to expose; the answer never leaves the server.
      await interaction.showModal(buildModal(guild.id, `What is ${question}?`, 'Answer'));
      return;
    }

    await interaction.showModal(buildModal(guild.id, 'Enter the passphrase from the rules', 'Passphrase'));
    return;
  }

  // ── Captcha ───────────────────────────────────────────────────────────────
  await interaction.deferReply({ flags: (MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral) as never });

  const code = VerificationManager.generateCaptchaText(6);

  let png: Buffer | null = null;
  try {
    png = renderCaptcha(code);
  } catch (err) {
    logger.warn(`[Verify] Captcha render failed, falling back to maths: ${(err as Error).message}`);
  }

  if (!png) {
    // Canvas unavailable — fall back to a maths challenge rather than blocking
    // everyone out of the server.
    const { question, answer } = VerificationManager.generateMathChallenge();
    VerificationManager.issueChallenge(guild.id, interaction.user.id, answer);
    await interaction.editReply({
      ...CB.errorResponse(
        'Captcha Unavailable',
        `Image captchas aren't working right now, so here's a question instead.\n\n## What is ${question}?\n\nUse the button below to answer.`,
      ),
    } as never);
    await interaction.followUp({
      components: [new ContainerBuilder()
        .addTextDisplayComponents(new TextDisplayBuilder().setContent('Press to enter your answer.'))
        .addActionRowComponents(answerButtonRow(guild.id))],
      flags: (MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral) as never,
    } as never).catch(() => {});
    return;
  }

  VerificationManager.issueChallenge(guild.id, interaction.user.id, code);

  const container = new ContainerBuilder()
    .addTextDisplayComponents(new TextDisplayBuilder().setContent([
      '# Captcha Verification',
      'Type the **6 characters** shown below. Case does not matter.',
    ].join('\n')))
    .addMediaGalleryComponents(
      new MediaGalleryBuilder().addItems(new MediaGalleryItemBuilder().setURL('attachment://captcha.png')),
    )
    .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true))
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(
      '-# Expires in 5 minutes · 3 attempts',
    ))
    .addActionRowComponents(answerButtonRow(guild.id));

  await interaction.editReply({
    components: [container],
    files: [new AttachmentBuilder(png, { name: 'captcha.png' })],
  } as never);
}

function answerButtonRow(guildId: string): ActionRowBuilder<ButtonBuilder> {
  // A separate button is required because a modal cannot be shown from an
  // interaction that has already been deferred/replied to.
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`verify_answer_open:${guildId}`)
      .setLabel('Enter code')
      .setStyle(ButtonStyle.Success),
  );
}

function buildModal(guildId: string, label: string, placeholder: string): ModalBuilder {
  return new ModalBuilder()
    .setCustomId(`verify_modal:${guildId}`)
    .setTitle('Server Verification')
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId('verify_input')
          .setLabel(label.slice(0, 45))
          .setPlaceholder(placeholder)
          .setStyle(TextInputStyle.Short)
          .setMaxLength(100)
          .setRequired(true),
      ),
    );
}
