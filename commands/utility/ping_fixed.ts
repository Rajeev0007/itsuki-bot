import {
  SlashCommandBuilder,
  MessageFlags,
  ContainerBuilder,
  TextDisplayBuilder,
  SeparatorBuilder,
  SeparatorSpacingSize,
  type ChatInputCommandInteraction,
} from 'discord.js';
import { Command } from '../../structures/Command';

export default new Command({
  data: new SlashCommandBuilder()
    .setName('ping')
    .setDescription("Check the bot's latency."),

  category: 'utility',

  async execute(interaction: ChatInputCommandInteraction) {
    // Discord Gateway/WebSocket latency.
    // This is the most useful latency value for the bot's Discord connection.
    const wsPing = interaction.client.ws.ping;

    // Time from Discord creating the interaction until this handler starts.
    // This is NOT the same thing as network latency to Discord.
    const interactionLatency = Math.max(
      0,
      Date.now() - interaction.createdTimestamp,
    );

    const getStatus = (ms: number): string => {
      if (ms < 100) return 'Excellent';
      if (ms < 200) return 'Good';
      if (ms < 400) return 'Average';
      return 'High';
    };

    const formatPing = (ms: number): string => {
      if (!Number.isFinite(ms) || ms < 0) return 'N/A';
      return `${Math.round(ms)}ms`;
    };

    const container = new ContainerBuilder()
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent('# 🏓 Pong!'),
      )
      .addSeparatorComponents(
        new SeparatorBuilder()
          .setSpacing(SeparatorSpacingSize.Large)
          .setDivider(true),
      )
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          [
            `**Discord WebSocket:** ${formatPing(wsPing)} — ${getStatus(wsPing)}`,
            `**Interaction Latency:** ${formatPing(interactionLatency)}`,
            '',
            '> WebSocket latency represents the bot\'s live Discord Gateway connection.',
            '> Interaction latency includes Discord interaction delivery/processing and should not be treated as raw network ping.',
          ].join('\n'),
        ),
      );

    await interaction.reply({
      components: [container],
      flags: MessageFlags.IsComponentsV2,
    });
  },
});
