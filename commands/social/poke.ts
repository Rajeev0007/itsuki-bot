import { createSocialCommand } from '../../utils/SocialCommandFactory';

export default createSocialCommand({
  action:    'poke',
  emoji:     '👉',
  pastTense: 'poked',
  plural:    'pokes',
  category:  'social',
});
