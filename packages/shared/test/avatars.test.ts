// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import {
  AGENT_AVATAR_AUTO,
  AVATAR_ANIMALS,
  AVATAR_BACKGROUNDS,
  animalAvatarCode,
  animalAvatarDataUrl,
  createAgentSchema,
  isAgentAvatarValue,
  parseAnimalAvatar,
  pickAnimalAvatar,
  randomAnimalAvatar,
} from '../src';

/** our animal avatars, and an agent's avatar as a code. */
describe('animal avatars', () => {
  it('a code names an animal and one of the backgrounds, and fits the agents.avatar column (16)', () => {
    for (const a of AVATAR_ANIMALS)
      for (let bg = 0; bg < AVATAR_BACKGROUNDS.length; bg++) {
        const code = animalAvatarCode(a.id, bg);
        expect(code.length).toBeLessThanOrEqual(16);
        expect(parseAnimalAvatar(code)).toEqual({ art: a, bg: AVATAR_BACKGROUNDS[bg], bgIndex: bg });
      }
  });

  it('anything else is not an animal: emoji, letters, auto, an unknown animal or background', () => {
    for (const v of [null, '', '🦊', 'AB', AGENT_AVATAR_AUTO, 'animal:unicorn:1', 'animal:fox:9', 'animal:fox'])
      expect(parseAnimalAvatar(v)).toBeNull();
    expect(animalAvatarDataUrl('🦊')).toBeNull();
    expect(animalAvatarDataUrl('animal:owl:3')).toMatch(/^data:image\/svg\+xml;charset=utf-8,%3Csvg/);
  });

  it('the stable pick gives the same animal for the same text; random gives a valid code', () => {
    expect(pickAnimalAvatar('Dana\nSales')).toBe(pickAnimalAvatar('Dana\nSales'));
    expect(parseAnimalAvatar(pickAnimalAvatar('anything'))).not.toBeNull();
    expect(parseAnimalAvatar(randomAnimalAvatar(() => 0))?.art.id).toBe(AVATAR_ANIMALS[0]!.id);
    expect(parseAnimalAvatar(randomAnimalAvatar(() => 0.999))?.art.id).toBe(AVATAR_ANIMALS.at(-1)!.id);
  });

  it("an agent's avatar accepts an animal, auto, or up to 8 characters of text — nothing longer", () => {
    for (const v of ['animal:penguin:7', AGENT_AVATAR_AUTO, '🤖', 'AB']) expect(isAgentAvatarValue(v)).toBe(true);
    expect(isAgentAvatarValue('not-an-animal-x')).toBe(false);
    const base = { name: 'A', connection_id: 'c1', model: 'm' };
    expect(createAgentSchema.parse({ ...base, avatar: 'animal:fox:2' }).avatar).toBe('animal:fox:2');
    expect(() => createAgentSchema.parse({ ...base, avatar: 'somethinglonger' })).toThrow();
  });
});
