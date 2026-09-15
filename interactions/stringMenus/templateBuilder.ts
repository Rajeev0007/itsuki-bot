/**
 * @file templateBuilder.ts
 * @description Removal menus for the message builder (`tb_rmfield` / `tb_rmbutton`).
 *
 * Removal is by index because field names are not unique — two fields can share
 * a name, and matching by name would delete the wrong one.
 */

import { MessageFlags, type StringSelectMenuInteraction } from 'discord.js';
import { getSession, refresh } from '../../services/TemplateBuilderUI';

export const customId = 'tb_rm:*';

export async function execute(interaction: StringSelectMenuInteraction): Promise<void> {
  const [action, sid] = interaction.customId.split(':');

  const { session, reason } = getSession(sid ?? '', interaction.user.id);
  if (!session) {
    await interaction.reply({ content: reason, flags: MessageFlags.Ephemeral });
    return;
  }

  const index = Number(interaction.values?.[0]);
  if (!Number.isInteger(index) || index < 0) {
    await interaction.reply({ content: 'That selection was invalid.', flags: MessageFlags.Ephemeral });
    return;
  }

  const tpl = session.template;

  if (action === 'tb_rmfield') {
    const fields = tpl.fields ?? [];
    // The panel may be stale if the list changed in another tab; bail rather
    // than deleting whatever now sits at that index.
    if (index >= fields.length) {
      await interaction.reply({
        content: 'That field is already gone — the panel was out of date.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    tpl.fields = fields.filter((_, i) => i !== index);
  } else if (action === 'tb_rmbutton') {
    const buttons = tpl.buttons ?? [];
    if (index >= buttons.length) {
      await interaction.reply({
        content: 'That button is already gone — the panel was out of date.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    tpl.buttons = buttons.filter((_, i) => i !== index);
  } else {
    await interaction.reply({ content: 'Unknown builder menu.', flags: MessageFlags.Ephemeral });
    return;
  }

  await refresh(interaction, session);
}
