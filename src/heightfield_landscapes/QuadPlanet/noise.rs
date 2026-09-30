//! Seeded 3D simplex noise (after Stefan Gustavson's public-domain reference) plus the fractal
//! layers QuadPlanet's terrain is built from. Sampled on the unit sphere, so a planet's surface is
//! continuous everywhere: there are no seams at the cube-face edges and no poles pinching.
//! A straight port of the TypeScript version the planets were designed with (same permutation
//! from the same Mulberry32 seed), so Verdant, Ember and Glacia keep their continents.

const GRAD3: [f64; 36] = [
    1.0, 1.0, 0.0, -1.0, 1.0, 0.0, 1.0, -1.0, 0.0, -1.0, -1.0, 0.0,
    1.0, 0.0, 1.0, -1.0, 0.0, 1.0, 1.0, 0.0, -1.0, -1.0, 0.0, -1.0,
    0.0, 1.0, 1.0, 0.0, -1.0, 1.0, 0.0, 1.0, -1.0, 0.0, -1.0, -1.0,
];

const F3: f64 = 1.0 / 3.0;
const G3: f64 = 1.0 / 6.0;

/// Mulberry32: a tiny deterministic PRNG, so a seed always builds the same planet.
pub struct Mulberry32(u32);

impl Mulberry32 {
    pub fn new(seed: u32) -> Self { Self(seed) }
    pub fn next(&mut self) -> f64 {
        self.0 = self.0.wrapping_add(0x6d2b79f5);
        let mut t = self.0;
        t = (t ^ (t >> 15)).wrapping_mul(t | 1);
        t ^= t.wrapping_add((t ^ (t >> 7)).wrapping_mul(t | 61));
        (t ^ (t >> 14)) as f64 / 4294967296.0
    }
}

pub struct Simplex3 {
    perm: [u8; 512],
    perm_mod12: [u8; 512],
}

impl Simplex3 {
    pub fn new(seed: u32) -> Self {
        let mut rand = Mulberry32::new(seed);
        let mut p = [0u8; 256];
        for (i, v) in p.iter_mut().enumerate() { *v = i as u8; }
        for i in (1..256).rev() {
            let j = (rand.next() * (i as f64 + 1.0)).floor() as usize;
            p.swap(i, j);
        }
        let mut perm = [0u8; 512];
        let mut perm_mod12 = [0u8; 512];
        for i in 0..512 {
            perm[i] = p[i & 255];
            perm_mod12[i] = perm[i] % 12;
        }
        Self { perm, perm_mod12 }
    }

    /// Noise in roughly [-1, 1].
    pub fn noise(&self, xin: f64, yin: f64, zin: f64) -> f64 {
        let perm = &self.perm;
        let pm = &self.perm_mod12;
        let s = (xin + yin + zin) * F3;
        let i = (xin + s).floor();
        let j = (yin + s).floor();
        let k = (zin + s).floor();
        let t = (i + j + k) * G3;
        let x0 = xin - (i - t);
        let y0 = yin - (j - t);
        let z0 = zin - (k - t);
        let (i1, j1, k1, i2, j2, k2) = if x0 >= y0 {
            if y0 >= z0 { (1, 0, 0, 1, 1, 0) }
            else if x0 >= z0 { (1, 0, 0, 1, 0, 1) }
            else { (0, 0, 1, 1, 0, 1) }
        } else if y0 < z0 { (0, 0, 1, 0, 1, 1) }
        else if x0 < z0 { (0, 1, 0, 0, 1, 1) }
        else { (0, 1, 0, 1, 1, 0) };
        let x1 = x0 - i1 as f64 + G3;
        let y1 = y0 - j1 as f64 + G3;
        let z1 = z0 - k1 as f64 + G3;
        let x2 = x0 - i2 as f64 + 2.0 * G3;
        let y2 = y0 - j2 as f64 + 2.0 * G3;
        let z2 = z0 - k2 as f64 + 2.0 * G3;
        let x3 = x0 - 1.0 + 3.0 * G3;
        let y3 = y0 - 1.0 + 3.0 * G3;
        let z3 = z0 - 1.0 + 3.0 * G3;
        let ii = ((i as i64) & 255) as usize;
        let jj = ((j as i64) & 255) as usize;
        let kk = ((k as i64) & 255) as usize;
        let mut n = 0.0;
        let corner = |g: usize, x: f64, y: f64, z: f64, t: f64| {
            let t = t * t;
            t * t * (GRAD3[g] * x + GRAD3[g + 1] * y + GRAD3[g + 2] * z)
        };
        let t0 = 0.6 - x0 * x0 - y0 * y0 - z0 * z0;
        if t0 > 0.0 {
            let g = pm[ii + perm[jj + perm[kk] as usize] as usize] as usize * 3;
            n += corner(g, x0, y0, z0, t0);
        }
        let t1 = 0.6 - x1 * x1 - y1 * y1 - z1 * z1;
        if t1 > 0.0 {
            let g = pm[ii + i1 + perm[jj + j1 + perm[kk + k1] as usize] as usize] as usize * 3;
            n += corner(g, x1, y1, z1, t1);
        }
        let t2 = 0.6 - x2 * x2 - y2 * y2 - z2 * z2;
        if t2 > 0.0 {
            let g = pm[ii + i2 + perm[jj + j2 + perm[kk + k2] as usize] as usize] as usize * 3;
            n += corner(g, x2, y2, z2, t2);
        }
        let t3 = 0.6 - x3 * x3 - y3 * y3 - z3 * z3;
        if t3 > 0.0 {
            let g = pm[ii + 1 + perm[jj + 1 + perm[kk + 1] as usize] as usize] as usize * 3;
            n += corner(g, x3, y3, z3, t3);
        }
        32.0 * n
    }

    /// Fractal Brownian motion, normalized to roughly [-1, 1]. `keep` (fractional) is how many
    /// octaves to actually add - the rest are left out, the last one faded in - so a coarse mesh
    /// can sample a band-limited version of the same field (the mip-pyramid idea from QuadTree.rs,
    /// done in frequency instead of by averaging). The normalization always counts every octave,
    /// so leaving detail out never rescales what remains.
    pub fn fbm(&self, x: f64, y: f64, z: f64, octaves: u32, lacunarity: f64, gain: f64, keep: f64) -> f64 {
        let (mut sum, mut amp, mut freq, mut norm) = (0.0, 1.0, 1.0, 0.0);
        for o in 0..octaves {
            let of = o as f64;
            let w = (keep - of).clamp(0.0, 1.0);
            if w > 0.0 { sum += self.noise(x * freq + of * 17.1, y * freq - of * 9.7, z * freq + of * 5.3) * amp * w; }
            norm += amp;
            amp *= gain;
            freq *= lacunarity;
        }
        sum / norm
    }

    /// Ridged multifractal in [0, 1]: sharp crests for mountain ranges. `keep` as for fbm.
    pub fn ridged(&self, x: f64, y: f64, z: f64, octaves: u32, keep: f64) -> f64 {
        let (mut sum, mut amp, mut freq, mut weight, mut norm) = (0.0, 0.5, 1.0, 1.0, 0.0);
        for o in 0..octaves {
            let of = o as f64;
            let w = (keep - of).clamp(0.0, 1.0);
            if w > 0.0 {
                let mut n = 1.0 - self.noise(x * freq + of * 3.3, y * freq + of * 7.7, z * freq - of * 1.9).abs();
                n *= n;
                n *= weight;
                weight = (n * 2.0).min(1.0);
                sum += n * amp * w;
            }
            norm += amp;
            amp *= 0.5;
            freq *= 2.1;
        }
        sum / norm
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mulberry_matches_the_typescript_generator() {
        // First outputs of the JS mulberry32(1337), as the TypeScript planets were seeded.
        let mut r = Mulberry32::new(1337);
        assert_eq!(r.next(), 0.1844118325971067);
        assert_eq!(r.next(), 0.18998925131745636);
        assert_eq!(r.next(), 0.8104719922412187);
    }

    #[test]
    fn layers_match_the_typescript_noise() {
        // Values printed by the TypeScript Simplex3(1337) this module was ported from.
        let n = Simplex3::new(1337);
        assert!((n.noise(0.3, -1.7, 2.9) - 0.06678585599999995).abs() < 1e-12);
        assert!((n.fbm(0.3, 0.5, 0.7, 5, 2.0, 0.5, 5.0) - 0.2176894296816669).abs() < 1e-12);
        assert!((n.ridged(1.3, 0.5, -0.7, 9, 9.0) - 0.37377976156463405).abs() < 1e-12);
    }

    #[test]
    fn noise_is_bounded_and_deterministic() {
        let n = Simplex3::new(1337);
        let m = Simplex3::new(1337);
        for k in 0..2000 {
            let (x, y, z) = ((k as f64) * 0.37, (k as f64) * -0.71 + 3.0, (k as f64).sin() * 40.0);
            let v = n.noise(x, y, z);
            assert!(v.abs() <= 1.05, "{v}");
            assert_eq!(v, m.noise(x, y, z));
        }
    }
}
