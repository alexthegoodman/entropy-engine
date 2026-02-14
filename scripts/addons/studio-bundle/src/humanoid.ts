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

    constructor() {
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

    resetPose() {
        // Realistic human proportions (in meters, ~1.75m tall)
        const hipHeight = 0.9;
        const spineLength = 0.25;
        const chestLength = 0.25;
        const neckLength = 0.12;
        const headLength = 0.23;
        
        const shoulderWidth = 0.18;
        const upperArmLength = 0.28;
        const forearmLength = 0.26;
        const handLength = 0.18;
        
        const upperLegLength = 0.45;
        const lowerLegLength = 0.43;
        const footLength = 0.25;
        const legSpacing = 0.10;

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

        const skinColor: [number, number, number, number] = [0.92, 0.76, 0.65, 1.0];
        const shirtColor: [number, number, number, number] = [0.2, 0.4, 0.8, 1.0];
        const pantsColor: [number, number, number, number] = [0.3, 0.3, 0.35, 1.0];

        // TEST: Create simple boxes at each bone's WORLD POSITION at bind time
        // This way we can see if skinning works at all
        
        // Get world positions from bind pose
        this.rootBone.updateWorldTransform(mat4_identity());
        
        // Helper to extract position from matrix
        const getPos = (mat: Mat4): Vec3 => [mat[12], mat[13], mat[14]];
        
        // Create small boxes at each bone position
        const boxSize = 0.1;
        const limbSize = 0.4;
        
        // Legs - the problematic ones
        this.addCylinder(getPos(this.leftUpperLeg.worldTransform), 0.05, limbSize, 8, this.leftUpperLeg.id, pantsColor);
        this.addCylinder(getPos(this.leftLowerLeg.worldTransform), 0.05, limbSize, 8, this.leftLowerLeg.id, pantsColor);
        this.addBox(getPos(this.leftFoot.worldTransform), boxSize, this.leftFoot.id, skinColor);
        
        this.addCylinder(getPos(this.rightUpperLeg.worldTransform), 0.05, limbSize, 8, this.rightUpperLeg.id, pantsColor);
        this.addCylinder(getPos(this.rightLowerLeg.worldTransform), 0.05, limbSize, 8, this.rightLowerLeg.id, pantsColor);
        this.addBox(getPos(this.rightFoot.worldTransform), boxSize, this.rightFoot.id, skinColor);
        
        // Torso
        this.addBox(getPos(this.chest.worldTransform), boxSize * 1.5, this.chest.id, shirtColor);
        this.addBox(getPos(this.head.worldTransform), boxSize, this.head.id, skinColor);
        
        // Arms
        this.addCylinder(getPos(this.leftUpperArm.worldTransform), 0.05, limbSize * 0.7, 8, this.leftUpperArm.id, skinColor);
        this.addCylinder(getPos(this.rightUpperArm.worldTransform), 0.05, limbSize * 0.7, 8, this.rightUpperArm.id, skinColor);
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
        
        const normals: Vec3[] = [
            [0, 0, -1], [0, 0, -1], [0, 0, -1], [0, 0, -1], // back
            [0, 0, 1], [0, 0, 1], [0, 0, 1], [0, 0, 1],       // front
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

    public addSphere(
        offset: Vec3,
        radius: number,
        segments: number,
        rings: number,
        boneIdx: number,
        color: [number, number, number, number]
    ) {
        const startVertex = this.vertices.length / 18;

        for (let ring = 0; ring <= rings; ring++) {
            const theta = (ring * Math.PI) / rings;
            const sinTheta = Math.sin(theta);
            const cosTheta = Math.cos(theta);

            for (let seg = 0; seg <= segments; seg++) {
                const phi = (seg * 2 * Math.PI) / segments;
                const sinPhi = Math.sin(phi);
                const cosPhi = Math.cos(phi);

                const x = cosPhi * sinTheta;
                const y = cosTheta;
                const z = sinPhi * sinTheta;

                this.pushVertex(
                    [offset[0] + radius * x, offset[1] + radius * y, offset[2] + radius * z],
                    [x, y, z],
                    color,
                    boneIdx
                );
            }
        }

        for (let ring = 0; ring < rings; ring++) {
            for (let seg = 0; seg < segments; seg++) {
                const current = startVertex + ring * (segments + 1) + seg;
                const next = current + segments + 1;

                this.indices.push(current, next, current + 1);
                this.indices.push(current + 1, next, next + 1);
            }
        }
    }

    public addCapsule(
        offset: Vec3,
        radius: number,
        height: number,
        segments: number,
        rings: number,
        boneIdx: number,
        color: [number, number, number, number]
    ) {
        const halfHeight = height / 2;
        const startVertex = this.vertices.length / 18;

        // Top hemisphere
        for (let ring = 0; ring <= rings / 2; ring++) {
            const theta = (ring * Math.PI) / rings;
            const sinTheta = Math.sin(theta);
            const cosTheta = Math.cos(theta);

            for (let seg = 0; seg <= segments; seg++) {
                const phi = (seg * 2 * Math.PI) / segments;
                const x = Math.cos(phi) * sinTheta;
                const y = cosTheta;
                const z = Math.sin(phi) * sinTheta;

                this.pushVertex(
                    [offset[0] + radius * x, offset[1] + halfHeight + radius * y, offset[2] + radius * z],
                    [x, y, z],
                    color,
                    boneIdx
                );
            }
        }

        // Cylinder middle
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

        // Bottom hemisphere
        for (let ring = rings / 2; ring <= rings; ring++) {
            const theta = (ring * Math.PI) / rings;
            const sinTheta = Math.sin(theta);
            const cosTheta = Math.cos(theta);

            for (let seg = 0; seg <= segments; seg++) {
                const phi = (seg * 2 * Math.PI) / segments;
                const x = Math.cos(phi) * sinTheta;
                const y = cosTheta;
                const z = Math.sin(phi) * sinTheta;

                this.pushVertex(
                    [offset[0] + radius * x, offset[1] - halfHeight + radius * y, offset[2] + radius * z],
                    [x, y, z],
                    color,
                    boneIdx
                );
            }
        }

        // Generate indices for all sections
        const totalRings = rings + 3;
        for (let ring = 0; ring < totalRings; ring++) {
            for (let seg = 0; seg < segments; seg++) {
                const current = startVertex + ring * (segments + 1) + seg;
                const next = current + segments + 1;

                this.indices.push(current, next, current + 1);
                this.indices.push(current + 1, next, next + 1);
            }
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
        // Entropy.println(`Animating humanoid with ${animation} at time ${time}`);
        // First, reset to bind pose
        this.resetPose();
        
        // Then apply animation modifications
        switch (animation) {
            case "Idle": this.animateIdle(time); break;
            case "Walk": case "Walking": 
                // Entropy.println("Performing Walk animation");
                this.animateWalk(time); 
                break;
            case "Wave": this.animateWave(time); break;
            case "Jump": this.animateJump(time); break;
            case "Dance": this.animateDance(time); break;
            default: this.animateIdle(time); break;
        }

        // Update world transforms from root
        this.rootBone.updateWorldTransform(mat4_identity());
    }

    public animateIdle(time: number) {
        // Subtle breathing
        const breathCycle = Math.sin(time * 1.5) * 0.02;
        const breathScale = [1.0, 1.0 + breathCycle, 1.0] as Vec3;
        
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
        
        // Leg swing goes from -1 to 1
        const leftLegPhase = Math.sin(cycle);
        const rightLegPhase = Math.sin(cycle + Math.PI);
        
        // Body bob - goes up when both legs are mid-stride
        const bobAmount = Math.abs(Math.sin(cycle * 2)) * 0.04;
        const hipHeight = 0.9 - 0.02 + bobAmount;
        this.rotateBone(this.hips, [0, 0, 0, 1], [0, hipHeight, 0]);
        
        // Slight spine lean forward
        const spineForwardLean = quat_from_axis_angle([1, 0, 0], 0.05);
        this.rotateBone(this.spine, spineForwardLean);
        
        // LEFT LEG - Hip rotation
        const leftHipSwing = leftLegPhase * 0.5;
        const leftHipRot = quat_from_axis_angle([1, 0, 0], leftHipSwing);
        this.rotateBone(this.leftUpperLeg, leftHipRot);
        
        // LEFT LEG - Knee bends when leg is back
        const leftKneeBend = Math.max(0, -leftLegPhase) * 1.2;
        const leftKneeRot = quat_from_axis_angle([1, 0, 0], leftKneeBend);
        this.rotateBone(this.leftLowerLeg, leftKneeRot);
        
        // LEFT LEG - Foot tilt
        const leftFootTilt = leftLegPhase * 0.3;
        const leftFootRot = quat_from_axis_angle([1, 0, 0], -leftFootTilt);
        this.rotateBone(this.leftFoot, leftFootRot);
        
        // RIGHT LEG - Hip rotation
        const rightHipSwing = rightLegPhase * 0.5;
        const rightHipRot = quat_from_axis_angle([1, 0, 0], rightHipSwing);
        this.rotateBone(this.rightUpperLeg, rightHipRot);
        
        // RIGHT LEG - Knee bend
        const rightKneeBend = Math.max(0, -rightLegPhase) * 1.2;
        const rightKneeRot = quat_from_axis_angle([1, 0, 0], rightKneeBend);
        this.rotateBone(this.rightLowerLeg, rightKneeRot);
        
        // RIGHT LEG - Foot tilt
        const rightFootTilt = rightLegPhase * 0.3;
        const rightFootRot = quat_from_axis_angle([1, 0, 0], -rightFootTilt);
        this.rotateBone(this.rightFoot, rightFootRot);
        
        // ARMS - swing opposite to legs
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
        
        // Apply transforms using rotateBone
        const hipRot = quat_from_axis_angle([1, 0, 0], hipBend);
        this.rotateBone(this.hips, hipRot, [0, 0.9 + jumpHeight, 0]);
        
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
}
