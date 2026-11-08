// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Built-in avatars (product decision: "א' — חיות"): eight friendly animals, our own drawings in our
 * palette, each on a soft background. People pick one in their profile (drawn to a PNG and saved as their photo);
 * agents carry one as a code in their `avatar` (`animal:<id>:<background>`), which the server also writes as the
 * agent user's image, so an agent shows its animal everywhere a person shows a photo (13:13).
 */
const INK = '#13221f';
const W = '#ffffff';
const eyes = (y = 50, dx = 10, r = 3.6, c = INK) =>
  `<circle cx="${50 - dx}" cy="${y}" r="${r}" fill="${c}"/><circle cx="${50 + dx}" cy="${y}" r="${r}" fill="${c}"/>`;
const smile = (y = 60, w = 8, c = INK, sw = 3) =>
  `<path d="M${50 - w} ${y} Q50 ${y + w * 0.85} ${50 + w} ${y}" fill="none" stroke="${c}" stroke-width="${sw}" stroke-linecap="round"/>`;
const cheeks = (y = 60, dx = 19, c = '#ff98a4') =>
  `<circle cx="${50 - dx}" cy="${y}" r="4.5" fill="${c}" opacity=".75"/><circle cx="${50 + dx}" cy="${y}" r="4.5" fill="${c}" opacity=".75"/>`;

export type AvatarArt = { id: string; bg: string; body: string };

export const AVATAR_ANIMALS: AvatarArt[] = [
  {
    id: 'fox',
    bg: '#fbc68c',
    body: `<path d="M20 30 L33 62 L22 70 Z" fill="#eb4600"/><path d="M80 30 L67 62 L78 70 Z" fill="#eb4600"/>
<path d="M22 34 L30 56 L26 58 Z" fill="${W}" opacity=".6"/><path d="M78 34 L70 56 L74 58 Z" fill="${W}" opacity=".6"/>
<path d="M50 92 C28 92 18 74 20 56 C24 46 36 40 50 40 C64 40 76 46 80 56 C82 74 72 92 50 92 Z" fill="#eb4600"/>
<path d="M50 92 C38 92 30 82 30 72 C38 70 44 74 50 80 C56 74 62 70 70 72 C70 82 62 92 50 92 Z" fill="${W}"/>
${eyes(60, 12, 3.8)}<circle cx="50" cy="78" r="4" fill="${INK}"/>${cheeks(70, 21)}`,
  },
  {
    id: 'cat',
    bg: '#c4ccdb',
    body: `<path d="M22 28 L36 46 L20 52 Z" fill="#7b8db0"/><path d="M78 28 L64 46 L80 52 Z" fill="#7b8db0"/>
<path d="M24 34 L32 45 L24 48 Z" fill="#ff98a4"/><path d="M76 34 L68 45 L76 48 Z" fill="#ff98a4"/>
<circle cx="50" cy="64" r="32" fill="#7b8db0"/><path d="M40 36 L44 46 M50 34 L50 45 M60 36 L56 46" stroke="#57616b" stroke-width="3" stroke-linecap="round"/>
${eyes(60, 12, 4)}<path d="M47 68 L53 68 L50 72 Z" fill="#ff98a4"/>${smile(73, 6, INK, 2.6)}
<path d="M28 70 L14 67 M28 75 L14 77 M72 70 L86 67 M72 75 L86 77" stroke="${W}" stroke-width="2" stroke-linecap="round"/>`,
  },
  {
    id: 'bear',
    bg: '#d7f3e2',
    body: `<circle cx="24" cy="36" r="12" fill="#8a480f"/><circle cx="76" cy="36" r="12" fill="#8a480f"/>
<circle cx="24" cy="36" r="6" fill="#de8c45"/><circle cx="76" cy="36" r="6" fill="#de8c45"/>
<circle cx="50" cy="62" r="34" fill="#8a480f"/><ellipse cx="50" cy="73" rx="15" ry="12" fill="#de8c45"/>
${eyes(56, 13, 4)}<ellipse cx="50" cy="68" rx="5.5" ry="4" fill="${INK}"/>${smile(75, 5, INK, 2.6)}${cheeks(66, 24)}`,
  },
  {
    id: 'owl',
    bg: '#dcc5fe',
    body: `<path d="M24 30 L36 42 L22 46 Z M76 30 L64 42 L78 46 Z" fill="#480f8a"/>
<ellipse cx="50" cy="66" rx="32" ry="34" fill="#755fe3"/><ellipse cx="50" cy="80" rx="18" ry="16" fill="#dcc5fe"/>
<path d="M42 78 Q46 82 50 78 Q54 82 58 78 M40 86 Q45 90 50 86 Q55 90 60 86" stroke="#755fe3" stroke-width="2" fill="none" stroke-linecap="round"/>
<circle cx="37" cy="54" r="12" fill="${W}"/><circle cx="63" cy="54" r="12" fill="${W}"/>
<circle cx="38" cy="55" r="5.5" fill="${INK}"/><circle cx="62" cy="55" r="5.5" fill="${INK}"/>
<circle cx="40" cy="53" r="1.8" fill="${W}"/><circle cx="64" cy="53" r="1.8" fill="${W}"/><path d="M46 64 L54 64 L50 71 Z" fill="#f58000"/>`,
  },
  {
    id: 'bunny',
    bg: '#ffbac2',
    body: `<ellipse cx="37" cy="26" rx="8" ry="22" fill="${W}"/><ellipse cx="63" cy="26" rx="8" ry="22" fill="${W}"/>
<ellipse cx="37" cy="27" rx="4" ry="15" fill="#ff98a4"/><ellipse cx="63" cy="27" rx="4" ry="15" fill="#ff98a4"/>
<circle cx="50" cy="66" r="30" fill="${W}"/>${eyes(62, 11, 3.8)}<ellipse cx="50" cy="70" rx="3.5" ry="2.6" fill="#e5309a"/>
<path d="M50 72 L50 76 M50 76 Q46 80 43 77 M50 76 Q54 80 57 77" stroke="${INK}" stroke-width="2.4" fill="none" stroke-linecap="round"/>${cheeks(72, 20)}`,
  },
  {
    id: 'panda',
    bg: '#bacefb',
    body: `<circle cx="24" cy="36" r="11" fill="${INK}"/><circle cx="76" cy="36" r="11" fill="${INK}"/>
<circle cx="50" cy="63" r="33" fill="${W}"/><ellipse cx="37" cy="58" rx="9" ry="11" fill="${INK}" transform="rotate(-20 37 58)"/>
<ellipse cx="63" cy="58" rx="9" ry="11" fill="${INK}" transform="rotate(20 63 58)"/>
<circle cx="38" cy="57" r="3" fill="${W}"/><circle cx="62" cy="57" r="3" fill="${W}"/>
<ellipse cx="50" cy="71" rx="5" ry="3.6" fill="${INK}"/>${smile(77, 5, INK, 2.6)}${cheeks(73, 22)}`,
  },
  {
    id: 'frog',
    bg: '#fcd9b3',
    body: `<circle cx="32" cy="38" r="14" fill="#6eaa0e"/><circle cx="68" cy="38" r="14" fill="#6eaa0e"/>
<ellipse cx="50" cy="68" rx="38" ry="28" fill="#6eaa0e"/><circle cx="32" cy="38" r="8" fill="${W}"/><circle cx="68" cy="38" r="8" fill="${W}"/>
<circle cx="33" cy="39" r="4.4" fill="${INK}"/><circle cx="67" cy="39" r="4.4" fill="${INK}"/>
<path d="M30 70 Q50 86 70 70" fill="none" stroke="${INK}" stroke-width="3" stroke-linecap="round"/>${cheeks(70, 27)}`,
  },
  {
    id: 'penguin',
    bg: '#b4e8da',
    body: `<ellipse cx="50" cy="70" rx="34" ry="38" fill="#0e3c7c"/><ellipse cx="50" cy="74" rx="24" ry="30" fill="${W}"/>
<path d="M26 40 Q50 22 74 40 Q66 50 50 50 Q34 50 26 40 Z" fill="#0e3c7c"/>${eyes(58, 10, 3.8)}
<path d="M44 66 L56 66 L50 73 Z" fill="#f58000"/>${cheeks(68, 19)}`,
  },
];

/**
 * The backgrounds a viewer can pick: soft tints of our palette (blue, amber, green, purple, rose, sage, grey and
 * a stronger amber) — the same tints each animal starts on.
 */
export const AVATAR_BACKGROUNDS = [
  '#bacefb',
  '#fcd9b3',
  '#d7f3e2',
  '#dcc5fe',
  '#ffbac2',
  '#b4e8da',
  '#c4ccdb',
  '#fbc68c',
] as const;

/** One avatar as a standalone SVG document on `bg` (its own background when none is given). */
export const avatarSvg = (art: AvatarArt, bg: string = art.bg, size?: number) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"${size ? ` width="${size}" height="${size}"` : ''}>` +
  `<defs><clipPath id="c"><circle cx="50" cy="50" r="50"/></clipPath></defs>` +
  `<g clip-path="url(#c)"><rect width="100" height="100" fill="${bg}"/>${art.body}</g></svg>`;

/** The SVG as a URL an `<img>` (or a user's `image`) shows. */
export const avatarDataUrl = (art: AvatarArt, bg?: string) =>
  `data:image/svg+xml;charset=utf-8,${encodeURIComponent(avatarSvg(art, bg))}`;

// ---------------------------------------------------------------- agents: the avatar as a code

/** An agent's avatar that its own AI picks when it is created (resolved to a code on the server). */
export const AGENT_AVATAR_AUTO = 'animal:auto';
const CODE = /^animal:([a-z]+):([0-7])$/;

/** `animal:<id>:<background index>` — at most 16 characters (the agents.avatar column). */
export const animalAvatarCode = (id: string, bg: number) => `animal:${id}:${bg}`;

/** The animal and background of a code; null for anything else (an emoji, letters, "animal:auto"). */
export const parseAnimalAvatar = (
  v: string | null | undefined,
): { art: AvatarArt; bg: string; bgIndex: number } | null => {
  const m = v ? CODE.exec(v) : null;
  const art = m ? AVATAR_ANIMALS.find((a) => a.id === m[1]) : undefined;
  if (!m || !art) return null;
  const bgIndex = Number(m[2]);
  return { art, bg: AVATAR_BACKGROUNDS[bgIndex]!, bgIndex };
};

/** A code's picture as a data URL (null when the value is not an animal code). */
export const animalAvatarDataUrl = (v: string | null | undefined) => {
  const p = parseAnimalAvatar(v);
  return p ? avatarDataUrl(p.art, p.bg) : null;
};

/** The animal's own background index (where it starts in the picker). */
export const ownBackground = (art: AvatarArt) => Math.max(0, AVATAR_BACKGROUNDS.indexOf(art.bg as never));

/** A stable pick from a text (an agent's name and role): the same text, the same animal. */
export const pickAnimalAvatar = (seed: string) => {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 16777619);
  const n = h >>> 0;
  const art = AVATAR_ANIMALS[n % AVATAR_ANIMALS.length]!;
  return animalAvatarCode(art.id, ownBackground(art));
};

/** A random animal on its own background. */
export const randomAnimalAvatar = (random: () => number = Math.random) => {
  const art = AVATAR_ANIMALS[Math.floor(random() * AVATAR_ANIMALS.length)]!;
  return animalAvatarCode(art.id, ownBackground(art));
};

/** An agent's avatar value: up to 8 characters of text (an emoji, letters), an animal code, or "animal:auto". */
export const isAgentAvatarValue = (v: string) => v.length <= 8 || CODE.test(v) || v === AGENT_AVATAR_AUTO;
