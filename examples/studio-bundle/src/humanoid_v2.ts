import { mat4, quat, vec3 } from "gl-matrix";

export type Vec3 = [number, number, number];
export type Quat = [number, number, number, number];
export type Mat4 = any;

export function quat_from_axis_angle(axis: Vec3, angle: number): Quat {
    const q = quat.create();
    quat.setAxisAngle(q, axis as any, angle);
    return [q[0], q[1], q[2], q[3]];
}

export function quat_multiply(a: Quat, b: Quat): Quat {
    const out = quat.create();
    quat.multiply(out, a as any, b as any);
    return [out[0], out[1], out[2], out[3]];
}

export function mat4_identity(): Mat4 {
    return mat4.create();
}

export function mat4_multiply(a: Mat4, b: Mat4): Mat4 {
    const out = mat4.create();
    mat4.multiply(out, a, b);
    return out;
}

export function mat4_from_rotation_translation_scale(q: Quat, t: Vec3, s: Vec3): Mat4 {
    const out = mat4.create();
    mat4.fromRotationTranslationScale(out, q, t, s);
    return out;
}

export function mat4_inverse(m: Mat4): Mat4 {
    const out = mat4.create();
    mat4.invert(out, m);
    return out;
}

// ============================================================================
// SKELETON SYSTEM
// ============================================================================

export class Bone {
    public localTransform: Mat4 = mat4_identity();
    public worldTransform: Mat4 = mat4_identity();
    public children: Bone[] = [];
    public inverseBindMatrix: Mat4 = mat4_identity();
    public parent: Bone | null = null;

    constructor(public name: string, public id: number) {}

    updateWorldTransform(parentWorld: Mat4) {
        this.worldTransform = mat4_multiply(parentWorld, this.localTransform);
        for (const child of this.children) {
            child.updateWorldTransform(this.worldTransform);
        }
    }

    addChild(bone: Bone) {
        this.children.push(bone);
        bone.parent = this;
    }
}

// ============================================================================
// BODY VARIATION TYPES
// ============================================================================

export interface BodyProportions {
    height: number;
    shoulderWidth: number;
    torsoWidth: number;
    armLength: number;
    legLength: number;
    headSize: number;
}

export type BodyType = 'average' | 'athletic' | 'stocky' | 'tall' | 'child' | 'random';

export const BODY_PRESETS: Record<BodyType, BodyProportions> = {
    average: {
        height: 1.0,
        shoulderWidth: 1.0,
        torsoWidth: 1.0,
        armLength: 1.0,
        legLength: 1.0,
        headSize: 1.0
    },
    athletic: {
        height: 1.05,
        shoulderWidth: 1.15,
        torsoWidth: 0.9,
        armLength: 1.05,
        legLength: 1.08,
        headSize: 0.95
    },
    stocky: {
        height: 0.92,
        shoulderWidth: 1.2,
        torsoWidth: 1.3,
        armLength: 0.95,
        legLength: 0.9,
        headSize: 1.05
    },
    tall: {
        height: 1.15,
        shoulderWidth: 0.95,
        torsoWidth: 0.85,
        armLength: 1.1,
        legLength: 1.2,
        headSize: 0.9
    },
    child: {
        height: 0.65,
        shoulderWidth: 0.8,
        torsoWidth: 0.9,
        armLength: 0.85,
        legLength: 0.7,
        headSize: 1.3
    },
    random: {
        height: 1.0,
        shoulderWidth: 1.0,
        torsoWidth: 1.0,
        armLength: 1.0,
        legLength: 1.0,
        headSize: 1.0
    }
};

export interface ColorScheme {
    skin: [number, number, number, number];
    shirt: [number, number, number, number];
    pants: [number, number, number, number];
}

export const COLOR_SCHEMES: ColorScheme[] = [
    {
        skin: [0.92, 0.76, 0.65, 1.0],
        shirt: [0.2, 0.4, 0.8, 1.0],
        pants: [0.3, 0.3, 0.35, 1.0]
    },
    {
        skin: [0.76, 0.58, 0.44, 1.0],
        shirt: [0.8, 0.2, 0.2, 1.0],
        pants: [0.15, 0.15, 0.2, 1.0]
    },
    {
        skin: [0.35, 0.25, 0.20, 1.0],
        shirt: [0.2, 0.7, 0.3, 1.0],
        pants: [0.4, 0.3, 0.25, 1.0]
    },
    {
        skin: [0.95, 0.87, 0.77, 1.0],
        shirt: [0.5, 0.3, 0.7, 1.0],
        pants: [0.2, 0.25, 0.3, 1.0]
    },
    {
        skin: [0.85, 0.65, 0.50, 1.0],
        shirt: [0.9, 0.7, 0.2, 1.0],
        pants: [0.25, 0.35, 0.45, 1.0]
    }
];

// ============================================================================
// PROCEDURAL MESH GENERATION
// ============================================================================

export class ProceduralHumanoid {
    vertices: number[] = [];
    indices: number[] = [];
    bones: Bone[] = [];
    rootBone: Bone;
    
    // Bone references
    public hips: Bone;
    public spine: Bone;
    public chest: Bone;
    public neck: Bone;
    public head: Bone;
    
    public leftShoulder: Bone;
    public leftUpperArm: Bone;
    public leftForearm: Bone;
    public leftHand: Bone;
    
    public rightShoulder: Bone;
    public rightUpperArm: Bone;
    public rightForearm: Bone;
    public rightHand: Bone;
    
    public leftUpperLeg: Bone;
    public leftLowerLeg: Bone;
    public leftFoot: Bone;
    
    public rightUpperLeg: Bone;
    public rightLowerLeg: Bone;
    public rightFoot: Bone;

    // Body variation properties
    public proportions: BodyProportions;
    public colorScheme: ColorScheme;

    constructor(bodyType: BodyType = 'random', colorSchemeIndex?: number) {
        // Generate proportions
        if (bodyType === 'random') {
            this.proportions = this.generateRandomProportions();
        } else {
            this.proportions = { ...BODY_PRESETS[bodyType] };
        }

        // Select color scheme
        if (colorSchemeIndex !== undefined && colorSchemeIndex < COLOR_SCHEMES.length) {
            this.colorScheme = COLOR_SCHEMES[colorSchemeIndex];
        } else {
            const randomIndex = Math.floor(Math.random() * COLOR_SCHEMES.length);
            this.colorScheme = COLOR_SCHEMES[randomIndex];
        }

        // Build comprehensive skeleton
        this.rootBone = new Bone("Hips", 0);
        this.hips = this.rootBone;
        
        // Spine chain
        this.spine = new Bone("Spine", 1);
        this.chest = new Bone("Chest", 2);
        this.neck = new Bone("Neck", 3);
        this.head = new Bone("Head", 4);
        
        // Left arm chain
        this.leftShoulder = new Bone("LeftShoulder", 5);
        this.leftUpperArm = new Bone("LeftUpperArm", 6);
        this.leftForearm = new Bone("LeftForearm", 7);
        this.leftHand = new Bone("LeftHand", 8);
        
        // Right arm chain
        this.rightShoulder = new Bone("RightShoulder", 9);
        this.rightUpperArm = new Bone("RightUpperArm", 10);
        this.rightForearm = new Bone("RightForearm", 11);
        this.rightHand = new Bone("RightHand", 12);
        
        // Left leg chain
        this.leftUpperLeg = new Bone("LeftUpperLeg", 13);
        this.leftLowerLeg = new Bone("LeftLowerLeg", 14);
        this.leftFoot = new Bone("LeftFoot", 15);
        
        // Right leg chain
        this.rightUpperLeg = new Bone("RightUpperLeg", 16);
        this.rightLowerLeg = new Bone("RightLowerLeg", 17);
        this.rightFoot = new Bone("RightFoot", 18);

        // Build hierarchy
        this.hips.addChild(this.spine);
        this.hips.addChild(this.leftUpperLeg);
        this.hips.addChild(this.rightUpperLeg);
        
        this.spine.addChild(this.chest);
        this.chest.addChild(this.neck);
        this.neck.addChild(this.head);
        
        this.chest.addChild(this.leftShoulder);
        this.leftShoulder.addChild(this.leftUpperArm);
        this.leftUpperArm.addChild(this.leftForearm);
        this.leftForearm.addChild(this.leftHand);
        
        this.chest.addChild(this.rightShoulder);
        this.rightShoulder.addChild(this.rightUpperArm);
        this.rightUpperArm.addChild(this.rightForearm);
        this.rightForearm.addChild(this.rightHand);
        
        this.leftUpperLeg.addChild(this.leftLowerLeg);
        this.leftLowerLeg.addChild(this.leftFoot);
        
        this.rightUpperLeg.addChild(this.rightLowerLeg);
        this.rightLowerLeg.addChild(this.rightFoot);

        this.bones = [
            this.hips, this.spine, this.chest, this.neck, this.head,
            this.leftShoulder, this.leftUpperArm, this.leftForearm, this.leftHand,
            this.rightShoulder, this.rightUpperArm, this.rightForearm, this.rightHand,
            this.leftUpperLeg, this.leftLowerLeg, this.leftFoot,
            this.rightUpperLeg, this.rightLowerLeg, this.rightFoot
        ];

        this.resetPose();
    }

    private generateRandomProportions(): BodyProportions {
        const randomRange = (min: number, max: number) => min + Math.random() * (max - min);
        
        return {
            height: randomRange(0.8, 1.2),
            shoulderWidth: randomRange(0.85, 1.25),
            torsoWidth: randomRange(0.8, 1.3),
            armLength: randomRange(0.9, 1.15),
            legLength: randomRange(0.85, 1.2),
            headSize: randomRange(0.9, 1.2)
        };
    }

    resetPose() {
        const p = this.proportions;
        
        // Base realistic human proportions (in meters, ~1.75m tall)
        const baseHeight = 1.75 * p.height;
        const hipHeight = 0.9 * p.height;
        const spineLength = 0.25 * p.height;
        const chestLength = 0.25 * p.height;
        const neckLength = 0.12 * p.height;
        const headLength = 0.23 * p.headSize;
        
        const shoulderWidth = 0.18 * p.shoulderWidth;
        const upperArmLength = 0.28 * p.armLength;
        const forearmLength = 0.26 * p.armLength;
        const handLength = 0.18 * p.armLength;
        
        const upperLegLength = 0.45 * p.legLength;
        const lowerLegLength = 0.43 * p.legLength;
        const footLength = 0.25 * p.legLength;
        const legSpacing = 0.10 * p.shoulderWidth;

        // Set initial pose transforms
        this.hips.localTransform = mat4_from_rotation_translation_scale(
            [0, 0, 0, 1], [0, hipHeight, 0], [1, 1, 1]
        );
        
        this.spine.localTransform = mat4_from_rotation_translation_scale(
            [0, 0, 0, 1], [0, spineLength, 0], [1, 1, 1]
        );
        
        this.chest.localTransform = mat4_from_rotation_translation_scale(
            [0, 0, 0, 1], [0, chestLength, 0], [1, 1, 1]
        );
        
        this.neck.localTransform = mat4_from_rotation_translation_scale(
            [0, 0, 0, 1], [0, neckLength, 0], [1, 1, 1]
        );
        
        this.head.localTransform = mat4_from_rotation_translation_scale(
            [0, 0, 0, 1], [0, headLength, 0], [1, 1, 1]
        );
        
        // Left arm
        this.leftShoulder.localTransform = mat4_from_rotation_translation_scale(
            [0, 0, 0, 1], [-shoulderWidth, 0, 0], [1, 1, 1]
        );
        
        this.leftUpperArm.localTransform = mat4_from_rotation_translation_scale(
            [0, 0, 0, 1], [-upperArmLength, 0, 0], [1, 1, 1]
        );
        
        this.leftForearm.localTransform = mat4_from_rotation_translation_scale(
            [0, 0, 0, 1], [-forearmLength, 0, 0], [1, 1, 1]
        );
        
        this.leftHand.localTransform = mat4_from_rotation_translation_scale(
            [0, 0, 0, 1], [-handLength, 0, 0], [1, 1, 1]
        );
        
        // Right arm (mirrored)
        this.rightShoulder.localTransform = mat4_from_rotation_translation_scale(
            [0, 0, 0, 1], [shoulderWidth, 0, 0], [1, 1, 1]
        );
        
        this.rightUpperArm.localTransform = mat4_from_rotation_translation_scale(
            [0, 0, 0, 1], [upperArmLength, 0, 0], [1, 1, 1]
        );
        
        this.rightForearm.localTransform = mat4_from_rotation_translation_scale(
            [0, 0, 0, 1], [forearmLength, 0, 0], [1, 1, 1]
        );
        
        this.rightHand.localTransform = mat4_from_rotation_translation_scale(
            [0, 0, 0, 1], [handLength, 0, 0], [1, 1, 1]
        );
        
        // Left leg
        this.leftUpperLeg.localTransform = mat4_from_rotation_translation_scale(
            [0, 0, 0, 1], [-legSpacing, -0.05, 0], [1, 1, 1]
        );
        
        this.leftLowerLeg.localTransform = mat4_from_rotation_translation_scale(
            [0, 0, 0, 1], [0, -upperLegLength, 0], [1, 1, 1]
        );
        
        this.leftFoot.localTransform = mat4_from_rotation_translation_scale(
            [0, 0, 0, 1], [0, -lowerLegLength, footLength * 0.3], [1, 1, 1]
        );
        
        // Right leg (mirrored)
        this.rightUpperLeg.localTransform = mat4_from_rotation_translation_scale(
            [0, 0, 0, 1], [legSpacing, -0.05, 0], [1, 1, 1]
        );
        
        this.rightLowerLeg.localTransform = mat4_from_rotation_translation_scale(
            [0, 0, 0, 1], [0, -upperLegLength, 0], [1, 1, 1]
        );
        
        this.rightFoot.localTransform = mat4_from_rotation_translation_scale(
            [0, 0, 0, 1], [0, -lowerLegLength, footLength * 0.3], [1, 1, 1]
        );

        this.rootBone.updateWorldTransform(mat4_identity());
        
        // Calculate inverse bind matrices
        for (const bone of this.bones) {
            bone.inverseBindMatrix = mat4_inverse(bone.worldTransform);
        }
    }

    getBone(name: string): Bone | undefined {
        return this.bones.find(b => b.name === name);
    }

    generateMesh() {
        this.vertices = [];
        this.indices = [];

        // Use character-specific colors
        const skinColor = this.colorScheme.skin;
        const shirtColor = this.colorScheme.shirt;
        const pantsColor = this.colorScheme.pants;

        // Get world positions from bind pose
        this.rootBone.updateWorldTransform(mat4_identity());
        
        // Helper to extract position from matrix
        const getPos = (mat: Mat4): Vec3 => [mat[12], mat[13], mat[14]];
        
        // Scale factors based on proportions
        const limbRadius = 0.05 * (this.proportions.shoulderWidth + this.proportions.torsoWidth) / 2;
        const limbLength = 0.4 * this.proportions.height;
        const boxSize = 0.1 * this.proportions.height;
        
        // Legs
        this.addCylinder(getPos(this.leftUpperLeg.worldTransform), limbRadius, limbLength, 8, this.leftUpperLeg.id, pantsColor);
        this.addCylinder(getPos(this.leftLowerLeg.worldTransform), limbRadius * 0.9, limbLength, 8, this.leftLowerLeg.id, pantsColor);
        this.addBox(getPos(this.leftFoot.worldTransform), boxSize, this.leftFoot.id, skinColor);
        
        this.addCylinder(getPos(this.rightUpperLeg.worldTransform), limbRadius, limbLength, 8, this.rightUpperLeg.id, pantsColor);
        this.addCylinder(getPos(this.rightLowerLeg.worldTransform), limbRadius * 0.9, limbLength, 8, this.rightLowerLeg.id, pantsColor);
        this.addBox(getPos(this.rightFoot.worldTransform), boxSize, this.rightFoot.id, skinColor);
        
        // Torso
        this.addBox(getPos(this.chest.worldTransform), boxSize * 1.5 * this.proportions.torsoWidth, this.chest.id, shirtColor);
        this.addBox(getPos(this.head.worldTransform), boxSize * this.proportions.headSize, this.head.id, skinColor);
        
        // Arms
        this.addCylinder(getPos(this.leftUpperArm.worldTransform), limbRadius * 0.8, limbLength * 0.7, 8, this.leftUpperArm.id, skinColor);
        this.addCylinder(getPos(this.rightUpperArm.worldTransform), limbRadius * 0.8, limbLength * 0.7, 8, this.rightUpperArm.id, skinColor);
    }
    
    public addBox(
        center: Vec3,
        size: number,
        boneIdx: number,
        color: [number, number, number, number]
    ) {
        const h = size / 2;
        const startIdx = this.vertices.length / 18;
        
        // 8 vertices of a cube
        const verts: Vec3[] = [
            [center[0]-h, center[1]-h, center[2]-h],
            [center[0]+h, center[1]-h, center[2]-h],
            [center[0]+h, center[1]+h, center[2]-h],
            [center[0]-h, center[1]+h, center[2]-h],
            [center[0]-h, center[1]-h, center[2]+h],
            [center[0]+h, center[1]-h, center[2]+h],
            [center[0]+h, center[1]+h, center[2]+h],
            [center[0]-h, center[1]+h, center[2]+h],
        ];
        
        for (let i = 0; i < 8; i++) {
            this.pushVertex(verts[i], [0, 1, 0], color, boneIdx);
        }
        
        // Indices for cube
        const indices = [
            0,1,2, 0,2,3, // back
            4,6,5, 4,7,6, // front  
            0,4,5, 0,5,1, // bottom
            2,6,7, 2,7,3, // top
            0,3,7, 0,7,4, // left
            1,5,6, 1,6,2  // right
        ];
        
        for (const idx of indices) {
            this.indices.push(startIdx + idx);
        }
    }

    public addCylinder(
        offset: Vec3,
        radius: number,
        height: number,
        segments: number,
        boneIdx: number,
        color: [number, number, number, number]
    ) {
        const halfHeight = height / 2;
        const startVertex = this.vertices.length / 18;

        // Generate cylinder vertices
        for (let h = 0; h <= 2; h++) {
            const y = halfHeight - h * height;
            for (let seg = 0; seg <= segments; seg++) {
                const phi = (seg * 2 * Math.PI) / segments;
                const x = Math.cos(phi);
                const z = Math.sin(phi);

                this.pushVertex(
                    [offset[0] + radius * x, offset[1] + y, offset[2] + radius * z],
                    [x, 0, z],
                    color,
                    boneIdx
                );
            }
        }

        // Generate indices
        for (let h = 0; h < 2; h++) {
            for (let seg = 0; seg < segments; seg++) {
                const current = startVertex + h * (segments + 1) + seg;
                const next = current + segments + 1;

                this.indices.push(current, next, current + 1);
                this.indices.push(current + 1, next, next + 1);
            }
        }
    }

    public pushVertex(
        pos: Vec3,
        normal: Vec3,
        color: [number, number, number, number],
        boneIdx: number
    ) {
        // Position
        this.vertices.push(pos[0], pos[1], pos[2]);
        // Normal
        this.vertices.push(normal[0], normal[1], normal[2]);
        // UV (placeholder)
        this.vertices.push(0, 0);
        // Color
        this.vertices.push(...color);
        
        // Joint indices (packed as 2 floats for 4 u16 values)
        const view = new DataView(new ArrayBuffer(8));
        view.setUint16(0, boneIdx, true);
        view.setUint16(2, 0, true);
        view.setUint16(4, 0, true);
        view.setUint16(6, 0, true);
        this.vertices.push(view.getFloat32(0, true), view.getFloat32(4, true));
        
        // Weights
        this.vertices.push(1.0, 0.0, 0.0, 0.0);
    }

    getJointMatrices(): number[] {
        const out: number[] = [];
        for (let i = 0; i < 256; i++) {
            const bone = this.bones[i];
            const mat = bone 
                ? mat4_multiply(bone.worldTransform, bone.inverseBindMatrix)
                : mat4_identity();
            out.push(...mat);
        }
        return out;
    }

    // Helper to apply rotation to a bone while preserving its translation
    public rotateBone(bone: Bone, rotation: Quat, translation?: Vec3) {
        // Get original translation from the bind pose
        const tx = bone.localTransform[12];
        const ty = bone.localTransform[13];
        const tz = bone.localTransform[14];
        
        // Apply new rotation with preserved (or overridden) translation
        const trans: Vec3 = translation || [tx, ty, tz];
        bone.localTransform = mat4_from_rotation_translation_scale(
            rotation, trans, [1, 1, 1]
        );
    }

    public animate(time: number, animation: string) {
        // First, reset to bind pose
        this.resetPose();
        
        // Then apply animation modifications
        switch (animation.toLowerCase()) {
            case "idle": this.animateIdle(time); break;
            case "walk": case "walking": this.animateWalk(time); break;
            case "run": case "running": this.animateRun(time); break;
            case "wave": this.animateWave(time); break;
            case "jump": this.animateJump(time); break;
            case "dance": this.animateDance(time); break;
            case "sit": this.animateSit(time); break;
            case "crouch": this.animateCrouch(time); break;
            case "celebrate": this.animateCelebrate(time); break;
            case "defeat": this.animateDefeat(time); break;
            case "stretch": this.animateStretch(time); break;
            case "yoga": this.animateYoga(time); break;
            case "sprint": this.animateSprint(time); break;
            case "crouchwalk": this.animateCrouchWalk(time); break;
            case "slide": this.animateSlide(time); break;
            case "ads": case "aim": this.animateAimDownSights(time); break;
            case "recoil": this.animateRecoil(time); break;
            case "reload": this.animateReload(time); break;
            case "melee": this.animateMelee(time); break;
            case "leanleft": this.animateLeanLeft(time); break;
            case "leanright": this.animateLeanRight(time); break;
            case "vault": case "mantle": this.animateVault(time); break;
            case "prone": this.animateProne(time); break;
            case "hitreaction": case "hit": this.animateHitReaction(time); break;
            case "death": this.animateDeath(time); break;
            default: this.animateIdle(time); break;
        }

        // Update world transforms from root
        this.rootBone.updateWorldTransform(mat4_identity());
    }

    public animateSprint(time: number) {
        const sprintSpeed = 6.5;
        const cycle = time * sprintSpeed;
        
        const leftLegPhase = Math.sin(cycle);
        const rightLegPhase = Math.sin(cycle + Math.PI);
        
        // Aggressive forward lean
        const spineForwardLean = quat_from_axis_angle([1, 0, 0], 0.25);
        this.rotateBone(this.spine, spineForwardLean);
        
        // Head down slightly
        const headDown = quat_from_axis_angle([1, 0, 0], 0.15);
        this.rotateBone(this.head, headDown);
        
        // Lower body for speed
        const bobAmount = Math.abs(Math.sin(cycle * 2)) * 0.1;
        const hipHeight = 0.9 * this.proportions.height - 0.08 + bobAmount;
        this.rotateBone(this.hips, [0, 0, 0, 1], [0, hipHeight, 0]);
        
        // Explosive leg movement
        const leftHipSwing = leftLegPhase * 1.0;
        const leftHipRot = quat_from_axis_angle([1, 0, 0], leftHipSwing);
        this.rotateBone(this.leftUpperLeg, leftHipRot);
        
        const leftKneeBend = Math.max(0, -leftLegPhase) * 2.0;
        const leftKneeRot = quat_from_axis_angle([1, 0, 0], leftKneeBend);
        this.rotateBone(this.leftLowerLeg, leftKneeRot);
        
        const rightHipSwing = rightLegPhase * 1.0;
        const rightHipRot = quat_from_axis_angle([1, 0, 0], rightHipSwing);
        this.rotateBone(this.rightUpperLeg, rightHipRot);
        
        const rightKneeBend = Math.max(0, -rightLegPhase) * 2.0;
        const rightKneeRot = quat_from_axis_angle([1, 0, 0], rightKneeBend);
        this.rotateBone(this.rightLowerLeg, rightKneeRot);
        
        // Arms pumping hard - more compact than running
        const leftArmSwing = -leftLegPhase * 0.8;
        const leftArmForward = quat_from_axis_angle([1, 0, 0], leftArmSwing);
        const leftArmIn = quat_from_axis_angle([0, 1, 0], 0.2);
        const leftArmCombined = quat_multiply(leftArmForward, leftArmIn);
        this.rotateBone(this.leftUpperArm, leftArmCombined);
        
        const rightArmSwing = -rightLegPhase * 0.8;
        const rightArmForward = quat_from_axis_angle([1, 0, 0], rightArmSwing);
        const rightArmIn = quat_from_axis_angle([0, 1, 0], -0.2);
        const rightArmCombined = quat_multiply(rightArmForward, rightArmIn);
        this.rotateBone(this.rightUpperArm, rightArmCombined);
        
        // Aggressive elbow bend
        const elbowBend = quat_from_axis_angle([1, 0, 0], 1.1);
        this.rotateBone(this.leftForearm, elbowBend);
        this.rotateBone(this.rightForearm, elbowBend);
    }

    public animateCrouchWalk(time: number) {
        const walkSpeed = 2.0; // Slower than normal walk
        const cycle = time * walkSpeed;
        
        const leftLegPhase = Math.sin(cycle);
        const rightLegPhase = Math.sin(cycle + Math.PI);
        
        // Low body position
        const hipHeight = 0.5 * this.proportions.height;
        const bobAmount = Math.abs(Math.sin(cycle * 2)) * 0.02; // Minimal bob
        this.rotateBone(this.hips, [0, 0, 0, 1], [0, hipHeight + bobAmount, 0]);
        
        // Forward spine lean
        const spineLean = quat_from_axis_angle([1, 0, 0], 0.35);
        this.rotateBone(this.spine, spineLean);
        
        // Knees bent significantly
        const leftHipBend = quat_from_axis_angle([1, 0, 0], -0.3 + leftLegPhase * 0.3);
        this.rotateBone(this.leftUpperLeg, leftHipBend);
        
        const leftKneeBend = 1.5 + Math.max(0, -leftLegPhase) * 0.5;
        const leftKneeRot = quat_from_axis_angle([1, 0, 0], leftKneeBend);
        this.rotateBone(this.leftLowerLeg, leftKneeRot);
        
        const rightHipBend = quat_from_axis_angle([1, 0, 0], -0.3 + rightLegPhase * 0.3);
        this.rotateBone(this.rightUpperLeg, rightHipBend);
        
        const rightKneeBend = 1.5 + Math.max(0, -rightLegPhase) * 0.5;
        const rightKneeRot = quat_from_axis_angle([1, 0, 0], rightKneeBend);
        this.rotateBone(this.rightLowerLeg, rightKneeRot);
        
        // Arms in ready position (like holding weapon)
        const armReady = quat_from_axis_angle([1, 0, 0], -0.5);
        const armIn = quat_from_axis_angle([0, 1, 0], 0.3);
        const leftArmCombined = quat_multiply(armReady, armIn);
        this.rotateBone(this.leftUpperArm, leftArmCombined);
        
        const rightArmInMirror = quat_from_axis_angle([0, 1, 0], -0.3);
        const rightArmCombined = quat_multiply(armReady, rightArmInMirror);
        this.rotateBone(this.rightUpperArm, rightArmCombined);
        
        // Forearms up (weapon grip)
        const forearmUp = quat_from_axis_angle([1, 0, 0], 0.9);
        this.rotateBone(this.leftForearm, forearmUp);
        this.rotateBone(this.rightForearm, forearmUp);
    }

    public animateSlide(time: number) {
        // Slide animation is a short burst, loop every 2 seconds
        const slideDuration = 1.5;
        const cycle = (time % slideDuration) / slideDuration;
        
        let slidePhase = 0;
        let legExtension = 0;
        let bodyRotation = 0;
        
        if (cycle < 0.3) {
            // Entry: dropping down
            const t = cycle / 0.3;
            slidePhase = t;
            legExtension = t * 0.8;
            bodyRotation = t * 0.2;
        } else if (cycle < 0.8) {
            // Middle: full slide
            slidePhase = 1.0;
            legExtension = 0.8;
            bodyRotation = 0.2;
        } else {
            // Exit: recovering
            const t = (cycle - 0.8) / 0.2;
            slidePhase = 1.0 - t * 0.5;
            legExtension = 0.8 - t * 0.8;
            bodyRotation = 0.2 - t * 0.2;
        }
        
        // Very low hip position
        const hipHeight = 0.25 * this.proportions.height + (1 - slidePhase) * 0.1;
        const hipTilt = quat_from_axis_angle([1, 0, 0], 0.6 * slidePhase);
        this.rotateBone(this.hips, hipTilt, [0, hipHeight, 0]);
        
        // Lean back
        const spineLean = quat_from_axis_angle([1, 0, 0], -0.3 * slidePhase);
        this.rotateBone(this.spine, spineLean);
        
        // One leg extended forward, one bent back
        const leftLegForward = quat_from_axis_angle([1, 0, 0], -0.5 * legExtension);
        this.rotateBone(this.leftUpperLeg, leftLegForward);
        
        const leftKneeExtend = quat_from_axis_angle([1, 0, 0], 0.2 * legExtension);
        this.rotateBone(this.leftLowerLeg, leftKneeExtend);
        
        const rightLegBent = quat_from_axis_angle([1, 0, 0], 1.2 * slidePhase);
        this.rotateBone(this.rightUpperLeg, rightLegBent);
        
        const rightKneeBend = quat_from_axis_angle([1, 0, 0], 1.8 * slidePhase);
        this.rotateBone(this.rightLowerLeg, rightKneeBend);
        
        // Arms out for balance
        const leftArmOut = quat_from_axis_angle([0, 0, 1], -0.6 * slidePhase);
        const leftArmBack = quat_from_axis_angle([1, 0, 0], 0.4 * slidePhase);
        const leftArmCombined = quat_multiply(leftArmOut, leftArmBack);
        this.rotateBone(this.leftUpperArm, leftArmCombined);
        
        const rightArmOut = quat_from_axis_angle([0, 0, 1], 0.6 * slidePhase);
        const rightArmBack = quat_from_axis_angle([1, 0, 0], 0.4 * slidePhase);
        const rightArmCombined = quat_multiply(rightArmOut, rightArmBack);
        this.rotateBone(this.rightUpperArm, rightArmCombined);
    }

    public animateAimDownSights(time: number) {
        // Stable aiming stance with minimal movement
        const breathCycle = Math.sin(time * 1.2) * 0.01;
        
        // Slight forward stance
        const spineLean = quat_from_axis_angle([1, 0, 0], 0.08);
        this.rotateBone(this.spine, spineLean);
        
        // Head aligned with sights
        const headForward = quat_from_axis_angle([1, 0, 0], 0.05);
        this.rotateBone(this.head, headForward);
        
        // Right arm (primary weapon hold) - shoulder level
        const rightShoulderRaise = quat_from_axis_angle([0, 0, 1], 0.4);
        const rightShoulderForward = quat_from_axis_angle([1, 0, 0], -0.6);
        const rightShoulderIn = quat_from_axis_angle([0, 1, 0], -0.15);
        let rightArmRot = quat_multiply(rightShoulderRaise, rightShoulderForward);
        rightArmRot = quat_multiply(rightArmRot, rightShoulderIn);
        this.rotateBone(this.rightUpperArm, rightArmRot);
        
        // Right forearm extended holding weapon
        const rightForearmExt = quat_from_axis_angle([1, 0, 0], 0.4);
        this.rotateBone(this.rightForearm, rightForearmExt);
        
        // Left arm (support hand) - reaches across
        const leftShoulderRaise = quat_from_axis_angle([0, 0, 1], -0.3);
        const leftShoulderForward = quat_from_axis_angle([1, 0, 0], -0.5);
        const leftShoulderAcross = quat_from_axis_angle([0, 1, 0], 0.4);
        let leftArmRot = quat_multiply(leftShoulderRaise, leftShoulderForward);
        leftArmRot = quat_multiply(leftArmRot, leftShoulderAcross);
        this.rotateBone(this.leftUpperArm, leftArmRot);
        
        // Left forearm bent supporting weapon
        const leftForearmBend = quat_from_axis_angle([1, 0, 0], 1.0);
        this.rotateBone(this.leftForearm, leftForearmBend);
        
        // Subtle breathing sway
        const sway = quat_from_axis_angle([0, 1, 0], breathCycle);
        this.rotateBone(this.chest, sway);
        
        // Stable leg stance
        const stanceWidth = 0.05;
        const leftLegOut = quat_from_axis_angle([0, 1, 0], -0.1);
        this.rotateBone(this.leftUpperLeg, leftLegOut);
        
        const rightLegOut = quat_from_axis_angle([0, 1, 0], 0.1);
        this.rotateBone(this.rightUpperLeg, rightLegOut);
    }

    public animateRecoil(time: number) {
        // Quick recoil snap - plays in about 0.3 seconds
        const recoilDuration = 0.3;
        const cycle = (time % recoilDuration) / recoilDuration;
        
        let recoilAmount = 0;
        if (cycle < 0.15) {
            // Quick kick back
            recoilAmount = (cycle / 0.15) * 1.0;
        } else {
            // Recovery
            const recoveryPhase = (cycle - 0.15) / 0.85;
            recoilAmount = (1.0 - recoveryPhase) * 1.0;
        }
        
        // Upper body kicks back
        const spineKickback = quat_from_axis_angle([1, 0, 0], -0.08 * recoilAmount);
        this.rotateBone(this.spine, spineKickback);
        
        const chestKickback = quat_from_axis_angle([1, 0, 0], -0.12 * recoilAmount);
        this.rotateBone(this.chest, chestKickback);
        
        // Head snaps back slightly
        const headKickback = quat_from_axis_angle([1, 0, 0], -0.06 * recoilAmount);
        this.rotateBone(this.head, headKickback);
        
        // Right shoulder absorbs recoil
        const rightShoulderKick = quat_from_axis_angle([1, 0, 0], 0.15 * recoilAmount);
        const rightShoulderRot = quat_from_axis_angle([0, 0, 1], 0.4); // Base ADS position
        const rightCombined = quat_multiply(rightShoulderRot, rightShoulderKick);
        this.rotateBone(this.rightUpperArm, rightCombined);
        
        // Weapon muzzle rise (forearm extension)
        const forearmKick = quat_from_axis_angle([1, 0, 0], -0.1 * recoilAmount);
        this.rotateBone(this.rightForearm, forearmKick);
        
        // Support hand compensates
        const leftArmBase = quat_from_axis_angle([0, 0, 1], -0.3);
        const leftArmPull = quat_from_axis_angle([1, 0, 0], 0.08 * recoilAmount);
        const leftCombined = quat_multiply(leftArmBase, leftArmPull);
        this.rotateBone(this.leftUpperArm, leftCombined);
    }

    public animateReload(time: number) {
        // Reload cycle ~2 seconds
        const reloadDuration = 2.0;
        const cycle = (time % reloadDuration) / reloadDuration;
        
        let phase = 0;
        if (cycle < 0.25) {
            phase = 0; // Magazine release
        } else if (cycle < 0.5) {
            phase = 1; // Reach for new mag
        } else if (cycle < 0.75) {
            phase = 2; // Insert magazine
        } else {
            phase = 3; // Charge handle/bolt release
        }
        
        // Lower weapon slightly
        const weaponLower = 0.3 + Math.sin(cycle * Math.PI * 2) * 0.15;
        
        // Right arm stays on weapon but lowers
        const rightArmDown = quat_from_axis_angle([1, 0, 0], weaponLower);
        const rightArmRot = quat_from_axis_angle([0, 0, 1], 0.2);
        const rightCombined = quat_multiply(rightArmRot, rightArmDown);
        this.rotateBone(this.rightUpperArm, rightCombined);
        
        // Right forearm adjusts
        const rightForearmBend = quat_from_axis_angle([1, 0, 0], 0.6);
        this.rotateBone(this.rightForearm, rightForearmBend);
        
        // Left arm animates the reload action
        let leftArmMotion = 0;
        let leftForearmBend = 0;
        
        if (phase === 0) {
            // Release mag - hand near magwell
            leftArmMotion = 0.2;
            leftForearmBend = 1.0;
        } else if (phase === 1) {
            // Reach to belt/pouch
            leftArmMotion = 0.8;
            leftForearmBend = 1.4;
        } else if (phase === 2) {
            // Bring mag to weapon
            leftArmMotion = 0.3;
            leftForearmBend = 1.1;
        } else {
            // Hit charging handle
            leftArmMotion = -0.2;
            leftForearmBend = 0.8;
        }
        
        const leftArmRot = quat_from_axis_angle([1, 0, 0], leftArmMotion);
        this.rotateBone(this.leftUpperArm, leftArmRot);
        
        const leftForearmRot = quat_from_axis_angle([1, 0, 0], leftForearmBend);
        this.rotateBone(this.leftForearm, leftForearmRot);
        
        // Slight head tilt to watch the action
        const headTilt = quat_from_axis_angle([1, 0, 0], 0.15);
        this.rotateBone(this.head, headTilt);
    }

    public animateMelee(time: number) {
        // Quick melee strike - 0.5 second animation
        const meleeDuration = 0.5;
        const cycle = (time % meleeDuration) / meleeDuration;
        
        let strikePhase = 0;
        if (cycle < 0.2) {
            // Wind up
            strikePhase = -(cycle / 0.2) * 0.8;
        } else if (cycle < 0.35) {
            // Strike forward
            const t = (cycle - 0.2) / 0.15;
            strikePhase = -0.8 + t * 1.8;
        } else {
            // Recovery
            const t = (cycle - 0.35) / 0.65;
            strikePhase = 1.0 - t * 1.0;
        }
        
        // Body rotation into strike
        const bodyRotation = quat_from_axis_angle([0, 1, 0], strikePhase * -0.3);
        this.rotateBone(this.chest, bodyRotation);
        
        // Aggressive forward lean during strike
        let spineLean = 0;
        if (strikePhase > 0) {
            spineLean = strikePhase * 0.2;
        }
        const spineLeanRot = quat_from_axis_angle([1, 0, 0], spineLean);
        this.rotateBone(this.spine, spineLeanRot);
        
        // Right arm (weapon arm) - horizontal slash
        const shoulderSwing = quat_from_axis_angle([0, 1, 0], strikePhase * 0.8);
        const shoulderRaise = quat_from_axis_angle([0, 0, 1], 0.4);
        const shoulderForward = quat_from_axis_angle([1, 0, 0], strikePhase * 0.5);
        let rightArmRot = quat_multiply(shoulderRaise, shoulderSwing);
        rightArmRot = quat_multiply(rightArmRot, shoulderForward);
        this.rotateBone(this.rightUpperArm, rightArmRot);
        
        // Forearm extends with strike
        const forearmExtend = 0.3 + Math.max(0, strikePhase) * 0.5;
        const rightForearmRot = quat_from_axis_angle([1, 0, 0], forearmExtend);
        this.rotateBone(this.rightForearm, rightForearmRot);
        
        // Left arm pulls back for balance
        const leftArmPull = quat_from_axis_angle([0, 1, 0], -strikePhase * 0.4);
        const leftArmBack = quat_from_axis_angle([1, 0, 0], strikePhase * 0.3);
        const leftArmCombined = quat_multiply(leftArmPull, leftArmBack);
        this.rotateBone(this.leftUpperArm, leftArmCombined);
        
        // Step forward with right leg during strike
        if (strikePhase > 0) {
            const rightLegForward = quat_from_axis_angle([1, 0, 0], -strikePhase * 0.4);
            this.rotateBone(this.rightUpperLeg, rightLegForward);
        }
    }

    public animateLeanLeft(time: number) {
        // Static lean with minimal sway
        const sway = Math.sin(time * 1.5) * 0.02;
        
        // Body leans left
        const bodyLean = quat_from_axis_angle([0, 0, 1], 0.35 + sway);
        this.rotateBone(this.spine, bodyLean);
        
        // Head compensates to stay level
        const headCompensate = quat_from_axis_angle([0, 0, 1], -0.15);
        this.rotateBone(this.head, headCompensate);
        
        // Weight on left leg
        const leftLegStraight = quat_from_axis_angle([0, 0, 1], -0.1);
        this.rotateBone(this.leftUpperLeg, leftLegStraight);
        
        // Right leg bends slightly
        const rightLegBend = quat_from_axis_angle([1, 0, 0], 0.1);
        this.rotateBone(this.rightLowerLeg, rightLegBend);
        
        // Arms maintain weapon position
        const rightArmAim = quat_from_axis_angle([0, 0, 1], 0.3);
        this.rotateBone(this.rightUpperArm, rightArmAim);
        
        const leftArmAim = quat_from_axis_angle([0, 0, 1], -0.2);
        this.rotateBone(this.leftUpperArm, leftArmAim);
        
        const forearmReady = quat_from_axis_angle([1, 0, 0], 0.6);
        this.rotateBone(this.leftForearm, forearmReady);
        this.rotateBone(this.rightForearm, forearmReady);
    }

    public animateLeanRight(time: number) {
        // Static lean with minimal sway (mirrored from left)
        const sway = Math.sin(time * 1.5) * 0.02;
        
        // Body leans right
        const bodyLean = quat_from_axis_angle([0, 0, 1], -0.35 + sway);
        this.rotateBone(this.spine, bodyLean);
        
        // Head compensates to stay level
        const headCompensate = quat_from_axis_angle([0, 0, 1], 0.15);
        this.rotateBone(this.head, headCompensate);
        
        // Weight on right leg
        const rightLegStraight = quat_from_axis_angle([0, 0, 1], 0.1);
        this.rotateBone(this.rightUpperLeg, rightLegStraight);
        
        // Left leg bends slightly
        const leftLegBend = quat_from_axis_angle([1, 0, 0], 0.1);
        this.rotateBone(this.leftLowerLeg, leftLegBend);
        
        // Arms maintain weapon position
        const rightArmAim = quat_from_axis_angle([0, 0, 1], 0.3);
        this.rotateBone(this.rightUpperArm, rightArmAim);
        
        const leftArmAim = quat_from_axis_angle([0, 0, 1], -0.2);
        this.rotateBone(this.leftUpperArm, leftArmAim);
        
        const forearmReady = quat_from_axis_angle([1, 0, 0], 0.6);
        this.rotateBone(this.leftForearm, forearmReady);
        this.rotateBone(this.rightForearm, forearmReady);
    }

    public animateVault(time: number) {
        // Vaulting over obstacle - 1.2 second animation
        const vaultDuration = 1.2;
        const cycle = (time % vaultDuration) / vaultDuration;
        
        let phase = 0;
        let vaultHeight = 0;
        
        if (cycle < 0.2) {
            // Approach and plant hands
            phase = cycle / 0.2;
            vaultHeight = 0;
        } else if (cycle < 0.5) {
            // Launch up and over
            const t = (cycle - 0.2) / 0.3;
            phase = 1.0;
            vaultHeight = Math.sin(t * Math.PI) * 0.6;
        } else {
            // Landing
            const t = (cycle - 0.5) / 0.7;
            phase = 1.0 - t * 0.5;
            vaultHeight = Math.max(0, (1 - t) * 0.2);
        }
        
        // Raise body
        const hipHeight = 0.9 * this.proportions.height + vaultHeight;
        this.rotateBone(this.hips, [0, 0, 0, 1], [0, hipHeight, 0]);
        
        // Forward body rotation during vault
        const bodyPitch = phase * 0.4;
        const bodyRot = quat_from_axis_angle([1, 0, 0], bodyPitch);
        this.rotateBone(this.spine, bodyRot);
        
        // Arms reach forward to push off
        let armReach = -1.2;
        if (cycle > 0.5) {
            // Arms return to sides after vault
            const t = (cycle - 0.5) / 0.7;
            armReach = -1.2 + t * 1.2;
        }
        
        const leftArmReach = quat_from_axis_angle([0, 0, 1], armReach);
        const rightArmReach = quat_from_axis_angle([0, 0, 1], -armReach);
        this.rotateBone(this.leftUpperArm, leftArmReach);
        this.rotateBone(this.rightUpperArm, rightArmReach);
        
        const armExtend = quat_from_axis_angle([1, 0, 0], -0.5 * phase);
        this.rotateBone(this.leftForearm, armExtend);
        this.rotateBone(this.rightForearm, armExtend);
        
        // Legs tuck up during vault
        let legTuck = 0;
        if (cycle >= 0.2 && cycle < 0.6) {
            const t = (cycle - 0.2) / 0.4;
            legTuck = Math.sin(t * Math.PI) * 1.5;
        }
        
        const legTuckRot = quat_from_axis_angle([1, 0, 0], legTuck);
        this.rotateBone(this.leftUpperLeg, legTuckRot);
        this.rotateBone(this.rightUpperLeg, legTuckRot);
        
        const kneeTuckRot = quat_from_axis_angle([1, 0, 0], legTuck * 1.2);
        this.rotateBone(this.leftLowerLeg, kneeTuckRot);
        this.rotateBone(this.rightLowerLeg, kneeTuckRot);
    }

    public animateProne(time: number) {
        // Lying flat on ground
        const breathCycle = Math.sin(time * 1.0) * 0.01;
        
        // Very low hip position
        const hipHeight = 0.15 * this.proportions.height;
        const proneRot = quat_from_axis_angle([1, 0, 0], 1.57); // 90 degrees - lying down
        this.rotateBone(this.hips, proneRot, [0, hipHeight, 0]);
        
        // Spine slightly raised (propped up on elbows)
        const spineRaise = quat_from_axis_angle([1, 0, 0], -0.3);
        this.rotateBone(this.spine, spineRaise);
        
        // Head up to look forward
        const headUp = quat_from_axis_angle([1, 0, 0], -0.5);
        this.rotateBone(this.head, headUp);
        
        // Arms supporting upper body
        const shoulderOut = quat_from_axis_angle([0, 1, 0], 0.6);
        const shoulderDown = quat_from_axis_angle([0, 0, 1], 0.3);
        const leftArmCombined = quat_multiply(shoulderOut, shoulderDown);
        this.rotateBone(this.leftUpperArm, leftArmCombined);
        
        const rightShoulderOut = quat_from_axis_angle([0, 1, 0], -0.6);
        const rightArmCombined = quat_multiply(rightShoulderOut, shoulderDown);
        this.rotateBone(this.rightUpperArm, rightArmCombined);
        
        // Forearms bent (elbows on ground)
        const forearmBend = quat_from_axis_angle([1, 0, 0], 1.8);
        this.rotateBone(this.leftForearm, forearmBend);
        this.rotateBone(this.rightForearm, forearmBend);
        
        // Legs straight out behind
        const legStraight = quat_from_axis_angle([1, 0, 0], 0.1);
        this.rotateBone(this.leftUpperLeg, legStraight);
        this.rotateBone(this.rightUpperLeg, legStraight);
        
        // Slight knee bend
        const kneeBend = quat_from_axis_angle([1, 0, 0], 0.2);
        this.rotateBone(this.leftLowerLeg, kneeBend);
        this.rotateBone(this.rightLowerLeg, kneeBend);
    }

    public animateHitReaction(time: number) {
        // Quick hit reaction - 0.4 seconds
        const hitDuration = 0.4;
        const cycle = (time % hitDuration) / hitDuration;
        
        let impactPhase = 0;
        if (cycle < 0.15) {
            // Initial impact
            impactPhase = cycle / 0.15;
        } else {
            // Recovery
            impactPhase = 1.0 - ((cycle - 0.15) / 0.85);
        }
        
        // Body jolts backward
        const spineJolt = quat_from_axis_angle([1, 0, 0], -0.15 * impactPhase);
        this.rotateBone(this.spine, spineJolt);
        
        // Head snaps back
        const headSnap = quat_from_axis_angle([1, 0, 0], -0.2 * impactPhase);
        this.rotateBone(this.head, headSnap);
        
        // Slight backward step (weight shift)
        const hipShift = [0, 0, -0.05 * impactPhase] as Vec3;
        this.rotateBone(this.hips, [0, 0, 0, 1], hipShift);
        
        // Arms flail slightly
        const leftArmFlail = quat_from_axis_angle([0, 0, 1], -0.2 * impactPhase);
        const leftArmBack = quat_from_axis_angle([1, 0, 0], 0.15 * impactPhase);
        const leftCombined = quat_multiply(leftArmFlail, leftArmBack);
        this.rotateBone(this.leftUpperArm, leftCombined);
        
        const rightArmFlail = quat_from_axis_angle([0, 0, 1], 0.2 * impactPhase);
        const rightArmBack = quat_from_axis_angle([1, 0, 0], 0.15 * impactPhase);
        const rightCombined = quat_multiply(rightArmFlail, rightArmBack);
        this.rotateBone(this.rightUpperArm, rightCombined);
        
        // Slight knee buckle
        const kneeBuckle = quat_from_axis_angle([1, 0, 0], 0.1 * impactPhase);
        this.rotateBone(this.leftLowerLeg, kneeBuckle);
        this.rotateBone(this.rightLowerLeg, kneeBuckle);
    }

    public animateDeath(time: number) {
        // Falling death animation - goes to ragdoll start pose
        const fallDuration = 1.5;
        const cycle = Math.min(time / fallDuration, 1.0);
        
        // Gradual collapse
        const collapsePhase = cycle;
        
        // Hip drops to ground
        const hipHeight = (0.9 * this.proportions.height) * (1 - collapsePhase);
        const hipTilt = quat_from_axis_angle([1, 0, 0], 0.5 * collapsePhase);
        this.rotateBone(this.hips, hipTilt, [0, hipHeight, 0]);
        
        // Spine crumples
        const spineCollapse = quat_from_axis_angle([1, 0, 0], 0.8 * collapsePhase);
        this.rotateBone(this.spine, spineCollapse);
        
        // Head drops
        const headDrop = quat_from_axis_angle([1, 0, 0], 0.6 * collapsePhase);
        this.rotateBone(this.head, headDrop);
        
        // Legs give out
        const legCollapse = quat_from_axis_angle([1, 0, 0], 0.4 * collapsePhase);
        this.rotateBone(this.leftUpperLeg, legCollapse);
        this.rotateBone(this.rightUpperLeg, legCollapse);
        
        const kneeCollapse = quat_from_axis_angle([1, 0, 0], 1.5 * collapsePhase);
        this.rotateBone(this.leftLowerLeg, kneeCollapse);
        this.rotateBone(this.rightLowerLeg, kneeCollapse);
        
        // Arms fall limply
        const leftArmFall = quat_from_axis_angle([0, 0, 1], -0.5 * collapsePhase);
        const leftArmDown = quat_from_axis_angle([1, 0, 0], 0.6 * collapsePhase);
        const leftCombined = quat_multiply(leftArmFall, leftArmDown);
        this.rotateBone(this.leftUpperArm, leftCombined);
        
        const rightArmFall = quat_from_axis_angle([0, 0, 1], 0.5 * collapsePhase);
        const rightArmDown = quat_from_axis_angle([1, 0, 0], 0.6 * collapsePhase);
        const rightCombined = quat_multiply(rightArmFall, rightArmDown);
        this.rotateBone(this.rightUpperArm, rightCombined);
        
        // Forearms bend naturally
        const forearmBend = quat_from_axis_angle([1, 0, 0], 0.4 * collapsePhase);
        this.rotateBone(this.leftForearm, forearmBend);
        this.rotateBone(this.rightForearm, forearmBend);
    }

    public animateIdle(time: number) {
        // Subtle breathing
        const breathCycle = Math.sin(time * 1.5) * 0.02;
        
        // Head sway
        const headSway = Math.sin(time * 0.8) * 0.03;
        const headRot = quat_from_axis_angle([0, 1, 0], headSway);
        this.rotateBone(this.head, headRot);
        
        // Gentle arm sway
        const armSway = Math.sin(time * 1.2) * 0.05;
        const leftArmRot = quat_from_axis_angle([0, 0, 1], armSway);
        const rightArmRot = quat_from_axis_angle([0, 0, 1], -armSway);
        
        this.rotateBone(this.leftUpperArm, leftArmRot);
        this.rotateBone(this.rightUpperArm, rightArmRot);
    }

    public animateWalk(time: number) {
        const walkSpeed = 3.0;
        const cycle = time * walkSpeed;
        
        const leftLegPhase = Math.sin(cycle);
        const rightLegPhase = Math.sin(cycle + Math.PI);
        
        // Body bob
        const bobAmount = Math.abs(Math.sin(cycle * 2)) * 0.04;
        const hipHeight = 0.9 * this.proportions.height - 0.02 + bobAmount;
        this.rotateBone(this.hips, [0, 0, 0, 1], [0, hipHeight, 0]);
        
        // Slight spine lean forward
        const spineForwardLean = quat_from_axis_angle([1, 0, 0], 0.05);
        this.rotateBone(this.spine, spineForwardLean);
        
        // Left leg
        const leftHipSwing = leftLegPhase * 0.5;
        const leftHipRot = quat_from_axis_angle([1, 0, 0], leftHipSwing);
        this.rotateBone(this.leftUpperLeg, leftHipRot);
        
        const leftKneeBend = Math.max(0, -leftLegPhase) * 1.2;
        const leftKneeRot = quat_from_axis_angle([1, 0, 0], leftKneeBend);
        this.rotateBone(this.leftLowerLeg, leftKneeRot);
        
        const leftFootTilt = leftLegPhase * 0.3;
        const leftFootRot = quat_from_axis_angle([1, 0, 0], -leftFootTilt);
        this.rotateBone(this.leftFoot, leftFootRot);
        
        // Right leg
        const rightHipSwing = rightLegPhase * 0.5;
        const rightHipRot = quat_from_axis_angle([1, 0, 0], rightHipSwing);
        this.rotateBone(this.rightUpperLeg, rightHipRot);
        
        const rightKneeBend = Math.max(0, -rightLegPhase) * 1.2;
        const rightKneeRot = quat_from_axis_angle([1, 0, 0], rightKneeBend);
        this.rotateBone(this.rightLowerLeg, rightKneeRot);
        
        const rightFootTilt = rightLegPhase * 0.3;
        const rightFootRot = quat_from_axis_angle([1, 0, 0], -rightFootTilt);
        this.rotateBone(this.rightFoot, rightFootRot);
        
        // Arms swing opposite to legs
        const leftArmSwing = -leftLegPhase * 0.35;
        const leftArmRot = quat_from_axis_angle([1, 0, 0], leftArmSwing);
        this.rotateBone(this.leftUpperArm, leftArmRot);
        
        const rightArmSwing = -rightLegPhase * 0.35;
        const rightArmRot = quat_from_axis_angle([1, 0, 0], rightArmSwing);
        this.rotateBone(this.rightUpperArm, rightArmRot);
        
        // Slight elbow bend
        const elbowBend = quat_from_axis_angle([1, 0, 0], 0.15);
        this.rotateBone(this.leftForearm, elbowBend);
        this.rotateBone(this.rightForearm, elbowBend);
    }

    public animateRun(time: number) {
        const runSpeed = 5.0;
        const cycle = time * runSpeed;
        
        const leftLegPhase = Math.sin(cycle);
        const rightLegPhase = Math.sin(cycle + Math.PI);
        
        // More pronounced bob
        const bobAmount = Math.abs(Math.sin(cycle * 2)) * 0.08;
        const hipHeight = 0.9 * this.proportions.height - 0.05 + bobAmount;
        this.rotateBone(this.hips, [0, 0, 0, 1], [0, hipHeight, 0]);
        
        // Forward lean
        const spineForwardLean = quat_from_axis_angle([1, 0, 0], 0.15);
        this.rotateBone(this.spine, spineForwardLean);
        
        // Exaggerated leg movement
        const leftHipSwing = leftLegPhase * 0.8;
        const leftHipRot = quat_from_axis_angle([1, 0, 0], leftHipSwing);
        this.rotateBone(this.leftUpperLeg, leftHipRot);
        
        const leftKneeBend = Math.max(0, -leftLegPhase) * 1.8;
        const leftKneeRot = quat_from_axis_angle([1, 0, 0], leftKneeBend);
        this.rotateBone(this.leftLowerLeg, leftKneeRot);
        
        const rightHipSwing = rightLegPhase * 0.8;
        const rightHipRot = quat_from_axis_angle([1, 0, 0], rightHipSwing);
        this.rotateBone(this.rightUpperLeg, rightHipRot);
        
        const rightKneeBend = Math.max(0, -rightLegPhase) * 1.8;
        const rightKneeRot = quat_from_axis_angle([1, 0, 0], rightKneeBend);
        this.rotateBone(this.rightLowerLeg, rightKneeRot);
        
        // Pumping arms
        const leftArmSwing = -leftLegPhase * 0.6;
        const leftArmRot = quat_from_axis_angle([1, 0, 0], leftArmSwing);
        this.rotateBone(this.leftUpperArm, leftArmRot);
        
        const rightArmSwing = -rightLegPhase * 0.6;
        const rightArmRot = quat_from_axis_angle([1, 0, 0], rightArmSwing);
        this.rotateBone(this.rightUpperArm, rightArmRot);
        
        // Bent elbows for running
        const elbowBend = quat_from_axis_angle([1, 0, 0], 0.8);
        this.rotateBone(this.leftForearm, elbowBend);
        this.rotateBone(this.rightForearm, elbowBend);
    }

    public animateWave(time: number) {
        const waveCycle = time * 3.0;
        
        // Raise right arm
        const shoulderRot = quat_from_axis_angle([0, 0, 1], -1.5);
        this.rotateBone(this.rightUpperArm, shoulderRot);
        
        // Wave hand with elbow rotation
        const elbowBase = quat_from_axis_angle([0, 0, 1], -0.5);
        const waveAngle = Math.sin(waveCycle) * 0.5;
        const waveRot = quat_from_axis_angle([0, 1, 0], waveAngle);
        const combinedElbowRot = quat_multiply(elbowBase, waveRot);
        
        this.rotateBone(this.rightForearm, combinedElbowRot);
    }

    public animateJump(time: number) {
        const jumpCycle = (time * 1.5) % 2.5;
        let jumpHeight = 0;
        let hipBend = 0;
        let kneeBend = 0;
        let ankleBend = 0;
        let armRaise = 0;
        
        if (jumpCycle < 0.4) {
            // Crouch preparation
            const t = jumpCycle / 0.4;
            kneeBend = t * 1.3;
            hipBend = t * 0.3;
            jumpHeight = -t * 0.15;
            armRaise = -t * 0.5;
        } else if (jumpCycle < 1.0) {
            // Launch and air time
            const t = (jumpCycle - 0.4) / 0.6;
            const airPhase = Math.sin(t * Math.PI);
            jumpHeight = airPhase * 0.5;
            kneeBend = (1 - t) * 0.4;
            ankleBend = t * 0.2;
            armRaise = t * 1.2;
        } else {
            // Landing
            const t = (jumpCycle - 1.0) / 1.5;
            jumpHeight = -Math.pow(1 - t, 2) * 0.1;
            kneeBend = (1 - t) * 0.8;
            hipBend = (1 - t) * 0.2;
            armRaise = (1 - t) * 1.0;
        }
        
        const hipRot = quat_from_axis_angle([1, 0, 0], hipBend);
        this.rotateBone(this.hips, hipRot, [0, 0.9 * this.proportions.height + jumpHeight, 0]);
        
        const legRot = quat_from_axis_angle([1, 0, 0], -hipBend);
        this.rotateBone(this.leftUpperLeg, legRot);
        this.rotateBone(this.rightUpperLeg, legRot);
        
        const kneeRot = quat_from_axis_angle([1, 0, 0], kneeBend);
        this.rotateBone(this.leftLowerLeg, kneeRot);
        this.rotateBone(this.rightLowerLeg, kneeRot);
        
        const ankleRot = quat_from_axis_angle([1, 0, 0], -ankleBend);
        this.rotateBone(this.leftFoot, ankleRot);
        this.rotateBone(this.rightFoot, ankleRot);
        
        const armRot = quat_from_axis_angle([1, 0, 0], armRaise);
        this.rotateBone(this.leftUpperArm, armRot);
        this.rotateBone(this.rightUpperArm, armRot);
    }

    public animateDance(time: number) {
        const danceSpeed = 2.5;
        const cycle = time * danceSpeed;
        
        // Hip rotation
        const hipRotation = Math.sin(cycle) * 0.3;
        const hipRot = quat_from_axis_angle([0, 1, 0], hipRotation);
        this.rotateBone(this.hips, hipRot);
        
        // Shoulder shimmy
        const shoulderShimmy = Math.sin(cycle * 2) * 0.2;
        const leftShoulderRot = quat_from_axis_angle([0, 0, 1], shoulderShimmy);
        const rightShoulderRot = quat_from_axis_angle([0, 0, 1], -shoulderShimmy);
        
        this.rotateBone(this.leftShoulder, leftShoulderRot);
        this.rotateBone(this.rightShoulder, rightShoulderRot);
        
        // Alternating arm raises
        const leftArmRaise = Math.max(0, Math.sin(cycle)) * -1.2;
        const rightArmRaise = Math.max(0, Math.sin(cycle + Math.PI)) * -1.2;
        
        const leftArmRot = quat_from_axis_angle([0, 0, 1], leftArmRaise);
        const rightArmRot = quat_from_axis_angle([0, 0, 1], rightArmRaise);
        
        this.rotateBone(this.leftUpperArm, leftArmRot);
        this.rotateBone(this.rightUpperArm, rightArmRot);
    }

    public animateSit(time: number) {
        // Sitting position
        const hipHeight = 0.45 * this.proportions.height;
        const hipBend = quat_from_axis_angle([1, 0, 0], -1.5);
        this.rotateBone(this.hips, hipBend, [0, hipHeight, 0]);
        
        // Bend legs
        const kneeBend = quat_from_axis_angle([1, 0, 0], 1.5);
        this.rotateBone(this.leftLowerLeg, kneeBend);
        this.rotateBone(this.rightLowerLeg, kneeBend);
        
        // Slight arm movement
        const armSway = Math.sin(time * 1.0) * 0.05;
        const leftArmRot = quat_from_axis_angle([1, 0, 0], 0.3 + armSway);
        const rightArmRot = quat_from_axis_angle([1, 0, 0], 0.3 - armSway);
        
        this.rotateBone(this.leftUpperArm, leftArmRot);
        this.rotateBone(this.rightUpperArm, rightArmRot);
    }

    public animateCrouch(time: number) {
        // Lower body position
        const hipHeight = 0.4 * this.proportions.height;
        const hipBend = quat_from_axis_angle([1, 0, 0], 0.3);
        this.rotateBone(this.hips, hipBend, [0, hipHeight, 0]);
        
        // Deep knee bend
        const kneeBend = quat_from_axis_angle([1, 0, 0], 1.8);
        this.rotateBone(this.leftLowerLeg, kneeBend);
        this.rotateBone(this.rightLowerLeg, kneeBend);
        
        // Forward spine lean
        const spineLean = quat_from_axis_angle([1, 0, 0], 0.4);
        this.rotateBone(this.spine, spineLean);
        
        // Arms down
        const armDown = quat_from_axis_angle([1, 0, 0], 0.3);
        this.rotateBone(this.leftUpperArm, armDown);
        this.rotateBone(this.rightUpperArm, armDown);
    }

    public animateCelebrate(time: number) {
        const cycle = time * 3.0;
        
        // Jump up and down
        const jumpHeight = Math.abs(Math.sin(cycle)) * 0.2;
        this.rotateBone(this.hips, [0, 0, 0, 1], [0, 0.9 * this.proportions.height + jumpHeight, 0]);
        
        // Both arms raised
        const armRaise = -1.5 + Math.sin(cycle * 2) * 0.2;
        const leftArmRot = quat_from_axis_angle([0, 0, 1], armRaise);
        const rightArmRot = quat_from_axis_angle([0, 0, 1], -armRaise);
        
        this.rotateBone(this.leftUpperArm, leftArmRot);
        this.rotateBone(this.rightUpperArm, rightArmRot);
        
        // Excited head movement
        const headTilt = Math.sin(cycle * 3) * 0.15;
        const headRot = quat_from_axis_angle([0, 1, 0], headTilt);
        this.rotateBone(this.head, headRot);
    }

    public animateDefeat(time: number) {
        // Slumped posture
        const spineLean = quat_from_axis_angle([1, 0, 0], 0.5);
        this.rotateBone(this.spine, spineLean);
        
        // Head down
        const headDown = quat_from_axis_angle([1, 0, 0], 0.6);
        this.rotateBone(this.head, headDown);
        
        // Arms hanging
        const armHang = quat_from_axis_angle([1, 0, 0], 0.3);
        this.rotateBone(this.leftUpperArm, armHang);
        this.rotateBone(this.rightUpperArm, armHang);
        
        // Slight sway
        const sway = Math.sin(time * 0.5) * 0.05;
        const swayRot = quat_from_axis_angle([0, 1, 0], sway);
        this.rotateBone(this.hips, swayRot);
    }

    public animateStretch(time: number) {
        const cycle = time * 1.5;
        const stretchPhase = (Math.sin(cycle) + 1) / 2;
        
        // Reach up high
        const armReach = -Math.PI / 2 - stretchPhase * 0.3;
        const leftArmRot = quat_from_axis_angle([0, 0, 1], armReach);
        const rightArmRot = quat_from_axis_angle([0, 0, 1], -armReach);
        
        this.rotateBone(this.leftUpperArm, leftArmRot);
        this.rotateBone(this.rightUpperArm, rightArmRot);
        
        // Extend spine
        const spineExtend = quat_from_axis_angle([1, 0, 0], -0.1 * stretchPhase);
        this.rotateBone(this.spine, spineExtend);
        
        // Slight tiptoe
        const tiptoe = stretchPhase * 0.1;
        this.rotateBone(this.hips, [0, 0, 0, 1], [0, 0.9 * this.proportions.height + tiptoe, 0]);
    }

    public animateYoga(time: number) {
        const cycle = time * 0.8;
        const phase = (Math.sin(cycle) + 1) / 2;
        
        // Tree pose variation - standing on one leg
        const balancePhase = Math.sin(cycle * 2);
        
        // Raise one leg
        const leftLegRaise = quat_from_axis_angle([1, 0, 0], -0.5);
        const leftLegOut = quat_from_axis_angle([0, 1, 0], 0.8);
        const combinedLegRot = quat_multiply(leftLegRaise, leftLegOut);
        this.rotateBone(this.leftUpperLeg, combinedLegRot);
        
        const kneeBend = quat_from_axis_angle([1, 0, 0], 1.5);
        this.rotateBone(this.leftLowerLeg, kneeBend);
        
        // Arms in prayer position or raised
        const armRaise = -Math.PI / 3;
        const leftArmRot = quat_from_axis_angle([0, 0, 1], armRaise);
        const rightArmRot = quat_from_axis_angle([0, 0, 1], -armRaise);
        
        this.rotateBone(this.leftUpperArm, leftArmRot);
        this.rotateBone(this.rightUpperArm, rightArmRot);
        
        // Subtle balance sway
        const sway = balancePhase * 0.03;
        const swayRot = quat_from_axis_angle([0, 0, 1], sway);
        this.rotateBone(this.hips, swayRot);
    }
}