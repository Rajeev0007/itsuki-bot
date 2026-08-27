/**
 * @file bonk.ts
 * @description The /bonk roleplay command.
 *
 * Wording, counters and the GIF category all come from the shared registry, so
 * this file carries no behaviour of its own.
 */

import { createSocialCommand } from '../../utils/SocialCommandFactory';
import { getAction } from '../../config/actions';

export default createSocialCommand(getAction('bonk')!);
