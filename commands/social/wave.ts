import { createSocialCommand } from '../../utils/SocialCommandFactory';

export default createSocialCommand({
  action:    'wave',
  emoji:     '👋',
  pastTense: 'waved at',
  plural:    'waves',
  soloText:  'is waving',
  category:  'social',
});
