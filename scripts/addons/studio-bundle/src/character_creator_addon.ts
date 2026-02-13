import { ComponentAddon } from "./system";

// ============================================================================
// CORE TYPES & MATH
// ============================================================================

type Vec3 = [number, number, number];
type Quat = [number, number, number, number]; // [x, y, z, w]
type Mat4 = number[]; // 16 elements

function mat4_identity(): Mat4 {
    return [
        1, 0, 0, 0,
        0, 1, 0, 0,
        0, 0, 1, 0,
        0, 0, 0, 1
    ];
}

function mat4_multiply(a: Mat4, b: Mat4): Mat4 {
    const out = new Array(16);
    for (let i = 0; i < 4; i++) {
        for (let j = 0; j < 4; j++) {
            let sum = 0;
            for (let k = 0; k < 4; k++) {
                sum += a[i * 4 + k] * b[k * 4 + j];
            }
            out[i * 4 + j] = sum;
        }
    }
    return out;
}

function quat_from_axis_angle(axis: Vec3, angle: number): Quat {
    const halfAngle = angle / 2;
    const s = Math.sin(halfAngle);
    return [axis[0] * s, axis[1] * s, axis[2] * s, Math.cos(halfAngle)];
}

function quat_multiply(a: Quat, b: Quat): Quat {
    return [
        a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
        a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
        a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
        a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2]
    ];
}

function mat4_from_rotation_translation_scale(q: Quat, t: Vec3, s: Vec3): Mat4 {
    const x = q[0], y = q[1], z = q[2], w = q[3];
    const x2 = x + x, y2 = y + y, z2 = z + z;
    const xx = x * x2, xy = x * y2, xz = x * z2;
    const yy = y * y2, yz = y * z2, zz = z * z2;
    const wx = w * x2, wy = w * y2, wz = w * z2;
    const sx = s[0], sy = s[1], sz = s[2];

    return [
        (1 - (yy + zz)) * sx, (xy + wz) * sx, (xz - wy) * sx, 0,
        (xy - wz) * sy, (1 - (xx + zz)) * sy, (yz + wx) * sy, 0,
        (xz + wy) * sz, (yz - wx) * sz, (1 - (xx + yy)) * sz, 0,
        t[0], t[1], t[2], 1
    ];
}

// function mat4_inverse(m: Mat4): Mat4 {
//     const out = new Array(16);
    
//     const a00 = m[0], a01 = m[1], a02 = m[2], a03 = m[3];
//     const a10 = m[4], a11 = m[5], a12 = m[6], a13 = m[7];
//     const a20 = m[8], a21 = m[9], a22 = m[10], a23 = m[11];
//     const a30 = m[12], a31 = m[13], a32 = m[14], a33 = m[15];

//     const b00 = a00 * a11 - a01 * a10;
//     const b01 = a00 * a12 - a02 * a10;
//     const b02 = a00 * a13 - a03 * a10;
//     const b03 = a01 * a12 - a02 * a11;
//     const b04 = a01 * a13 - a03 * a11;
//     const b05 = a02 * a13 - a03 * a12;
//     const b06 = a20 * a31 - a21 * a30;
//     const b07 = a20 * a32 - a22 * a30;
//     const b08 = a20 * a33 - a23 * a30;
//     const b09 = a21 * a32 - a22 * a31;
//     const b10 = a21 * a33 - a23 * a31;
//     const b11 = a22 * a33 - a23 * a32;

//     let det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;

//     if (!det) return mat4_identity();
//     det = 1.0 / det;

//     out[0] = (a11 * b11 - a12 * b10 + a13 * b09) * det;
//     out[1] = (a02 * b10 - a01 * b11 - a03 * b09) * det;
//     out[2] = (a31 * b05 - a32 * b04 + a33 * b03) * det;
//     out[3] = (a22 * b04 - a21 * b05 - a23 * b03) * det;
//     out[4] = (a12 * b08 - a10 * b11 - a13 * b07) * det;
//     out[5] = (a00 * b11 - a02 * b08 + a03 * b07) * det;
//     out[6] = (a32 * b02 - a30 * b05 - a33 * b01) * det;
//     out[7] = (a20 * b05 - a22 * b02 + a23 * b01) * det;
//     out[8] = (a10 * b10 - a11 * b08 + a13 * b06) * det;
//     out[9] = (a01 * b08 - a00 * b10 - a03 * b06) * det;
//     out[10] = (a30 * b04 - a31 * b02 + a33 * b00) * det;
//     out[11] = (a21 * b02 - a20 * b04 - a23 * b00) * det;
//     out[12] = (a11 * b07 - a10 * b09 - a12 * b06) * det;
//     out[13] = (a00 * b09 - a01 * b07 + a02 * b06) * det;
//     out[14] = (a31 * b01 - a30 * b03 - a32 * b00) * det;
//     out[15] = (a20 * b03 - a21 * b01 + a22 * b00) * det;

//     return out;
// }

function mat4_inverse(m: Mat4): Mat4 {
    // Extract translation t from m[12..14]
    const t: Vec3 = [m[12], m[13], m[14]];

    // Extract upper 3x3 (rotation, assuming orthogonal and det=1)
    const r00 = m[0], r01 = m[1], r02 = m[2];
    const r10 = m[4], r11 = m[5], r12 = m[6];
    const r20 = m[8], r21 = m[9], r22 = m[10];

    // Transpose rotation for R^T
    const rt00 = r00, rt01 = r10, rt02 = r20;
    const rt10 = r01, rt11 = r11, rt12 = r21;
    const rt20 = r02, rt21 = r12, rt22 = r21;  // typo in original, should be r22

    // Inverse translation -t
    const it0 = -(rt00 * t[0] + rt01 * t[1] + rt02 * t[2]);
    const it1 = -(rt10 * t[0] + rt11 * t[1] + rt12 * t[2]);
    const it2 = -(rt20 * t[0] + rt21 * t[1] + rt22 * t[2]);

    return [
        rt00, rt01, rt02, 0,
        rt10, rt11, rt12, 0,
        rt20, rt21, rt22, 0,
        it0, it1, it2, 1
    ];
}

// ============================================================================
// SKELETON SYSTEM
// ============================================================================

class Bone {
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

class ProceduralHumanoid {
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

        // Body proportions
        const skinColor: [number, number, number, number] = [0.92, 0.76, 0.65, 1.0];
        const shirtColor: [number, number, number, number] = [0.2, 0.4, 0.8, 1.0];
        const pantsColor: [number, number, number, number] = [0.3, 0.3, 0.35, 1.0];
        const shoeColor: [number, number, number, number] = [0.15, 0.15, 0.15, 1.0];

        // IMPORTANT: Vertices must be in BONE LOCAL SPACE
        // Offset determines where geometry sits relative to the bone's origin
        
        // Torso - centered on chest bone
        this.addCapsule([0, 0, 0], 0.20, 0.50, 8, 6, this.chest.id, shirtColor);
        
        // Hips - centered on hips bone
        this.addCapsule([0, 0, 0], 0.18, 0.25, 8, 4, this.hips.id, pantsColor);
        
        // Head - starts at bone origin, extends upward
        this.addSphere([0, 0.11, 0], 0.13, 12, 10, this.head.id, skinColor);
        
        // Neck - centered
        this.addCylinder([0, 0, 0], 0.06, 0.12, 8, this.neck.id, skinColor);
        
        // Left arm - extends along bone's local X axis
        this.addCapsule([-0.14, 0, 0], 0.045, 0.28, 6, 4, this.leftUpperArm.id, skinColor);
        this.addCapsule([-0.13, 0, 0], 0.04, 0.26, 6, 4, this.leftForearm.id, skinColor);
        this.addSphere([-0.09, 0, 0], 0.055, 8, 6, this.leftHand.id, skinColor);
        
        // Right arm - extends along bone's local X axis
        this.addCapsule([0.14, 0, 0], 0.045, 0.28, 6, 4, this.rightUpperArm.id, skinColor);
        this.addCapsule([0.13, 0, 0], 0.04, 0.26, 6, 4, this.rightForearm.id, skinColor);
        this.addSphere([0.09, 0, 0], 0.055, 8, 6, this.rightHand.id, skinColor);
        
        // Left leg - extends downward from bone origin along local -Y
        this.addCapsule([0, -0.225, 0], 0.08, 0.45, 8, 6, this.leftUpperLeg.id, pantsColor);
        this.addCapsule([0, -0.215, 0], 0.065, 0.43, 8, 6, this.leftLowerLeg.id, pantsColor);
        // Foot extends forward from ankle
        this.addCapsule([0, -0.05, 0.08], 0.06, 0.2, 6, 4, this.leftFoot.id, shoeColor);
        
        // Right leg - mirror of left
        this.addCapsule([0, -0.225, 0], 0.08, 0.45, 8, 6, this.rightUpperLeg.id, pantsColor);
        this.addCapsule([0, -0.215, 0], 0.065, 0.43, 8, 6, this.rightLowerLeg.id, pantsColor);
        this.addCapsule([0, -0.05, 0.08], 0.06, 0.2, 6, 4, this.rightFoot.id, shoeColor);
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
}

// ============================================================================
// SHADER
// ============================================================================

const SKINNED_SHADER = `
struct Camera {
    view_proj: mat4x4<f32>,
    view: mat4x4<f32>,
    proj: mat4x4<f32>,
};
@group(0) @binding(0) var<uniform> camera: Camera;

struct MeshUniforms {
    model_matrix: mat4x4<f32>,
};
@group(1) @binding(0) var<uniform> mesh: MeshUniforms;

struct SkinUniforms {
    joints: array<mat4x4<f32>, 256>,
};
@group(2) @binding(0) var<uniform> skin: SkinUniforms;

struct VertexInput {
    @location(0) position: vec3<f32>,
    @location(1) normal: vec3<f32>,
    @location(2) uv: vec2<f32>,
    @location(3) color: vec4<f32>,
    @location(4) joint_indices: vec4<u32>,
    @location(5) joint_weights: vec4<f32>,
};

struct VertexOutput {
    @builtin(position) clip_position: vec4<f32>,
    @location(0) color: vec4<f32>,
    @location(1) world_pos: vec3<f32>,
    @location(2) normal: vec3<f32>,
};

@vertex
fn vs_main(in: VertexInput) -> VertexOutput {
    var skin_matrix: mat4x4<f32> = mat4x4<f32>(
        1.0, 0.0, 0.0, 0.0,
        0.0, 1.0, 0.0, 0.0,
        0.0, 0.0, 1.0, 0.0,
        0.0, 0.0, 0.0, 1.0
    );
    
    for (var i = 0u; i < 4u; i = i + 1u) {
        let joint_index = in.joint_indices[i];
        let joint_weight = in.joint_weights[i];
        if (joint_weight > 0.0) {
            skin_matrix = skin_matrix + joint_weight * skin.joints[joint_index];
        }
    }

    let skinned_pos = skin_matrix * vec4<f32>(in.position, 1.0);
    let world_pos = mesh.model_matrix * skinned_pos;
    
    let skinned_normal = skin_matrix * vec4<f32>(in.normal, 0.0);
    let world_normal = mesh.model_matrix * skinned_normal;
    
    var out: VertexOutput;
    out.clip_position = camera.view_proj * world_pos;
    out.world_pos = world_pos.xyz;
    out.normal = normalize(world_normal.xyz);
    out.color = in.color;
    return out;
}

struct GbufferOutput {
    @location(0) pos: vec4<f32>,
    @location(1) norm: vec4<f32>,
    @location(2) albedo: vec4<f32>,
    @location(3) mat: vec4<f32>,
}

@fragment
fn fs_main(in: VertexOutput) -> GbufferOutput {
    var out: GbufferOutput;
    out.pos = vec4<f32>(in.world_pos, 1.0);
    out.norm = vec4<f32>(in.normal, 1.0);
    out.albedo = in.color;
    out.mat = vec4<f32>(0.6, 0.0, 1.0, 1.0);
    return out;
}
`;

// ============================================================================
// ANIMATION SYSTEM
// ============================================================================

interface CharacterParams {
    bodyScale: number;
    headScale: number;
    armLength: number;
    activeAnimation: "Idle" | "Walk" | "Wave" | "Jump" | "Dance";
}

export class CharacterCreator extends ComponentAddon<CharacterParams> {
    protected defaultParams: CharacterParams = {
        bodyScale: 1.0,
        headScale: 1.0,
        armLength: 1.0,
        activeAnimation: "Idle"
    };

    public pipelineId: string | null = null;
    public meshId: string | null = null;
    public humanoid: ProceduralHumanoid;
    public jointBufferId: string | null = null;
    public animationTime: number = 0;

    constructor() {
        super({
            name: "Character Creator",
            version: "3.0.0",
            description: "Realistic procedural humanoid with smooth animations",
            author: ["Entropy Team"],
            capabilities: { graphics: true, ui: true }
        });
        this.humanoid = new ProceduralHumanoid();
    }

    protected setup(): void {
        this.initComponentState("Realistic Hero");
        
        this.pipelineId = Entropy.Pipeline.create({
            name: "Realistic_Skinned_Pipeline",
            layout: "skinned",
            vertexShader: SKINNED_SHADER,
            fragmentShader: SKINNED_SHADER,
            extraBindGroups: [
                { entries: [{ binding: 0, visibility: ["Vertex"], resourceType: "Uniform" }] }
            ]
        });

        this.jointBufferId = this.api.Buffer.create({
            size: 16384,
            usage: "Uniform"
        });

        this.generateCharacter();
        this.setupUI();

        this.api.onUpdate((time) => {
            this.animationTime = time;
            this.animate(time);
        });
    }

    public generateCharacter() {
        if (this.meshId) this.api.Model.clearMesh(this.meshId);
        
        this.humanoid.generateMesh();
        this.meshId = Entropy.generateUUID();

        this.api.Model.createMesh({
            id: this.meshId,
            position: [0, 0, 0],
            vertexData: this.humanoid.vertices,
            indexData: this.humanoid.indices,
            pipelineId: this.pipelineId!,
            bindings: [
                { group: 2, binding: 0, resource: { type: "Buffer", value: { id: this.jointBufferId! } } }
            ]
        });
    }

    public animate(time: number) {
        // First, reset to bind pose
        this.humanoid.resetPose();

        const params = this.currentParams;
        
        // Then apply animation modifications
        switch (params.activeAnimation) {
            case "Idle":
                this.animateIdle(time);
                break;
            case "Walk":
                this.animateWalk(time);
                break;
            case "Wave":
                this.animateWave(time);
                break;
            case "Jump":
                this.animateJump(time);
                break;
            case "Dance":
                this.animateDance(time);
                break;
        }

        // Update world transforms from root
        this.humanoid.rootBone.updateWorldTransform(mat4_identity());
        
        // Upload joint matrices to GPU
        const matrices = this.humanoid.getJointMatrices();
        this.api.Buffer.write(this.jointBufferId!, new Float32Array(matrices));
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

    public animateIdle(time: number) {
        // Subtle breathing
        const breathCycle = Math.sin(time * 1.5) * 0.02;
        const breathScale = [1.0, 1.0 + breathCycle, 1.0] as Vec3;
        
        // Head sway
        const headSway = Math.sin(time * 0.8) * 0.03;
        const headRot = quat_from_axis_angle([0, 1, 0], headSway);
        this.rotateBone(this.humanoid.head, headRot);
        
        // Gentle arm sway
        const armSway = Math.sin(time * 1.2) * 0.05;
        const leftArmRot = quat_from_axis_angle([0, 0, 1], armSway);
        const rightArmRot = quat_from_axis_angle([0, 0, 1], -armSway);
        
        this.rotateBone(this.humanoid.leftUpperArm, leftArmRot);
        this.rotateBone(this.humanoid.rightUpperArm, rightArmRot);
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
        this.rotateBone(this.humanoid.hips, [0, 0, 0, 1], [0, hipHeight, 0]);
        
        // Slight spine lean forward
        const spineForwardLean = quat_from_axis_angle([1, 0, 0], 0.05);
        this.rotateBone(this.humanoid.spine, spineForwardLean);
        
        // LEFT LEG - Hip rotation
        const leftHipSwing = leftLegPhase * 0.5;
        const leftHipRot = quat_from_axis_angle([1, 0, 0], leftHipSwing);
        this.rotateBone(this.humanoid.leftUpperLeg, leftHipRot);
        
        // LEFT LEG - Knee bends when leg is back
        const leftKneeBend = Math.max(0, -leftLegPhase) * 1.2;
        const leftKneeRot = quat_from_axis_angle([1, 0, 0], leftKneeBend);
        this.rotateBone(this.humanoid.leftLowerLeg, leftKneeRot);
        
        // LEFT LEG - Foot tilt
        const leftFootTilt = leftLegPhase * 0.3;
        const leftFootRot = quat_from_axis_angle([1, 0, 0], -leftFootTilt);
        this.rotateBone(this.humanoid.leftFoot, leftFootRot);
        
        // RIGHT LEG - Hip rotation
        const rightHipSwing = rightLegPhase * 0.5;
        const rightHipRot = quat_from_axis_angle([1, 0, 0], rightHipSwing);
        this.rotateBone(this.humanoid.rightUpperLeg, rightHipRot);
        
        // RIGHT LEG - Knee bend
        const rightKneeBend = Math.max(0, -rightLegPhase) * 1.2;
        const rightKneeRot = quat_from_axis_angle([1, 0, 0], rightKneeBend);
        this.rotateBone(this.humanoid.rightLowerLeg, rightKneeRot);
        
        // RIGHT LEG - Foot tilt
        const rightFootTilt = rightLegPhase * 0.3;
        const rightFootRot = quat_from_axis_angle([1, 0, 0], -rightFootTilt);
        this.rotateBone(this.humanoid.rightFoot, rightFootRot);
        
        // ARMS - swing opposite to legs
        const leftArmSwing = -leftLegPhase * 0.35;
        const leftArmRot = quat_from_axis_angle([1, 0, 0], leftArmSwing);
        this.rotateBone(this.humanoid.leftUpperArm, leftArmRot);
        
        const rightArmSwing = -rightLegPhase * 0.35;
        const rightArmRot = quat_from_axis_angle([1, 0, 0], rightArmSwing);
        this.rotateBone(this.humanoid.rightUpperArm, rightArmRot);
        
        // Slight elbow bend
        const elbowBend = quat_from_axis_angle([1, 0, 0], 0.15);
        this.rotateBone(this.humanoid.leftForearm, elbowBend);
        this.rotateBone(this.humanoid.rightForearm, elbowBend);
    }

    public animateWave(time: number) {
        const waveCycle = time * 3.0;
        
        // Raise right arm
        const shoulderRot = quat_from_axis_angle([0, 0, 1], -1.5);
        this.rotateBone(this.humanoid.rightUpperArm, shoulderRot);
        
        // Wave hand with elbow rotation
        const elbowBase = quat_from_axis_angle([0, 0, 1], -0.5);
        const waveAngle = Math.sin(waveCycle) * 0.5;
        const waveRot = quat_from_axis_angle([0, 1, 0], waveAngle);
        const combinedElbowRot = quat_multiply(elbowBase, waveRot);
        
        this.rotateBone(this.humanoid.rightForearm, combinedElbowRot);
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
        this.rotateBone(this.humanoid.hips, hipRot, [0, 0.9 + jumpHeight, 0]);
        
        const legRot = quat_from_axis_angle([1, 0, 0], -hipBend);
        this.rotateBone(this.humanoid.leftUpperLeg, legRot);
        this.rotateBone(this.humanoid.rightUpperLeg, legRot);
        
        const kneeRot = quat_from_axis_angle([1, 0, 0], kneeBend);
        this.rotateBone(this.humanoid.leftLowerLeg, kneeRot);
        this.rotateBone(this.humanoid.rightLowerLeg, kneeRot);
        
        const ankleRot = quat_from_axis_angle([1, 0, 0], -ankleBend);
        this.rotateBone(this.humanoid.leftFoot, ankleRot);
        this.rotateBone(this.humanoid.rightFoot, ankleRot);
        
        const armRot = quat_from_axis_angle([1, 0, 0], armRaise);
        this.rotateBone(this.humanoid.leftUpperArm, armRot);
        this.rotateBone(this.humanoid.rightUpperArm, armRot);
    }

    public animateDance(time: number) {
        const danceSpeed = 2.5;
        const cycle = time * danceSpeed;
        
        // Hip rotation
        const hipRotation = Math.sin(cycle) * 0.3;
        const hipRot = quat_from_axis_angle([0, 1, 0], hipRotation);
        this.rotateBone(this.humanoid.hips, hipRot);
        
        // Shoulder shimmy
        const shoulderShimmy = Math.sin(cycle * 2) * 0.2;
        const leftShoulderRot = quat_from_axis_angle([0, 0, 1], shoulderShimmy);
        const rightShoulderRot = quat_from_axis_angle([0, 0, 1], -shoulderShimmy);
        
        this.rotateBone(this.humanoid.leftShoulder, leftShoulderRot);
        this.rotateBone(this.humanoid.rightShoulder, rightShoulderRot);
        
        // Alternating arm raises
        const leftArmRaise = Math.max(0, Math.sin(cycle)) * -1.2;
        const rightArmRaise = Math.max(0, Math.sin(cycle + Math.PI)) * -1.2;
        
        const leftArmRot = quat_from_axis_angle([0, 0, 1], leftArmRaise);
        const rightArmRot = quat_from_axis_angle([0, 0, 1], rightArmRaise);
        
        this.rotateBone(this.humanoid.leftUpperArm, leftArmRot);
        this.rotateBone(this.humanoid.rightUpperArm, rightArmRot);
    }

    public setupUI() {
        const tab = this.api.UI.createTab({
            title: "Character Creator",
            onRender: () => {
                Entropy.UI.Widget.label(tab, { text: "👤 Realistic Character Creator", bold: true });
                Entropy.UI.Widget.separator(tab);
                
                this.renderComponentUI(tab, () => this.generateCharacter());
                
                Entropy.UI.Widget.separator(tab);
                Entropy.UI.Widget.label(tab, { text: "Animation Controls", bold: true });
                
                Entropy.UI.Widget.dropdown(tab, {
                    label: "Active Animation",
                    options: ["Idle", "Walk", "Wave", "Jump", "Dance"],
                    selectedIndex: ["Idle", "Walk", "Wave", "Jump", "Dance"].indexOf(this.currentParams.activeAnimation),
                    onChange: (idx) => { 
                        this.currentParams.activeAnimation = ["Idle", "Walk", "Wave", "Jump", "Dance"][parseInt(idx)] as any;
                    }
                });

                Entropy.UI.Widget.separator(tab);
                Entropy.UI.Widget.label(tab, { text: "Morphology", bold: true });
                
                Entropy.UI.Widget.button(tab, {
                    text: "🎲 Randomize Character",
                    onClick: () => {
                        this.currentParams.headScale = 0.8 + Math.random() * 0.4;
                        this.currentParams.bodyScale = 0.85 + Math.random() * 0.3;
                        this.currentParams.armLength = 0.9 + Math.random() * 0.2;
                        this.generateCharacter();
                    }
                });
            }
        });
    }
}

new CharacterCreator().register();