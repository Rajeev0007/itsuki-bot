import {
  SlashCommandBuilder, MessageFlags, ContainerBuilder, SectionBuilder,
  TextDisplayBuilder, SeparatorBuilder, SeparatorSpacingSize, ThumbnailBuilder,
  type ChatInputCommandInteraction,
} from 'discord.js';
import { Command }    from '../../structures/Command';
import UserManager    from '../../managers/UserManager';
import * as CB        from '../../builders/ComponentBuilder';
import fmt            from '../../utils/Formatter';
import config         from '../../config/config';
import ProgressBar    from '../../utils/ProgressBar';
import { getStore }   from '../../database/JsonStore';

const petsDB = getStore('pets');
const PET_TYPES = config.pets.types;

interface PetData {
  type: string; name: string; emoji: string; hunger: number; happiness: number;
  health: number; xp: number; level: number; adoptedAt: number; lastFed: number; lastPlayed: number;
}

export default new Command({
  data: new SlashCommandBuilder()
    .setName('pet').setDescription('Manage your virtual pet.')
    .addSubcommand((s) => s.setName('view').setDescription('View your pet'))
    .addSubcommand((s) => s.setName('adopt').setDescription('Adopt a new pet')
      .addStringOption((o) => o.setName('type').setDescription('Pet type').setRequired(true)
        .addChoices(...PET_TYPES.map((p) => ({ name: `${p.name}`, value: p.id }))))
      .addStringOption((o) => o.setName('name').setDescription('Name your pet').setRequired(true).setMaxLength(20)))
    .addSubcommand((s) => s.setName('feed').setDescription('Feed your pet'))
    .addSubcommand((s) => s.setName('play').setDescription('Play with your pet'))
    .addSubcommand((s) => s.setName('train').setDescription('Train your pet')),
  category: 'pets', cooldown: 3000,
  async execute(interaction: ChatInputCommandInteraction) {
    await interaction.deferReply({ flags: MessageFlags.IsComponentsV2 as any });
    const sub = (interaction.options as { getSubcommand: () => string }).getSubcommand();
    const av  = interaction.user.displayAvatarURL({ size: 256 });

    if (sub === 'adopt') {
      const existing = await petsDB.get(`${interaction.user.id}.pet`) as PetData | null;
      if (existing) return interaction.editReply({ ...CB.errorResponse('Already Have a Pet', `You already have **${existing.name}**!`) } as never);
      const typeId = interaction.options.get('type')!.value as string;
      const name   = (interaction.options.get('name')!.value as string).slice(0, 20);
      const type   = PET_TYPES.find((p) => p.id === typeId);
      if (!type)     return interaction.editReply({ ...CB.errorResponse('Invalid Type', 'That pet type does not exist.') } as never);
      const cost = config.pets.adoptCost;
      const { wallet } = await UserManager.getBalance(interaction.user.id);
      if (wallet < cost) return interaction.editReply({ ...CB.errorResponse('Insufficient Funds', `Adopting costs ${fmt.coins(cost)}.`) } as never);
      await UserManager.addWallet(interaction.user.id, -cost);
      const pet: PetData = { type: typeId, name, emoji: '', hunger: 100, happiness: 100, health: 100, xp: 0, level: 1, adoptedAt: Date.now(), lastFed: Date.now(), lastPlayed: Date.now() };
      await petsDB.set(`${interaction.user.id}.pet`, pet);
      const c = new ContainerBuilder().addSectionComponents(new SectionBuilder().addTextDisplayComponents(
        new TextDisplayBuilder().setContent([`# You adopted **${name}**!`, 'Remember to feed and play daily!'].join('\n'))
      ).setThumbnailAccessory(new ThumbnailBuilder().setURL(av)));
      return interaction.editReply({ components: [c] });
    }

    const pet = await petsDB.get(`${interaction.user.id}.pet`) as PetData | null;
    if (!pet) return interaction.editReply({ ...CB.errorResponse('No Pet', 'Use `/pet adopt` to get one!') } as never);
    const hSinceF = (Date.now() - pet.lastFed) / 3_600_000;
    const hSinceP = (Date.now() - pet.lastPlayed) / 3_600_000;
    pet.hunger    = Math.max(0, pet.hunger - Math.floor(hSinceF * 5));
    pet.happiness = Math.max(0, pet.happiness - Math.floor(hSinceP * 3));
    if (pet.hunger === 0) pet.health = Math.max(0, pet.health - 5);

    if (sub === 'view') {
      const bars = [
        `Hunger ${ProgressBar.create(pet.hunger, 100, 10)} ${pet.hunger}%`,
        `Happiness ${ProgressBar.create(pet.happiness, 100, 10)} ${pet.happiness}%`,
        `Health ${ProgressBar.create(pet.health, 100, 10)} ${pet.health}%`,
        `XP ${ProgressBar.create(pet.xp % 100, 100, 10)} Level ${pet.level}`,
      ];
      const c = new ContainerBuilder()
        .addSectionComponents(new SectionBuilder().addTextDisplayComponents(
          new TextDisplayBuilder().setContent([`# ${pet.name}`, `*Level ${pet.level} ${PET_TYPES.find((p) => p.id === pet.type)?.name ?? pet.type}*`].join('\n'))
        ).setThumbnailAccessory(new ThumbnailBuilder().setURL(av)))
        .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Large).setDivider(true))
        .addTextDisplayComponents(new TextDisplayBuilder().setContent('```\n' + bars.join('\n') + '\n```'))
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(`-# Adopted ${fmt.fullTime(pet.adoptedAt)}`));
      return interaction.editReply({ components: [c] });
    }

    if (sub === 'feed') {
      if (Date.now() - pet.lastFed < 3_600_000) return interaction.editReply({ ...CB.errorResponse('Not Hungry', `${pet.name} isn't hungry yet.`) } as never);
      pet.hunger  = Math.min(100, pet.hunger + 40); pet.health = Math.min(100, pet.health + 5); pet.lastFed = Date.now();
      await petsDB.set(`${interaction.user.id}.pet`, pet);
      return interaction.editReply({ ...CB.successResponse('Fed!', `You fed **${pet.name}**! Hunger: ${pet.hunger}%`) } as never);
    }
    if (sub === 'play') {
      if (Date.now() - pet.lastPlayed < 3_600_000) return interaction.editReply({ ...CB.errorResponse('Tired', `${pet.name} needs rest.`) } as never);
      pet.happiness = Math.min(100, pet.happiness + 30); pet.xp += 10; pet.lastPlayed = Date.now();
      if (pet.xp >= pet.level * 100) { pet.xp = 0; pet.level++; }
      await petsDB.set(`${interaction.user.id}.pet`, pet);
      return interaction.editReply({ ...CB.successResponse('Played!', `You played with **${pet.name}**! Happiness: ${pet.happiness}%`) } as never);
    }
    if (sub === 'train') {
      const lastTrain = (await petsDB.get(`${interaction.user.id}.lastTrain`) ?? 0) as number;
      if (Date.now() - lastTrain < 14_400_000) return interaction.editReply({ ...CB.errorResponse('Tired', `${pet.name} is too tired.`) } as never);
      pet.xp += 25; if (pet.xp >= pet.level * 100) { pet.xp = 0; pet.level++; }
      await petsDB.set(`${interaction.user.id}.pet`, pet); await petsDB.set(`${interaction.user.id}.lastTrain`, Date.now());
      const reward = fmt.randomInt(50, 200); await UserManager.addWallet(interaction.user.id, reward);
      return interaction.editReply({ ...CB.successResponse('Trained!', `**${pet.name}** trained and earned you ${fmt.coins(reward)}! Level: ${pet.level}`) } as never);
    }
  },
});
