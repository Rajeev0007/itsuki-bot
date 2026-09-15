/**
 * @file ComponentBuilder.ts
 * @description Reusable factory functions for Discord Components V2.
 */

import {
  ContainerBuilder, SectionBuilder, TextDisplayBuilder, ThumbnailBuilder,
  SeparatorBuilder, SeparatorSpacingSize, MediaGalleryBuilder, MediaGalleryItemBuilder,
  ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder, MessageFlags,
} from 'discord.js';
import config from '../config/config';
import { EMOJI as E } from '../utils/Constants';

/* Low-level helpers */
export const text = (content: string) => new TextDisplayBuilder().setContent(content);
export const sep = (large = false) =>
  new SeparatorBuilder()
    .setSpacing(large ? SeparatorSpacingSize.Large : SeparatorSpacingSize.Small)
    .setDivider(true);
export const sepSmall = () => sep(false);
export const sepLarge = () => sep(true);

/* Section helper — SectionBuilder requires an accessory (thumbnail or button) */
export function section(lines: string | string[], thumbnailUrl?: string): SectionBuilder | TextDisplayBuilder {
  const content = Array.isArray(lines) ? lines.join('\n') : lines;
  if (thumbnailUrl) {
    return new SectionBuilder()
      .addTextDisplayComponents(text(content))
      .setThumbnailAccessory(new ThumbnailBuilder().setURL(thumbnailUrl));
  }
  // No accessory — return TextDisplayBuilder instead (SectionBuilder requires accessory)
  return text(content);
}

/* Gallery helper */
export function gallery(...urls: (string | undefined)[]): MediaGalleryBuilder {
  const g = new MediaGalleryBuilder();
  for (const url of urls) {
    if (url) g.addItems(new MediaGalleryItemBuilder().setURL(url));
  }
  return g;
}

/* Button helpers */
export function button(label: string, customId: string, style = ButtonStyle.Secondary, emoji?: string): ButtonBuilder {
  const b = new ButtonBuilder().setCustomId(customId).setLabel(label).setStyle(style);
  if (emoji) b.setEmoji(emoji);
  return b;
}
export const primaryBtn = (label: string, customId: string, emoji?: string) => button(label, customId, ButtonStyle.Primary, emoji);
export const successBtn = (label: string, customId: string, emoji?: string) => button(label, customId, ButtonStyle.Success, emoji);
export const dangerBtn = (label: string, customId: string, emoji?: string) => button(label, customId, ButtonStyle.Danger, emoji);
export const secondaryBtn = (label: string, customId: string, emoji?: string) => button(label, customId, ButtonStyle.Secondary, emoji);

export function linkBtn(label: string, url: string, emoji?: string): ButtonBuilder {
  const b = new ButtonBuilder().setLabel(label).setStyle(ButtonStyle.Link).setURL(url);
  if (emoji) b.setEmoji(emoji);
  return b;
}

export function row(...buttons: ButtonBuilder[]): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(...buttons);
}

/* Pre-built responses */
export function headerSection(title: string, subtitle?: string, avatarUrl?: string): SectionBuilder | TextDisplayBuilder {
  const lines = [`# ${title}`];
  if (subtitle) lines.push(subtitle);
  return section(lines, avatarUrl);
}

export function errorResponse(title: string, description: string): { components: ContainerBuilder[] } {
  const container = new ContainerBuilder()
    .addTextDisplayComponents(text(`# ${title}\n${description}`));
  return { components: [container] };
}

export function successResponse(title: string, description: string): { components: ContainerBuilder[] } {
  const container = new ContainerBuilder()
    .addTextDisplayComponents(text(`# ${title}\n${description}`));
  return { components: [container] };
}

export function cooldownResponse(command: string, remainingMs: number): { components: ContainerBuilder[] } {
  const secs = Math.ceil(remainingMs / 1000);
  const mins = Math.floor(secs / 60);
  const s = secs % 60;
  const time = mins > 0 ? `${mins}m ${s}s` : `${s}s`;
  const container = new ContainerBuilder()
    .addTextDisplayComponents(text(`# ${E.COOLDOWN} Slow Down!\nYou can use \`/${command}\` again in **${time}**.`));
  return { components: [container] };
}

export function navRow(homeId = 'nav_home', closeId = 'nav_close'): ActionRowBuilder<ButtonBuilder> {
  return row(secondaryBtn('Home', homeId, ''), dangerBtn('Close', closeId, ''));
}

export function confirmRow(confirmId: string, cancelId = 'confirm_cancel'): ActionRowBuilder<ButtonBuilder> {
  return row(successBtn('Confirm', confirmId, ''), dangerBtn('Cancel', cancelId, ''));
}

export function paginationRow(prevId: string, nextId: string, current: number, total: number): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    secondaryBtn('◀ Prev', prevId).setDisabled(current <= 1),
    new ButtonBuilder().setCustomId('page_display').setLabel(`${current} / ${total}`).setStyle(ButtonStyle.Secondary).setDisabled(true),
    secondaryBtn('Next ▶', nextId).setDisabled(current >= total),
  );
}

export function statsBlock(fields: Array<{ label: string; value: string | number }>): string {
  return fields.map(({ label, value }) => `**${label}:** ${value}`).join('\n');
}

/* Re-exports for convenience */
export {
  ContainerBuilder, SectionBuilder, TextDisplayBuilder, ThumbnailBuilder,
  SeparatorBuilder, SeparatorSpacingSize, ActionRowBuilder, ButtonBuilder,
  ButtonStyle, MediaGalleryBuilder, MediaGalleryItemBuilder, MessageFlags,
  StringSelectMenuBuilder,
};
