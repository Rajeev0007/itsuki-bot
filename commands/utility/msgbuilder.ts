import {
  SlashCommandBuilder, MessageFlags, PermissionFlagsBits, ChannelType,
  ContainerBuilder, TextDisplayBuilder, SeparatorBuilder, SeparatorSpacingSize,
  type ChatInputCommandInteraction, type AutocompleteInteraction,
  type TextChannel, type GuildMember,
} from 'discord.js';
import { Command } from '../../structures/Command';
import {
  openBuilder, loadSaved, listSaved, deleteSaved,
} from '../../services/TemplateBuilderUI';
import {
  emptyTemplate, renderTemplate, isRenderable,
  type TemplateStyle,
} from '../../services/MessageTemplate';
import * as CB from '../../builders/ComponentBuilder';
import logger from '../../utils/Logger';

/** Template names become JSON keys, so `.` (which nests) and `:` are rejected. */
const NAME_RE = /^[a-z0-9_-]{1,32}$/;

function normaliseName(raw: string | null): string | null {
  const name = (raw ?? '').trim().toLowerCase();
  return NAME_RE.test(name) ? name : null;
}

/**
 * Free-form message builder.
 *
 * Two ways to use it, matching the welcomer:
 *   compose — build a one-off message and post it straight to a channel
 *   create  — save a named, reusable template you can edit and re-send later
 * Either can render as a classic embed or as Components V2, switchable at any
 * time from inside the builder without losing content.
 */
export default new Command({
  data: new SlashCommandBuilder()
    .setName('msgbuilder').setDescription('Build custom embed or Components V2 messages.')
    .addSubcommand((s) => s.setName('compose').setDescription('Build a one-off message and post it')
      .addChannelOption((o) => o.setName('channel').setDescription('Where to post it').setRequired(true)
        .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement))
      .addStringOption((o) => o.setName('style').setDescription('Rendering style')
        .addChoices({ name: 'Embed (classic)', value: 'embed' }, { name: 'Components V2 (modern)', value: 'v2' })))
    .addSubcommand((s) => s.setName('create').setDescription('Build and save a reusable named template')
      .addStringOption((o) => o.setName('name').setDescription('Short name, e.g. rules-header').setRequired(true))
      .addStringOption((o) => o.setName('style').setDescription('Rendering style')
        .addChoices({ name: 'Embed (classic)', value: 'embed' }, { name: 'Components V2 (modern)', value: 'v2' })))
    .addSubcommand((s) => s.setName('edit').setDescription('Re-open a saved template in the builder')
      .addStringOption((o) => o.setName('name').setDescription('Saved template').setRequired(true).setAutocomplete(true)))
    .addSubcommand((s) => s.setName('send').setDescription('Post a saved template to a channel')
      .addStringOption((o) => o.setName('name').setDescription('Saved template').setRequired(true).setAutocomplete(true))
      .addChannelOption((o) => o.setName('channel').setDescription('Where to post it').setRequired(true)
        .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)))
    .addSubcommand((s) => s.setName('list').setDescription('List this server\'s saved templates'))
    .addSubcommand((s) => s.setName('delete').setDescription('Delete a saved template')
      .addStringOption((o) => o.setName('name').setDescription('Saved template').setRequired(true).setAutocomplete(true)))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages),
  category: 'utility',
  guildOnly: true,
  permissions: ['ManageMessages'],
  cooldown: 3_000,

  async autocomplete(interaction: AutocompleteInteraction) {
    try {
      if (!interaction.guildId) return interaction.respond([]);
      const focused = (interaction.options.getFocused() ?? '').toString().toLowerCase();
      const names = await listSaved(interaction.guildId);
      return interaction.respond(
        names.filter((n) => n.includes(focused)).slice(0, 25).map((n) => ({ name: n, value: n })),
      );
    } catch {
      // Autocomplete must always answer or the client shows a loading spinner.
      return interaction.respond([]).catch(() => null);
    }
  },

  async execute(interaction: ChatInputCommandInteraction) {
    await interaction.deferReply({
      flags: (MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral) as never,
    });

    const sub = (interaction.options as { getSubcommand: () => string }).getSubcommand();
    const SUBCOMMANDS = ['compose', 'create', 'edit', 'send', 'list', 'delete'];
    if (!SUBCOMMANDS.includes(sub)) {
      return interaction.editReply({ ...CB.errorResponse(
        'Unknown Subcommand', `Use one of: ${SUBCOMMANDS.map((s) => `\`${s}\``).join(', ')}.`,
      ) } as never);
    }

    const guild = interaction.guild!;

    /** Both the bot and the caller must be able to post there. */
    const checkChannel = (channel: TextChannel): string | null => {
      const me = guild.members.me;
      const mine = me ? channel.permissionsFor(me) : null;
      if (!mine?.has(PermissionFlagsBits.ViewChannel) || !mine?.has(PermissionFlagsBits.SendMessages)) {
        return `I need **View Channel** and **Send Messages** in ${channel}.`;
      }
      // Without this check the command would be a way to speak in channels the
      // caller has no access to.
      const theirs = channel.permissionsFor(interaction.member as GuildMember);
      if (!theirs?.has(PermissionFlagsBits.ViewChannel) || !theirs?.has(PermissionFlagsBits.SendMessages)) {
        return `You don't have permission to send messages in ${channel}.`;
      }
      return null;
    };

    // ── list ────────────────────────────────────────────────────────────────
    if (sub === 'list') {
      const names = await listSaved(guild.id);
      const container = new ContainerBuilder()
        .addTextDisplayComponents(new TextDisplayBuilder().setContent('# 💾 Saved Templates'))
        .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true));

      if (!names.length) {
        container.addTextDisplayComponents(new TextDisplayBuilder().setContent([
          'No templates saved yet.',
          '',
          'Create one with `/msgbuilder create name:my-template`,',
          'or post a one-off message with `/msgbuilder compose channel:#…`.',
        ].join('\n')));
      } else {
        const lines = await Promise.all(names.slice(0, 25).map(async (n) => {
          const tpl = await loadSaved(guild.id, n);
          const style = tpl?.style === 'v2' ? 'V2' : 'Embed';
          const title = tpl?.title?.trim() || tpl?.description?.trim() || '*no title*';
          return `\`${n}\` — **${style}** · ${title.slice(0, 60)}`;
        }));
        container.addTextDisplayComponents(new TextDisplayBuilder().setContent(lines.join('\n')))
          .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true))
          .addTextDisplayComponents(new TextDisplayBuilder().setContent(
            `-# ${names.length} saved${names.length > 25 ? ' (showing 25)' : ''} · edit with \`/msgbuilder edit\``,
          ));
      }
      return interaction.editReply({ components: [container] });
    }

    // ── delete ──────────────────────────────────────────────────────────────
    if (sub === 'delete') {
      const name = normaliseName(interaction.options.getString('name'));
      if (!name) {
        return interaction.editReply({ ...CB.errorResponse('Invalid Name', 'Names use letters, numbers, `-` and `_` only.') } as never);
      }
      const removed = await deleteSaved(guild.id, name);
      return interaction.editReply({
        ...(removed
          ? CB.successResponse('Template Deleted', `\`${name}\` is gone.`)
          : CB.errorResponse('Not Found', `No saved template called \`${name}\`. See \`/msgbuilder list\`.`)),
      } as never);
    }

    // ── send ────────────────────────────────────────────────────────────────
    if (sub === 'send') {
      const name = normaliseName(interaction.options.getString('name'));
      if (!name) {
        return interaction.editReply({ ...CB.errorResponse('Invalid Name', 'Names use letters, numbers, `-` and `_` only.') } as never);
      }
      const tpl = await loadSaved(guild.id, name);
      if (!tpl) {
        return interaction.editReply({ ...CB.errorResponse('Not Found', `No saved template called \`${name}\`. See \`/msgbuilder list\`.`) } as never);
      }
      if (!isRenderable(tpl)) {
        return interaction.editReply({ ...CB.errorResponse('Template Empty', `\`${name}\` has no content. Edit it with \`/msgbuilder edit name:${name}\`.`) } as never);
      }

      const channel = interaction.options.getChannel('channel') as TextChannel | null;
      if (!channel) return interaction.editReply({ ...CB.errorResponse('Missing Channel', 'Pick a channel.') } as never);
      const problem = checkChannel(channel);
      if (problem) return interaction.editReply({ ...CB.errorResponse('Cannot Post There', problem) } as never);

      try {
        const sent = await channel.send(renderTemplate(tpl, {
          member: interaction.member as GuildMember, user: interaction.user, guild,
        }) as never);
        return interaction.editReply({ ...CB.successResponse(
          'Message Sent', `\`${name}\` was posted in ${channel}.\n-# [Jump to it](${sent.url})`,
        ) } as never);
      } catch (err) {
        logger.warn(`[MsgBuilder] Send failed: ${(err as Error).message}`);
        return interaction.editReply({ ...CB.errorResponse('Send Failed', (err as Error).message) } as never);
      }
    }

    // ── edit ────────────────────────────────────────────────────────────────
    if (sub === 'edit') {
      const name = normaliseName(interaction.options.getString('name'));
      if (!name) {
        return interaction.editReply({ ...CB.errorResponse('Invalid Name', 'Names use letters, numbers, `-` and `_` only.') } as never);
      }
      const tpl = await loadSaved(guild.id, name);
      if (!tpl) {
        return interaction.editReply({ ...CB.errorResponse('Not Found', `No saved template called \`${name}\`. Create it with \`/msgbuilder create name:${name}\`.`) } as never);
      }
      return openBuilder(interaction, { target: `msg:${name}`, template: tpl, ownerId: interaction.user.id });
    }

    const style = (interaction.options.getString('style') ?? 'embed') as TemplateStyle;
    const safeStyle: TemplateStyle = style === 'v2' ? 'v2' : 'embed';

    // ── create ──────────────────────────────────────────────────────────────
    if (sub === 'create') {
      const name = normaliseName(interaction.options.getString('name'));
      if (!name) {
        return interaction.editReply({ ...CB.errorResponse(
          'Invalid Name',
          'Use 1–32 characters: letters, numbers, `-` and `_` only.\n-# Example: `rules-header`',
        ) } as never);
      }
      // Re-opening an existing name loads it rather than silently wiping it.
      const existing = await loadSaved(guild.id, name);
      return openBuilder(interaction, {
        target: `msg:${name}`,
        template: existing ?? emptyTemplate(safeStyle),
        ownerId: interaction.user.id,
      });
    }

    // ── compose ─────────────────────────────────────────────────────────────
    const channel = interaction.options.getChannel('channel') as TextChannel | null;
    if (!channel) return interaction.editReply({ ...CB.errorResponse('Missing Channel', 'Pick a channel.') } as never);
    const problem = checkChannel(channel);
    if (problem) return interaction.editReply({ ...CB.errorResponse('Cannot Post There', problem) } as never);

    return openBuilder(interaction, {
      target: `send:${channel.id}`,
      template: emptyTemplate(safeStyle),
      ownerId: interaction.user.id,
    });
  },
});
