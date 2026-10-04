//! View-frustum tests for culling on the CPU. Planes come from the camera's view-projection
//! matrix (clip = M * world). Only the four side planes are used: shaders such as QuadPlanet's
//! rewrite depth (logarithmic, per fragment), so the projection's near/far planes say nothing
//! about what is drawn, while the side planes still bound what reaches the screen.

use nalgebra::Matrix4;

#[derive(Clone, Copy, Debug)]
pub struct Frustum {
    /// a, b, c, d with (a, b, c) unit length: a point p is inside when a·p + d >= 0.
    planes: [[f32; 4]; 4],
}

impl Frustum {
    pub fn from_view_proj(m: &Matrix4<f32>) -> Self {
        let row = |i: usize| [m[(i, 0)], m[(i, 1)], m[(i, 2)], m[(i, 3)]];
        let (r0, r1, r3) = (row(0), row(1), row(3));
        let combine = |a: [f32; 4], b: [f32; 4], s: f32| [a[0] + s * b[0], a[1] + s * b[1], a[2] + s * b[2], a[3] + s * b[3]];
        let mut planes = [
            combine(r3, r0, 1.0),  // left:   w + x >= 0
            combine(r3, r0, -1.0), // right:  w - x >= 0
            combine(r3, r1, 1.0),  // bottom: w + y >= 0
            combine(r3, r1, -1.0), // top:    w - y >= 0
        ];
        for p in &mut planes {
            let len = (p[0] * p[0] + p[1] * p[1] + p[2] * p[2]).sqrt();
            if len > 0.0 { for v in p.iter_mut() { *v /= len; } }
        }
        Self { planes }
    }

    /// False only when the sphere lies entirely outside one side plane.
    pub fn sphere_visible(&self, center: [f32; 3], radius: f32) -> bool {
        self.planes.iter().all(|p| p[0] * center[0] + p[1] * center[1] + p[2] * center[2] + p[3] >= -radius)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use nalgebra::{Point3, Vector3, Perspective3, Isometry3};

    fn camera() -> Matrix4<f32> {
        let view = Isometry3::look_at_rh(&Point3::new(0.0, 0.0, 0.0), &Point3::new(0.0, 0.0, -1.0), &Vector3::y()).to_homogeneous();
        Perspective3::new(16.0 / 9.0, 60f32.to_radians(), 0.1, 1000.0).to_homogeneous() * view
    }

    #[test]
    fn keeps_what_is_in_view_and_culls_what_is_not() {
        let f = Frustum::from_view_proj(&camera());
        assert!(f.sphere_visible([0.0, 0.0, -50.0], 1.0));
        assert!(f.sphere_visible([0.0, 0.0, -5000.0], 1.0), "no far plane: log depth draws past it");
        assert!(!f.sphere_visible([0.0, 0.0, 50.0], 1.0), "behind");
        assert!(!f.sphere_visible([200.0, 0.0, -50.0], 5.0), "far to the right");
        assert!(!f.sphere_visible([0.0, 100.0, -50.0], 5.0), "above");
        // Straddling the edge: kept.
        assert!(f.sphere_visible([48.0, 0.0, -50.0], 10.0));
        // Big enough to surround the camera: kept.
        assert!(f.sphere_visible([0.0, 0.0, 30.0], 40.0));
    }
}
