/**
 * @file eval.ts
 * @description Owner-only debugging command — runs a JS expression in the
 * bot's process and returns the result. Restricted to config.owners via the
 * ownerOnly guard enforced in interactionCreate.ts/messageCreate.ts.
 */

import {
  SlashCommandBuilder, MessageFlags,
  type ChatInputCommandInteraction, type Client,
} from 'discord.js';
import { Command } from '../../structures/Command';
import config      from '../../config/config';
import * as CB      from '../../builders/ComponentBuilder';

const IS_V2 = Number(MessageFlags.IsComponentsV2);

/** Redact anything that looks like the bot token or another secret before display. */
function redact(str: string): string {
  let out = str;
  if (config.token) out = out.split(config.token).join('[REDACTED_TOKEN]');
  return out.replace(/[\w-]{24,}\.[\w-]{6,}\.[\w-]{27,}/g, '[REDACTED_TOKEN]');
}

export default new Command({
  data: new SlashCommandBuilder()
    .setName('eval')
    .setDescription('(Owner) Evaluate a JavaScript expression.')
    .addStringOption((o) =>
      o.setName('code').setDescription('The code to run.').setRequired(true)
    )
    .addBooleanOption((o) =>
      o.setName('silent').setDescription('Only show whether it succeeded, not the output.').setRequired(false)
    ),

  category:  'owner',
  ownerOnly: true,
  cooldown:  0,

  async execute(interaction: ChatInputCommandInteraction, client?: Client) {
    await interaction.deferReply({ flags: IS_V2 as never });

    const code   = interaction.options.getString('code', true);
    const silent = interaction.options.getBoolean('silent') ?? false;

    const started = Date.now();
    try {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const bot = client; // exposed as `bot` inside eval scope for convenience
      // eslint-disable-next-line no-eval
      let result = await eval(code);
      const ms = Date.now() - started;

      if (silent) {
        return interaction.editReply(
          CB.successResponse('Eval Succeeded', `Ran in ${ms}ms.`) as never,
        );
      }

      if (typeof result !== 'string') {
        try { result = require('util').inspect(result, { depth: 1 }); }
        catch { result = String(result); }
      }
      const output = redact(String(result)).slice(0, 1800);

      return interaction.editReply(
        CB.successResponse('Eval Result', `\`\`\`js\n${output || 'undefined'}\n\`\`\`\n-# Ran in ${ms}ms`) as never,
      );
    } catch (err) {
      const message = redact((err as Error).message ?? String(err)).slice(0, 1800);
      return interaction.editReply(
        CB.errorResponse('Eval Threw', `\`\`\`js\n${message}\n\`\`\``) as never,
      );
    }
  },
});
