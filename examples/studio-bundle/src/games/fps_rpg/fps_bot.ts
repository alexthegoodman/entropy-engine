// ## Battlefield-Style Bot AI Summary

// ### Core Philosophy
// **Entity-by-entity approach** with raycasts for a 1024×1024 terrain map with 15 bots. Skip complex pathfinding - use simple obstacle avoidance with raycasts since it's mostly open terrain with buildings/trees.

// ### The State Machine (Heart of the AI)
// ```typescript
// enum BotState {
//   PATROL,      // Wandering, looking for threats
//   ENGAGE,      // Actively shooting at player
//   ADVANCE,     // Moving toward enemy's last known position
//   RETREAT,     // Falling back when hurt/outnumbered
//   TAKE_COVER,  // Moving to cover position
//   IN_COVER,    // Behind cover, peeking out to shoot
//   RELOAD,      // Reloading weapon
//   HEALING,     // Using medkit
//   STUNNED,     // Flashbanged/suppressed
// }

// enum Stance {
//   STANDING,
//   CROUCHING,
//   PRONE,
//   SPRINTING,
// }
// ```

// ### Critical Systems

// **1. Realistic Aiming**
// - Smooth tracking (no instant snap-to-target)
// - Accuracy affected by: stance, movement, distance, suppression, time-on-target
// - Prone = most accurate, sprinting = terrible
// - Gets more accurate the longer they aim at you

// **2. Cover System**
// - Raycast around bot to find positions that block line-of-sight to player
// - Evaluate cover quality (full height vs crouch vs prone)
// - Score by: distance, quality, angle, not occupied
// - Bots peek out periodically to shoot, then duck back

// **3. Stance Management**
// - Go prone when: under fire with no cover, sniping at range, health critical
// - Crouch when: in partial cover, medium range combat
// - Sprint when: advancing/retreating, not in combat
// - Dynamically switch based on situation

// **4. Weapon/Ammo**
// - Reload when safe (in cover or out of sight)
// - Don't reload mid-firefight unless empty
// - Fire mode selection: auto for close, burst for medium, single for long range

// **5. Combat Awareness**
// - Track last known player position even after losing sight
// - Field of view ~120-160° (not omniscient)
// - Suppression: being shot at reduces accuracy, increases cover-seeking
// - Threat assessment if multiple enemies

// ### Key Behaviors

// **Navigation**: Direct approach with local obstacle avoidance (raycasts left/right/forward)
// **Stuck detection**: If not moving for ~0.5 seconds, wiggle out or try different direction
// **Cover seeking**: When health low, need reload, or heavily suppressed
// **Peeking**: Pop out from cover every 2-4 seconds to take shots
// **Variable aggression**: Some bots more aggressive (push forward), others cautious (hold position)

// ### The Feel
// - Bots that feel **tactical** not robotic
// - Take cover when hurt, peek to return fire
// - Smooth aim tracking, not instant headshots
// - Realistic weapon handling and stance changes
// - Emergent squad behavior from individual decision-making

// ### Implementation Priority
// 1. Basic movement + obstacle avoidance (raycasts)
// 2. State machine with PATROL → ENGAGE → TAKE_COVER → IN_COVER flow
// 3. Stance system (affects accuracy)
// 4. Cover detection (raycasts to find safe positions)
// 5. Realistic aiming (smooth tracking + spread calculations)
// 6. Weapon management (reload timing, fire modes)

// There needs to be an animation for each BotState and Stance on the humanoid (add animation functions 
// to separate file outside of character_creator_addon.ts, and then use that file inside character_creator_addon.ts)
// There should be a synth sound every time a weapon fires (see DAW addon)
// Make sure that these guys dont walk off the edge of the map :)

// We will want this exhaustive list of animations and state to be implemented here JS-side

/// Exhaustive animation state enum for a realistic FPS character
// #[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
// pub enum FPSCharacterAnimation {
//     // ===== IDLE STATES =====
//     IdleStand,
//     IdleStandBreathing,
//     IdleStandFidget1, // Check watch
//     IdleStandFidget2, // Adjust gear
//     IdleStandFidget3, // Neck crack
//     IdleStandFidget4, // Shoulder roll
//     IdleStandWeaponInspect,
//     IdleCrouch,
//     IdleCrouchBreathing,
//     IdleProne,
//     IdleProneBreathing,
//     IdleInjured, // Holding wound
//     IdleExhausted, // Hands on knees
    
//     // ===== MOVEMENT - WALKING =====
//     WalkForward,
//     WalkBackward,
//     WalkLeft,
//     WalkRight,
//     WalkForwardLeft,
//     WalkForwardRight,
//     WalkBackwardLeft,
//     WalkBackwardRight,
    
//     // ===== MOVEMENT - SPRINTING =====
//     SprintForward,
//     SprintForwardLeft,
//     SprintForwardRight,
//     SprintTactical, // Weapon up
    
//     // ===== MOVEMENT - CROUCHED =====
//     CrouchWalkForward,
//     CrouchWalkBackward,
//     CrouchWalkLeft,
//     CrouchWalkRight,
//     CrouchWalkForwardLeft,
//     CrouchWalkForwardRight,
//     CrouchWalkBackwardLeft,
//     CrouchWalkBackwardRight,
    
//     // ===== MOVEMENT - PRONE =====
//     ProneForward,
//     ProneBackward,
//     ProneLeft,
//     ProneRight,
    
//     // ===== STANCE TRANSITIONS =====
//     StandToCrouch,
//     CrouchToStand,
//     StandToProne,
//     ProneToStand,
//     CrouchToProne,
//     ProneToCrouch,
    
//     // ===== JUMPING & AERIAL =====
//     JumpStart,
//     JumpRising,
//     JumpApex,
//     JumpFalling,
//     JumpLandLight,
//     JumpLandMedium,
//     JumpLandHeavy,
//     JumpLandRoll,
//     JumpForward,
//     JumpBackward,
//     JumpLeft,
//     JumpRight,
//     DoubleJump,
//     WallJump,
    
//     // ===== MANTLING & CLIMBING =====
//     VaultLow,
//     VaultMedium,
//     VaultHigh,
//     MantleLow,
//     MantleMedium,
//     MantleHigh,
//     ClimbLadderUp,
//     ClimbLadderDown,
//     ClimbLadderIdle,
//     ClimbLadderDismountTop,
//     ClimbLadderDismountBottom,
//     ClimbRope,
//     ClimbWall,
//     Parkour,
    
//     // ===== LEANING =====
//     LeanLeft,
//     LeanRight,
//     LeanLeftAim,
//     LeanRightAim,
//     LeanReturn,
//     PeekCornerLeft,
//     PeekCornerRight,
    
//     // ===== SLIDING & DODGING =====
//     SlideStart,
//     SlideLoop,
//     SlideEnd,
//     DodgeLeft,
//     DodgeRight,
//     DodgeForward,
//     DodgeBackward,
//     DiveForward,
//     DiveSide,
//     Roll,
    
//     // ===== WEAPON HANDLING - DRAW/HOLSTER =====
//     DrawPrimaryWeapon,
//     DrawSecondaryWeapon,
//     DrawMeleeWeapon,
//     DrawGrenade,
//     HolsterPrimary,
//     HolsterSecondary,
//     QuickSwapPrimaryToSecondary,
//     QuickSwapSecondaryToPrimary,
    
//     // ===== WEAPON HANDLING - AIMING =====
//     AimDownSights,
//     AimDownSightsIdle,
//     AimDownSightsExit,
//     AimHipFire,
//     AimOverShoulder,
    
//     // ===== WEAPON HANDLING - FIRING =====
//     FireSingle,
//     FireBurst,
//     FireFullAuto,
//     FireFromHip,
//     FireWhileMoving,
//     FireWhileSprinting,
//     FireWhileCrouched,
//     FireWhileProne,
//     FireWhileJumping,
//     FireWhileSliding,
//     FireLastRound,
//     FireDryFire,
    
//     // ===== WEAPON HANDLING - RELOADING =====
//     ReloadStandard,
//     ReloadTactical,
//     ReloadEmpty,
//     ReloadPartial,
//     ReloadWhileMoving,
//     ReloadWhileCrouched,
//     ReloadWhileProne,
//     ReloadCancel,
//     ReloadShotgunSingle,
//     ReloadShotgunLoop,
//     ReloadShotgunEnd,
//     ReloadRevolverOpen,
//     ReloadRevolverLoad,
//     ReloadRevolverClose,
//     ReloadCheckMagazine,
    
//     // ===== WEAPON HANDLING - RECOIL =====
//     RecoilLight,
//     RecoilMedium,
//     RecoilHeavy,
//     RecoilVertical,
//     RecoilHorizontalLeft,
//     RecoilHorizontalRight,
//     RecoilRecovery,
    
//     // ===== WEAPON HANDLING - MELEE =====
//     MeleeSlash,
//     MeleeStab,
//     MeleeBash,
//     MeleeButtstroke,
//     MeleeUppercut,
//     MeleeCombo1,
//     MeleeCombo2,
//     MeleeCombo3,
//     MeleeChargeUp,
//     MeleeChargingAttack,
//     MeleeExecutionStart,
//     MeleeExecutionLoop,
    
//     // ===== GRENADES & THROWABLES =====
//     GrenadeDrawPin,
//     GrenadePullPin,
//     GrenadeHold,
//     GrenadeThrowOverhand,
//     GrenadeThrowUnderhand,
//     GrenadeThrowRoll,
//     GrenadeCookLoop,
//     ThrowFlashbang,
//     ThrowSmoke,
//     ThrowMolotov,
//     ThrowKnife,
    
//     // ===== EQUIPMENT & GADGETS =====
//     PlaceClaymore,
//     PlaceC4,
//     DetonateExplosive,
//     DeployShield,
//     DeployBipod,
//     UseMedkit,
//     UseStimPack,
//     UseArmorPlate,
//     DrinkPotion,
//     EatFood,
//     UseRadio,
//     UseTablet,
//     ThrowDrone,
//     ControlDrone,
    
//     // ===== INTERACTIONS =====
//     OpenDoor,
//     CloseDoor,
//     BreachDoor,
//     KickDoor,
//     PickupItem,
//     DropItem,
//     ExamineItem,
//     UseComputer,
//     FlipSwitch,
//     PushButton,
//     TurnValve,
//     ReviveAlly,
//     CarryAlly,
    
//     // ===== VEHICLE INTERACTIONS =====
//     EnterVehicleDriver,
//     EnterVehiclePassenger,
//     ExitVehicleDriver,
//     ExitVehiclePassenger,
//     DriveVehicle,
//     ShootFromVehicle,
//     VehicleCollision,
    
//     // ===== DAMAGE & REACTIONS =====
//     HitReactionFront,
//     HitReactionBack,
//     HitReactionLeft,
//     HitReactionRight,
//     HitReactionHead,
//     HitReactionChest,
//     HitReactionStomach,
//     HitReactionLegs,
//     StaggerForward,
//     StaggerBackward,
//     Stumble,
//     Flinch,
//     BlockWithArms,
    
//     // ===== INJURY STATES =====
//     LimpLeft,
//     LimpRight,
//     Crawl,
//     CrawlForward,
//     CrawlBackward,
//     KnockdownFront,
//     KnockdownBack,
//     GetupFromFront,
//     GetupFromBack,
//     Stagger,
//     Dazed,
//     Stunned,
//     BleedingOut,
    
//     // ===== DEATH ANIMATIONS =====
//     DeathHeadshot,
//     DeathChest,
//     DeathBack,
//     DeathExplosion,
//     DeathFall,
//     DeathBurn,
//     DeathDrown,
//     DeathRagdoll,
//     DeathSpectacular,
    
//     // ===== ENVIRONMENTAL REACTIONS =====
//     WadeWaterShallow,
//     WadeWaterDeep,
//     SwimIdle,
//     SwimForward,
//     SwimUnderwater,
//     SwimSurface,
//     Tread,
//     SlipOnIce,
//     PushThroughBush,
//     CoverFromWind,
//     ShieldFromExplosion,
    
//     // ===== COVER SYSTEM =====
//     EnterCoverLeft,
//     EnterCoverRight,
//     ExitCoverLeft,
//     ExitCoverRight,
//     CoverIdle,
//     CoverPeekOver,
//     CoverPeekLeft,
//     CoverPeekRight,
//     CoverPeekReturn,
//     CoverMoveLeft,
//     CoverMoveRight,
//     CoverSwapSides,
//     CoverBlindFire,
    
//     // ===== STEALTH =====
//     StealthIdle,
//     StealthWalk,
//     StealthRun,
//     StealthCrouch,
//     Takedown,
//     TakedownLethal,
//     TakedownNonLethal,
//     DragBody,
//     HideInShadows,
    
//     // ===== EMOTES & GESTURES =====
//     PointForward,
//     PointLeft,
//     PointRight,
//     WaveHello,
//     WaveGoodbye,
//     Salute,
//     ThumbsUp,
//     ThumbsDown,
//     Shrug,
//     Nod,
//     Shake,
//     Taunt,
//     Victory,
//     Surrender,
//     CallOut,
//     HandSignalAdvance,
//     HandSignalStop,
//     HandSignalCoverMe,
//     HandSignalRegroup,
// }