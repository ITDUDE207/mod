# UpEnchant (Minecraft Bedrock addon)

Adds a custom command, `/upenchant`, that lets you put enchantments on an item
above their normal maximum level, for example:

```
/upenchant sharpness 50
/upenchant looting 10
/upenchant protection 30
```

## Why this is not a one-liner

Bedrock's `/enchant` command refuses any level above the enchantment's vanilla
maximum, and the scripting API does too: `ItemEnchantableComponent.addEnchantment`
throws a level-out-of-bounds error for anything past the cap. There is no way to
store a real "Sharpness 50" on an item in current Bedrock.

So UpEnchant does two things:

1. It applies the **real** enchantment, clamped to its vanilla maximum, so the
   item is genuinely enchanted and shows the vanilla level.
2. It records the level you asked for on the item and then **drives the extra
   levels with scripted effects** so the item actually behaves like the level
   you requested (bonus damage, extra loot, stronger knockback, fire, damage
   reduction, thorns, ...).

That is the same approach used by other "max enchantments" addons on Bedrock.

## Install

1. Run `./build.sh` (or just download the built `upenchant.mcaddon`).
2. Open `upenchant.mcaddon` to import both packs, or copy `BP/` and `RP/`
   into your world's `behavior_packs/` and `resource_packs/` folders.
3. Enable **UpEnchant** under Behavior Packs.
4. Enable cheats and operator commands (the command requires operator
   permission). No experiment toggles are needed.

The pack targets Minecraft Bedrock **1.21.100+** and uses the stable
`@minecraft/server` 2.1.0 module.

## Usage

```
/upenchant <enchantment> <level>
/upenchant all <level>
```

- Run it while holding the item in your main hand (weapons, tools, bows), or
  while wearing the relevant armour piece (armour enchantments). For armour the
  pack uses the worn piece that already has UpEnchant data, otherwise the first
  enchantable armour slot.
- `all` is a bulk shortcut: it puts every weapon/tool/bow enchantment on the held
  item and every armour enchantment on each worn piece, in one command.
- The enchantment name is autocompleted. Level range is `1` to `100`.
- Levels at or below the vanilla cap behave exactly like vanilla.
- For a level above the cap, the pack first asks the engine to store the exact
  level. If your engine version accepts it, the item displays it natively
  (e.g. `Sharpness 50`). If the engine clamps to the vanilla max, the pack keeps
  the clamped enchantment, shows the requested level on the item's lore, and
  adds the scripted effect for the difference. Either way the item behaves like
  the level you asked for.

### Which enchantments get a real beyond-max effect

| Enchantment | Beyond-max effect |
| --- | --- |
| Sharpness | Bonus melee damage (`+1.25` per extra level) |
| Smite / Bane of Arthropods | Bonus damage vs undead / arthropods (`+2.5` per extra level) |
| Fire Aspect | Longer burn time |
| Knockback | Stronger knockback |
| Looting | Extra mob drops |
| Efficiency | `haste` while the tool is held |
| Power (bow) | Bonus arrow damage |
| Punch (bow) | Stronger arrow knockback |
| Flame (bow) | Longer burn time |
| Fortune | Extra block drops |
| Unbreaking | Chance to skip durability loss |
| Protection / Projectile / Fire / Blast / Feather Falling | Damage reduction vs the matching source |
| Thorns | Reflect damage |
| Respiration | Water breathing while worn |
| Depth Strider | `dolphins_grace` while worn |
| Soul Speed | `speed` while worn and standing on soul sand/soil |
| Aqua Affinity | `haste` while worn and underwater |
| Swift Sneak | `speed` while worn and sneaking (approximation) |

`Mending`, `Infinity` and `Silk Touch` are single-level enchantments with no
meaningful beyond-max effect, so requesting them above level 1 is refused rather
than recorded as a level that does nothing.

## Files

```
BP/manifest.json          behaviour pack manifest (script module)
BP/scripts/main.js        the command + scripted effects
RP/manifest.json          resource pack manifest (command text)
RP/texts/en_US.lang       command description string
build.sh                  zips BP/ + RP/ into upenchant.mcaddon
```

## Notes / limitations

- The engine only stores the vanilla level on the item; the higher number is
  shown in the item lore (`Sharpness L`) and tracked in an item dynamic
  property, and the gameplay effect is applied by scripts.
- Looting only adds drops for mobs in the pack's drop table. Mobs outside it
  fall back to a bone drop, which is not always lore-accurate.
- Values are tuned to be strong but not absurd; edit the multipliers at the
  top of each effect section in `BP/scripts/main.js` to taste.
