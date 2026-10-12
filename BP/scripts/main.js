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
  power: { max: 5, group: "bow" },
  punch: { max: 2, group: "bow" },
  flame: { max: 1, group: "bow" },
  mending: { max: 1, group: "special" },
  infinity: { max: 1, group: "special" },
  silk_touch: { max: 1, group: "special" },
};

const HARD_MAX = 100;
const ENCHANT_DP = "upenchant:data";

const ENCHANT_KEYS = Object.keys(ENCHANTS).filter((k) => ENCHANTS[k].group !== "special");

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

      const view = attacker.getViewDirection();
      const horizontal = Math.hypot(view.x, view.z) || 1;
      const dir = { x: view.x / horizontal, z: view.z / horizontal };
      const force = 1 + extra * 0.6;
      try {
        victim.applyKnockback({ x: dir.x * force, z: dir.z * force }, 0.4);
      } catch (e) {
        victim.applyImpulse({ x: dir.x * force * 0.5, y: 0.4, z: dir.z * force * 0.5 });
      }
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

/* --- Armour: water breathing (respiration) ------------------------- */

system.runInterval(() => {
  for (const player of world.getAllPlayers()) {
    const extra = sumArmorExtra(player, "respiration");
    if (extra <= 0) continue;
    try {
      player.addEffect("water_breathing", 60, { amplifier: extra, showParticles: false });
    } catch (e) {
      /* ignore */
    }
  }
}, 40);

/* =====================================================================
   Command registration
   ===================================================================== */

system.beforeEvents.startup.subscribe(({ customCommandRegistry }) => {
  customCommandRegistry.registerEnum("upenchant:enchant", ENCHANT_KEYS);

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
      if (!ENCHANTS[enchantKey]) {
        return { status: CustomCommandStatus.Failure, message: `Unknown enchantment: ${enchantKey}` };
      }
      if (!Number.isInteger(level) || level < 1 || level > HARD_MAX) {
        return { status: CustomCommandStatus.Failure, message: `Level must be a whole number from 1 to ${HARD_MAX}.` };
      }

      system.run(() => {
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
