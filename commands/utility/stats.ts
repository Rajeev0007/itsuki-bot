import {
  SlashCommandBuilder, MessageFlags, ContainerBuilder, SectionBuilder,
  TextDisplayBuilder, SeparatorBuilder, SeparatorSpacingSize,
  type ChatInputCommandInteraction,
} from 'discord.js';
import { Command } from '../../structures/Command';
import config from '../../config/config';
import fmt from '../../utils/Formatter';
import { getStore } from '../../database/JsonStore';

const usersDB = getStore('users');

export default new Command({
  data: new SlashCommandBuilder().setName('stats').setDescription('View bot statistics and info.'),
  category: 'utility', cooldown: 10_000,
  async execute(interaction: ChatInputCommandInteraction) {
    await interaction.deferReply({ flags: MessageFlags.IsComponentsV2 as any });
    const client = interaction.client;
    const guilds = client.guilds.cache.size;
    const users = client.users.cache.size;
    const up = process.uptime();
    const mem = process.memoryUsage();
    const allU = await usersDB.all();
    const total = Array.isArray(allU) ? allU.length : Object.keys(allU || {}).length;
    const upStr = `${Math.floor(up / 86400)}d ${Math.floor((up % 86400) / 3600)}h ${Math.floor((up % 3600) / 60)}m ${Math.floor(up % 60)}s`;
    const c = new ContainerBuilder()
      .addTextDisplayComponents(new TextDisplayBuilder().setContent([`# ${config.bot.name} Statistics`, `Version ${config.bot.version} • Discord.js v14`].join('\n')))
      .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Large).setDivider(true))
      .addTextDisplayComponents(new TextDisplayBuilder().setContent([
        '** Bot Info**', `> Guilds: **${guilds}**`, `> Cached Users: **${fmt.number(users)}**`, `> Uptime: **${upStr}**`, '',
        '** Database**', `> Registered Users: **${fmt.number(total)}**`, '',
        '** System**', `> RAM: **${(mem.heapUsed / 1024 / 1024).toFixed(1)} MB**`, `> WS Ping: **${client.ws.ping}ms**`, `> Node.js: **${process.version}**`,
      ].join('\n')))
      .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true))
      .addTextDisplayComponents(new TextDisplayBuilder().setContent(`-# ${config.bot.name} v${config.bot.version}`));
    await interaction.editReply({ components: [c] });
  },
});
