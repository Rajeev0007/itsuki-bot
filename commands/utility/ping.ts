import {
  SlashCommandBuilder, MessageFlags, ContainerBuilder,
  TextDisplayBuilder, SeparatorBuilder, SeparatorSpacingSize,
  type ChatInputCommandInteraction,
} from 'discord.js';
import { Command } from '../../structures/Command';

export default new Command({
  data: new SlashCommandBuilder().setName('ping').setDescription("Check the bot's latency."),
  category: 'utility',
  async execute(interaction: ChatInputCommandInteraction) {
    const start = Date.now();
    await interaction.deferReply({ flags: MessageFlags.IsComponentsV2 as any });
    const rtt = Date.now() - start;
    const ws = interaction.client.ws.ping;
    const bar = (ms: number) => ms < 100 ? ' Excellent' : ms < 200 ? ' Good' : ms < 400 ? ' Average' : ' Poor';
    const c = new ContainerBuilder()
      .addTextDisplayComponents(new TextDisplayBuilder().setContent('# Pong!'))
      .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Large).setDivider(true))
      .addTextDisplayComponents(new TextDisplayBuilder().setContent([
        `**Websocket Ping:** ${ws}ms — ${bar(ws)}`,
        `**Round-Trip Time:** ${rtt}ms`,
        `**API Latency:** ${Math.round(interaction.client.ws.ping)}ms`,
      ].join('\n')));
    await interaction.editReply({ components: [c] });
  },
});
