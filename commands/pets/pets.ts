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
      const typeId = interaction.options.getString('type');
      const rawName = interaction.options.getString('name');
      if (!typeId || !rawName)
        return interaction.editReply({ ...CB.errorResponse('Missing Details', `Usage: \`/pet adopt <type> <name>\`. Types: ${PET_TYPES.map((p) => p.id).join(', ')}.`) } as never);
      const name   = rawName.trim().slice(0, 20);
      const type   = PET_TYPES.find((p) => p.id === typeId);
      if (!type)     return interaction.editReply({ ...CB.errorResponse('Invalid Type', `That pet type does not exist. Try: ${PET_TYPES.map((p) => p.id).join(', ')}.`) } as never);
      if (!name)     return interaction.editReply({ ...CB.errorResponse('Invalid Name', 'Give your pet a name.') } as never);
      const cost = config.pets.adoptCost;
      const { wallet } = await UserManager.getBalance(interaction.user.id);
      if (wallet < cost) return interaction.editReply({ ...CB.errorResponse('Insufficient Funds', `Adopting costs ${fmt.coins(cost)}.`) } as never);
      await UserManager.addWallet(interaction.user.id, -cost);
      const pet: PetData = { type: typeId, name, emoji: '', hunger: 100, happiness: 100, health: 100, xp: 0, level: 1, adoptedAt: Date.now(), lastFed: Date.now(), lastPlayed: Date.now() };
      await petsDB.set(`${interaction.user.id}.pet`, pet);
      // The "Pet Lover" achievement had no code path granting it.
      await UserManager.grantAchievement(interaction.user.id, 'pet_owner');
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

    /** Grants pet XP and levels up, carrying the overflow instead of dropping it. */
    const grantPetXp = (amount: number) => {
      pet.xp += amount;
      let needed = pet.level * 100;
      while (pet.xp >= needed) {
        pet.xp -= needed;
        pet.level++;
        needed = pet.level * 100;
      }
    };

    if (sub === 'feed') {
      // Cooldown comes from config instead of a hardcoded literal.
      if (Date.now() - pet.lastFed < config.pets.feedCooldown)
        return interaction.editReply({ ...CB.errorResponse('Not Hungry', `${pet.name} isn't hungry yet. Try again ${fmt.relativeTime(pet.lastFed + config.pets.feedCooldown)}.`) } as never);
      // config.pets.feedCost existed but was never charged — feeding was free.
      const { wallet: w } = await UserManager.getBalance(interaction.user.id);
      if (w < config.pets.feedCost)
        return interaction.editReply({ ...CB.errorResponse('Insufficient Funds', `Food costs ${fmt.coins(config.pets.feedCost)} and you only have ${fmt.coins(w)}.`) } as never);
      await UserManager.addWallet(interaction.user.id, -config.pets.feedCost);
      pet.hunger  = Math.min(100, pet.hunger + 40); pet.health = Math.min(100, pet.health + 5); pet.lastFed = Date.now();
      await petsDB.set(`${interaction.user.id}.pet`, pet);
      return interaction.editReply({ ...CB.successResponse('Fed!', `You fed **${pet.name}** for ${fmt.coins(config.pets.feedCost)}! Hunger: ${pet.hunger}%`) } as never);
    }
    if (sub === 'play') {
      if (Date.now() - pet.lastPlayed < config.pets.feedCooldown)
        return interaction.editReply({ ...CB.errorResponse('Tired', `${pet.name} needs rest. Try again ${fmt.relativeTime(pet.lastPlayed + config.pets.feedCooldown)}.`) } as never);
      pet.happiness = Math.min(100, pet.happiness + 30); pet.lastPlayed = Date.now();
      grantPetXp(10);
      await petsDB.set(`${interaction.user.id}.pet`, pet);
      return interaction.editReply({ ...CB.successResponse('Played!', `You played with **${pet.name}**! Happiness: ${pet.happiness}%`) } as never);
    }
    if (sub === 'train') {
      const lastTrain = Number(await petsDB.get(`${interaction.user.id}.lastTrain`, 0)) || 0;
      // Was hardcoded to 4 h while config said 2 h.
      if (Date.now() - lastTrain < config.pets.trainCooldown)
        return interaction.editReply({ ...CB.errorResponse('Tired', `${pet.name} is too tired. Try again ${fmt.relativeTime(lastTrain + config.pets.trainCooldown)}.`) } as never);
      // config.pets.trainCost was likewise never charged, so /pet train was a
      // pure coin faucet: no cost, plus a 50-200 payout every cooldown.
      const { wallet: w } = await UserManager.getBalance(interaction.user.id);
      if (w < config.pets.trainCost)
        return interaction.editReply({ ...CB.errorResponse('Insufficient Funds', `Training costs ${fmt.coins(config.pets.trainCost)} and you only have ${fmt.coins(w)}.`) } as never);
      await UserManager.addWallet(interaction.user.id, -config.pets.trainCost);
      grantPetXp(25);
      await petsDB.set(`${interaction.user.id}.pet`, pet);
      await petsDB.set(`${interaction.user.id}.lastTrain`, Date.now());
      const reward = fmt.randomInt(50, 200);
      await UserManager.addWallet(interaction.user.id, reward);
      return interaction.editReply({ ...CB.successResponse(
        'Trained!',
        `**${pet.name}** trained for ${fmt.coins(config.pets.trainCost)} and earned you ${fmt.coins(reward)}! Level: ${pet.level}`,
      ) } as never);
    }
  },
});
