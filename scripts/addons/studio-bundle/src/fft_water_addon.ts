// ============================================================================
// FFT OCEAN - UNREAL ENGINE 5 QUALITY WATER
// GPU-Accelerated Ocean Simulation with Compute Shaders
// ============================================================================

// ===== COMPUTE SHADERS =====

const SPECTRUM_INIT_SHADER = `
// Initialize H0(k) - the initial wave spectrum using Phillips spectrum
struct SpectrumParams {
    resolution: f32,
    ocean_size: f32,
    wind_speed: f32,
    wind_direction_x: f32,
    wind_direction_y: f32,
    amplitude: f32,
    gravity: f32,
    padding: f32,
}

@group(0) @binding(0)
var output_h0: texture_storage_2d<rgba16float, write>;

@group(0) @binding(1)
var<uniform> params: SpectrumParams;

// Random number generation for gaussian
fn hash(p: vec2<f32>) -> f32 {
    let p3 = fract(vec3<f32>(p.x, p.y, p.x) * 0.13);
    let p3_dot = dot(p3, vec3<f32>(p3.y + 3.333, p3.z + 3.333, p3.x + 3.333));
    return fract((p3.x + p3.y) * p3_dot);
}

// Box-Muller transform for gaussian random
fn gaussian_random(uv: vec2<f32>) -> vec2<f32> {
    let u1 = hash(uv);
    let u2 = hash(uv + vec2<f32>(127.1, 311.7));
    
    let r = sqrt(-2.0 * log(u1 + 0.0001));
    let theta = 6.28318530718 * u2;
    
    return vec2<f32>(r * cos(theta), r * sin(theta));
}

// Phillips spectrum
// other spectrums to try include JONSWAP, TMA, Pierson-Moskowitz, and Donelan-Banner
fn phillips_spectrum(k: vec2<f32>) -> f32 {
    let k_length = length(k);
    if (k_length < 0.0001) {
        return 0.0;
    }
    
    let L = (params.wind_speed * params.wind_speed) / params.gravity;
    let k_length2 = k_length * k_length;
    let k_length4 = k_length2 * k_length2;
    
    let wind_dir = normalize(vec2<f32>(params.wind_direction_x, params.wind_direction_y));
    let k_normalized = k / k_length;
    let k_dot_w = dot(k_normalized, wind_dir);
    let k_dot_w2 = k_dot_w * k_dot_w;
    
    // Suppression of waves perpendicular to wind
    let damping = 0.001;
    let l2 = L * L * damping * damping;
    
    let phillips = params.amplitude * 
                   exp(-1.0 / (k_length2 * L * L)) / k_length4 *
                   k_dot_w2 *
                   exp(-k_length2 * l2);
    
    return phillips;
}

// JONSWAP spectrum — models fetch-limited seas with a pronounced dominant frequency peak.
// More physically accurate than Phillips for coastal/stormy conditions.
//
// Key addition over Phillips/Pierson-Moskowitz: the "peak enhancement factor" gamma,
// which sharpens the spectral peak around the dominant frequency omega_p.
// gamma = 1.0  =>  reduces to Pierson-Moskowitz (fully developed, calm open sea)
// gamma = 3.3  =>  standard JONSWAP (typical North Sea fetch-limited conditions)
// gamma = 7.0  =>  very sharp peak (young, stormy, short-fetch sea state)
fn jonswap_spectrum(wave_vector: vec2<f32>) -> f32 {
    let wave_number = length(wave_vector);
    if (wave_number < 0.0001) {
        return 0.0;
    }

    // Peak wavenumber: derived from the dominant angular frequency omega_p.
    // For a fully developed sea: omega_p ≈ 0.87 * g / U (Pierson-Moskowitz).
    // Via dispersion omega^2 = g*k => k_p = omega_p^2 / g
    let omega_p = 0.87 * params.gravity / params.wind_speed;
    let peak_wave_number = (omega_p * omega_p) / params.gravity;

    // Pierson-Moskowitz base shape — broad energy distribution across frequencies.
    // S_PM(k) = (alpha / k^4) * exp(-beta * (k_p / k)^2)
    let alpha = 0.0081; // Phillips-Hasselmann constant
    let beta  = 1.25;
    let pm_shape = (alpha / (wave_number * wave_number * wave_number * wave_number))
                 * exp(-beta * pow(peak_wave_number / wave_number, 2.0));

    // JONSWAP peak enhancement — sharpens the spectral peak at k = k_p.
    // Multiplies the PM base by gamma^(exp(...)), which boosts energy near the peak.
    let gamma         = 5.3; // Try 1.0 (calm) to 7.0 (stormy) — biggest visual lever
    let sigma         = select(0.09, 0.07, wave_number <= peak_wave_number); // width of peak (narrower below peak)
    let peak_exponent = exp(
        -pow(sqrt(wave_number / peak_wave_number) - 1.0, 2.0)
        / (2.0 * sigma * sigma)
    );
    let peak_enhancement = pow(gamma, peak_exponent);

    // Directional spreading — how energy fans out around wind direction.
    // Phillips uses dot(k,wind)^2 which is very broad. This is still simple
    // but you could replace with Donelan-Banner sech^2 for tighter realism.
    let wind_dir    = normalize(vec2<f32>(params.wind_direction_x, params.wind_direction_y));
    let k_dir       = wave_vector / wave_number;
    let directional = max(0.0, dot(k_dir, wind_dir));
    let spreading   = directional * directional; // ^2 = moderate spreading, ^4 = tight beam

    // Small-wave damping — suppresses wavelengths shorter than a capillary cutoff.
    // Keeps the surface from getting unphysically noisy at high k.
    let capillary_cutoff = 0.001;
    let damping = exp(-wave_number * wave_number * capillary_cutoff * capillary_cutoff);

    return params.amplitude * pm_shape * peak_enhancement * spreading * damping;
}

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
    let N = u32(params.resolution);
    
    // Wave vector k
    let n = vec2<f32>(f32(id.x) - f32(N) * 0.5, f32(id.y) - f32(N) * 0.5);
    let k = (2.0 * 3.14159265359 * n) / params.ocean_size;
    
    // Phillips spectrum value
    // let ph = phillips_spectrum(k); // best for semi-calm
    let ph = jonswap_spectrum(k);
    
    // Gaussian random numbers
    let uv = vec2<f32>(f32(id.x), f32(id.y)) / f32(N);
    let xi = gaussian_random(uv);
    
    // H0(k) = gaussian * sqrt(Ph(k) / 2)
    let h0 = xi * sqrt(ph * 0.5);
    
    // Store as complex number (real, imag, -real, -imag) for conjugate
    textureStore(output_h0, vec2<i32>(id.xy), vec4<f32>(h0.x, h0.y, -h0.x, -h0.y));
}
`;

// const SPECTRUM_INIT_SHADER = `
// struct SpectrumParams {
//     resolution: f32,
//     ocean_size: f32,
//     wind_speed: f32,
//     wind_direction_x: f32,
//     wind_direction_y: f32,
//     amplitude: f32,
//     gravity: f32,
//     padding: f32,
// }

// @group(0) @binding(0)
// var output_h0: texture_storage_2d<rgba16float, write>;

// @group(0) @binding(1)
// var<uniform> params: SpectrumParams;

// @compute @workgroup_size(8, 8, 1)
// fn main(@builtin(global_invocation_id) id: vec3<u32>) {
//     let N = u32(params.resolution);
    
//     // Safety check for texture bounds
//     //if (id.x >= N || id.y >= N) { return; }

//     // Create a simple 0.0 to 1.0 gradient based on position
//     let uv = vec2<f32>(id.xy) / f32(N);
    
//     // Generate a simple test pattern:
//     // Red/Green: Horizontal and vertical gradients
//     // Blue: A simple sine wave to simulate "waves"
//     let test_height = sin(uv.x * 10.0) * 0.5 + 0.5;
    
//     // Pack it into the h0 format (Real, Imaginary, etc.)
//     // We use uv.x and uv.y so you can see if the orientation is correct
//     let debug_val = vec4<f32>(
//         uv.x,          // Real
//         uv.y,          // Imaginary
//         test_height,   // Placeholder for conjugate real
//         1.0            // Alpha / Debug marker
//     );

//     textureStore(output_h0, vec2<i32>(id.xy), debug_val);
// }
// `;

const SPECTRUM_UPDATE_SHADER = `
// Evolves the frequency-domain ocean spectrum H(k,t) forward in time.
//
// Each texel (texture pixel) represents one wave vector k. We take the initial spectrum H0(k)
// (generated offline with an oceanography spectrum, Phillips in our case)
// and animate it by rotating each complex amplitude in the complex plane at
// its natural angular frequency omega(k). This gives us the time-varying
// spectrum H(k,t), which can then be inverse-FFT'd (Fast Fourier Transform) to get real-space
// surface displacement.

struct TimeParams {
    time: f32,          // Simulation time in seconds
    resolution: f32,    // Grid resolution N (texture is N x N)
    ocean_size: f32,    // Physical size of the ocean tile in meters
    gravity: f32,       // Gravitational acceleration (m/s^2), typically 9.81
    choppiness: f32,    // Scales horizontal (Gerstner) displacement
    padding1: f32,
    padding2: f32,
    padding3: f32,
}

@group(0) @binding(0)
var initial_spectrum_h0: texture_2d<f32>;
// Each texel stores two complex numbers packed into rgba:
//   rg = H0(k)    — the complex amplitude for wave vector k
//   ba = H0*(-k)  — the conjugate amplitude for the negated wave vector
// These are generated once at startup and never change.

@group(0) @binding(1)
var output_animated_spectrum: texture_storage_2d<rgba16float, write>;
// Output: time-evolved spectrum ready for the IFFT pass.
// Packed as: rg = H(k,t) complex height,  ba = (Dx, Dz) real parts of horizontal displacement

@group(0) @binding(2)
var<uniform> params: TimeParams;

// Multiplies two complex numbers represented as vec2(real, imaginary).
// (a + ib)(c + id) = (ac - bd) + i(ad + bc)
fn complex_multiply(a: vec2<f32>, b: vec2<f32>) -> vec2<f32> {
    return vec2<f32>(
        a.x * b.x - a.y * b.y,  // real part
        a.x * b.y + a.y * b.x   // imaginary part
    );
}

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) global_id: vec3<u32>) {
    let grid_size = u32(params.resolution);

    // Compute the 2D wave vector k for this texel.
    // We center the grid so that k = 0 is in the middle (DC component),
    // with negative frequencies on the left/bottom and positive on the right/top.
    // grid_offset maps [0, N) texel indices to [-N/2, N/2) frequency indices.
    let grid_offset = vec2<f32>(
        f32(global_id.x) - f32(grid_size) * 0.5,
        f32(global_id.y) - f32(grid_size) * 0.5
    );

    // Convert from grid index space to physical wavenumber (radians per meter).
    // k = 2*pi * n / L, where L = ocean_size in meters.
    let wave_vector = (2.0 * 3.14159265359 * grid_offset) / params.ocean_size;
    let wave_number = length(wave_vector); // |k| = scalar wavenumber (rad/m)

    // Deep-water dispersion relation: omega^2 = g * |k|
    // => omega = sqrt(g * |k|)
    // This gives the natural angular frequency (rad/s) at which a wave of this
    // wavenumber oscillates. Shorter waves (higher |k|) oscillate faster.
    let angular_frequency = sqrt(params.gravity * wave_number);

    // Load H0(k) and H0*(-k) from the packed initial spectrum texture.
    // rg channels hold H0(k), ba channels hold H0*(-k) (precomputed conjugate).
    let packed_initial_spectrum = textureLoad(initial_spectrum_h0, vec2<i32>(global_id.xy), 0);
    let h0_k              = vec2<f32>(packed_initial_spectrum.x, packed_initial_spectrum.y);
    let h0_minus_k_conj   = vec2<f32>(packed_initial_spectrum.z, packed_initial_spectrum.w);

    // Compute the time-rotation phasors: exp(±i * omega * t)
    // By Euler's formula: e^(i*theta) = cos(theta) + i*sin(theta)
    // Positive phasor rotates H0(k) forward in time.
    // Negative phasor rotates H0*(-k) backward (required for the conjugate symmetry term).
    let phase_angle   = angular_frequency * params.time;
    let phasor_forward  = vec2<f32>( cos(phase_angle), sin(phase_angle));   // e^(+i*omega*t)
    let phasor_backward = vec2<f32>( cos(phase_angle), -sin(phase_angle));  // e^(-i*omega*t)

    // Animate the spectrum using the standard ocean simulation formula:
    //   H(k,t) = H0(k) * e^(+i*omega*t) + H0*(-k) * e^(-i*omega*t)
    // This superposition ensures the resulting surface displacement is real-valued,
    // since the two terms are complex conjugates of each other.
    let animated_height_spectrum = complex_multiply(h0_k, phasor_forward)
                                 + complex_multiply(h0_minus_k_conj, phasor_backward);

    // Compute horizontal (Gerstner/choppy) displacement spectra Dx and Dz.
    // In the frequency domain, horizontal displacement is derived by multiplying
    // the height spectrum by -i * (k / |k|):
    //   Dx(k,t) = -i * (kx / |k|) * H(k,t)
    //   Dz(k,t) = -i * (kz / |k|) * H(k,t)
    //
    // Multiplying a complex number (r + i*m) by -i gives (m - i*r),
    // i.e. swap real/imag and negate the new imaginary part:
    //   -i * (h_real + i*h_imag) = h_imag - i*h_real  =>  vec2(h_imag, -h_real)
    var displacement_x = vec2<f32>(0.0);
    var displacement_z = vec2<f32>(0.0);

    if (wave_number > 0.0001) {
        // Normalized wave direction vector (unit vector pointing in wave travel direction)
        let wave_direction = wave_vector / wave_number;

        // Apply -i rotation and scale by wave direction component and choppiness factor.
        // The choppiness parameter controls how far waves peak and crest horizontally.
        let height_rotated_by_neg_i = vec2<f32>(animated_height_spectrum.y, -animated_height_spectrum.x);
        displacement_x = height_rotated_by_neg_i * wave_direction.x * params.choppiness;
        displacement_z = height_rotated_by_neg_i * wave_direction.y * params.choppiness;
    }

    // Pack output into a single rgba16float texel for the IFFT pass:
    //   rg = H(k,t) complex height spectrum  (real, imaginary)
    //   b  = Dx real part (horizontal displacement in x after IFFT)
    //   a  = Dz real part (horizontal displacement in z after IFFT)
    // Only the real parts of Dx/Dz are stored since the IFFT will produce real outputs.
    textureStore(
        output_animated_spectrum,
        vec2<i32>(global_id.xy),
        vec4<f32>(
            animated_height_spectrum.x,  // height: real
            animated_height_spectrum.y,  // height: imaginary
            displacement_x.x,            // Dx: real
            displacement_z.x             // Dz: real
        )
    );
}
`;

// const SPECTRUM_UPDATE_SHADER = `
// struct SpectrumParams {
//     time: f32,
//     resolution: f32,
//     ocean_size: f32,
//     gravity: f32,
//     choppiness: f32,
//     padding1: f32,
//     padding2: f32,
//     padding3: f32,
// }

// @group(0) @binding(0)
// var input_h0: texture_2d<f32>;

// @group(0) @binding(1)
// var output_ht: texture_storage_2d<rgba16float, write>;

// @group(0) @binding(2)
// var<uniform> params: SpectrumParams;

// @compute @workgroup_size(8, 8, 1)
// fn main(@builtin(global_invocation_id) id: vec3<u32>) {
//     let N = u32(params.resolution);
    
//     // Safety check for texture bounds
//     //if (id.x >= N || id.y >= N) { return; }

//     // Create a simple 0.0 to 1.0 gradient based on position
//     let uv = vec2<f32>(id.xy) / f32(N);
    
//     // Generate a simple test pattern:
//     // Red/Green: Horizontal and vertical gradients
//     // Blue: A simple sine wave to simulate "waves"
//     let test_height = sin(uv.x * 10.0) * 0.5 + 0.5;
    
//     // Pack it into the h0 format (Real, Imaginary, etc.)
//     // We use uv.x and uv.y so you can see if the orientation is correct
//     let debug_val = vec4<f32>(
//         uv.x,          // Real
//         uv.y,          // Imaginary
//         test_height,   // Placeholder for conjugate real
//         1.0            // Alpha / Debug marker
//     );

//     textureStore(output_ht, vec2<i32>(id.xy), debug_val);
//     // textureStore(output_ht, vec2<i32>(id.xy), vec4<f32>(1.0, 0.0, 1.0, 1.0)); // Bright magenta
// }
// `;


const FFT_HORIZONTAL_SHADER = `
// Horizontal FFT pass using Cooley-Tukey butterfly algorithm
struct FFTParams {
    resolution: f32,
    stage: f32,      // Which butterfly stage (0 to log2(N)-1)
    direction: f32,  // 0 = forward, 1 = inverse
    pingpong: f32,   // 0 = read A write B, 1 = read B write A
}

@group(0) @binding(0)
var input_tex: texture_2d<f32>;

@group(0) @binding(1)
var output_tex: texture_storage_2d<rgba16float, write>;

@group(0) @binding(2)
var<uniform> params: FFTParams;

// Complex operations
fn cmul(a: vec2<f32>, b: vec2<f32>) -> vec2<f32> {
    return vec2<f32>(a.x * b.x - a.y * b.y, a.x * b.y + a.y * b.x);
}

fn cadd(a: vec2<f32>, b: vec2<f32>) -> vec2<f32> {
    return a + b;
}

fn csub(a: vec2<f32>, b: vec2<f32>) -> vec2<f32> {
    return a - b;
}

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
    let N = u32(params.resolution);
    
    // if (id.x >= N || id.y >= N) {
    //     return;
    // }
    
    let stage = u32(params.stage);
    let butterflySpan = 1u << stage;
    let butterflyWing = butterflySpan >> 1u;
    
    let x = id.x;
    let y = id.y;
    
    // Determine if this thread handles top or bottom butterfly
    let topWing = (x / butterflySpan) * butterflySpan + (x % butterflyWing);
    let bottomWing = topWing + butterflyWing;
    
    // Bit-reversed addressing for first stage
    var x1: u32;
    var x2: u32;
    
    if (stage == 0u) {
        // Bit reversal
        x1 = bitReverse(topWing) >> (32u - u32(log2(f32(N))));
        x2 = bitReverse(bottomWing) >> (32u - u32(log2(f32(N))));
    } else {
        x1 = topWing;
        x2 = bottomWing;
    }
    
    // Read complex values
    let p = textureLoad(input_tex, vec2<i32>(i32(x1), i32(y)), 0);
    let q = textureLoad(input_tex, vec2<i32>(i32(x2), i32(y)), 0);
    
    // Twiddle factor: W = exp(-2*pi*i*k/N) for forward FFT
    let k = f32(x % butterflySpan);
    let angle = -6.28318530718 * k / f32(butterflySpan * 2u);
    let twiddle = vec2<f32>(cos(angle), sin(angle));
    
    // Butterfly operation
    let h_val = vec2<f32>(p.x, p.y);
    let d_val = vec2<f32>(p.z, p.w);
    
    let q_h = vec2<f32>(q.x, q.y);
    let q_d = vec2<f32>(q.z, q.w);
    
    let h_result = cadd(h_val, cmul(twiddle, q_h));
    let d_result = cadd(d_val, cmul(twiddle, q_d));
    
    textureStore(output_tex, vec2<i32>(id.xy), vec4<f32>(h_result, d_result));
}

fn bitReverse(x: u32) -> u32 {
    var result = x;
    result = ((result & 0xAAAAAAAAu) >> 1u) | ((result & 0x55555555u) << 1u);
    result = ((result & 0xCCCCCCCCu) >> 2u) | ((result & 0x33333333u) << 2u);
    result = ((result & 0xF0F0F0F0u) >> 4u) | ((result & 0x0F0F0F0Fu) << 4u);
    result = ((result & 0xFF00FF00u) >> 8u) | ((result & 0x00FF00FFu) << 8u);
    result = (result >> 16u) | (result << 16u);
    return result;
}
`;

const FFT_VERTICAL_SHADER = `
// Vertical FFT pass - same as horizontal but operates on columns
struct FFTParams {
    resolution: f32,
    stage: f32,
    direction: f32,
    pingpong: f32,
}

@group(0) @binding(0)
var input_tex: texture_2d<f32>;

@group(0) @binding(1)
var output_tex: texture_storage_2d<rgba16float, write>;

@group(0) @binding(2)
var<uniform> params: FFTParams;

fn cmul(a: vec2<f32>, b: vec2<f32>) -> vec2<f32> {
    return vec2<f32>(a.x * b.x - a.y * b.y, a.x * b.y + a.y * b.x);
}

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
    let N = u32(params.resolution);
    
    // if (id.x >= N || id.y >= N) {
    //     return;
    // }
    
    let stage = u32(params.stage);
    let butterflySpan = 1u << stage;
    let butterflyWing = butterflySpan >> 1u;
    
    let x = id.x;
    let y = id.y;
    
    let topWing = (y / butterflySpan) * butterflySpan + (y % butterflyWing);
    let bottomWing = topWing + butterflyWing;
    
    var y1: u32;
    var y2: u32;
    
    if (stage == 0u) {
        y1 = bitReverse(topWing) >> (32u - u32(log2(f32(N))));
        y2 = bitReverse(bottomWing) >> (32u - u32(log2(f32(N))));
    } else {
        y1 = topWing;
        y2 = bottomWing;
    }
    
    let p = textureLoad(input_tex, vec2<i32>(i32(x), i32(y1)), 0);
    let q = textureLoad(input_tex, vec2<i32>(i32(x), i32(y2)), 0);
    
    let k = f32(y % butterflySpan);
    let angle = -6.28318530718 * k / f32(butterflySpan * 2u);
    let twiddle = vec2<f32>(cos(angle), sin(angle));
    
    let h_val = vec2<f32>(p.x, p.y);
    let d_val = vec2<f32>(p.z, p.w);
    let q_h = vec2<f32>(q.x, q.y);
    let q_d = vec2<f32>(q.z, q.w);
    
    let h_result = h_val + cmul(twiddle, q_h);
    let d_result = d_val + cmul(twiddle, q_d);
    
    textureStore(output_tex, vec2<i32>(id.xy), vec4<f32>(h_result, d_result));
}

fn bitReverse(x: u32) -> u32 {
    var result = x;
    result = ((result & 0xAAAAAAAAu) >> 1u) | ((result & 0x55555555u) << 1u);
    result = ((result & 0xCCCCCCCCu) >> 2u) | ((result & 0x33333333u) << 2u);
    result = ((result & 0xF0F0F0F0u) >> 4u) | ((result & 0x0F0F0F0Fu) << 4u);
    result = ((result & 0xFF00FF00u) >> 8u) | ((result & 0x00FF00FFu) << 8u);
    result = (result >> 16u) | (result << 16u);
    return result;
}
`;

const DISPLACEMENT_SHADER = `
// Final pass: extract displacement, compute normals and jacobian for foam
struct OutputParams {
    resolution: f32,
    ocean_size: f32,
    choppiness: f32,
    padding: f32,
}

@group(0) @binding(0)
var input_fft: texture_2d<f32>;

@group(0) @binding(1)
var output_displacement: texture_storage_2d<rgba16float, write>;

@group(0) @binding(2)
var output_derivatives: texture_storage_2d<rgba16float, write>;

@group(0) @binding(3)
var<uniform> params: OutputParams;

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
    let N = u32(params.resolution);
    
    // if (id.x >= N || id.y >= N) {
    //     return;
    // }
    
    let fft_data = textureLoad(input_fft, vec2<i32>(id.xy), 0);
    
    // // fft_data contains: (height.real, height.imag, choppy_x.real, choppy_z.real)
    // // We only need the real parts after FFT
    // let height = fft_data.x;
    // let choppy_x = fft_data.z;
    // let choppy_z = fft_data.w;

    // CRITICAL: Normalize FFT output
    // For a 2D FFT with separate horizontal and vertical passes, divide by N
    let normalized = fft_data / f32(N);
    
    // Extract components (now from normalized data)
    let height = normalized.x;
    let choppy_x = normalized.z;
    let choppy_z = normalized.w;
    
    // Sign correction for FFT indexing
    let sign_correction = select(1.0, -1.0, ((id.x + id.y) % 2u) == 1u);
    
    let displacement = vec3<f32>(
        choppy_x * sign_correction,
        height * sign_correction,
        choppy_z * sign_correction
    );
    
    // Compute derivatives for normal calculation
    // Sample neighboring heights
    let x_next = (id.x + 1u) % N;
    let x_prev = select(id.x - 1u, N - 1u, id.x == 0u);
    let y_next = (id.y + 1u) % N;
    let y_prev = select(id.y - 1u, N - 1u, id.y == 0u);
    
    let h_right = textureLoad(input_fft, vec2<i32>(i32(x_next), i32(id.y)), 0).x;
    let h_left = textureLoad(input_fft, vec2<i32>(i32(x_prev), i32(id.y)), 0).x;
    let h_top = textureLoad(input_fft, vec2<i32>(i32(id.x), i32(y_next)), 0).x;
    let h_bottom = textureLoad(input_fft, vec2<i32>(i32(id.x), i32(y_prev)), 0).x;
    
    let texel_size = params.ocean_size / f32(N);
    let dhdx = (h_right - h_left) / (2.0 * texel_size);
    let dhdz = (h_top - h_bottom) / (2.0 * texel_size);
    
    // Jacobian for foam (measure of wave breaking)
    let dx_right = textureLoad(input_fft, vec2<i32>(i32(x_next), i32(id.y)), 0).z;
    let dx_left = textureLoad(input_fft, vec2<i32>(i32(x_prev), i32(id.y)), 0).z;
    let dz_top = textureLoad(input_fft, vec2<i32>(i32(id.x), i32(y_next)), 0).w;
    let dz_bottom = textureLoad(input_fft, vec2<i32>(i32(id.x), i32(y_prev)), 0).w;
    
    let dDx_dx = (dx_right - dx_left) / (2.0 * texel_size);
    let dDz_dz = (dz_top - dz_bottom) / (2.0 * texel_size);
    
    // Jacobian determinant (negative values indicate folding/foam)
    let jacobian = (1.0 + dDx_dx) * (1.0 + dDz_dz);
    
    // Store displacement (xyz) and jacobian (w)
    textureStore(output_displacement, vec2<i32>(id.xy), vec4<f32>(displacement, jacobian));
    
    // Store derivatives for normal calculation: (dhdx, dhdz, foam, unused)
    let foam = clamp(-jacobian + 1.0, 0.0, 1.0);
    textureStore(output_derivatives, vec2<i32>(id.xy), vec4<f32>(dhdx, dhdz, foam, 0.0));
}
`;

// ===== WATER RENDERING SHADER =====

const WATER_RENDER_SHADER = `
// Water vertex and fragment shaders with FFT displacement sampling

// ===== UNIFORMS =====
struct Camera {
    view_proj: mat4x4<f32>,
    view_pos: vec4<f32>,
};
@group(0) @binding(0)
var<uniform> camera: Camera;

struct Time {
    time: f32,
};
@group(2) @binding(0)
var<uniform> u_time: Time;

@group(3) @binding(0)
var displacement_texture: texture_2d<f32>;
@group(3) @binding(1)
var derivatives_texture: texture_2d<f32>;
@group(3) @binding(2)
var ocean_sampler: sampler;

struct WaterConfig {
    shallow_color: vec4<f32>,
    medium_color: vec4<f32>,
    deep_color: vec4<f32>,
    
    ocean_size: vec4<f32>,        // x: size, y: height, z,w: padding
    lighting_params: vec4<f32>,   // x: fresnel_pow, y: fresnel_mult, z: spec_pow, w: spec_int
    foam_params: vec4<f32>,       // x: threshold, y: intensity, z,w: padding
}
@group(4) @binding(0)
var<uniform> water_config: WaterConfig;

struct GlintConfig {
    tile_world_size: f32,   // 3.0 - 7.0  (smaller = denser glints)
    intensity: f32,         // 1.2 - 2.5
    crest_threshold: f32,   // 0.40
    crest_range: f32,       // 0.55
};
@group(4) @binding(1)
var<uniform> glint_config: GlintConfig;

@group(3) @binding(3)   // adjust binding if needed
var glint_sampler: sampler;
@group(3) @binding(4)
var glint_texture: texture_2d<f32>;

// ===== STRUCTS =====
struct VertexInput {
    @location(0) position: vec3<f32>,
    @location(1) normal: vec3<f32>,
    @location(2) tex_coords: vec2<f32>,
    @location(3) color: vec4<f32>
};

struct VertexOutput {
    @builtin(position) clip_position: vec4<f32>,
    @location(0) world_position: vec3<f32>,
    @location(1) normal: vec3<f32>,
    @location(2) uv: vec2<f32>,
};

struct GbufferOutput {
    @location(0) position: vec4<f32>,
    @location(1) normal: vec4<f32>,
    @location(2) albedo: vec4<f32>,
    @location(3) pbr_material: vec4<f32>,
}

// ===== VERTEX SHADER =====
@vertex
fn vs_main(in: VertexInput) -> VertexOutput {
    var out: VertexOutput;
    
    // UV coordinates for displacement lookup
    let ocean_size = water_config.ocean_size.x;
    let uv = (in.position.xz + ocean_size * 0.5) / ocean_size;
    
    // Sample displacement
    let disp_data = textureSampleLevel(displacement_texture, ocean_sampler, uv, 0.0);
    let displacement = disp_data.xyz;
    
    // Apply displacement to vertex
    var world_pos = in.position + displacement;
    world_pos.y += water_config.ocean_size.y; // Ocean height offset
    
    // Compute normal from derivatives
    let deriv_data = textureSampleLevel(derivatives_texture, ocean_sampler, uv, 0.0);
    let dhdx = deriv_data.x;
    let dhdz = deriv_data.y;
    
    let normal = normalize(vec3<f32>(-dhdx, 1.0, -dhdz));
    
    out.world_position = world_pos;
    out.clip_position = camera.view_proj * vec4<f32>(world_pos, 1.0);
    out.normal = normal;
    out.uv = uv;
    
    return out;
}

// ===== FRAGMENT SHADER =====
@fragment
fn fs_main(in: VertexOutput) -> GbufferOutput {
    var output: GbufferOutput;
    
    let view_dir = normalize(camera.view_pos.xyz - in.world_position);
    
    // Sample derivatives (already in your original code)
    let deriv_data = textureSample(derivatives_texture, ocean_sampler, in.uv);
    let dhdx = deriv_data.x;
    let dhdz = deriv_data.y;
    let foam = deriv_data.z;
    
    let disp_data = textureSampleLevel(displacement_texture, ocean_sampler, in.uv, 0.0);
    let displacement = disp_data.xyz;

    // === Dynamic white capillary glints (high-res texture, per-pixel) ===
    let steepness = length(vec2<f32>(dhdx, dhdz));                    // uses your existing derivatives
    let crest_factor = smoothstep(
        glint_config.crest_threshold,
        glint_config.crest_threshold + glint_config.crest_range,
        steepness
    );

    // Convert UV to world XZ (same as your ocean grid)
    let base_xz = (in.uv * water_config.ocean_size.x) - water_config.ocean_size.x * 0.5;
    let glint_uv = base_xz / glint_config.tile_world_size;   // high tiling = fine detail

    let glint_sample = textureSample(glint_texture, glint_sampler, glint_uv);
    let glint = glint_sample.a * crest_factor * glint_config.intensity;

    // === Your original lighting (unchanged except + glint) ===
    let ndotv = max(dot(normalize(in.normal), view_dir), 0.0);  // or recompute from dhdx/dhdz if you prefer
    let fresnel = pow(1.0 - ndotv, water_config.lighting_params.x);
    
    let water_depth = 5.0;
    var water_color: vec3<f32>;
    if (water_depth < 2.0) {
        water_color = mix(water_config.shallow_color.xyz, water_config.medium_color.xyz, water_depth / 2.0);
    } else {
        water_color = mix(water_config.medium_color.xyz, water_config.deep_color.xyz, clamp((water_depth - 2.0) / 8.0, 0.0, 1.0));
    }
    
    let sky_color = vec3<f32>(0.6, 0.8, 1.0);
    var final_color = mix(water_color, sky_color, fresnel * water_config.lighting_params.y);
    
    let sun_dir = normalize(vec3<f32>(0.3, 0.8, 0.5));
    let reflect_dir = reflect(-sun_dir, normalize(in.normal));
    let spec = pow(max(dot(view_dir, reflect_dir), 0.0), water_config.lighting_params.z);
    final_color += vec3<f32>(1.0, 1.0, 0.95) * spec * water_config.lighting_params.w;
    
    let foam_intensity = smoothstep(water_config.foam_params.x, water_config.foam_params.x + 0.2, foam);
    final_color = mix(final_color, vec3<f32>(0.95, 0.95, 1.0), foam_intensity * water_config.foam_params.y);
    
    // Add the white glints on top (this is the magic)
    final_color += glint * vec3<f32>(1.0, 1.0, 1.0);

    output.position = vec4<f32>(in.world_position, 1.0);
    output.normal = vec4<f32>(in.normal, 1.0);
    output.albedo = vec4<f32>(final_color, 0.85);
    output.pbr_material = vec4<f32>(0.0, 0.1, 0.4, 1.0);
    
    return output;
}
`;

// const WATER_RENDER_SHADER = `
// // ===== DEBUG RAINBOW SHADER (FIXED) =====

// struct Camera { view_proj: mat4x4<f32>, view_pos: vec4<f32> };
// @group(0) @binding(0) var<uniform> camera: Camera;

// @group(3) @binding(0)
// var displacement_texture: texture_2d<f32>;
// @group(3) @binding(1)
// var derivatives_texture: texture_2d<f32>;
// @group(3) @binding(2)
// var ocean_sampler: sampler;

// struct WaterConfig {
//     shallow_color: vec4<f32>, medium_color: vec4<f32>, deep_color: vec4<f32>,
//     ocean_size: vec4<f32>, lighting_params: vec4<f32>, foam_params: vec4<f32>
// }
// @group(4) @binding(0) var<uniform> water_config: WaterConfig;

// struct VertexInput {
//     @location(0) position: vec3<f32>,
//     @location(2) tex_coords: vec2<f32>,
// };

// struct VertexOutput {
//     @builtin(position) clip_position: vec4<f32>,
//     @location(0) world_position: vec3<f32>,
//     @location(1) uv: vec2<f32>,
// };

// struct GbufferOutput {
//     @location(0) position: vec4<f32>,
//     @location(1) normal: vec4<f32>,
//     @location(2) albedo: vec4<f32>,
//     @location(3) pbr_material: vec4<f32>,
// }

// // Helper: HSV to RGB for the rainbow effect
// fn hsv2rgb(c: vec3<f32>) -> vec3<f32> {
//     let k = vec4<f32>(1.0, 2.0 / 3.0, 1.0 / 3.0, 3.0);
//     let p = abs(fract(c.xxx + k.xyz) * 6.0 - k.www);
//     // FIXED: Using vec3 for clamp bounds to match the vec3 input
//     return c.z * mix(k.xxx, clamp(p - k.xxx, vec3<f32>(0.0), vec3<f32>(1.0)), c.y);
// }

// @vertex
// fn vs_main(in: VertexInput) -> VertexOutput {
//     var out: VertexOutput;
//     let ocean_size = water_config.ocean_size.x;
//     let uv = (in.position.xz + ocean_size * 0.5) / ocean_size;
//     let world_pos = in.position + vec3<f32>(0.0, water_config.ocean_size.y, 0.0);
    
//     out.world_position = world_pos;
//     out.clip_position = camera.view_proj * vec4<f32>(world_pos, 1.0);
//     out.uv = uv;
//     return out;
// }

// @fragment
// fn fs_main(in: VertexOutput) -> GbufferOutput {
//     var output: GbufferOutput;

//     let ocean_size = water_config.ocean_size.x;
//     let uv = (in.world_position.xz + ocean_size * 0.5) / ocean_size;
//     // let uv = (in.world_position.xz) / ocean_size;
//     let disp_data = textureSampleLevel(displacement_texture, ocean_sampler, uv, 0.0);

//     // drive Hue by UV sum for a diagonal rainbow
//     let hue = fract(in.uv.x * 5.0 + in.uv.y * 5.0); 
//     // let rainbow = hsv2rgb(vec3<f32>(disp_data.x, 0.8, 1.0));
//     let dispbow = vec3<f32>(disp_data.x, disp_data.y, disp_data.z);

//     output.position = vec4<f32>(in.world_position, 1.0);
//     output.normal = vec4<f32>(0.0, 1.0, 0.0, 1.0);
//     output.albedo = vec4<f32>(dispbow, 1.0);
//     output.pbr_material = vec4<f32>(0.0, 1.0, 0.0, 1.0);
    
//     return output;
// }
// `;

const GLINT_COMPUTE_SHADER = `
struct GlintParams {
    resolution: f32,        // e.g. 2048 or 4096
    tile_freq: f32,         // how many capillary features across one texture (2-45)
    speed: f32,             // 1.8-3.2
    time: f32,
    wind_dir: vec2<f32>,
    peak_threshold: f32,    // 0.55-0.75  (higher = only the very tips are white)
    glint_intensity: f32,   // 0.7-1.3
};

@group(0) @binding(0)
var glint_storage: texture_storage_2d<rgba16float, write>;

@group(0) @binding(1)
var<uniform> params: GlintParams;

// === Simplex + fBm (same high-quality version) ===
fn mod289(x: vec2<f32>) -> vec2<f32> { return x - floor(x * (1.0 / 289.0)) * 289.0; }
fn mod289_3(x: vec3<f32>) -> vec3<f32> { return x - floor(x * (1.0 / 289.0)) * 289.0; }
fn permute3(x: vec3<f32>) -> vec3<f32> { return mod289_3(((x * 34.0) + 1.0) * x); }

fn simplex2(v: vec2<f32>) -> f32 {
    let C = vec4<f32>(0.211324865405187, 0.366025403784439, -0.577350269189626, 0.024390243902439);
    var i = floor(v + dot(v, C.yy));
    let x0 = v - i + dot(i, C.xx);
    var i1 = select(vec2<f32>(0.0, 1.0), vec2<f32>(1.0, 0.0), x0.x > x0.y);
    var x12 = x0.xyxy + C.xxzz;
    x12.x -= i1.x; x12.y -= i1.y;
    i = mod289(i);
    let p = permute3(permute3(i.y + vec3(0.0, i1.y, 1.0)) + i.x + vec3(0.0, i1.x, 1.0));
    var m = max(vec3(0.0) - vec3(dot(x0,x0), dot(x12.xy,x12.xy), dot(x12.zw,x12.zw)), vec3(0.0));
    m = m * m * m * m;
    let x = 2.0 * fract(p * C.www) - 1.0;
    let h = abs(x) - 0.5;
    let ox = floor(x + 0.5);
    let a0 = x - ox;
    m *= 1.79284291400159 - 0.85373472095314 * (a0*a0 + h*h);
    var g: vec3<f32>;
    g.x = a0.x * x0.x + h.x * x0.y;
    g.y = a0.y * x12.x + h.y * x12.y;
    g.z = a0.z * x12.z + h.z * x12.w;
    return 130.0 * dot(m, g);
}

fn fbm_ripples(p: vec2<f32>) -> f32 {
    var total = 0.0;
    var amp = 1.0;
    var freq = 1.0;
    for (var i = 0; i < 7; i++) {          // 7 octaves = super fine grain
        total += amp * simplex2(p * freq);
        amp *= 0.48;
        freq *= 2.13;
    }
    return total * 0.58;                    // ≈ -1 … 1
}

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
    let res = params.resolution;
    if (id.x >= u32(res) || id.y >= u32(res)) { return; }

    let uv = vec2<f32>(id.xy) / res;
    let noise_pos = uv * params.tile_freq + params.time * params.wind_dir * params.speed;

    let height = fbm_ripples(noise_pos);                    // capillary "height"
    let mask = smoothstep(params.peak_threshold, 1.0, height);   // only the highest peaks become white

    let white = vec4<f32>(1.0, 1.0, 1.0, mask * params.glint_intensity);

    textureStore(glint_storage, vec2<i32>(id.xy), white);
}
`;

// ===== TYPESCRIPT ADDON =====

interface OceanParams {
    resolution: number;
    oceanSize: number;
    windSpeed: number;
    windDirection: [number, number];
    amplitude: number;
    choppiness: number;
    gravity: number;
    
    // Visual params
    shallowColor: [number, number, number, number];
    mediumColor: [number, number, number, number];
    deepColor: [number, number, number, number];
    oceanHeight: number;
    
    fresnelPower: number;
    fresnelMult: number;
    specularPower: number;
    specularIntensity: number;
    
    foamThreshold: number;
    foamIntensity: number;
}

const addonInfo = {
    name: "FFT Ocean",
    version: "1.1.0",
    description: "GPU-Accelerated FFT Ocean with Photorealistic Waves",
    author: ["Entropy Team", "Claude"],
    capabilities: {
        audio: true,
        ui: true
    }
}

const addon = Entropy.AddonAtom.register(addonInfo);

let oceanParams: OceanParams = {
    resolution: 512,
    oceanSize: 1000.0,
    windSpeed: 2.0,
    windDirection: [1.0, 0.7],
    amplitude: 0.02,
    choppiness: 0.15,
    gravity: 9.81,
    
    shallowColor: [0.2, 0.85, 0.95, 1.0],
    mediumColor: [0.0, 0.55, 0.75, 1.0],
    deepColor: [0.0, 0.25, 0.45, 1.0],
    oceanHeight: -150.0,
    
    fresnelPower: 3.0,
    fresnelMult: 0.7,
    specularPower: 200.0,
    specularIntensity: 0.5,
    
    foamThreshold: 0.85,
    foamIntensity: 0.6,
};

let addonState: {
    currentParams: OceanParams,
    savedComponents: { id: string, name: string, params: OceanParams }[],
    activeComponentId: string | null
} = {
    currentParams: { ...oceanParams },
    savedComponents: [],
    activeComponentId: Entropy.generateUUID()
};

let newComponentName = "New Water Component";

let pipelineIds = {
    spectrumInit: null as string | null,
    spectrumUpdate: null as string | null,
    fftHorizontal: null as string | null,
    fftVertical: null as string | null,
    displacement: null as string | null,
    waterRender: null as string | null,
    glint: null as string | null,
};

let buffers = {
    spectrumParams: null as string | null,
    timeParams: null as string | null,
    fftParams: null as string | null,
    outputParams: null as string | null,
    glintParams: null as string | null,
};

let textures = {
    h0: null as string | null,          // Initial spectrum
    ht: null as string | null,          // Time-evolved spectrum
    pingpong: [null, null] as (string | null)[],  // For FFT passes
    displacement: null as string | null, // Final displacement map
    derivatives: null as string | null,  // Normals and foam
    glint: null as string | null,       // capillary foam look
};

addon.onInit(async () => {
    Entropy.println("🌊 FFT Ocean: onInit started");
    
    // Create compute pipelines
    pipelineIds.spectrumInit = Entropy.Pipeline.createCompute({
        name: "SpectrumInit",
        shaderSource: SPECTRUM_INIT_SHADER,
        bindGroups: [{
            entries: [
                { binding: 0, visibility: ["Compute"], resourceType: "StorageTextureRgba16" },
                { binding: 1, visibility: ["Compute"], resourceType: "Uniform" },
            ]
        }]
    });
    
    pipelineIds.spectrumUpdate = Entropy.Pipeline.createCompute({
        name: "SpectrumUpdate",
        shaderSource: SPECTRUM_UPDATE_SHADER,
        bindGroups: [{
            entries: [
                { binding: 0, visibility: ["Compute"], resourceType: "TextureNonFilterable" },
                { binding: 1, visibility: ["Compute"], resourceType: "StorageTextureRgba16" },
                { binding: 2, visibility: ["Compute"], resourceType: "Uniform" },
            ]
        }]
    });
    
    pipelineIds.fftHorizontal = Entropy.Pipeline.createCompute({
        name: "FFT_Horizontal",
        shaderSource: FFT_HORIZONTAL_SHADER,
        bindGroups: [{
            entries: [
                { binding: 0, visibility: ["Compute"], resourceType: "TextureNonFilterable" },
                { binding: 1, visibility: ["Compute"], resourceType: "StorageTextureRgba16" },
                { binding: 2, visibility: ["Compute"], resourceType: "Uniform" },
            ]
        }]
    });
    
    pipelineIds.fftVertical = Entropy.Pipeline.createCompute({
        name: "FFT_Vertical",
        shaderSource: FFT_VERTICAL_SHADER,
        bindGroups: [{
            entries: [
                { binding: 0, visibility: ["Compute"], resourceType: "TextureNonFilterable" },
                { binding: 1, visibility: ["Compute"], resourceType: "StorageTextureRgba16" },
                { binding: 2, visibility: ["Compute"], resourceType: "Uniform" },
            ]
        }]
    });
    
    pipelineIds.displacement = Entropy.Pipeline.createCompute({
        name: "Displacement",
        shaderSource: DISPLACEMENT_SHADER,
        bindGroups: [{
            entries: [
                { binding: 0, visibility: ["Compute"], resourceType: "TextureNonFilterable" },
                { binding: 1, visibility: ["Compute"], resourceType: "StorageTextureRgba16" },
                { binding: 2, visibility: ["Compute"], resourceType: "StorageTextureRgba16" },
                { binding: 3, visibility: ["Compute"], resourceType: "Uniform" },
            ]
        }]
    });

    // Create water render pipeline
    pipelineIds.glint = Entropy.Pipeline.createCompute({
        name: "FFT_Capillary_Glints",
        shaderSource: GLINT_COMPUTE_SHADER,
        bindGroups: [
            { entries: [
                { binding: 0, visibility: ["Compute"], resourceType: "StorageTextureRgba16" },
                { binding: 1, visibility: ["Compute"], resourceType: "Uniform" }
            ] }
        ]
    });
    
    // Create water render pipeline
    pipelineIds.waterRender = Entropy.Pipeline.create({
        name: "FFT_Water_Render",
        layout: "mesh",
        vertexShader: WATER_RENDER_SHADER,
        fragmentShader: WATER_RENDER_SHADER,
        pbr: true,
        extraBindGroups: [
            { entries: [{ binding: 0, visibility: ["Vertex", "Fragment"], resourceType: "Time" }] },
            {
                entries: [
                    { binding: 0, visibility: ["Vertex", "Fragment"], resourceType: "Texture" },
                    { binding: 1, visibility: ["Vertex", "Fragment"], resourceType: "Texture" },
                    { binding: 2, visibility: ["Vertex", "Fragment"], resourceType: "Sampler" },
                    { binding: 3, visibility: ["Vertex", "Fragment"], resourceType: "Sampler" },
                    { binding: 4, visibility: ["Vertex", "Fragment"], resourceType: "Texture" },
                ]
            },
            { entries: [
                { binding: 0, visibility: ["Vertex", "Fragment"], resourceType: "Uniform" },
                { binding: 1, visibility: ["Vertex", "Fragment"], resourceType: "Uniform" }
            ] }
        ]
    });
    
    // Initialize textures and buffers
    initializeResources();
    
    // Load saved data
    // const savedData = addon.IO.load();
    // if (savedData) {
    //     addonState = { ...addonState, ...savedData };
    // }

    // Register with Composer
    if (Entropy.Composer) {
        Entropy.Composer.registerEditor(addonInfo.name, renderUI);
        
        if (Entropy.Composer.registerRenderer) {
            Entropy.Composer.registerRenderer(addonInfo.name, (id: string, params: OceanParams) => {
                // For the composer, we might want to respect the instance position
                // The current shader assumes y=oceanHeight, but we should probably add world pos
                createWaterMesh(id, params);
            });
        }
    }

    // // Generate initial spectrum
    generateInitialSpectrum();

    // to test if water is active 2000 seconds in
    // updateOcean(2000);
    
    // // Create water mesh (preview)
    createWaterMesh("fft_ocean_preview", addonState.currentParams);

    // Atmospheric lighting
    addon.Lighting.createPointLight({
        position: [-3.0, 4.0, 65.0],
        color: [0.9, 0.9, 0.9],
        intensity: 8.0,
        maxDistance: 350.0
    });

    addon.Lighting.createPointLight({
        position: [3.0, 4.0, 10.0],
        color: [0.9, 0.9, 0.9],
        intensity: 8.0,
        maxDistance: 350.0
    });

    addon.Lighting.createPointLight({
        position: [0.0, 5.0, -60.0],
        color: [0.9, 0.9, 0.9],
        intensity: 8.0,
        maxDistance: 350.0
    });
    
    // Setup UI
    setupUI();

    addon.onProjectChanged((newProjectId) => {
        const data = addon.IO.load();
        if (data) {
            addonState = { ...addonState, ...data };
            if (Entropy.Composer) {
                addonState.savedComponents.forEach(comp => {
                    Entropy.Composer!.registerComponent(addonInfo.name, comp.id, comp.name, comp.params);
                });
            }
            createWaterMesh("fft_ocean_preview", addonState.currentParams);
        }
    });

    // Register update loop
    addon.onUpdate((time) => {
        updateOcean(time);
    });

    addon.onUpdatePlus("Game Composer", (time) => {
        (globalThis as any).__entropy_current_addon_context_override = "Game Composer";
        updateOcean(time);
        (globalThis as any).__entropy_current_addon_context_override = null;
    });
    
    Entropy.println("✅ FFT Ocean initialized!");

    // --- Tools Registration ---

    const persistState = (newComponent = false) => {
        let id = addonState.activeComponentId;
        
        // persist state
        if (newComponent) {
            id = Entropy.generateUUID();

            addonState.savedComponents.push({
                id,
                name: newComponentName,
                params: JSON.parse(JSON.stringify(addonState.currentParams))
            });

            if (Entropy.Composer) {
                Entropy.Composer!.registerComponent(addonInfo.name, id, newComponentName, addonState.currentParams);
            }
        }

        // at least, save the current state
        addon.IO.save(addonState);

        return id;
    }

    addon.registerTool({
        name: "update_ocean_parameters",
        description: "Update the high-fidelity FFT ocean simulation parameters.",
        parameters: {
            type: "object",
            properties: {
                windSpeed: { type: "number", description: "Speed of the wind (0 to 40). Affects wave height." },
                choppiness: { type: "number", description: "How 'peaky' the waves are (0 to 5)." },
                shallowColor: { type: "array", items: { type: "number" }, description: "RGB(A) color for shallow areas." },
                deepColor: { type: "array", items: { type: "number" }, description: "RGB(A) color for deep water." },
                foamThreshold: { type: "number", description: "Threshold for foam generation (0 to 1)." }
            }
        }
    }, (args: any) => {
        Entropy.println("Updating FFT Ocean via tool: " + JSON.stringify(args));
        let changed = false;
        let spectrumChanged = false;

        if (typeof args.windSpeed !== "undefined") { addonState.currentParams.windSpeed = args.windSpeed; changed = true; spectrumChanged = true; }
        if (typeof args.choppiness !== "undefined") { addonState.currentParams.choppiness = args.choppiness; changed = true; }
        if (args.shallowColor) { addonState.currentParams.shallowColor = args.shallowColor.length === 3 ? [...args.shallowColor, 1.0] : args.shallowColor; changed = true; }
        if (args.deepColor) { addonState.currentParams.deepColor = args.deepColor.length === 3 ? [...args.deepColor, 1.0] : args.deepColor; changed = true; }
        if (typeof args.foamThreshold !== "undefined") { addonState.currentParams.foamThreshold = args.foamThreshold; changed = true; }

        if (changed) {
            if (spectrumChanged) generateInitialSpectrum();
            createWaterMesh("fft_ocean_preview", addonState.currentParams);
            persistState();
            return { success: true, currentParams: addonState.currentParams };
        }
        return { success: false, error: "No parameters provided." };
    });

    addon.registerTool({
        name: "save_ocean_component",
        description: "Save the current FFT ocean settings as a reusable component for the Game Composer.",
        parameters: {
            type: "object",
            properties: {
                name: { type: "string", description: "Name for this ocean configuration (e.g., 'Calm Caribbean')." }
            },
            required: ["name"]
        }
    }, (args: any) => {
        const id = persistState(true);
        
        return { success: true, id: id, name: args.name, addonName: addonInfo.name };
    });
});

function initializeResources() {
    const N = addonState.currentParams.resolution;

    // Create textures using the new createStorage API
    textures.h0 = Entropy.Texture.createStorage(N, N, "Rgba16Float");
    textures.ht = Entropy.Texture.createStorage(N, N, "Rgba16Float");
    textures.pingpong[0] = Entropy.Texture.createStorage(N, N, "Rgba16Float");
    textures.pingpong[1] = Entropy.Texture.createStorage(N, N, "Rgba16Float");

    // capillary glints / capillary foam look
    textures.glint = Entropy.Texture.createStorage(N, N, "Rgba16Float");
    
    // Displacement and derivatives need to be sampled with filtering in the vertex/fragment shaders
    // Rgba16Float is highly precise but supports linear filtering on most hardware
    textures.displacement = Entropy.Texture.createStorage(N, N, "Rgba16Float");
    textures.derivatives = Entropy.Texture.createStorage(N, N, "Rgba16Float");
    
    // Create uniform buffers
    buffers.spectrumParams = Entropy.Buffer.create({ size: 32, usage: "Uniform" });
    buffers.timeParams = Entropy.Buffer.create({ size: 32, usage: "Uniform" });
    buffers.fftParams = Entropy.Buffer.create({ size: 16, usage: "Uniform" });
    buffers.outputParams = Entropy.Buffer.create({ size: 16, usage: "Uniform" });
    buffers.glintParams = Entropy.Buffer.create({ size: 32, usage: "Uniform" });
}

function generateInitialSpectrum() {
    if (!pipelineIds.spectrumInit || !textures.h0 || !buffers.spectrumParams) return;
    
    // Update spectrum params
    const params = new Float32Array([
        addonState.currentParams.resolution,
        addonState.currentParams.oceanSize,
        addonState.currentParams.windSpeed,
        addonState.currentParams.windDirection[0],
        addonState.currentParams.windDirection[1],
        addonState.currentParams.amplitude,
        addonState.currentParams.gravity,
        0.0, // padding
    ]);
    
    Entropy.Buffer.write(buffers.spectrumParams, params);
    
    // Dispatch compute
    const N = addonState.currentParams.resolution;
    const workgroups = Math.ceil(N / 8);
    
    Entropy.Compute.dispatch({
        pipelineId: pipelineIds.spectrumInit,
        groups: [workgroups, workgroups, 1],
        bindings: [
            { group: 0, binding: 0, resource: { type: "StorageTextureRgba16", value: { id: textures.h0! } } },
            { group: 0, binding: 1, resource: { type: "Uniform", value: { data: Array.from(params) } } },
        ]
    });
}

function updateOcean(time: number) {
    if (!pipelineIds.spectrumUpdate || !textures.h0 || !textures.ht) return;

    // if (Math.random() < 0.01) {
    //     Entropy.println(`🌊 FFT update loop running, time=${time.toFixed(2)}`);
    // }

    const N = addonState.currentParams.resolution;
    const workgroups = Math.ceil(N / 8);
    const logN = Math.log2(N); // by this point, youve covered the whole grid resolution via the horiz and vert passes

    // 1. Update Spectrum
    const timeParams = new Float32Array([
        time,
        N,
        addonState.currentParams.oceanSize,
        addonState.currentParams.gravity,
        addonState.currentParams.choppiness,
        0, 0, 0 // padding
    ]);
    // Entropy.Buffer.write(buffers.timeParams!, timeParams); // Or use inline uniform

    Entropy.Compute.dispatch({
        pipelineId: pipelineIds.spectrumUpdate,
        groups: [workgroups, workgroups, 1],
        bindings: [
            { group: 0, binding: 0, resource: { type: "TextureNonFilterable", value: { id: textures.h0! } } },
            { group: 0, binding: 1, resource: { type: "StorageTextureRgba16", value: { id: textures.ht! } } },
            { group: 0, binding: 2, resource: { type: "Uniform", value: { data: Array.from(timeParams) } } },
        ]
    });

    // 2. FFT Horizontal
    let pingpong = 0;
    for (let i = 0; i < logN; i++) {
        const input = i === 0 ? textures.ht : textures.pingpong[pingpong];
        const output = textures.pingpong[1 - pingpong];
        
        Entropy.Compute.dispatch({
            pipelineId: pipelineIds.fftHorizontal!,
            groups: [workgroups, workgroups, 1],
            bindings: [
                { group: 0, binding: 0, resource: { type: "TextureNonFilterable", value: { id: input! } } },
                { group: 0, binding: 1, resource: { type: "StorageTextureRgba16", value: { id: output! } } },
                { group: 0, binding: 2, resource: { type: "Uniform", value: { data: [N, i, 0, 0] } } },
            ]
        });
        pingpong = 1 - pingpong;
    }

    // 3. FFT Vertical
    for (let i = 0; i < logN; i++) {
        const input = textures.pingpong[pingpong];
        const output = textures.pingpong[1 - pingpong];
        
        Entropy.Compute.dispatch({
            pipelineId: pipelineIds.fftVertical!,
            groups: [workgroups, workgroups, 1],
            bindings: [
                { group: 0, binding: 0, resource: { type: "TextureNonFilterable", value: { id: input! } } },
                { group: 0, binding: 1, resource: { type: "StorageTextureRgba16", value: { id: output! } } },
                { group: 0, binding: 2, resource: { type: "Uniform", value: { data: [N, i, 0, 0] } } },
            ]
        });
        pingpong = 1 - pingpong;
    }

    // Glint / Capillary Foam / High Detail Texture
    const glintParams = new Float32Array([
        1024,        // resolution: e.g. 2048 or 4096
        5,        // tile_freq: how many capillary features across one texture (2-45)
        2.2,             // speed: 1.8-3.2
        time,
        ...[1.0, 0.0, 0.0],   // wind_dir
        0.65,    // peak_threshold: 0.55-0.75  (higher = only the very tips are white)
        1.0,   // glint_intensity: 0.7-1.3
        0, 0, 0, 0, 0, 0, 0 // padding
    ]);
    Entropy.Compute.dispatch({
        pipelineId: pipelineIds.glint!,
        groups: [workgroups, workgroups, 1],
        bindings: [
            { group: 0, binding: 0, resource: { type: "StorageTextureRgba16", value: { id: textures.glint! } } },
            { group: 0, binding: 1, resource: { type: "Uniform", value: { data: Array.from(glintParams) } } },
        ]
    });

    // 4. Final Displacement Pass
    const outputParams = new Float32Array([N, addonState.currentParams.oceanSize, addonState.currentParams.choppiness, 0]);
    Entropy.Compute.dispatch({
        pipelineId: pipelineIds.displacement!,
        groups: [workgroups, workgroups, 1],
        bindings: [
            { group: 0, binding: 0, resource: { type: "TextureNonFilterable", value: { id: textures.pingpong[pingpong]! } } },
            { group: 0, binding: 1, resource: { type: "StorageTextureRgba16", value: { id: textures.displacement! } } },
            { group: 0, binding: 2, resource: { type: "StorageTextureRgba16", value: { id: textures.derivatives! } } },
            { group: 0, binding: 3, resource: { type: "Uniform", value: { data: Array.from(outputParams) } } },
        ]
    });
}

function createWaterMesh(id: string, params: OceanParams & { _transform?: { position: [number, number, number], scale: [number, number, number] } }) {
    if (!pipelineIds.waterRender) return;
    
    // Generate grid
    const gridSize = params.oceanSize;
    const resolution = 256; // Lower res for mesh than FFT
    
    const vertices: number[] = [];
    const indices: number[] = [];
    const halfSize = gridSize / 2;
    
    for (let row = 0; row <= resolution; row++) {
        for (let col = 0; col <= resolution; col++) {
            const x = -halfSize + (col / resolution) * gridSize;
            const z = -halfSize + (row / resolution) * gridSize;
            
            // Position
            vertices.push(x, 0, z);
            // Normal
            vertices.push(0, 1, 0);
            // UV
            vertices.push(col / resolution, row / resolution);
            // Color
            vertices.push(1, 1, 1, 1);
        }
    }
    
    for (let row = 0; row < resolution; row++) {
        for (let col = 0; col < resolution; col++) {
            const topLeft = row * (resolution + 1) + col;
            const topRight = topLeft + 1;
            const bottomLeft = (row + 1) * (resolution + 1) + col;
            const bottomRight = bottomLeft + 1;
            
            indices.push(topLeft, bottomLeft, topRight);
            indices.push(topRight, bottomLeft, bottomRight);
        }
    }
    
    const waterConfig = [
        ...params.shallowColor,
        ...params.mediumColor,
        ...params.deepColor,
        params.oceanSize, params.oceanHeight, 0, 0,
        params.fresnelPower, params.fresnelMult, params.specularPower, params.specularIntensity,
        params.foamThreshold, params.foamIntensity, 0, 0,
    ];

    const pos = params._transform?.position || [0, 0, 0];
    const scale = params._transform?.scale || [1, 1, 1];

//     struct GlintConfig {
//     tile_world_size: f32,   // 3.0 - 7.0  (smaller = denser glints)
//     intensity: f32,         // 1.2 - 2.5
//     crest_threshold: f32,   // 0.40
//     crest_range: f32,       // 0.55
// };
// @group(4) @binding(1)
// var<uniform> glint_config: GlintConfig;

// @group(3) @binding(3)   // adjust binding if needed
// var glint_sampler: sampler;
// @group(3) @binding(4)
// var glint_texture: texture_2d<f32>;

    const glintConfig = [
        3.0, 1.6, 0.40, 0.55
    ]
    
    addon.Model.clearMesh(id);
    addon.Model.createMesh({
        id: id,
        position: pos,
        scale: scale,
        vertexData: vertices,
        indexData: indices,
        pipelineId: pipelineIds.waterRender,
        renderRole: "Water",
        bindings: [
            { group: 2, binding: 0, resource: { type: "Time" } },
            // NOTE: when using textures.ht as input to the debug mesh shader, i see ripples. when using the actual textures.displacement, I see just black. When using pingpong[0], also just black.
            { group: 3, binding: 0, resource: { type: "Texture", value: { id: textures.displacement! } } },
            { group: 3, binding: 1, resource: { type: "Texture", value: { id: textures.derivatives! } } },
            { group: 3, binding: 2, resource: { type: "Sampler" } },
            { group: 3, binding: 3, resource: { type: "Sampler" } },
            { group: 3, binding: 4, resource: { type: "Texture", value: { id: textures.glint! } } },
            { group: 4, binding: 0, resource: { type: "Uniform", value: { data: waterConfig } } },
            { group: 4, binding: 1, resource: { type: "Uniform", value: { data: glintConfig } } },
        ]
    });
    
    Entropy.println(`Created water mesh: ${id} at ${pos}`);
}

function setupUI() {
    const tab = addon.UI.createTab({
        title: "FFT Ocean",
        onRender: () => renderUI(tab)
    });
}

function renderUI(tab: string) {
    Entropy.Addon.setVisibility(addonInfo.name, true);
    Entropy.UI.Widget.label(tab, { text: "🌊 FFT Ocean Simulation", bold: true });

    Entropy.UI.Widget.button(tab, { text: "💾 Save All to Project", onClick: () => {
        addon.IO.save(addonState);
        if (Entropy.Composer) {
            addonState.savedComponents.forEach(comp => { Entropy.Composer!.registerComponent(addonInfo.name, comp.id, comp.name, comp.params); });
        }
    }});

    Entropy.UI.Widget.label(tab, { text: "📦 Components", bold: true });
    Entropy.UI.Widget.button(tab, { text: "➕ Save Current as Component", onClick: () => {
        const id = Entropy.generateUUID();
        addonState.savedComponents.push({ id, name: newComponentName, params: JSON.parse(JSON.stringify(addonState.currentParams)) });
        if (Entropy.Composer) { Entropy.Composer!.registerComponent(addonInfo.name, id, newComponentName, addonState.currentParams); }
    }});
    
    addonState.savedComponents.forEach(comp => {
        Entropy.UI.Widget.button(tab, { text: `📂 Load & Render: ${comp.name}`, onClick: () => {
            addonState.currentParams = JSON.parse(JSON.stringify(comp.params));
            addonState.activeComponentId = comp.id;
            generateInitialSpectrum();
            createWaterMesh("fft_ocean_preview", addonState.currentParams);
        }});
    });
    
    Entropy.UI.Widget.label(tab, { text: "--------------------------------" });
    
    Entropy.UI.Widget.label(tab, { text: "Ocean Parameters", bold: true });
    Entropy.UI.Widget.slider(tab, {
        label: "Wind Speed",
        value: addonState.currentParams.windSpeed,
        min: 0,
        max: 40,
        onChange: (v) => {
            addonState.currentParams.windSpeed = parseFloat(v);
            generateInitialSpectrum();
        }
    });
    
    Entropy.UI.Widget.slider(tab, {
        label: "Choppiness",
        value: addonState.currentParams.choppiness,
        min: 0,
        max: 5,
        onChange: (v) => {
            addonState.currentParams.choppiness = parseFloat(v);
        }
    });
    
    Entropy.UI.Widget.label(tab, { text: "Colors", bold: true });
    Entropy.UI.Widget.colorInput(tab, {
        label: "Shallow",
        color: addonState.currentParams.shallowColor,
        onChange: (c) => {
            addonState.currentParams.shallowColor = c as [number, number, number, number];
            createWaterMesh("fft_ocean_preview", addonState.currentParams);
        }
    });
    
    Entropy.UI.Widget.colorInput(tab, {
        label: "Deep",
        color: addonState.currentParams.deepColor,
        onChange: (c) => {
            addonState.currentParams.deepColor = c as [number, number, number, number];
            createWaterMesh("fft_ocean_preview", addonState.currentParams);
        }
    });
    
    Entropy.UI.Widget.label(tab, { text: "Foam", bold: true });
    Entropy.UI.Widget.slider(tab, {
        label: "Foam Threshold",
        value: addonState.currentParams.foamThreshold,
        min: 0,
        max: 1,
        onChange: (v) => {
            addonState.currentParams.foamThreshold = parseFloat(v);
            createWaterMesh("fft_ocean_preview", addonState.currentParams);
        }
    });
    
    Entropy.UI.Widget.button(tab, {
        text: "🔄 Regenerate Spectrum",
        onClick: () => generateInitialSpectrum()
    });
}