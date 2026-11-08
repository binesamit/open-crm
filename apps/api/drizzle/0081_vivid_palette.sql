-- Release E (D-PAL v2): the palette turns vivid. Label, group and tag colours are KEYS (0080), so they
-- render vivid with no data change. Support console tags are the one place that stores a hex: 0080 wrote our earthy
-- palette's light value there; each earthy hex (light or dark) → the vivid light value of its key (colors.ts
-- PALETTE / EARTHY_PALETTE_HEX, tested to match). The renamed keys brown / olive read as gold.
UPDATE "support_tags" t SET "color" = m.v
  FROM (VALUES ('#2e6b57', '#05b347'), ('#6fbf9f', '#05b347'), ('#9a6a0b', '#f58000'), ('#d9a24a', '#f58000'), ('#a3413f', '#ff1a35'), ('#db7f6a', '#ff1a35'), ('#21727a', '#00a5e0'), ('#7cb8b3', '#00a5e0'), ('#3d4677', '#4040e8'), ('#9d9be6', '#4040e8'), ('#655080', '#8a3ffc'), ('#bf9fd4', '#8a3ffc'), ('#5b7d33', '#6eaa0e'), ('#b3c98a', '#6eaa0e'), ('#b0592b', '#eb4600'), ('#eb9a69', '#eb4600'), ('#3a6488', '#1a5cf0'), ('#8ab8e0', '#1a5cf0'), ('#a8566e', '#e5309a'), ('#e3a1b4', '#e5309a'), ('#83674a', '#db8b00'), ('#cdb08e', '#db8b00'), ('#6e6a5e', '#7b8db0'), ('#b8b3a6', '#7b8db0'), ('#77702c', '#db8b00'), ('#c8c07a', '#db8b00'), ('#557a6d', '#05b382'), ('#a2c4b6', '#05b382'), ('#4f5f80', '#00abc2'), ('#a0aac8', '#00abc2'), ('#8a3d5c', '#c2006a'), ('#c97f9b', '#c2006a')) AS m(h, v)
  WHERE lower(t."color") = m.h;
