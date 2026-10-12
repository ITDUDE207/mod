import {
  world,
  system,
  CommandPermissionLevel,
  CustomCommandStatus,
  CustomCommandParamType,
  Player,
  EntityComponentTypes,
  ItemComponentTypes,
  EquipmentSlot,
  EnchantmentType,
  EntityDamageCause,
  ItemStack,
} from "@minecraft/server";

/*
 * /upenchant - apply enchantments above their vanilla level cap.
 *
 * The Bedrock engine refuses to store a level above an enchantment's vanilla
 * maximum (ItemEnchantableComponent.addEnchantment throws a level-out-of-bounds
 * error). So this pack applies the real enchantment clamped to its vanilla max,
 * records the requested level on the item (lore + dynamic property), and then
 * drives the extra levels with scripted effects: bonus melee damage, extra
 * loot, stronger knockback, fire, protection, thorns, ...
 *
 * The result is a "Sharpness 50" sword that actually hits like Sharpness 50.
 */

/* =====================================================================
   Enchantment table
   ===================================================================== */

// group: weapon = held weapon, tool = held tool, armor = equipped armour,
//        bow = held bow/crossbow, special = engine only (no scripted effect)
const ENCHANTS = {
  sharpness: { max: 5, group: "weapon" },
  smite: { max: 5, group: "weapon" },
  bane_of_arthropods: { max: 5, group: "weapon" },
  fire_aspect: { max: 2, group: "weapon" },
  knockback: { max: 2, group: "weapon" },
  looting: { max: 3, group: "weapon" },
  efficiency: { max: 5, group: "tool" },
  fortune: { max: 3, group: "tool" },
  unbreaking: { max: 3, group: "tool" },
  protection: { max: 4, group: "armor" },
  projectile_protection: { max: 4, group: "armor" },
  fire_protection: { max: 4, group: "armor" },
  blast_protection: { max: 4, group: "armor" },
  feather_falling: { max: 4, group: "armor" },
  thorns: { max: 3, group: "armor" },
  respiration: { max: 3, group: "armor" },
  depth_strider: { max: 3, group: "armor" },
  soul_speed: { max: 3, group: "armor" },
  aqua_affinity: { max: 1, group: "armor" },
  swift_sneak: { max: 3, group: "armor" },
  power: { max: 5, group: "bow" },
  punch: { max: 2, group: "bow" },
  flame: { max: 1, group: "bow" },
  mending: { max: 1, group: "special" },
  infinity: { max: 1, group: "special" },
  silk_touch: { max: 1, group: "special" },
};

// "special" enchantments only exist at level 1 and have no scripted effect, so a
// request above their cap is refused instead of recorded as a phantom level.
const isSimulated = (def) => def.group !== "special";

// Every enchantment that /upenchant can target, plus "all" for the bulk command.
const COMMAND_ENCHANTS = ["all", ...Object.keys(ENCHANTS)];

const HARD_MAX = 100;
const ENCHANT_DP = "upenchant:data";

const ARMOR_SLOTS = [EquipmentSlot.Head, EquipmentSlot.Chest, EquipmentSlot.Legs, EquipmentSlot.Feet];

/* =====================================================================
   Small helpers
   ===================================================================== */

const ROMAN = ["", "I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X"];

const prettify = (key) =>
  key
    .split("_")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");

const getEnchantable = (itemStack) => itemStack?.getComponent(ItemComponentTypes.Enchantable);

const nsId = (key) => `minecraft:${key}`;

// Levels that the engine stored natively are already handled by vanilla, so only
// the difference it refused (clamped entries) needs scripted effects.
const simExtra = (data, key, max) => {
  const entry = data[key];
  return entry && !entry.native ? Math.max(0, entry.level - max) : 0;
};

function readData(itemStack) {
  try {
    const raw = itemStack.getDynamicProperty(ENCHANT_DP);
    if (typeof raw !== "string") return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch (e) {
    return {};
  }
}

function writeData(itemStack, data) {
  const kept = {};
  for (const [key, value] of Object.entries(data)) {
    if (value && value.level > 0) kept[key] = value;
  }
  try {
    if (Object.keys(kept).length === 0) itemStack.setDynamicProperty(ENCHANT_DP, undefined);
    else itemStack.setDynamicProperty(ENCHANT_DP, JSON.stringify(kept));
  } catch (e) {
    /* dynamic properties may be unavailable on some stacks */
  }
}

function writeLore(itemStack, data) {
  const lines = [];
  for (const key of Object.keys(data)) {
    const entry = data[key];
    // When the engine stored the full level, the item already shows it natively,
    // so only add a lore line for levels that had to be clamped.
    if (entry.level > ENCHANTS[key].max && !entry.native) {
      lines.push(`§7${prettify(key)} ${entry.level}`);
    }
  }
  try {
    itemStack.setLore(lines.length ? lines : undefined);
  } catch (e) {
    /* lore is cosmetic */
  }
}

function getHeldItem(player) {
  return player.getComponent(EntityComponentTypes.Equippable)?.getEquipment(EquipmentSlot.Mainhand);
}

function sumArmorExtra(player, enchantKey) {
  const equippable = player.getComponent(EntityComponentTypes.Equippable);
  if (!equippable) return 0;
  const max = ENCHANTS[enchantKey].max;
  let total = 0;
  for (const slot of ARMOR_SLOTS) {
    const item = equippable.getEquipment(slot);
    if (!item) continue;
    total += simExtra(readData(item), enchantKey, max);
  }
  return total;
}

// Simulated extra for a piece in any slot (used for aqua affinity on a helmet,
// which the player may be holding rather than wearing).
function anySlotExtra(player, enchantKey) {
  const equippable = player.getComponent(EntityComponentTypes.Equippable);
  if (!equippable) return 0;
  const max = ENCHANTS[enchantKey].max;
  let total = 0;
  for (const slot of Object.values(EquipmentSlot)) {
    try {
      const item = equippable.getEquipment(slot);
      if (!item) continue;
      total += simExtra(readData(item), enchantKey, max);
    } catch (e) {
      /* some slots (e.g. Body) are not supported on every entity */
    }
  }
  return total;
}

function hasFamily(entity, family) {
  try {
    const component = entity.getComponent(EntityComponentTypes.TypeFamily);
    return component ? component.hasTypeFamily(family) : false;
  } catch (e) {
    return false;
  }
}

/* =====================================================================
   Applying an enchantment
   ===================================================================== */

function resolveTarget(player, def) {
  const equippable = player.getComponent(EntityComponentTypes.Equippable);
  if (!equippable) return null;

  if (def.group === "armor") {
    // Prefer the worn armour piece that already carries enchant data (so re-running
    // updates the same item), otherwise the first enchantable armour slot.
    const worn = ARMOR_SLOTS.map((slot) => ({ slot, item: equippable.getEquipment(slot) })).filter(
      (entry) => entry.item && getEnchantable(entry.item)
    );
    if (worn.length === 0) return null;
    const withData = worn.find((entry) => Object.keys(readData(entry.item)).length > 0);
    const chosen = withData ?? worn[0];
    return { equippable, slot: chosen.slot, item: chosen.item };
  }

  const slot = EquipmentSlot.Mainhand;
  const item = equippable.getEquipment(slot);
  return item ? { equippable, slot, item } : null;
}

function applyToTarget(target, enchantKey, level) {
  const def = ENCHANTS[enchantKey];
  if (!isSimulated(def) && level > def.max) {
    return { ok: false, message: `${prettify(enchantKey)} only exists at level ${def.max} (nothing to simulate).` };
  }

  const { equippable, slot, item } = target;
  const enchantable = getEnchantable(item);
  if (!enchantable) return { ok: false, message: `${item.typeId} cannot be enchanted.` };

  const id = nsId(enchantKey);
  const type = new EnchantmentType(id);

  // Try to store the level the player asked for. Some engine versions accept
  // levels above the vanilla max here (unlike the /enchant command), which makes
  // the item display "Sharpness 50" natively. If the engine rejects it, fall back
  // to the vanilla max and drive the difference with scripted effects.
  let storedLevel = null;
  let native = false;
  for (const attempt of [level, def.max]) {
    try {
      if (enchantable.hasEnchantment(id)) enchantable.removeEnchantment(id);
      enchantable.addEnchantment({ type, level: attempt });
      storedLevel = attempt;
      native = attempt === level && level > def.max;
      break;
    } catch (e) {
      /* try the next candidate */
    }
  }
  if (storedLevel === null) {
    return { ok: false, message: `The engine refused ${prettify(enchantKey)} at any level up to ${level}.` };
  }

  const data = readData(item);
  if (level > def.max) {
    // Only the levels the engine did not store need scripted effects.
    const extra = level - storedLevel;
    if (extra > 0) data[enchantKey] = { level, max: def.max, native: false };
    else if (native) data[enchantKey] = { level, max: def.max, native: true };
    else delete data[enchantKey];
  } else {
    delete data[enchantKey];
  }
  writeData(item, data);
  writeLore(item, data);
  equippable.setEquipment(slot, item);

  return { ok: true, storedLevel, native, simulated: level > storedLevel };
}

function applyEnchant(player, enchantKey, level) {
  const def = ENCHANTS[enchantKey];
  if (!def) return { ok: false, message: `Unknown enchantment: ${enchantKey}` };

  const target = resolveTarget(player, def);
  if (!target) {
    return {
      ok: false,
      message:
        def.group === "armor"
          ? "Wear a piece of armour in the matching slot first."
          : "Hold the item you want to enchant in your main hand.",
    };
  }
  return applyToTarget(target, enchantKey, level);
}

// Bulk command: weapon/tool/bow enchantments go on the held item, armour
// enchantments on every worn piece. Enchantments that fit nowhere are reported.
function applyAll(player, level) {
  const equippable = player.getComponent(EntityComponentTypes.Equippable);
  if (!equippable) return { ok: false, message: "You have no equipment to enchant." };

  const applied = new Set();
  const errors = new Map();
  let simulated = false;

  const run = (slot, key) => {
    const item = equippable.getEquipment(slot);
    if (!item || !getEnchantable(item)) return;
    const result = applyToTarget({ equippable, slot, item }, key, level);
    if (result.ok) {
      applied.add(key);
      errors.delete(key);
      simulated = simulated || result.simulated;
    } else if (!applied.has(key)) {
      errors.set(key, result.message);
    }
  };

  const held = equippable.getEquipment(EquipmentSlot.Mainhand);
  if (held && getEnchantable(held)) {
    for (const key of Object.keys(ENCHANTS)) {
      const group = ENCHANTS[key].group;
      if (group === "weapon" || group === "tool" || group === "bow") run(EquipmentSlot.Mainhand, key);
    }
  }

  for (const slot of ARMOR_SLOTS) {
    for (const key of Object.keys(ENCHANTS)) {
      if (ENCHANTS[key].group === "armor") run(slot, key);
    }
  }

  if (applied.size === 0) {
    return { ok: false, message: "Hold a weapon/tool or wear armour, then run /upenchant all <level>." };
  }
  return {
    ok: true,
    applied: [...applied],
    failed: [...errors.entries()].map(([key, message]) => `${prettify(key)}: ${message}`),
    simulated,
  };
}

/* =====================================================================
   Scripted effects
   ===================================================================== */

/* --- Weapon: bonus melee damage (sharpness / smite / bane) --------- */

world.afterEvents.entityHitEntity.subscribe((event) => {
  const attacker = event.damagingEntity;
  const victim = event.hitEntity;
  if (!(attacker instanceof Player) || !victim?.isValid) return;

  system.run(() => {
    try {
      const item = getHeldItem(attacker);
      if (!item) return;
      const data = readData(item);

      let bonus = 0;
      bonus += simExtra(data, "sharpness", ENCHANTS.sharpness.max) * 1.25;
      if (hasFamily(victim, "undead")) bonus += simExtra(data, "smite", ENCHANTS.smite.max) * 2.5;
      if (hasFamily(victim, "arthropod")) bonus += simExtra(data, "bane_of_arthropods", ENCHANTS.bane_of_arthropods.max) * 2.5;
      if (bonus > 0) victim.applyDamage(bonus, { cause: EntityDamageCause.entityAttack, damagingEntity: attacker });
    } catch (e) {
      /* victim may have died or unloaded */
    }
  });
});

/* --- Shared: push a victim away from a source --------------------- */

function knockAway(source, victim, force, vertical) {
  try {
    const view = source.getViewDirection();
    const horizontal = Math.hypot(view.x, view.z) || 1;
    const dir = { x: view.x / horizontal, z: view.z / horizontal };
    try {
      victim.applyKnockback({ x: dir.x * force, z: dir.z * force }, vertical);
    } catch (e) {
      victim.applyImpulse({ x: dir.x * force * 0.5, y: vertical, z: dir.z * force * 0.5 });
    }
  } catch (e) {
    /* ignore */
  }
}

/* --- Weapon: stronger knockback ------------------------------------ */

world.afterEvents.entityHitEntity.subscribe((event) => {
  const attacker = event.damagingEntity;
  const victim = event.hitEntity;
  if (!(attacker instanceof Player) || !victim?.isValid) return;

  system.run(() => {
    try {
      const item = getHeldItem(attacker);
      const extra = item ? simExtra(readData(item), "knockback", ENCHANTS.knockback.max) : 0;
      if (extra <= 0) return;
      knockAway(attacker, victim, 1 + extra * 0.6, 0.4);
    } catch (e) {
      /* ignore */
    }
  });
});

/* --- Weapon: fire aspect above max --------------------------------- */

world.afterEvents.entityHitEntity.subscribe((event) => {
  const attacker = event.damagingEntity;
  const victim = event.hitEntity;
  if (!(attacker instanceof Player) || !victim?.isValid) return;

  system.run(() => {
    try {
      const item = getHeldItem(attacker);
      const extra = item ? simExtra(readData(item), "fire_aspect", ENCHANTS.fire_aspect.max) : 0;
      if (extra > 0) victim.setOnFire(extra * 4, true);
    } catch (e) {
      /* ignore */
    }
  });
});

/* --- Weapon: extra looting (bonus drops) --------------------------- */

const LOOT = {
  cow: [["minecraft:leather", 2], ["minecraft:beef", 2]],
  mooshroom: [["minecraft:leather", 2], ["minecraft:beef", 2]],
  pig: [["minecraft:porkchop", 2]],
  chicken: [["minecraft:chicken", 2], ["minecraft:feather", 2]],
  sheep: [["minecraft:mutton", 2]],
  rabbit: [["minecraft:rabbit", 1]],
  zombie: [["minecraft:rotten_flesh", 2]],
  husk: [["minecraft:rotten_flesh", 2]],
  drowned: [["minecraft:rotten_flesh", 2]],
  skeleton: [["minecraft:bone", 2]],
  stray: [["minecraft:bone", 2]],
  wither_skeleton: [["minecraft:bone", 2], ["minecraft:coal", 1]],
  spider: [["minecraft:string", 2]],
  cave_spider: [["minecraft:string", 2]],
  blaze: [["minecraft:blaze_rod", 1]],
  enderman: [["minecraft:ender_pearl", 1]],
  creeper: [["minecraft:gunpowder", 2]],
  slime: [["minecraft:slime_ball", 2]],
  magma_cube: [["minecraft:magma_cream", 1]],
  squid: [["minecraft:ink_sac", 1]],
  ghast: [["minecraft:ghast_tear", 1]],
};

world.afterEvents.entityDie.subscribe((event) => {
  const dead = event.deadEntity;
  const killer = event.damageSource?.damagingEntity;
  if (!(killer instanceof Player)) return;

  const item = getHeldItem(killer);
  const extra = item ? simExtra(readData(item), "looting", ENCHANTS.looting.max) : 0;
  if (extra <= 0) return;

  const typeId = dead.typeId.replace("minecraft:", "");
  const table = LOOT[typeId] ?? [["minecraft:bone", 1]];
  const location = dead.location;
  const dimension = dead.dimension;

  system.run(() => {
    for (const [id, per] of table) {
      try {
        dimension.spawnItem(new ItemStack(id, Math.min(per * extra, 64)), location);
      } catch (e) {
        /* ignore individual drop failures */
      }
    }
  });
});

/* --- Bow: bonus projectile damage / fire --------------------------- */

world.afterEvents.projectileHitEntity.subscribe((event) => {
  const shooter = event.source;
  if (!(shooter instanceof Player)) return;

  system.run(() => {
    try {
      const item = getHeldItem(shooter);
      if (!item) return;
      const data = readData(item);
      const victim = event.getEntityHit().entity;
      if (!victim?.isValid) return;

      const powerExtra = simExtra(data, "power", ENCHANTS.power.max);
      if (powerExtra > 0) {
        victim.applyDamage(powerExtra * 1.25, { cause: EntityDamageCause.entityAttack, damagingEntity: shooter });
      }
      const flameExtra = simExtra(data, "flame", ENCHANTS.flame.max);
      if (flameExtra > 0) victim.setOnFire(flameExtra * 5, true);
      const punchExtra = simExtra(data, "punch", ENCHANTS.punch.max);
      if (punchExtra > 0) knockAway(shooter, victim, 1 + punchExtra * 0.6, 0.4);
    } catch (e) {
      /* ignore */
    }
  });
});

/* --- Tool: extra block drops (fortune) ----------------------------- */

world.afterEvents.playerBreakBlock.subscribe((event) => {
  const item = event.itemStackAfterBreak;
  if (!item) return;

  const extra = simExtra(readData(item), "fortune", ENCHANTS.fortune.max);
  if (extra <= 0) return;

  const permutation = event.brokenBlockPermutation;
  let base = 1;
  try {
    base = permutation.getItemStack()?.amount ?? 1;
  } catch (e) {
    /* non-dropping block */
  }
  if (base <= 0) return;

  const dimension = event.player.dimension;
  const location = event.block.location;
  const copies = Math.min(extra, 8);

  system.run(() => {
    try {
      const stack = permutation.getItemStack(base * copies);
      if (stack) dimension.spawnItem(stack, location);
    } catch (e) {
      /* ignore */
    }
  });
});

/* --- Tool: chance to save durability (unbreaking) ------------------ */

world.afterEvents.playerBreakBlock.subscribe((event) => {
  const item = event.itemStackAfterBreak;
  if (!item) return;

  const extra = simExtra(readData(item), "unbreaking", ENCHANTS.unbreaking.max);
  if (extra <= 0) return;
  if (Math.random() >= Math.min(0.95, extra * 0.08)) return;

  const player = event.player;
  const typeId = item.typeId;

  system.run(() => {
    try {
      const equippable = player.getComponent(EntityComponentTypes.Equippable);
      const held = equippable?.getEquipment(EquipmentSlot.Mainhand);
      if (!held || held.typeId !== typeId) return;
      const durability = held.getComponent(ItemComponentTypes.Durability);
      if (durability && durability.damage > 0) {
        durability.damage -= 1;
        equippable.setEquipment(EquipmentSlot.Mainhand, held);
      }
    } catch (e) {
      /* ignore */
    }
  });
});

/* --- Armour: damage reduction (protection family) ------------------ */

world.beforeEvents.entityHurt.subscribe((event) => {
  const hurt = event.hurtEntity;
  if (!(hurt instanceof Player)) return;
  const cause = event.damageSource?.cause;
  if (!cause) return;

  const extra = (key) => sumArmorExtra(hurt, key);
  let reduction = extra("protection") * 0.04;

  if (cause === EntityDamageCause.projectile) reduction += extra("projectile_protection") * 0.05;
  if (
    cause === EntityDamageCause.fire ||
    cause === EntityDamageCause.fireTick ||
    cause === EntityDamageCause.lava ||
    cause === EntityDamageCause.magma
  ) {
    reduction += extra("fire_protection") * 0.05;
  }
  if (cause === EntityDamageCause.entityExplosion || cause === EntityDamageCause.blockExplosion) {
    reduction += extra("blast_protection") * 0.05;
  }
  if (cause === EntityDamageCause.fall) reduction += extra("feather_falling") * 0.06;

  if (reduction <= 0) return;
  event.damage = event.damage * (1 - Math.min(reduction, 0.9));
});

/* --- Armour: thorns reflect ---------------------------------------- */

world.afterEvents.entityHurt.subscribe((event) => {
  const hurt = event.hurtEntity;
  if (!(hurt instanceof Player)) return;

  const attacker = event.damageSource?.damagingEntity;
  if (!attacker?.isValid) return;

  const extra = sumArmorExtra(hurt, "thorns");
  if (extra <= 0) return;

  system.run(() => {
    try {
      attacker.applyDamage(extra * 1.5, { cause: EntityDamageCause.thorns, damagingEntity: hurt });
    } catch (e) {
      /* ignore */
    }
  });
});

/* --- Held / worn effects (respiration, efficiency, striders, ...) --- */

function isOnSoulBlock(player) {
  try {
    const { x, y, z } = player.location;
    const below = player.dimension.getBlock({ x: Math.floor(x), y: Math.floor(y) - 1, z: Math.floor(z) });
    return below?.typeId === "minecraft:soul_sand" || below?.typeId === "minecraft:soul_soil";
  } catch (e) {
    return false;
  }
}

system.runInterval(() => {
  for (const player of world.getAllPlayers()) {
    try {
      const equippable = player.getComponent(EntityComponentTypes.Equippable);
      if (!equippable) continue;
      const hide = { showParticles: false };

      // Respiration -> water breathing while worn.
      const resp = sumArmorExtra(player, "respiration");
      if (resp > 0) player.addEffect("water_breathing", 40, { amplifier: resp, ...hide });

      // Efficiency -> haste while a simulated-efficiency tool is held.
      const held = equippable.getEquipment(EquipmentSlot.Mainhand);
      const eff = held ? simExtra(readData(held), "efficiency", ENCHANTS.efficiency.max) : 0;
      if (eff > 0) player.addEffect("haste", 40, { amplifier: eff, ...hide });

      // Depth Strider -> dolphins grace while boots are worn.
      const depth = sumArmorExtra(player, "depth_strider");
      if (depth > 0) player.addEffect("dolphins_grace", 40, { amplifier: depth, ...hide });

      // Aqua Affinity -> haste while underwater with a simulated piece equipped.
      const aqua = anySlotExtra(player, "aqua_affinity");
      if (aqua > 0 && player.isInWater) player.addEffect("haste", 40, { amplifier: aqua, ...hide });

      // Soul Speed and Swift Sneak both map to speed; keep the strongest.
      let speedAmp = 0;
      const soul = sumArmorExtra(player, "soul_speed");
      if (soul > 0 && isOnSoulBlock(player)) speedAmp = Math.max(speedAmp, soul);
      const sneak = sumArmorExtra(player, "swift_sneak");
      if (sneak > 0 && player.isSneaking) speedAmp = Math.max(speedAmp, sneak);
      if (speedAmp > 0) player.addEffect("speed", 40, { amplifier: speedAmp, ...hide });
    } catch (e) {
      /* ignore */
    }
  }
}, 10);

/* =====================================================================
   Command registration
   ===================================================================== */

system.beforeEvents.startup.subscribe(({ customCommandRegistry }) => {
  customCommandRegistry.registerEnum("upenchant:enchant", COMMAND_ENCHANTS);

  customCommandRegistry.registerCommand(
    {
      name: "upenchant:upenchant",
      description: "Enchant the held or worn item above its normal level cap.",
      permissionLevel: CommandPermissionLevel.GameDirectors,
      cheatsRequired: false,
      mandatoryParameters: [
        { name: "upenchant:enchant", type: CustomCommandParamType.Enum },
        { name: "level", type: CustomCommandParamType.Integer },
      ],
    },
    (origin, enchantKey, level) => {
      const player = origin.sourceEntity;
      if (!(player instanceof Player)) {
        return { status: CustomCommandStatus.Failure, message: "Only a player can run /upenchant." };
      }
      if (enchantKey !== "all" && !ENCHANTS[enchantKey]) {
        return { status: CustomCommandStatus.Failure, message: `Unknown enchantment: ${enchantKey}` };
      }
      if (!Number.isInteger(level) || level < 1 || level > HARD_MAX) {
        return { status: CustomCommandStatus.Failure, message: `Level must be a whole number from 1 to ${HARD_MAX}.` };
      }

      system.run(() => {
        if (enchantKey === "all") {
          const result = applyAll(player, level);
          if (!result.ok) {
            player.sendMessage(`§c[upenchant] ${result.message}`);
            return;
          }
          player.sendMessage(`§a[upenchant] §fApplied ${result.applied.length} enchantments at level ${level}.`);
          for (const failure of result.failed) player.sendMessage(`§7  skipped ${failure}`);
          return;
        }

        const result = applyEnchant(player, enchantKey, level);
        if (!result.ok) {
          player.sendMessage(`§c[upenchant] ${result.message}`);
          return;
        }
        const label = prettify(enchantKey);
        const note = result.simulated
          ? ` §7(stored ${result.storedLevel}; extra levels are scripted)`
          : "";
        player.sendMessage(`§a[upenchant] §f${label} ${level} applied.${note}`);
      });

      return { status: CustomCommandStatus.Success };
    }
  );
});
