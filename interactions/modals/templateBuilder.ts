/**
 * @file templateBuilder.ts
 * @description Modal submissions for the message builder (`tb_modal:<group>:<sid>`).
 *
 * An empty input means "clear this field" rather than "leave unchanged" — the
 * modal is pre-filled with the current values, so blanking one is the natural
 * way to remove it and there would otherwise be no way to unset anything.
 */

import { MessageFlags, type ModalSubmitInteraction } from 'discord.js';
import { getSession, refresh, parseColor, parseUrlList } from '../../services/TemplateBuilderUI';

export const customId = 'tb_modal:*';

/** Reads an optional input; modals return '' for untouched optional fields. */
function value(interaction: ModalSubmitInteraction, id: string): string {
  try {
    return (interaction.fields.getTextInputValue(id) ?? '').trim();
  } catch {
    // Field absent from this modal group.
    return '';
  }
}

/** Blank → null so the renderer skips the field entirely. */
function orNull(text: string): string | null {
  return text ? text : null;
}

export async function execute(interaction: ModalSubmitInteraction): Promise<void> {
  const [, group, sid] = interaction.customId.split(':');

  const { session, reason } = getSession(sid ?? '', interaction.user.id);
  if (!session) {
    await interaction.reply({ content: reason, flags: MessageFlags.Ephemeral });
    return;
  }
  const tpl = session.template;

  // Warnings are collected instead of aborting: one bad URL shouldn't throw away
  // the other four fields the user just typed.
  const warnings: string[] = [];

  if (group === 'text') {
    tpl.content = orNull(value(interaction, 'content'));
    tpl.title = orNull(value(interaction, 'title'));
    tpl.description = orNull(value(interaction, 'description'));

    const url = value(interaction, 'url');
    if (url && !/^https?:\/\//i.test(url)) {
      warnings.push('Title link ignored — it must start with `http://` or `https://`.');
      tpl.url = null;
    } else {
      tpl.url = orNull(url);
    }

    const color = parseColor(value(interaction, 'color'));
    if (color === undefined) {
      warnings.push('Colour not recognised — use a hex code like `#5865F2`, a name like `blurple`, or `random`.');
    } else {
      tpl.color = color;
    }
  } else if (group === 'media') {
    const check = (raw: string, label: string): string | null => {
      if (!raw) return null;
      // Placeholders resolve to URLs later, so they must pass validation now.
      if (/^https?:\/\//i.test(raw) || /\{[a-z0-9_.]+\}/i.test(raw)) return raw;
      warnings.push(`${label} ignored — must be an \`https://\` URL or a placeholder like \`{user.avatar}\`.`);
      return null;
    };
    tpl.thumbnail = check(value(interaction, 'thumbnail'), 'Thumbnail');
    tpl.image = check(value(interaction, 'image'), 'Image');

    const gallery = parseUrlList(value(interaction, 'gallery')).slice(0, 9);
    tpl.gallery = gallery;
    if (tpl.style !== 'v2' && gallery.length) {
      warnings.push('Gallery images only render in Components V2 — in embed style only the main image is shown.');
    }
  } else if (group === 'trim') {
    const name = value(interaction, 'author_name');
    tpl.author = name
      ? {
        name,
        iconUrl: orNull(value(interaction, 'author_icon')),
        url: orNull(value(interaction, 'author_url')),
      }
      : null;

    const footerText = value(interaction, 'footer_text');
    tpl.footer = footerText
      ? { text: footerText, iconUrl: orNull(value(interaction, 'footer_icon')) }
      : null;

    if (!name && (value(interaction, 'author_icon') || value(interaction, 'author_url'))) {
      warnings.push('Author icon/link need an author **name** to show up.');
    }
  } else if (group === 'field') {
    const name = value(interaction, 'name');
    const fieldValue = value(interaction, 'value');
    if (!name || !fieldValue) {
      await interaction.reply({
        content: 'A field needs both a name and a value. Nothing was added.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    const inlineRaw = value(interaction, 'inline').toLowerCase();
    const inline = ['yes', 'y', 'true', '1', 'on'].includes(inlineRaw);

    tpl.fields = [...(tpl.fields ?? []), { name, value: fieldValue, inline }].slice(0, 25);
    if (inline && tpl.style === 'v2') {
      warnings.push('Components V2 has no inline layout — inline fields are grouped onto one line instead.');
    }
  } else if (group === 'button') {
    const label = value(interaction, 'label');
    const url = value(interaction, 'url');
    if (!label || !/^https?:\/\//i.test(url)) {
      await interaction.reply({
        content: 'A button needs a label and an `https://` URL. Nothing was added.\n-# Only link buttons are supported, since any other kind would need code behind it.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    tpl.buttons = [...(tpl.buttons ?? []), {
      label, url, emoji: orNull(value(interaction, 'emoji')),
    }].slice(0, 5);
  } else {
    await interaction.reply({ content: 'Unknown editor.', flags: MessageFlags.Ephemeral });
    return;
  }

  await refresh(interaction, session);

  if (warnings.length) {
    await interaction.followUp({
      content: warnings.map((w) => `⚠️ ${w}`).join('\n'),
      flags: MessageFlags.Ephemeral,
    }).catch(() => null);
  }
}
